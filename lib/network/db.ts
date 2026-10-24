/**
 * Database utilities for Network module
 * Handles all PostgreSQL operations for communities, memberships, and metrics
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg"

import { getSharedPool, getClient as getSharedClient } from "../db"
import { baseLogger } from "../logger"

const logger = baseLogger.child({ module: "network-db" })

// ============================================
// INTERFACES — Input types
// ============================================

export interface CommunityCreateData {
  name: string
  slug: string
  description?: string
  countryCode?: string
  region?: string
  city?: string
  latitude?: number | null
  longitude?: number | null
  leaderNpub: string
  leaderPubkeyHex: string
  settings?: Record<string, unknown> | null
}

export interface ListOptions {
  status?: string
  limit?: number
  offset?: number
}

export interface ConsentData {
  consentGiven: boolean
  blinkApiKeyEncrypted?: string | null
  blinkWalletIds?: string | null
  blinkUsername?: string | null
  syncFromDate?: string | Date | null
}

export interface MemberTransaction {
  id: string
  direction: string
  settlementAmount: number | string
  settlementCurrency: string
  status: string
  counterpartyUsername?: string | null
  counterpartyWalletId?: string | null
  initiationType?: string | null
  settlementType?: string | null
  createdAt: number | string | Date
  memo?: string | null
}

export interface DateRange {
  start: Date
  end: Date
  label: string
}

export interface CalculatedMetrics {
  transaction_count: number
  total_volume_sats: number
  intra_community_count: number
  intra_volume_sats: number
  unique_members: number
  closed_loop_ratio: number
  velocity: number
  avg_tx_size: number
}

export interface BitcoinPreference {
  community_id: string | number
  btc_preference_pct: number | null
  total_btc_sats: number
  total_stablesats_sats: number
  total_balance_sats: number
  member_count: number
  members_with_balance: number
  has_data: boolean
}

export interface DataCoverage {
  oldest: string | null
  newest: string | null
  total_transactions: number
}

// ============================================
// INTERFACES — Database row types
// ============================================

/** Row shape returned by `super_admins` table queries */
export interface SuperAdminRow {
  id: number
  npub: string
  display_name: string | null
  status: string
  added_at: string
}

/** Row shape returned by `community_leader_whitelist` table queries */
export interface WhitelistRow {
  id: number
  npub: string
  pubkey_hex: string
  display_name: string | null
  status: string
  added_by: string
  reason: string | null
  created_at: string
  updated_at: string | null
}

/** Row shape returned by `communities` table queries */
export interface CommunityRow {
  id: number
  name: string
  slug: string
  description: string | null
  country_code: string | null
  region: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
  leader_npub: string
  leader_pubkey_hex: string
  settings: Record<string, unknown> | null
  status: string
  member_count: number
  data_sharing_member_count: number
  created_at: string
  updated_at: string | null
  // Computed fields from JOINs
  member_count_live?: number
}

/** Row shape returned by `community_memberships` table queries */
export interface MembershipRow {
  id: number
  community_id: number
  user_npub: string
  user_pubkey_hex: string | null
  role: string
  status: string
  application_note: string | null
  applied_at: string
  approved_at: string | null
  approved_by_npub: string | null
  reviewed_at: string | null
  rejection_reason: string | null
  left_at: string | null
  removed_at: string | null
  removed_by_npub: string | null
  // Computed fields from JOINs
  community_name?: string
  community_slug?: string
  leader_npub?: string
  member_count?: number
  data_sharing_member_count?: number
  // From LEFT JOIN with data_sharing_consents
  consent_given?: boolean
  blink_username?: string | null
  total_transactions_synced?: number
}

/** Row shape returned by `data_sharing_consents` table queries */
export interface ConsentRow {
  id: number
  membership_id: number
  user_npub: string
  community_id: number
  consent_given: boolean
  blink_api_key_encrypted: string | null
  blink_wallet_ids: string | null
  blink_username: string | null
  sync_from_date: string | null
  consented_at: string | null
  revoked_at: string | null
  sync_status: string
  last_sync_at: string | null
  last_sync_error: string | null
  total_transactions_synced: number
  next_sync_at: string | null
  updated_at: string | null
}

/** Row shape returned by `getCommunityConsents` (aliased columns) */
export interface ConsentForSyncRow {
  consent_id: number
  membership_id: number
  user_npub: string
  community_id: number
  encrypted_api_key: string | null
  blink_username: string | null
  blink_wallet_ids: string | null
  sync_status: string
  last_sync_at: string | null
  total_transactions_synced: number
}

/** Row shape returned by `community_metrics` table queries */
export interface MetricsRow {
  id: number
  community_id: number
  period_type: string
  period_start: string
  period_end: string
  transaction_count: number
  total_volume_sats: number
  intra_community_count: number
  intra_volume_sats: number
  unique_members: number
  closed_loop_ratio: number
  velocity: number
  avg_tx_size: number
  created_at: string
}

