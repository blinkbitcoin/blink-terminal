/**
 * Transaction Sync Service
 * Fetches transaction data from Blink API for opted-in community members
 * Also captures wallet balance snapshots for Bitcoin Preference metric
 *
 * IMPORTANT: This service uses DATABASE storage, not in-memory stores
 */

import AuthManager from "../auth"
import BlinkAPI from "../blink-api"
import { parseTxTimestamp } from "../time-utils"

import * as db from "./db"

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Shape of the Blink API wallet object returned by getBalance() */
interface BlinkWallet {
  walletCurrency: string
  balance: number
}

/** Blink API "via" sub-objects that appear on transactions */
interface BlinkVia {
  __typename?: string
  counterPartyUsername?: string
  counterPartyWalletId?: string
}

/** A raw transaction coming back from the Blink GraphQL API */
export interface BlinkTransaction {
  id: string
  direction: string
  settlementAmount: number
  settlementCurrency?: string
  status: string
  initiationVia?: BlinkVia
  settlementVia?: BlinkVia
  createdAt: string | number
  memo?: string
}

/** An edge wrapper around a BlinkTransaction in paginated results */
interface BlinkTransactionEdge {
  node: BlinkTransaction
}

/** Page-info object returned by the Blink API */
interface BlinkPageInfo {
  hasNextPage?: boolean
  endCursor?: string
}

/** The paginated response from blinkApi.getTransactions() */
interface BlinkTransactionPage {
  edges: BlinkTransactionEdge[]
  pageInfo?: BlinkPageInfo
}

/** Normalised transaction stored in our database */
export interface NormalizedTransaction {
  id: string
  direction: string
  settlementAmount: number
  settlementCurrency: string
  status: string
  counterpartyUsername: string | null
  counterpartyWalletId: string | null
  initiationType: string | null
  settlementType: string | null
  createdAt: string | number
  memo: string | null
}

/** Consent row coming from the database */
export interface SyncConsent {
  consent_id: string
  user_npub: string
  community_id: string
  encrypted_api_key: string
  blink_username: string
  blink_wallet_ids?: string[]
}

/** Result returned from syncUserTransactions on success */
interface SyncUserResultSuccess {
  success: true
  user_npub: string
  community_id: string
  blink_username: string
  transaction_count: number
  new_transactions?: number
  pages_loaded: number
  message: string
}

/** Result returned from syncUserTransactions on failure */
interface SyncUserResultError {
  success: false
  user_npub: string
  community_id: string
  blink_username: string
  error: string
}

export type SyncUserResult = SyncUserResultSuccess | SyncUserResultError

/** Result returned from syncCommunityTransactions */
export interface SyncCommunityResult {
  success: true
  community_id: string
  members_synced: number
  total_members: number
  total_transactions: number
  new_transactions?: number
  internal_transactions_marked?: number
  metrics: unknown
  results: SyncUserResult[]
  message?: string
}

/** Result returned from syncAllCommunities */
export interface SyncAllResult {
  success: true
  communities_synced: number
  total_members: number
  total_transactions: number
  new_transactions: number
  results: SyncCommunityResult[]
}