/** Row shape returned by `community_milestones` table queries */
export interface MilestoneRow {
  id: number
  community_id: number
  milestone_type: string
  milestone_value: string
  achieved_at: string
}

/** Row shape returned by `member_balance_snapshots` table queries */
export interface BalanceSnapshotRow {
  id: number
  consent_id: number
  community_id: number
  btc_balance_sats: number
  stablesats_balance_sats: number
  total_balance_sats: number
  snapshot_date: string
  created_at: string
}

/** Row shape returned by `getBitcoinPreferenceHistory` (aggregated) */
export interface BalanceHistoryRow {
  snapshot_date: string
  total_btc_sats: number
  total_stablesats_sats: number
  total_balance_sats: number
  btc_preference_pct: number
  member_count: number
}

/** Row shape for member_transactions with computed intra-community flag */
export interface TransactionRow {
  id: number
  consent_id: number
  community_id: number
  tx_id: string
  direction: string
  settlement_amount: number
  settlement_currency: string
  status: string
  counterparty_username: string | null
  counterparty_wallet_id: string | null
  counterparty_in_community: boolean | null
  initiation_type: string | null
  settlement_type: string | null
  tx_created_at: string
  memo: string | null
  created_at: string
  /** Computed: true if counterparty is in the same community */
  is_intra: boolean
}

/** Row shape for blink_username lookup in calculateMetricsForPeriod */
interface BlinkUsernameRow {
  blink_username: string
}

/** Row shape for getDataCoverage aggregate query */
interface DataCoverageRow {
  oldest: Date | null
  newest: Date | null
  total_transactions: string
}

/** Row shape for COUNT(*) aggregate queries */
interface CountRow {
  count: string
}

/** Row shape returned by `calculate_community_btc_preference` SQL function */
interface BtcPreferenceFunctionRow {
  btc_preference_pct: string | null
  total_btc_sats: string
  total_stablesats_sats: string
  total_balance_sats: string
  member_count: string
  members_with_balance: string
}

// ============================================
// CONNECTION POOL (delegates to shared pool)
// ============================================

// Create connection pool
export function getPool(): Pool {
  return getSharedPool()
}

/**
 * Execute a query with parameters
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const start = Date.now()
  const result = await getPool().query<T>(text, params)
  const duration = Date.now() - start

  if (duration > 1000) {
    logger.warn({ duration, query: text.substring(0, 100) }, "Slow query detected")
  }

  return result
}

/**
 * Get a client from pool for transactions
 */
export async function getClient(): Promise<PoolClient> {
  return getSharedClient()
}

// ============================================
// SUPER ADMIN OPERATIONS
// ============================================

// Super admins live in the super_admins table only (seeded by migration
// 003). There is no hard-coded fallback (blink-wip#1679): a fallback could
// not be revoked by setting the row inactive, and a database error now fails
// closed instead of granting admin.
export async function isSuperAdmin(npub: string | null | undefined): Promise<boolean> {
  if (!npub) return false

  const result = await query(
    "SELECT id FROM super_admins WHERE npub = $1 AND status = $2",
    [npub, "active"],
  )
  return result.rows.length > 0
}

export async function getSuperAdmins(): Promise<SuperAdminRow[]> {
  const result = await query<SuperAdminRow>(
    `SELECT npub, display_name, added_at FROM super_admins WHERE status = 'active'`,
  )
  return result.rows
}

// ============================================
// LEADER WHITELIST OPERATIONS
// ============================================

export async function isLeaderWhitelisted(
  npub: string | null | undefined,
): Promise<boolean> {
  if (!npub) return false

  const result = await query(
    "SELECT id FROM community_leader_whitelist WHERE npub = $1 AND status = $2",
    [npub, "active"],
  )
  return result.rows.length > 0
}

export async function canCreateCommunity(npub: string): Promise<boolean> {
  // Only super admin can create new communities (whitelist new leaders)
  return isSuperAdmin(npub)
}

export async function addToWhitelist(
  npub: string,
  pubkeyHex: string,
  displayName: string,
  addedByNpub: string,
  reason: string,
): Promise<WhitelistRow> {
  // Verify the caller is a super admin
  const isAdmin = await isSuperAdmin(addedByNpub)
  if (!isAdmin) {
    throw new Error("Only super admins can whitelist community leaders")
  }

  const result = await query<WhitelistRow>(
    `INSERT INTO community_leader_whitelist 
     (npub, pubkey_hex, display_name, added_by, reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [npub, pubkeyHex, displayName, addedByNpub, reason],
  )
  return result.rows[0]
}

export async function removeFromWhitelist(
  npub: string,
  removedByNpub: string,
): Promise<WhitelistRow | undefined> {
  // Verify the caller is a super admin
  const isAdmin = await isSuperAdmin(removedByNpub)
  if (!isAdmin) {
    throw new Error("Only super admins can remove community leaders from whitelist")
  }

  const result = await query<WhitelistRow>(
    `UPDATE community_leader_whitelist 
     SET status = 'revoked', updated_at = NOW()
     WHERE npub = $1
     RETURNING *`,
    [npub],
  )
  return result.rows[0]
}

export async function getWhitelistedLeaders(): Promise<WhitelistRow[]> {
  const result = await query<WhitelistRow>(
    `SELECT * FROM community_leader_whitelist WHERE status = 'active' ORDER BY created_at DESC`,
  )
  return result.rows
}

// ============================================
// COMMUNITY OPERATIONS
// ============================================

export async function createCommunity(data: CommunityCreateData): Promise<CommunityRow> {
  const {
    name,
    slug,
    description,
    countryCode,
    region,
    city,
    latitude,
    longitude,
    leaderNpub,
    leaderPubkeyHex,
    settings,
  } = data

  const result = await query<CommunityRow>(
    `INSERT INTO communities 
     (name, slug, description, country_code, region, city, latitude, longitude,
       leader_npub, leader_pubkey_hex, settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      name,
      slug,
      description,
      countryCode,
      region,
      city,
      latitude,
      longitude,
      leaderNpub,
      leaderPubkeyHex,
      settings ? JSON.stringify(settings) : null,
    ],
  )

  // Also create membership for leader
  await query(
    `INSERT INTO community_memberships 
     (community_id, user_npub, user_pubkey_hex, role, status, approved_at)
     VALUES ($1, $2, $3, 'leader', 'approved', NOW())`,
    [result.rows[0].id, leaderNpub, leaderPubkeyHex],
  )

  return result.rows[0]
}

export async function getCommunityBySlug(
  slug: string,
): Promise<CommunityRow | undefined> {
  const result = await query<CommunityRow>("SELECT * FROM communities WHERE slug = $1", [
    slug,
  ])
  return result.rows[0]
}

export async function getCommunityById(
  id: string | number,
): Promise<CommunityRow | undefined> {
  const result = await query<CommunityRow>("SELECT * FROM communities WHERE id = $1", [
    id,
  ])
  return result.rows[0]
}

export async function listCommunities(
  options: ListOptions = {},
): Promise<CommunityRow[]> {
  const { status = "active", limit = 50, offset = 0 } = options

  const result = await query<CommunityRow>(
    `SELECT c.*, 
            (SELECT COUNT(*) FROM community_memberships 
             WHERE community_id = c.id AND status = 'approved') as member_count_live
     FROM communities c
     WHERE c.status = $1
     ORDER BY c.member_count DESC, c.created_at DESC
     LIMIT $2 OFFSET $3`,
    [status, limit, offset],
  )
  return result.rows
}

export async function getCommunitiesForHeatmap(): Promise<CommunityRow[]> {
  const result = await query<CommunityRow>(`SELECT * FROM community_heatmap`)
  return result.rows
}

export async function getLeaderboard(): Promise<CommunityRow[]> {
  const result = await query<CommunityRow>(
    `SELECT * FROM community_leaderboard LIMIT 100`,
  )
  return result.rows
}

// ============================================
// MEMBERSHIP OPERATIONS
// ============================================

export async function applyToJoinCommunity(
  communityId: string | number,
  userNpub: string,
  userPubkeyHex: string,
  applicationNote: string | null,
): Promise<MembershipRow> {
  const result = await query<MembershipRow>(
    `INSERT INTO community_memberships 
     (community_id, user_npub, user_pubkey_hex, application_note, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (community_id, user_npub) 
     DO UPDATE SET 
       application_note = EXCLUDED.application_note,
       applied_at = NOW(),
       status = CASE 
         WHEN community_memberships.status = 'rejected' THEN 'pending'
         ELSE community_memberships.status
       END
     RETURNING *`,
    [communityId, userNpub, userPubkeyHex, applicationNote],
  )
  return result.rows[0]
}

export async function getMembership(
  communityId: string | number,
  userNpub: string,
): Promise<MembershipRow | undefined> {
  const result = await query<MembershipRow>(
    `SELECT cm.*, c.name as community_name, c.slug as community_slug
     FROM community_memberships cm
     JOIN communities c ON c.id = cm.community_id
     WHERE cm.community_id = $1 AND cm.user_npub = $2`,
    [communityId, userNpub],
  )
  return result.rows[0]
}

/**
 * Get membership by ID
 */
export async function getMembershipById(
  membershipId: string | number,
): Promise<MembershipRow | undefined> {
  const result = await query<MembershipRow>(
    `SELECT cm.*, c.name as community_name, c.slug as community_slug, c.leader_npub
     FROM community_memberships cm
     JOIN communities c ON c.id = cm.community_id
     WHERE cm.id = $1`,
    [parseInt(String(membershipId), 10)],
  )
  return result.rows[0]
}