/** Community row as returned by db.listCommunities() */
interface Community {
  id: string
  name: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Typed facade for the db module (db.js is not yet migrated to TS)
// ---------------------------------------------------------------------------

interface DbModule {
  updateSyncStatus(
    consentId: string,
    status: string,
    error: string | null,
    transactionsSynced: number,
  ): Promise<unknown>
  insertBalanceSnapshot(
    consentId: string,
    communityId: string,
    btcBalanceSats: number,
    stablesatsBalanceSats: number,
  ): Promise<unknown>
  insertMemberTransactions(
    consentId: string,
    communityId: string,
    transactions: NormalizedTransaction[],
  ): Promise<number>
  getCommunityConsents(communityId: string): Promise<SyncConsent[]>
  markInternalTransactions(communityId: string): Promise<number>
  computeMetrics(
    communityId: string,
    periodType: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<void>
  getLatestMetrics(communityId: string, periodType: string): Promise<unknown>
  listCommunities(options: { status: string }): Promise<Community[]>
}

const typedDb = db as unknown as DbModule

// ---------------------------------------------------------------------------
// Sync configuration
// ---------------------------------------------------------------------------

const SYNC_CONFIG = {
  DAYS_TO_SYNC: 90, // Fetch transactions from last 90 days
  MAX_TRANSACTIONS: 1000, // Maximum transactions per member
  BATCH_SIZE: 100, // Transactions per API call
} as const

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Decrypt API key using AuthManager (AES encryption)
 */
function decryptApiKey(encryptedKey: string): string {
  const decrypted = AuthManager.decryptApiKey(encryptedKey)
  if (!decrypted) {
    throw new Error("Failed to decrypt API key")
  }
  return decrypted
}

/**
 * Normalize transaction from Blink API format to our database format
 */
function normalizeTransaction(tx: BlinkTransaction): NormalizedTransaction {
  return {
    id: tx.id,
    direction: tx.direction,
    settlementAmount: Math.abs(tx.settlementAmount || 0),
    settlementCurrency: tx.settlementCurrency || "BTC",
    status: tx.status,
    counterpartyUsername:
      tx.initiationVia?.counterPartyUsername ||
      tx.settlementVia?.counterPartyUsername ||
      null,
    counterpartyWalletId:
      tx.initiationVia?.counterPartyWalletId ||
      tx.settlementVia?.counterPartyWalletId ||
      null,
    initiationType: tx.initiationVia?.__typename?.replace("InitiationVia", "") || null,
    settlementType: tx.settlementVia?.__typename?.replace("SettlementVia", "") || null,
    createdAt: tx.createdAt,
    memo: tx.memo || null,
  }
}

// ---------------------------------------------------------------------------
// Core sync functions
// ---------------------------------------------------------------------------

/**
 * Sync transactions for a single user/community with pagination.
 * Fetches up to SYNC_CONFIG.DAYS_TO_SYNC days of history.
 */
export async function syncUserTransactions(
  consent: SyncConsent,
): Promise<SyncUserResult> {
  const { consent_id, user_npub, community_id, encrypted_api_key, blink_username } =
    consent

  // Update sync status to 'syncing'
  await typedDb.updateSyncStatus(consent_id, "syncing", null, 0)

  try {
    // Decrypt API key
    const apiKey: string = decryptApiKey(encrypted_api_key)

    // Create Blink API client
    const blinkApi = new BlinkAPI(apiKey)

    // ===== FETCH WALLET BALANCES FOR BITCOIN PREFERENCE =====
    let btcBalanceSats = 0
    let stablesatsBalanceSats = 0

    try {
      const wallets: BlinkWallet[] = await blinkApi.getBalance()

      for (const wallet of wallets) {
        if (wallet.walletCurrency === "BTC") {
          btcBalanceSats = Math.abs(wallet.balance || 0)
        } else if (wallet.walletCurrency === "USD") {
          // StableSats (USD) balance is stored in cents, need to convert to sats equivalent
          // For Bitcoin Preference, we store the raw sats value
          stablesatsBalanceSats = Math.abs(wallet.balance || 0)
        }
      }

      // Store balance snapshot
      await typedDb.insertBalanceSnapshot(
        consent_id,
        community_id,
        btcBalanceSats,
        stablesatsBalanceSats,
      )
      console.log(
        `[SyncService] Balance snapshot for ${blink_username}: BTC=${btcBalanceSats} sats, StableSats=${stablesatsBalanceSats} sats`,
      )
    } catch (balanceError: unknown) {
      console.warn(
        `[SyncService] Could not fetch balance for ${blink_username}:`,
        (balanceError as Error).message,
      )
      // Continue with transaction sync even if balance fetch fails
    }

    // ===== FETCH TRANSACTIONS =====
    // Calculate cutoff date (90 days ago)
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - SYNC_CONFIG.DAYS_TO_SYNC)
    const cutoffTimestamp: number = cutoffDate.getTime()

    console.log(
      `[SyncService] Fetching transactions for ${blink_username || user_npub.substring(0, 20)}...`,
    )
    console.log(
      `[SyncService] Cutoff date: ${cutoffDate.toISOString()} (last ${SYNC_CONFIG.DAYS_TO_SYNC} days)`,
    )

    const allTransactions: NormalizedTransaction[] = []
    let cursor: string | null = null
    let hasMore = true
    let pagesLoaded = 0

    // Paginate through transactions until we hit the cutoff date or max limit
    while (hasMore && allTransactions.length < SYNC_CONFIG.MAX_TRANSACTIONS) {
      const txData: BlinkTransactionPage | null = (await blinkApi.getTransactions(
        SYNC_CONFIG.BATCH_SIZE,
        cursor,
      )) as BlinkTransactionPage | null
      pagesLoaded++

      if (!txData || !txData.edges || txData.edges.length === 0) {
        hasMore = false
        break
      }

      // Extract transactions from edges
      const batchTransactions: BlinkTransaction[] = txData.edges.map(
        (edge: BlinkTransactionEdge) => edge.node,
      )

      // Check if we've reached transactions older than cutoff
      let reachedCutoff = false
      for (const tx of batchTransactions) {
        const txTimestamp: number = parseTxTimestamp(tx.createdAt)

        if (txTimestamp < cutoffTimestamp) {
          reachedCutoff = true
          break
        }

        allTransactions.push(normalizeTransaction(tx))

        if (allTransactions.length >= SYNC_CONFIG.MAX_TRANSACTIONS) {
          break
        }
      }

      if (reachedCutoff) {
        console.log(
          `[SyncService] Reached ${SYNC_CONFIG.DAYS_TO_SYNC}-day cutoff after ${pagesLoaded} pages`,
        )
        hasMore = false
      } else if (txData.pageInfo?.hasNextPage && txData.pageInfo?.endCursor) {
        cursor = txData.pageInfo.endCursor
      } else {
        hasMore = false
      }
    }

    if (allTransactions.length === 0) {
      console.log(`[SyncService] No transactions found for ${blink_username}`)
      await typedDb.updateSyncStatus(consent_id, "synced", null, 0)
      return {
        success: true,
        user_npub,
        community_id,
        blink_username,
        transaction_count: 0,
        pages_loaded: pagesLoaded,
        message: "No transactions found",
      }
    }

    // Store transactions in database
    const insertedCount: number = await typedDb.insertMemberTransactions(
      consent_id,
      community_id,
      allTransactions,
    )

    // Update sync status
    await typedDb.updateSyncStatus(consent_id, "synced", null, insertedCount)

    console.log(
      `[SyncService] Synced ${allTransactions.length} transactions for ${blink_username} (${insertedCount} new, ${pagesLoaded} API calls)`,
    )

    return {
      success: true,
      user_npub,
      community_id,
      blink_username,
      transaction_count: allTransactions.length,
      new_transactions: insertedCount,
      pages_loaded: pagesLoaded,
      message: `Synced ${allTransactions.length} transactions (${insertedCount} new)`,
    }
  } catch (error: unknown) {
    const errorMessage = (error as Error).message
    console.error(
      `[SyncService] Error syncing for ${blink_username || user_npub}:`,
      errorMessage,
    )

    // Update sync status with error
    await typedDb.updateSyncStatus(consent_id, "error", errorMessage, 0)

    return {
      success: false,
      user_npub,
      community_id,
      blink_username,
      error: errorMessage,
    }
  }
}

/**
 * Sync all transactions for a community
 */
export async function syncCommunityTransactions(
  communityId: string,
): Promise<SyncCommunityResult> {
  console.log(`[SyncService] Starting sync for community ${communityId}`)

  // Get all active consents for this community from DATABASE
  const consents: SyncConsent[] = await typedDb.getCommunityConsents(communityId)

  if (!consents || consents.length === 0) {
    console.log(`[SyncService] No opted-in members found for community ${communityId}`)
    return {
      success: true,
      community_id: communityId,
      message: "No members have opted in for data sharing",
      members_synced: 0,
      total_members: 0,
      total_transactions: 0,
      results: [],
      metrics: null,
    }
  }

  console.log(`[SyncService] Found ${consents.length} opted-in members`)

  // Sync each member's transactions
  const results: SyncUserResult[] = []
  const memberUsernames: string[] = []

  for (const consent of consents) {
    const result: SyncUserResult = await syncUserTransactions(consent)
    results.push(result)

    if (consent.blink_username) {
      memberUsernames.push(consent.blink_username)
    }
  }

  // Mark internal transactions (transactions between community members)
  const internalMarked: number = await typedDb.markInternalTransactions(communityId)
  console.log(`[SyncService] Marked ${internalMarked} internal transactions`)

  // Compute metrics for current period
  const now = new Date()
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1) // First of current month
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0) // Last of current month

  try {
    await typedDb.computeMetrics(
      communityId,
      "monthly",
      periodStart.toISOString().split("T")[0],
      periodEnd.toISOString().split("T")[0],
    )
    console.log(
      `[SyncService] Computed metrics for ${periodStart.toISOString().split("T")[0]} to ${periodEnd.toISOString().split("T")[0]}`,
    )
  } catch (metricsError: unknown) {
    console.error(
      `[SyncService] Error computing metrics:`,
      (metricsError as Error).message,
    )
  }

  // Get the computed metrics to return
  let metrics: unknown = null
  try {
    metrics = await typedDb.getLatestMetrics(communityId, "monthly")
  } catch (err: unknown) {
    console.error(`[SyncService] Error fetching metrics:`, (err as Error).message)
  }

  const successCount: number = results.filter((r) => r.success).length
  const totalTxs: number = results.reduce(
    (sum, r) => sum + ("transaction_count" in r ? r.transaction_count || 0 : 0),
    0,
  )
  const newTxs: number = results.reduce(
    (sum, r) => sum + ("new_transactions" in r ? r.new_transactions || 0 : 0),
    0,
  )

  console.log(
    `[SyncService] Community sync complete: ${successCount}/${consents.length} members, ${totalTxs} transactions (${newTxs} new)`,
  )

  return {
    success: true,
    community_id: communityId,
    members_synced: successCount,
    total_members: consents.length,
    total_transactions: totalTxs,
    new_transactions: newTxs,
    internal_transactions_marked: internalMarked,
    metrics,
    results,
  }
}