export async function getUserMemberships(userNpub: string): Promise<MembershipRow[]> {
  const result = await query<MembershipRow>(
    `SELECT cm.*, c.name as community_name, c.slug as community_slug,
            c.member_count, c.data_sharing_member_count
     FROM community_memberships cm
     JOIN communities c ON c.id = cm.community_id
     WHERE cm.user_npub = $1
     ORDER BY cm.approved_at DESC NULLS LAST`,
    [userNpub],
  )
  return result.rows
}

export async function getPendingApplications(
  communityId: string | number,
): Promise<MembershipRow[]> {
  const result = await query<MembershipRow>(
    `SELECT * FROM pending_applications WHERE community_id = $1`,
    [communityId],
  )
  return result.rows
}

export async function reviewApplication(
  membershipId: string | number,
  approvedByNpub: string,
  approved: boolean,
  rejectionReason: string | null,
): Promise<MembershipRow | undefined> {
  const result = await query<MembershipRow>(
    `UPDATE community_memberships 
     SET status = $1::varchar,
         reviewed_at = NOW(),
         approved_at = CASE WHEN $1::varchar = 'approved' THEN NOW() ELSE approved_at END,
         approved_by_npub = $2,
         rejection_reason = $3
     WHERE id = $4
     RETURNING *`,
    [
      approved ? "approved" : "rejected",
      approvedByNpub,
      rejectionReason,
      parseInt(String(membershipId), 10),
    ],
  )
  return result.rows[0]
}

export async function leaveCommunity(
  communityId: string | number,
  userNpub: string,
): Promise<MembershipRow | undefined> {
  const result = await query<MembershipRow>(
    `UPDATE community_memberships 
     SET status = 'left', left_at = NOW()
     WHERE community_id = $1 AND user_npub = $2
     RETURNING *`,
    [communityId, userNpub],
  )
  return result.rows[0]
}

/**
 * Remove a member from a community (leader action)
 * Sets status to 'removed' and records who removed them
 */
export async function removeMember(
  membershipId: string | number,
  removedByNpub: string,
): Promise<MembershipRow | undefined> {
  const result = await query<MembershipRow>(
    `UPDATE community_memberships 
     SET status = 'removed', 
         removed_at = NOW(),
         removed_by_npub = $2
     WHERE id = $1
     RETURNING *`,
    [parseInt(String(membershipId), 10), removedByNpub],
  )

  // Also revoke any data sharing consent
  await query(
    `UPDATE data_sharing_consents 
     SET consent_given = false, 
         revoked_at = NOW()
     WHERE membership_id = $1`,
    [parseInt(String(membershipId), 10)],
  )

  return result.rows[0]
}

export async function getCommunityMembers(
  communityId: string | number,
  options: ListOptions = {},
): Promise<MembershipRow[]> {
  const { status = "approved", limit = 100, offset = 0 } = options

  const result = await query<MembershipRow>(
    `SELECT cm.*, 
            dsc.consent_given,
            dsc.blink_username,
            dsc.total_transactions_synced
     FROM community_memberships cm
     LEFT JOIN data_sharing_consents dsc ON dsc.membership_id = cm.id
     WHERE cm.community_id = $1 AND cm.status = $2
     ORDER BY cm.approved_at DESC
     LIMIT $3 OFFSET $4`,
    [communityId, status, limit, offset],
  )
  return result.rows
}

// ============================================
// DATA SHARING CONSENT OPERATIONS
// ============================================

export async function createOrUpdateConsent(
  membershipId: string | number,
  userNpub: string,
  communityId: string | number,
  consentData: ConsentData,
): Promise<ConsentRow> {
  const {
    consentGiven,
    blinkApiKeyEncrypted,
    blinkWalletIds,
    blinkUsername,
    syncFromDate,
  } = consentData

  const result = await query<ConsentRow>(
    `INSERT INTO data_sharing_consents 
     (membership_id, user_npub, community_id, consent_given, 
      blink_api_key_encrypted, blink_wallet_ids, blink_username,
      sync_from_date, consented_at, sync_status, next_sync_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 
             CASE WHEN $4 THEN NOW() ELSE NULL END,
             CASE WHEN $4 THEN 'pending' ELSE 'never' END,
             CASE WHEN $4 THEN NOW() ELSE NULL END)
     ON CONFLICT (membership_id) 
     DO UPDATE SET 
       consent_given = EXCLUDED.consent_given,
       blink_api_key_encrypted = COALESCE(EXCLUDED.blink_api_key_encrypted, data_sharing_consents.blink_api_key_encrypted),
       blink_wallet_ids = COALESCE(EXCLUDED.blink_wallet_ids, data_sharing_consents.blink_wallet_ids),
       blink_username = COALESCE(EXCLUDED.blink_username, data_sharing_consents.blink_username),
       sync_from_date = COALESCE(EXCLUDED.sync_from_date, data_sharing_consents.sync_from_date),
       consented_at = CASE WHEN EXCLUDED.consent_given AND NOT data_sharing_consents.consent_given THEN NOW() ELSE data_sharing_consents.consented_at END,
       revoked_at = CASE WHEN NOT EXCLUDED.consent_given AND data_sharing_consents.consent_given THEN NOW() ELSE data_sharing_consents.revoked_at END,
       sync_status = CASE WHEN EXCLUDED.consent_given THEN 'pending' ELSE 'never' END,
       next_sync_at = CASE WHEN EXCLUDED.consent_given THEN NOW() ELSE NULL END,
       updated_at = NOW()
     RETURNING *`,
    [
      membershipId,
      userNpub,
      communityId,
      consentGiven,
      blinkApiKeyEncrypted,
      blinkWalletIds,
      blinkUsername,
      syncFromDate,
    ],
  )
  return result.rows[0]
}

export async function getConsent(
  membershipId: string | number,
): Promise<ConsentRow | undefined> {
  const result = await query<ConsentRow>(
    `SELECT * FROM data_sharing_consents WHERE membership_id = $1`,
    [membershipId],
  )
  return result.rows[0]
}

export async function getConsentByUser(
  communityId: string | number,
  userNpub: string,
): Promise<ConsentRow | undefined> {
  const result = await query<ConsentRow>(
    `SELECT dsc.* 
     FROM data_sharing_consents dsc
     JOIN community_memberships cm ON cm.id = dsc.membership_id
     WHERE cm.community_id = $1 AND cm.user_npub = $2`,
    [communityId, userNpub],
  )
  return result.rows[0]
}

export async function getConsentsForSync(limit: number = 10): Promise<ConsentRow[]> {
  const result = await query<ConsentRow>(`SELECT * FROM data_sync_queue LIMIT $1`, [
    limit,
  ])
  return result.rows
}

export async function getCommunityConsents(
  communityId: string | number,
): Promise<ConsentForSyncRow[]> {
  // Get all active consents for a specific community with API keys for syncing
  const result = await query<ConsentForSyncRow>(
    `SELECT 
       dsc.id as consent_id,
       dsc.membership_id,
       dsc.user_npub,
       dsc.community_id,
       dsc.blink_api_key_encrypted as encrypted_api_key,
       dsc.blink_username,
       dsc.blink_wallet_ids,
       dsc.sync_status,
       dsc.last_sync_at,
       dsc.total_transactions_synced
     FROM data_sharing_consents dsc
     WHERE dsc.community_id = $1
       AND dsc.consent_given = true
       AND dsc.blink_api_key_encrypted IS NOT NULL`,
    [communityId],
  )
  return result.rows
}

export async function updateSyncStatus(
  consentId: string | number,
  status: string,
  error: string | null = null,
  transactionsSynced: number = 0,
): Promise<ConsentRow | undefined> {
  const result = await query<ConsentRow>(
    `UPDATE data_sharing_consents 
     SET sync_status = $1::varchar,
         last_sync_at = NOW(),
         last_sync_error = $2,
         total_transactions_synced = total_transactions_synced + $3,
         next_sync_at = CASE 
           WHEN $1::varchar = 'synced' THEN NOW() + INTERVAL '24 hours'
           WHEN $1::varchar = 'error' THEN NOW() + INTERVAL '1 hour'
           ELSE next_sync_at
         END,
         updated_at = NOW()
     WHERE id = $4
     RETURNING *`,
    [status, error, transactionsSynced, consentId],
  )
  return result.rows[0]
}

// ============================================
// TRANSACTION OPERATIONS
// ============================================

/**
 * Convert a transaction timestamp to a proper Date object
 * Handles Unix timestamps (seconds), milliseconds, and ISO strings
 */
export function parseTransactionTimestamp(
  timestamp: number | string | Date | null | undefined,
): Date | null {
  if (!timestamp) return null

  // If it's already a Date object, return it
  if (timestamp instanceof Date) return timestamp

  // If it's a number, check if it's seconds or milliseconds
  if (typeof timestamp === "number") {
    // If timestamp is in seconds (typical Unix timestamp), convert to milliseconds
    // Unix timestamps from 2020-2030 are in the range 1577836800 to 1893456000
    if (timestamp < 10000000000) {
      return new Date(timestamp * 1000)
    }
    // Already in milliseconds
    return new Date(timestamp)
  }

  // If it's a string, parse it
  if (typeof timestamp === "string") {
    return new Date(timestamp)
  }

  return null
}