/**
 * Sync all transactions across all communities
 */
export async function syncAllCommunities(): Promise<SyncAllResult> {
  console.log("[SyncService] Starting full sync for all communities")

  // Get all active communities from DATABASE
  const communities: Community[] = await typedDb.listCommunities({ status: "active" })

  if (!communities || communities.length === 0) {
    console.log("[SyncService] No active communities found")
    return {
      success: true,
      communities_synced: 0,
      total_members: 0,
      total_transactions: 0,
      new_transactions: 0,
      results: [],
    }
  }

  console.log(`[SyncService] Found ${communities.length} active communities`)

  const results: SyncCommunityResult[] = []

  for (const community of communities) {
    console.log(`[SyncService] Syncing community: ${community.name} (${community.id})`)
    const result: SyncCommunityResult = await syncCommunityTransactions(community.id)
    results.push(result)
  }

  const totalMembers: number = results.reduce(
    (sum, r) => sum + (r.members_synced || 0),
    0,
  )
  const totalTxs: number = results.reduce(
    (sum, r) => sum + (r.total_transactions || 0),
    0,
  )
  const newTxs: number = results.reduce((sum, r) => sum + (r.new_transactions || 0), 0)

  console.log(
    `[SyncService] Full sync complete: ${communities.length} communities, ${totalMembers} members, ${totalTxs} transactions (${newTxs} new)`,
  )

  return {
    success: true,
    communities_synced: communities.length,
    total_members: totalMembers,
    total_transactions: totalTxs,
    new_transactions: newTxs,
    results,
  }
}