export async function insertMemberTransactions(
  consentId: string | number,
  communityId: string | number,
  transactions: MemberTransaction[],
): Promise<number> {
  if (!transactions || transactions.length === 0) {
    return 0
  }

  const client = await getClient()
  let inserted = 0

  try {
    await client.query("BEGIN")

    for (const tx of transactions) {
      try {
        // Convert timestamp to proper Date
        const txCreatedAt = parseTransactionTimestamp(tx.createdAt)

        if (!txCreatedAt || isNaN(txCreatedAt.getTime())) {
          logger.warn(
            { txId: tx.id, timestamp: tx.createdAt },
            "Skipping transaction with invalid timestamp",
          )
          continue
        }

        // Use a savepoint so individual insert failures don't abort the whole transaction
        await client.query("SAVEPOINT insert_tx")

        await client.query(
          `INSERT INTO member_transactions 
           (consent_id, community_id, tx_id, direction, settlement_amount, settlement_currency,
            status, counterparty_username, counterparty_wallet_id, initiation_type,
            settlement_type, tx_created_at, memo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (consent_id, tx_id) DO NOTHING`,
          [
            consentId,
            communityId,
            tx.id,
            tx.direction,
            tx.settlementAmount,
            tx.settlementCurrency,
            tx.status,
            tx.counterpartyUsername,
            tx.counterpartyWalletId,
            tx.initiationType,
            tx.settlementType,
            txCreatedAt,
            tx.memo,
          ],
        )

        await client.query("RELEASE SAVEPOINT insert_tx")
        inserted++
      } catch (err: unknown) {
        // Rollback to savepoint and continue with next transaction
        await client.query("ROLLBACK TO SAVEPOINT insert_tx")

        // Only log if it's not a duplicate (which is handled by ON CONFLICT)
        if ((err as Record<string, unknown>).code !== "23505") {
          logger.error({ txId: tx.id, err }, "Error inserting transaction")
        }
      }
    }

    await client.query("COMMIT")
  } catch (err: unknown) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }

  return inserted
}

export async function markInternalTransactions(
  communityId: string | number,
): Promise<number> {
  const result = await query<{ mark_internal_transactions: number }>(
    `SELECT mark_internal_transactions($1)`,
    [communityId],
  )
  return result.rows[0].mark_internal_transactions
}

// ============================================
// METRICS OPERATIONS
// ============================================

export async function computeMetrics(
  communityId: string | number,
  periodType: string,
  periodStart: Date | string,
  periodEnd: Date | string,
): Promise<void> {
  await query(`SELECT compute_community_metrics($1, $2, $3, $4)`, [
    communityId,
    periodType,
    periodStart,
    periodEnd,
  ])
}

export async function getLatestMetrics(
  communityId: string | number,
  periodType: string = "monthly",
): Promise<MetricsRow | undefined> {
  const result = await query<MetricsRow>(
    `SELECT * FROM community_metrics 
     WHERE community_id = $1 AND period_type = $2
     ORDER BY period_start DESC
     LIMIT 1`,
    [communityId, periodType],
  )
  return result.rows[0]
}

export async function getMetricsHistory(
  communityId: string | number,
  periodType: string = "monthly",
  limit: number = 12,
): Promise<MetricsRow[]> {
  const result = await query<MetricsRow>(
    `SELECT * FROM community_metrics 
     WHERE community_id = $1 AND period_type = $2
     ORDER BY period_start DESC
     LIMIT $3`,
    [communityId, periodType, limit],
  )
  return result.rows
}

/**
 * Calculate metrics for a specific time period from transactions
 */
export async function calculateMetricsForPeriod(
  communityId: string | number,
  periodStart: Date | string,
  periodEnd: Date | string,
): Promise<CalculatedMetrics> {
  // Get member usernames for intra-community detection
  const consentsResult = await query<BlinkUsernameRow>(
    `SELECT blink_username FROM data_sharing_consents 
     WHERE community_id = $1 AND consent_given = true AND blink_username IS NOT NULL`,
    [communityId],
  )
  const memberUsernames: string[] = consentsResult.rows.map((r) =>
    r.blink_username.toLowerCase(),
  )
  const memberSet = new Set(memberUsernames)

  // Get transactions for the period
  const txResult = await query<TransactionRow>(
    `SELECT 
       mt.*,
       CASE WHEN LOWER(mt.counterparty_username) = ANY($4::text[]) THEN true ELSE mt.counterparty_in_community END as is_intra
     FROM member_transactions mt
     WHERE mt.community_id = $1 
       AND mt.tx_created_at >= $2 
       AND mt.tx_created_at <= $3
     ORDER BY mt.tx_created_at DESC`,
    [communityId, periodStart, periodEnd, memberUsernames],
  )

  const transactions = txResult.rows

  if (transactions.length === 0) {
    return {
      transaction_count: 0,
      total_volume_sats: 0,
      intra_community_count: 0,
      intra_volume_sats: 0,
      unique_members: 0,
      closed_loop_ratio: 0,
      velocity: 0,
      avg_tx_size: 0,
    }
  }

  // Calculate metrics
  const uniqueMembers = new Set(transactions.map((tx) => tx.consent_id))
  const totalVolume = transactions.reduce(
    (sum, tx) => sum + Number(tx.settlement_amount || 0),
    0,
  )

  // Count intra-community transactions
  const intraCommunityTxs = transactions.filter((tx) => {
    if (tx.counterparty_in_community) return true
    if (!tx.counterparty_username) return false
    return memberSet.has(tx.counterparty_username.toLowerCase())
  })

  const intraVolume = intraCommunityTxs.reduce(
    (sum, tx) => sum + Number(tx.settlement_amount || 0),
    0,
  )

  const closedLoopRatio =
    transactions.length > 0
      ? Math.round((intraCommunityTxs.length / transactions.length) * 100)
      : 0

  const velocity =
    uniqueMembers.size > 0 ? Math.round(transactions.length / uniqueMembers.size) : 0

  const avgTxSize =
    transactions.length > 0 ? Math.round(totalVolume / transactions.length) : 0

  return {
    transaction_count: transactions.length,
    total_volume_sats: totalVolume,
    intra_community_count: intraCommunityTxs.length,
    intra_volume_sats: intraVolume,
    unique_members: uniqueMembers.size,
    closed_loop_ratio: closedLoopRatio,
    velocity: velocity,
    avg_tx_size: avgTxSize,
  }
}

/**
 * Get data coverage (oldest and newest transaction dates) for a community
 */
export async function getDataCoverage(
  communityId: string | number,
): Promise<DataCoverage> {
  const result = await query<DataCoverageRow>(
    `SELECT 
       MIN(tx_created_at) as oldest,
       MAX(tx_created_at) as newest,
       COUNT(*) as total_transactions
     FROM member_transactions
     WHERE community_id = $1`,
    [communityId],
  )

  const row = result.rows[0]
  return {
    oldest: row.oldest ? row.oldest.toISOString() : null,
    newest: row.newest ? row.newest.toISOString() : null,
    total_transactions: parseInt(String(row.total_transactions || 0), 10),
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get date range for a period type
 */
export function getDateRange(period: string): DateRange {
  const now = new Date()
  let start: Date
  let end: Date
  let label: string

  switch (period) {
    case "current_week": {
      const dayOfWeek = now.getDay()
      start = new Date(now)
      start.setDate(now.getDate() - dayOfWeek)
      start.setHours(0, 0, 0, 0)
      end = new Date(now)
      label = "This Week"
      break
    }
    case "last_week": {
      const dayOfWeek = now.getDay()
      start = new Date(now)
      start.setDate(now.getDate() - dayOfWeek - 7)
      start.setHours(0, 0, 0, 0)
      end = new Date(start)
      end.setDate(start.getDate() + 6)
      end.setHours(23, 59, 59, 999)
      label = "Last Week"
      break
    }
    case "current_month": {
      start = new Date(now.getFullYear(), now.getMonth(), 1)
      end = new Date(now)
      label = now.toLocaleString("default", { month: "long", year: "numeric" })
      break
    }
    case "last_month": {
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
      label = new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleString(
        "default",
        { month: "long", year: "numeric" },
      )
      break
    }
    case "all":
    default: {
      start = new Date(2020, 0, 1) // Far in the past
      end = new Date(now)
      label = "All Time"
      break
    }
  }

  return { start, end, label }
}

/**
 * Get member count for a community (approved members)
 */
export async function getMemberCount(communityId: string | number): Promise<number> {
  const result = await query<CountRow>(
    `SELECT COUNT(*) as count FROM community_memberships 
     WHERE community_id = $1 AND status = 'approved'`,
    [communityId],
  )
  return parseInt(String(result.rows[0]?.count || 0), 10)
}

/**
 * Get count of members who have given data sharing consent
 */
export async function getConsentCount(communityId: string | number): Promise<number> {
  const result = await query<CountRow>(
    `SELECT COUNT(*) as count FROM data_sharing_consents 
     WHERE community_id = $1 AND consent_given = true`,
    [communityId],
  )
  return parseInt(String(result.rows[0]?.count || 0), 10)
}

/**
 * Get all communities with basic info for heatmap/leaderboard
 */
export async function getAllCommunities(): Promise<CommunityRow[]> {
  const result = await query<CommunityRow>(
    `SELECT 
       id, name, slug, 
       country_code, region, city, 
       latitude, longitude,
       leader_npub, member_count, data_sharing_member_count
     FROM communities 
     WHERE status = 'active'
     ORDER BY member_count DESC`,
  )
  return result.rows
}

// ============================================
// MILESTONE OPERATIONS
// ============================================

export async function checkAndRecordMilestone(
  communityId: string | number,
  milestoneType: string,
  value: number | string,
): Promise<MilestoneRow | undefined> {
  const result = await query<MilestoneRow>(
    `INSERT INTO community_milestones (community_id, milestone_type, milestone_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (community_id, milestone_type) DO NOTHING
     RETURNING *`,
    [communityId, milestoneType, value],
  )
  return result.rows[0]
}

export async function getCommunityMilestones(
  communityId: string | number,
): Promise<MilestoneRow[]> {
  const result = await query<MilestoneRow>(
    `SELECT * FROM community_milestones 
     WHERE community_id = $1 
     ORDER BY achieved_at DESC`,
    [communityId],
  )
  return result.rows
}

// ============================================
// BALANCE SNAPSHOT OPERATIONS
// For Bitcoin Preference metric
// ============================================

/**
 * Insert or update a balance snapshot for a member
 * Only one snapshot per day per consent is stored
 */
export async function insertBalanceSnapshot(
  consentId: string | number,
  communityId: string | number,
  btcBalanceSats: number,
  stablesatsBalanceSats: number,
): Promise<BalanceSnapshotRow> {
  const result = await query<BalanceSnapshotRow>(
    `INSERT INTO member_balance_snapshots 
     (consent_id, community_id, btc_balance_sats, stablesats_balance_sats, snapshot_date)
     VALUES ($1, $2, $3, $4, CURRENT_DATE)
     ON CONFLICT (consent_id, snapshot_date) 
     DO UPDATE SET 
       btc_balance_sats = EXCLUDED.btc_balance_sats,
       stablesats_balance_sats = EXCLUDED.stablesats_balance_sats,
       created_at = NOW()
     RETURNING *`,
    [consentId, communityId, btcBalanceSats, stablesatsBalanceSats],
  )
  return result.rows[0]
}

/**
 * Get the latest balance snapshot for a member
 */
export async function getLatestBalanceSnapshot(
  consentId: string | number,
): Promise<BalanceSnapshotRow | null> {
  const result = await query<BalanceSnapshotRow>(
    `SELECT * FROM member_balance_snapshots 
     WHERE consent_id = $1 
     ORDER BY snapshot_date DESC 
     LIMIT 1`,
    [consentId],
  )
  return result.rows[0] || null
}

/**
 * Calculate Bitcoin Preference for a community
 * Returns the weighted average of BTC vs StableSats holdings
 */
export async function getCommunityBitcoinPreference(
  communityId: string | number,
  asOfDate: Date = new Date(),
): Promise<BitcoinPreference> {
  const dateStr = asOfDate.toISOString().split("T")[0]

  const result = await query<BtcPreferenceFunctionRow>(
    `SELECT * FROM calculate_community_btc_preference($1, $2::date)`,
    [communityId, dateStr],
  )

  if (result.rows.length === 0) {
    return {
      community_id: communityId,
      btc_preference_pct: null,
      total_btc_sats: 0,
      total_stablesats_sats: 0,
      total_balance_sats: 0,
      member_count: 0,
      members_with_balance: 0,
      has_data: false,
    }
  }

  const row = result.rows[0]
  return {
    community_id: communityId,
    btc_preference_pct: parseFloat(row.btc_preference_pct ?? "") || null,
    total_btc_sats: parseInt(String(row.total_btc_sats), 10) || 0,
    total_stablesats_sats: parseInt(String(row.total_stablesats_sats), 10) || 0,
    total_balance_sats: parseInt(String(row.total_balance_sats), 10) || 0,
    member_count: parseInt(String(row.member_count), 10) || 0,
    members_with_balance: parseInt(String(row.members_with_balance), 10) || 0,
    has_data: (parseInt(String(row.member_count), 10) || 0) > 0,
  }
}

/**
 * Get Bitcoin Preference history for trending/charts
 */
export async function getBitcoinPreferenceHistory(
  communityId: string | number,
  days: number = 30,
): Promise<BalanceHistoryRow[]> {
  const result = await query<BalanceHistoryRow>(
    `SELECT 
       snapshot_date,
       SUM(btc_balance_sats) as total_btc_sats,
       SUM(stablesats_balance_sats) as total_stablesats_sats,
       SUM(total_balance_sats) as total_balance_sats,
       CASE 
         WHEN SUM(total_balance_sats) = 0 THEN 50.00
         ELSE ROUND((SUM(btc_balance_sats)::decimal / SUM(total_balance_sats)::decimal) * 100, 2)
       END as btc_preference_pct,
       COUNT(DISTINCT consent_id) as member_count
     FROM member_balance_snapshots
     WHERE community_id = $1
       AND snapshot_date >= CURRENT_DATE - $2::int
     GROUP BY snapshot_date
     ORDER BY snapshot_date DESC`,
    [communityId, days],
  )
  return result.rows
}
