/**
 * Boltcard Store - PostgreSQL-backed storage for Boltcard registrations
 *
 * Implements spec-compliant Boltcard management per:
 * https://github.com/boltcard/boltcard/blob/main/docs/DETERMINISTIC.md
 *
 * Storage Interface Contract:
 * - Issuer Key Management (per user)
 * - Pending Registration Management (deeplink flow)
 * - Card CRUD with spec-compliant key derivation
 * - Privacy-preserving card_id_hash
 * - Version rotation on re-program
 *
 * @module lib/boltcard/store
 */

import crypto from "crypto"

import type { QueryResult, QueryResultRow } from "pg"

import AuthManager from "../auth"
import { getClient, getSharedPool } from "../db"

import * as boltcardCrypto from "./crypto"

// ==========================================================================
// Interfaces & Types
// ==========================================================================

/** A raw row from the database, used by _rowToCard and similar converters */
interface DbRow extends QueryResultRow {
  [column: string]: unknown
}

/** The shape of a card object returned by the store */
export interface BoltcardData {
  id: string
  cardUid: string
  cardIdHash: string
  name: string | null
  ownerPubkey: string
  walletId: string
  walletCurrency: string
  version: number
  lastCounter: number
  balance: number
  maxTxAmount: number | null
  dailyLimit: number | null
  dailySpent: number
  dailyResetAt: number | null
  status: string
  createdAt: number
  activatedAt: number | null
  lastUsedAt: number | null
  disabledAt: number | null
  environment: string
  // Keys — only present when includeKeys is true
  apiKey?: string | null
  k0?: string | null
  k1?: string | null
  k2?: string | null
  k3?: string | null
  k4?: string | null
}

/** Data required to create a card */
export interface CardCreateData {
  cardUid: string
  ownerPubkey: string
  walletId: string
  apiKey: string
}

/** Optional settings when creating a card */
export interface CardCreateOptions {
  name?: string | null
  walletCurrency?: string
  maxTxAmount?: number | null
  dailyLimit?: number | null
  initialBalance?: number
  environment?: string
}

/** Data required to create a pending registration */
export interface PendingRegistrationData {
  ownerPubkey: string
  walletId: string
  apiKey: string
}

/** Optional settings when creating a pending registration */
export interface PendingRegistrationOptions {
  name?: string | null
  walletCurrency?: string
  maxTxAmount?: number | null
  dailyLimit?: number | null
  initialBalance?: number
  environment?: string
  expiresIn?: number
}

/** A pending registration object returned from the store */
export interface PendingRegistrationRecord {
  id: string
  ownerPubkey: string
  walletId: string
  walletCurrency: string
  apiKey?: string | null
  name: string | null
  maxTxAmount: number | null
  dailyLimit: number | null
  initialBalance: number
  environment: string
  status: string
  createdAt: number
  expiresAt: number
  completedAt?: number | null
  cardId?: string | null
}

/** A summary of a pending registration (list view) */
export interface PendingRegistrationSummary {
  id: string
  name: string | null
  walletCurrency: string
  initialBalance: number
  status: string
  createdAt: number
  expiresAt: number
}

/** Data for recording a transaction */
export interface TransactionData {
  type: string
  amount: number
  balanceAfter: number
  paymentHash?: string | null
  description?: string | null
}

/** A transaction record from the store */
export interface TransactionRecord {
  id: number
  cardId: string
  type: string
  amount: number
  balanceAfter: number
  paymentHash: string | null
  description: string | null
  createdAt: number
}

/** A pending top-up record */
export interface PendingTopUp {
  paymentHash: string
  cardId: string
  amount: number
  currency: string
  createdAt: number
  expiresAt: number
}

/** Store-wide statistics */
export interface StoreStats {
  total: number
  pending: number
  active: number
  disabled: number
  wiped: number
  btcCards: number
  usdCards: number
  totalBtcBalanceSats: number
  totalUsdBalanceCents: number
  issuerKeys: number
  pendingRegistrations: number
}

/** Result from incrementDailySpent */
export interface IncrementResult {
  success: boolean
  balance?: number
  dailySpent?: number
  /** The daily window (next reset) the deduction belongs to. */
  dailyResetAt?: number | null
  error?: string
}

/** Result from topUpCard */
export interface TopUpResult {
  success: boolean
  balance?: number
  transaction?: TransactionRecord | null
  error?: string
}

/** Derived keys returned from deriveKeysForCard */
export interface DerivedKeysResult {
  k0: string
  k1: string
  k2: string
  k3: string
  k4: string
}

// ==========================================================================
// Constants
// ==========================================================================

/**
 * Boltcard status constants
 */
const CardStatus = {
  PENDING: "PENDING", // Card registered but not yet programmed
  ACTIVE: "ACTIVE", // Card is active and can be used
  DISABLED: "DISABLED", // Card temporarily disabled
  WIPED: "WIPED", // Card wiped/deleted
} as const

/**
 * Transaction type constants
 */
const TxType = {
  WITHDRAW: "WITHDRAW", // Card tap to pay (spend)
  TOPUP: "TOPUP", // Top-up via LNURL-pay
  ADJUST: "ADJUST", // Manual balance adjustment
} as const

/**
 * Pending registration status constants
 */
const PendingStatus = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
} as const

// Default registration expiry (15 minutes)
const REGISTRATION_EXPIRY_MS: number = 15 * 60 * 1000

/** Lifetime of a tap-bound LNURL-withdraw session (k1). */
const WITHDRAW_SESSION_TTL_MS: number = 5 * 60 * 1000

const sha256Hex = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex")

/** Thrown when a newly minted / reprogrammed card could not be activated. */
const CARD_ACTIVATION_FAILED = "Failed to activate card"

/**
 * Owner pubkeys are stored and looked up lowercase (hex), matching the Nostr
 * session; migration 023 normalizes legacy rows.
 */
const normalizeOwnerPubkey = (pubkey: string): string =>
  typeof pubkey === "string" ? pubkey.toLowerCase() : pubkey

// ==========================================================================
// Database connection pool (delegates to shared pool)
// ==========================================================================

let pool: ReturnType<typeof getSharedPool> | null = null

function getPool() {
  if (!pool) {
    pool = getSharedPool()
  }
  return pool
}

/**
 * Execute a query with parameters
 */
async function query(text: string, params?: unknown[]): Promise<QueryResult<DbRow>> {
  const start: number = Date.now()
  const result: QueryResult<DbRow> = await getPool().query(text, params)
  const duration: number = Date.now() - start

  if (duration > 1000) {
    console.warn(`[BoltcardStore] Slow query (${duration}ms):`, text.substring(0, 100))
  }

  return result
}

// ==========================================================================
// BoltcardStore class
// ==========================================================================

class BoltcardStore {
  lastCleanup: number
  CLEANUP_INTERVAL_MS: number

  constructor() {
    // Lazy cleanup flag
    this.lastCleanup = 0
    this.CLEANUP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
  }

  /**
   * Run lazy cleanup - reset daily limits for expired cards
   */
  async lazyCleanup(): Promise<void> {
    const now: number = Date.now()
    if (now - this.lastCleanup < this.CLEANUP_INTERVAL_MS) {
      return
    }

    this.lastCleanup = now

    try {
      // Reset daily limits
      const dailyResult: QueryResult<DbRow> = await query(
        `SELECT reset_boltcard_daily_limits()`,
      )
      const resetCount: number =
        (dailyResult.rows[0]?.reset_boltcard_daily_limits as number) || 0

      if (resetCount > 0) {
        console.log(
          `[BoltcardStore] Lazy cleanup: reset daily limits for ${resetCount} card(s)`,
        )
      }

      // Cleanup expired pending registrations
      const expiredResult: QueryResult<DbRow> = await query(
        `SELECT cleanup_expired_boltcard_registrations()`,
      )
      const expiredCount: number =
        (expiredResult.rows[0]?.cleanup_expired_boltcard_registrations as number) || 0

      if (expiredCount > 0) {
        console.log(
          `[BoltcardStore] Lazy cleanup: expired ${expiredCount} pending registration(s)`,
        )
      }

      // Drop withdraw sessions a day after expiry
      await query(`DELETE FROM boltcard_withdraw_sessions WHERE expires_at < $1`, [
        now - 24 * 60 * 60 * 1000,
      ])
    } catch (err: unknown) {
      console.error("[BoltcardStore] Lazy cleanup error:", (err as Error).message)
    }
  }

  /**
   * Generate a unique ID (32-character hex string)
   */
  generateId(): string {
    return crypto.randomBytes(16).toString("hex")
  }

  // Alias for backwards compatibility
  generateCardId(): string {
    return this.generateId()
  }

  // ==========================================================================
  // ISSUER KEY MANAGEMENT
  // ==========================================================================

  /**
   * Get or create IssuerKey for a user
   * Each user has exactly one IssuerKey used to derive all their card keys
   */
  async getOrCreateIssuerKey(rawOwnerPubkey: string): Promise<string> {
    const ownerPubkey: string = normalizeOwnerPubkey(rawOwnerPubkey)
    if (!/^[0-9a-f]{64}$/.test(ownerPubkey)) {
      throw new Error("Invalid owner pubkey format")
    }

    try {
      // Try to get existing key
      const existing: QueryResult<DbRow> = await query(
        `SELECT issuer_key_encrypted FROM boltcard_issuer_keys WHERE owner_pubkey = $1`,
        [ownerPubkey],
      )

      if (existing.rows.length > 0) {
        // Update last_used_at
        await query(
          `UPDATE boltcard_issuer_keys SET last_used_at = $2 WHERE owner_pubkey = $1`,
          [ownerPubkey, Date.now()],
        )
        return AuthManager.decryptApiKey(
          existing.rows[0].issuer_key_encrypted as string,
        ) as string
      }

      // Create new IssuerKey
      const issuerKey: string = boltcardCrypto.generateIssuerKey()
      const issuerKeyEncrypted: string = AuthManager.encryptApiKey(issuerKey)
      const now: number = Date.now()

      await query(
        `INSERT INTO boltcard_issuer_keys (owner_pubkey, issuer_key_encrypted, created_at, last_used_at)
         VALUES ($1, $2, $3, $3)`,
        [ownerPubkey, issuerKeyEncrypted, now],
      )

      console.log(
        `[BoltcardStore] Created new IssuerKey for owner: ${ownerPubkey.substring(0, 8)}...`,
      )
      return issuerKey
    } catch (err: unknown) {
      // Handle race condition - another process may have created the key
      if ((err as Record<string, unknown>).code === "23505") {
        // Unique constraint violation
        const existing: QueryResult<DbRow> = await query(
          `SELECT issuer_key_encrypted FROM boltcard_issuer_keys WHERE owner_pubkey = $1`,
          [ownerPubkey],
        )
        if (existing.rows.length > 0) {
          return AuthManager.decryptApiKey(
            existing.rows[0].issuer_key_encrypted as string,
          ) as string
        }
      }
      console.error("[BoltcardStore] getOrCreateIssuerKey error:", (err as Error).message)
      throw err
    }
  }

  /**
   * Get IssuerKey for a user (returns null if not found)
   */
  async getIssuerKey(rawOwnerPubkey: string): Promise<string | null> {
    const ownerPubkey: string = normalizeOwnerPubkey(rawOwnerPubkey)
    try {
      const result: QueryResult<DbRow> = await query(
        `SELECT issuer_key_encrypted FROM boltcard_issuer_keys WHERE owner_pubkey = $1`,
        [ownerPubkey],
      )

      if (result.rows.length === 0) {
        return null
      }

      return AuthManager.decryptApiKey(result.rows[0].issuer_key_encrypted as string)
    } catch (err: unknown) {
      console.error("[BoltcardStore] getIssuerKey error:", (err as Error).message)
      return null
    }
  }

  // ==========================================================================
  // PENDING REGISTRATION MANAGEMENT (Deeplink Flow)
  // ==========================================================================

  /**
   * Create a pending card registration
   * Used with deeplink flow where card UID is not known until programming
   */
  async createPendingRegistration(
    data: PendingRegistrationData,
    options: PendingRegistrationOptions = {},
  ): Promise<PendingRegistrationRecord> {
    const { walletId, apiKey } = data
    const ownerPubkey: string = normalizeOwnerPubkey(data.ownerPubkey)

    if (!ownerPubkey || !walletId || !apiKey) {
      throw new Error("Missing required fields: ownerPubkey, walletId, apiKey")
    }

    const id: string = this.generateId()
    const now: number = Date.now()
    const expiresAt: number = now + (options.expiresIn || REGISTRATION_EXPIRY_MS)

    const apiKeyEncrypted: string = AuthManager.encryptApiKey(apiKey)

    try {
      const result: QueryResult<DbRow> = await query(
        `INSERT INTO boltcard_pending_registrations
         (id, owner_pubkey, wallet_id, wallet_currency, api_key_encrypted,
          name, max_tx_amount, daily_limit, initial_balance,
          environment, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          id,
          ownerPubkey,
          walletId,
          options.walletCurrency || "BTC",
          apiKeyEncrypted,
          options.name || null,
          options.maxTxAmount || null,
          options.dailyLimit || null,
          options.initialBalance || 0,
          options.environment || "production",
          PendingStatus.PENDING,
          now,
          expiresAt,
        ],
      )

      console.log(
        `[BoltcardStore] Created pending registration for ${ownerPubkey.substring(0, 8)}...`,
      )

      const row: DbRow = result.rows[0]
      return {
        id: row.id as string,
        ownerPubkey: row.owner_pubkey as string,
        walletId: row.wallet_id as string,
        walletCurrency: row.wallet_currency as string,
        name: row.name as string | null,
        maxTxAmount: row.max_tx_amount ? parseInt(row.max_tx_amount as string, 10) : null,
        dailyLimit: row.daily_limit ? parseInt(row.daily_limit as string, 10) : null,
        initialBalance: parseInt(row.initial_balance as string, 10),
        environment: row.environment as string,
        status: row.status as string,
        createdAt: parseInt(row.created_at as string, 10),
        expiresAt: parseInt(row.expires_at as string, 10),
      }
    } catch (err: unknown) {
      console.error(
        "[BoltcardStore] createPendingRegistration error:",
        (err as Error).message,
      )
      throw err
    }
  }

  /**
   * Get a pending registration by ID
   */
  async getPendingRegistration(id: string): Promise<PendingRegistrationRecord | null> {
    try {
      await this.lazyCleanup()

      const result: QueryResult<DbRow> = await query(
        `SELECT * FROM boltcard_pending_registrations WHERE id = $1`,
        [id],
      )

      if (result.rows.length === 0) {
        return null
      }

      const row: DbRow = result.rows[0]
      return {
        id: row.id as string,
        ownerPubkey: row.owner_pubkey as string,
        walletId: row.wallet_id as string,
        walletCurrency: row.wallet_currency as string,
        apiKey: AuthManager.decryptApiKey(row.api_key_encrypted as string),
        name: row.name as string | null,
        maxTxAmount: row.max_tx_amount ? parseInt(row.max_tx_amount as string, 10) : null,
        dailyLimit: row.daily_limit ? parseInt(row.daily_limit as string, 10) : null,
        initialBalance: parseInt(row.initial_balance as string, 10),
        environment: row.environment as string,
        status: row.status as string,
        createdAt: parseInt(row.created_at as string, 10),
        expiresAt: parseInt(row.expires_at as string, 10),
        completedAt: row.completed_at ? parseInt(row.completed_at as string, 10) : null,
        cardId: row.card_id as string | null,
      }
    } catch (err: unknown) {
      console.error(
        "[BoltcardStore] getPendingRegistration error:",
        (err as Error).message,
      )
      return null
    }
  }

  /**
   * Complete a pending registration by creating the actual card
   * Called when NFC Programmer app sends the UID
   */
  async completePendingRegistration(
    registrationId: string,
    cardUid: string,
  ): Promise<BoltcardData | null> {
    // Validate UID format
    if (!/^[0-9a-fA-F]{14}$/.test(cardUid)) {
      throw new Error("Invalid card UID format: expected 14 hex characters")
    }

    const registration: PendingRegistrationRecord | null =
      await this.getPendingRegistration(registrationId)

    if (!registration) {
      throw new Error("Registration not found")
    }

    if (registration.status !== PendingStatus.PENDING) {
      throw new Error(`Registration is not pending: ${registration.status}`)
    }

    if (registration.expiresAt < Date.now()) {
      throw new Error("Registration has expired")
    }

    // Atomically claim the registration: the keys link is single-use, so two
    // concurrent requests can never both mint a card (and keys) from it.
    const claimedAt: number = Date.now()
    const claim: QueryResult<DbRow> = await query(
      `UPDATE boltcard_pending_registrations
       SET status = $2, completed_at = $3
       WHERE id = $1 AND status = $4 AND expires_at > $3
       RETURNING id`,
      [registrationId, PendingStatus.COMPLETED, claimedAt, PendingStatus.PENDING],
    )
    if ((claim.rowCount ?? 0) === 0) {
      throw new Error("Registration is not pending")
    }

    // Set just before the first write (delete / reprogram / create). Until
    // then a failure provably minted nothing and the claim may be released.
    const progress = { mutated: false }
    try {
      return await this._completeClaimedRegistration(
        registrationId,
        registration,
        cardUid,
        progress,
      )
    } catch (err: unknown) {
      if (!progress.mutated) {
        // Nothing was written: release the claim so the owner can retry
        // (e.g. after tapping a card that belongs to someone else).
        await query(
          `UPDATE boltcard_pending_registrations
           SET status = $2, completed_at = NULL
           WHERE id = $1 AND card_id IS NULL AND status = $3`,
          [registrationId, PendingStatus.PENDING, PendingStatus.COMPLETED],
        ).catch(() => undefined)
      }
      // Otherwise the link stays consumed: a card may exist already.
      throw err
    }
  }

  async _completeClaimedRegistration(
    registrationId: string,
    registration: PendingRegistrationRecord,
    cardUid: string,
    progress: { mutated: boolean } = { mutated: false },
  ): Promise<BoltcardData | null> {
    // Check if card UID already exists
    const existingCard: BoltcardData | null = await this.getCardByUid(cardUid)
    if (existingCard) {
      // If card is WIPED, delete it completely to allow fresh registration
      if (existingCard.status === CardStatus.WIPED) {
        console.log(
          `[BoltcardStore] Deleting WIPED card ${existingCard.id} to allow fresh registration`,
        )
        progress.mutated = true
        await query(`DELETE FROM boltcard_transactions WHERE card_id = $1`, [
          existingCard.id,
        ])
        await query(`DELETE FROM boltcard_pending_topups WHERE card_id = $1`, [
          existingCard.id,
        ])
        await query(`DELETE FROM boltcards WHERE id = $1`, [existingCard.id])
        // Fall through to create new card below
      } else if (
        normalizeOwnerPubkey(existingCard.ownerPubkey) ===
        normalizeOwnerPubkey(registration.ownerPubkey)
      ) {
        // Same owner, active card - this is a re-program, increment version
        progress.mutated = true
        const updated: BoltcardData | null = await this.reprogramCard(
          existingCard.id,
          cardUid,
        )
        if (updated) {
          // reprogramCard resets the card to PENDING: re-activate (the NFC
          // Programmer app has no confirmation callback) before handing out
          // keys, and fail if that didn't persist.
          if (!(await this.activateCard(existingCard.id))) {
            throw new Error(CARD_ACTIVATION_FAILED)
          }
          // Mark registration as completed
          await query(
            `UPDATE boltcard_pending_registrations 
             SET status = $2, completed_at = $3, card_id = $4
             WHERE id = $1`,
            [registrationId, PendingStatus.COMPLETED, Date.now(), existingCard.id],
          )
          return this.getCard(existingCard.id, true)
        }
      } else {
        throw new Error(`Card with UID ${cardUid} already registered to another user`)
      }
    }

    // Create the card
    progress.mutated = true
    const card: BoltcardData | null = await this.createCard(
      {
        cardUid,
        ownerPubkey: registration.ownerPubkey,
        walletId: registration.walletId,
        apiKey: registration.apiKey as string,
      },
      {
        name: registration.name,
        walletCurrency: registration.walletCurrency,
        maxTxAmount: registration.maxTxAmount,
        dailyLimit: registration.dailyLimit,
        initialBalance: registration.initialBalance,
        environment: registration.environment,
      },
    )

    if (!card) {
      throw new Error("Failed to create card")
    }

    // Auto-activate the card since NFC Programmer app doesn't have a confirmation callback.
    // If activation didn't persist, fail WITHOUT returning keys. The card row
    // exists, so the link stays consumed; the owner recovers by starting a new
    // registration and tapping the same card (same-owner reprogram path).
    if (!(await this.activateCard(card.id))) {
      throw new Error(CARD_ACTIVATION_FAILED)
    }

    // Mark registration as completed
    await query(
      `UPDATE boltcard_pending_registrations 
       SET status = $2, completed_at = $3, card_id = $4
       WHERE id = $1`,
      [registrationId, PendingStatus.COMPLETED, Date.now(), card.id],
    )

    console.log(
      `[BoltcardStore] Completed registration -> card ${card.id} (auto-activated)`,
    )

    // Return card with keys for programming
    return this.getCard(card.id, true)
  }

  /**
   * Cancel a pending registration
   */
  async cancelPendingRegistration(id: string): Promise<boolean> {
    try {
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcard_pending_registrations 
         SET status = $2
         WHERE id = $1 AND status = 'PENDING'
         RETURNING id`,
        [id, PendingStatus.CANCELLED],
      )
      return (result.rowCount ?? 0) > 0
    } catch (err: unknown) {
      console.error(
        "[BoltcardStore] cancelPendingRegistration error:",
        (err as Error).message,
      )
      return false
    }
  }

  /**
   * Get pending registrations for an owner
   */
  async getPendingRegistrationsByOwner(
    rawOwnerPubkey: string,
  ): Promise<PendingRegistrationSummary[]> {
    const ownerPubkey: string = normalizeOwnerPubkey(rawOwnerPubkey)
    try {
      await this.lazyCleanup()

      const result: QueryResult<DbRow> = await query(
        `SELECT id, name, wallet_currency, initial_balance, status, created_at, expires_at
         FROM boltcard_pending_registrations 
         WHERE owner_pubkey = $1 AND status = 'PENDING'
         ORDER BY created_at DESC`,
        [ownerPubkey],
      )

      return result.rows.map(
        (row: DbRow): PendingRegistrationSummary => ({
          id: row.id as string,
          name: row.name as string | null,
          walletCurrency: row.wallet_currency as string,
          initialBalance: parseInt(row.initial_balance as string, 10),
          status: row.status as string,
          createdAt: parseInt(row.created_at as string, 10),
          expiresAt: parseInt(row.expires_at as string, 10),
        }),
      )
    } catch (err: unknown) {
      console.error(
        "[BoltcardStore] getPendingRegistrationsByOwner error:",
        (err as Error).message,
      )
      return []
    }
  }

  // ==========================================================================
  // CARD MANAGEMENT
  // ==========================================================================

  /**
   * Convert database row to card object
   */
  _rowToCard(
    row: DbRow | undefined | null,
    includeKeys: boolean = false,
  ): BoltcardData | null {
    if (!row) return null

    const card: BoltcardData = {
      id: row.id as string,
      cardUid: row.card_uid as string,
      cardIdHash: row.card_id_hash as string,
      name: row.name as string | null,
      ownerPubkey: row.owner_pubkey as string,
      walletId: row.wallet_id as string,
      walletCurrency: row.wallet_currency as string,
      version: parseInt(row.version as string, 10),
      lastCounter: parseInt(row.last_counter as string, 10),
      balance: parseInt(row.balance as string, 10),
      maxTxAmount: row.max_tx_amount ? parseInt(row.max_tx_amount as string, 10) : null,
      dailyLimit: row.daily_limit ? parseInt(row.daily_limit as string, 10) : null,
      dailySpent: parseInt(row.daily_spent as string, 10),
      dailyResetAt: row.daily_reset_at
        ? parseInt(row.daily_reset_at as string, 10)
        : null,
      status: row.status as string,
      createdAt: parseInt(row.created_at as string, 10),
      activatedAt: row.activated_at ? parseInt(row.activated_at as string, 10) : null,
      lastUsedAt: row.last_used_at ? parseInt(row.last_used_at as string, 10) : null,
      disabledAt: row.disabled_at ? parseInt(row.disabled_at as string, 10) : null,
      environment: (row.environment as string) || "production",
    }

    // Only include sensitive data when explicitly requested
    if (includeKeys) {
      card.apiKey = AuthManager.decryptApiKey(row.api_key_encrypted as string)
      card.k0 = AuthManager.decryptApiKey(row.k0_encrypted as string)
      card.k1 = AuthManager.decryptApiKey(row.k1_encrypted as string)
      card.k2 = AuthManager.decryptApiKey(row.k2_encrypted as string)
      card.k3 = row.k3_encrypted
        ? AuthManager.decryptApiKey(row.k3_encrypted as string)
        : null
      card.k4 = row.k4_encrypted
        ? AuthManager.decryptApiKey(row.k4_encrypted as string)
        : null
    }

    return card
  }

  /**
   * Create a new Boltcard registration with spec-compliant key derivation
   */
  async createCard(
    cardData: CardCreateData,
    options: CardCreateOptions = {},
  ): Promise<BoltcardData | null> {
    const { cardUid, walletId, apiKey } = cardData
    const ownerPubkey: string = normalizeOwnerPubkey(cardData.ownerPubkey)

    // Validate required fields
    if (!cardUid || !ownerPubkey || !walletId || !apiKey) {
      throw new Error(
        "Missing required card data: cardUid, ownerPubkey, walletId, apiKey",
      )
    }

    // Validate card UID format (14 hex chars)
    if (!/^[0-9a-fA-F]{14}$/.test(cardUid)) {
      throw new Error("Invalid card UID format: expected 14 hex characters")
    }

    // Get or create IssuerKey for this owner
    const issuerKey: string = await this.getOrCreateIssuerKey(ownerPubkey)

    // Derive all keys using spec-compliant derivation
    const version: number = 1
    const derivedKeys = boltcardCrypto.deriveAllKeys(
      issuerKey,
      cardUid.toLowerCase(),
      version,
    )

    const id: string = this.generateCardId()
    const now: number = Date.now()
    const walletCurrency: string = options.walletCurrency || "BTC"
    const environment: string = options.environment || "production"
    const initialBalance: number = options.initialBalance || 0

    // Encrypt sensitive data
    const apiKeyEncrypted: string = AuthManager.encryptApiKey(apiKey)
    const k0Encrypted: string = AuthManager.encryptApiKey(derivedKeys.k0)
    const k1Encrypted: string = AuthManager.encryptApiKey(derivedKeys.k1)
    const k2Encrypted: string = AuthManager.encryptApiKey(derivedKeys.k2)
    const k3Encrypted: string = AuthManager.encryptApiKey(derivedKeys.k3)
    const k4Encrypted: string = AuthManager.encryptApiKey(derivedKeys.k4)

    // Set up daily limit tracking
    const dailyResetAt: number | null = options.dailyLimit
      ? now + 24 * 60 * 60 * 1000
      : null

    try {
      const result: QueryResult<DbRow> = await query(
        `INSERT INTO boltcards 
         (id, card_uid, card_id_hash, name, owner_pubkey, wallet_id, wallet_currency, api_key_encrypted,
          k0_encrypted, k1_encrypted, k2_encrypted, k3_encrypted, k4_encrypted,
          version, last_counter, balance, max_tx_amount, daily_limit, daily_spent, daily_reset_at,
          status, created_at, environment)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         RETURNING *`,
        [
          id,
          cardUid.toLowerCase(),
          derivedKeys.cardIdHash,
          options.name || null,
          ownerPubkey,
          walletId,
          walletCurrency,
          apiKeyEncrypted,
          k0Encrypted,
          k1Encrypted,
          k2Encrypted,
          k3Encrypted,
          k4Encrypted,
          version,
          0,
          initialBalance,
          options.maxTxAmount || null,
          options.dailyLimit || null,
          0,
          dailyResetAt,
          CardStatus.PENDING,
          now,
          environment,
        ],
      )

      const card: BoltcardData | null = this._rowToCard(result.rows[0])

      const currencySymbol: string = walletCurrency === "USD" ? "$" : ""
      const currencyUnit: string = walletCurrency === "USD" ? "cents" : "sats"
      console.log(
        `[BoltcardStore] Created card: ${id} (UID: ${cardUid}) - ${walletCurrency}${currencySymbol}${initialBalance} ${currencyUnit}${environment !== "production" ? ` [${environment}]` : ""}`,
      )

      return card
    } catch (err: unknown) {
      if ((err as Record<string, unknown>).code === "23505") {
        // Unique constraint violation
        throw new Error(`Card with UID ${cardUid} already exists`)
      }
      console.error("[BoltcardStore] createCard error:", (err as Error).message)
      throw err
    }
  }

  /**
   * Re-program an existing card (increment version, derive new keys)
   * Used when a card is programmed again (e.g., after reset)
   */
  async reprogramCard(cardId: string, cardUid: string): Promise<BoltcardData | null> {
    const card: BoltcardData | null = await this.getCard(cardId, true)

    if (!card) {
      throw new Error("Card not found")
    }

    if (card.cardUid.toLowerCase() !== cardUid.toLowerCase()) {
      throw new Error("Card UID mismatch")
    }

    // Get IssuerKey
    const issuerKey: string | null = await this.getIssuerKey(card.ownerPubkey)
    if (!issuerKey) {
      throw new Error("IssuerKey not found for owner")
    }

    // Increment version and derive new keys
    const newVersion: number = card.version + 1
    const derivedKeys = boltcardCrypto.deriveAllKeys(
      issuerKey,
      cardUid.toLowerCase(),
      newVersion,
    )

    // Encrypt new keys
    const k0Encrypted: string = AuthManager.encryptApiKey(derivedKeys.k0)
    const k1Encrypted: string = AuthManager.encryptApiKey(derivedKeys.k1)
    const k2Encrypted: string = AuthManager.encryptApiKey(derivedKeys.k2)
    const k3Encrypted: string = AuthManager.encryptApiKey(derivedKeys.k3)
    const k4Encrypted: string = AuthManager.encryptApiKey(derivedKeys.k4)

    try {
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards 
         SET version = $2, 
             k0_encrypted = $3, k1_encrypted = $4, k2_encrypted = $5, 
             k3_encrypted = $6, k4_encrypted = $7,
             last_counter = 0,
             status = 'PENDING'
         WHERE id = $1
         RETURNING *`,
        [
          cardId,
          newVersion,
          k0Encrypted,
          k1Encrypted,
          k2Encrypted,
          k3Encrypted,
          k4Encrypted,
        ],
      )

      if ((result.rowCount ?? 0) === 0) {
        return null
      }

      console.log(
        `[BoltcardStore] Re-programmed card ${cardId}: version ${card.version} -> ${newVersion}`,
      )
      return this._rowToCard(result.rows[0], true)
    } catch (err: unknown) {
      console.error("[BoltcardStore] reprogramCard error:", (err as Error).message)
      throw err
    }
  }

  /**
   * Get card by ID
   */
  async getCard(
    cardId: string,
    includeKeys: boolean = false,
  ): Promise<BoltcardData | null> {
    try {
      await this.lazyCleanup()

      const result: QueryResult<DbRow> = await query(
        `SELECT * FROM boltcards WHERE id = $1`,
        [cardId],
      )

      if (result.rows.length === 0) {
        return null
      }

      return this._rowToCard(result.rows[0], includeKeys)
    } catch (err: unknown) {
      console.error("[BoltcardStore] getCard error:", (err as Error).message)
      return null
    }
  }

  /**
   * Get card by UID (for LNURL-withdraw lookups)
   */
  async getCardByUid(
    cardUid: string,
    includeKeys: boolean = false,
  ): Promise<BoltcardData | null> {
    try {
      await this.lazyCleanup()

      const result: QueryResult<DbRow> = await query(
        `SELECT * FROM boltcards WHERE card_uid = $1`,
        [cardUid.toLowerCase()],
      )

      if (result.rows.length === 0) {
        return null
      }

      return this._rowToCard(result.rows[0], includeKeys)
    } catch (err: unknown) {
      console.error("[BoltcardStore] getCardByUid error:", (err as Error).message)
      return null
    }
  }

  /**
   * Get card by privacy-preserving ID hash
   */
  async getCardByIdHash(
    cardIdHash: string,
    includeKeys: boolean = false,
  ): Promise<BoltcardData | null> {
    try {
      await this.lazyCleanup()

      const result: QueryResult<DbRow> = await query(
        `SELECT * FROM boltcards WHERE card_id_hash = $1`,
        [cardIdHash.toLowerCase()],
      )

      if (result.rows.length === 0) {
        return null
      }

      return this._rowToCard(result.rows[0], includeKeys)
    } catch (err: unknown) {
      console.error("[BoltcardStore] getCardByIdHash error:", (err as Error).message)
      return null
    }
  }

  /**
   * Get all cards for an owner
   */
  async getCardsByOwner(rawOwnerPubkey: string): Promise<BoltcardData[]> {
    const ownerPubkey: string = normalizeOwnerPubkey(rawOwnerPubkey)
    try {
      await this.lazyCleanup()

      const result: QueryResult<DbRow> = await query(
        `SELECT * FROM boltcards 
         WHERE owner_pubkey = $1 
         ORDER BY created_at DESC`,
        [ownerPubkey],
      )

      return result.rows.map(
        (row: DbRow): BoltcardData => this._rowToCard(row) as BoltcardData,
      )
    } catch (err: unknown) {
      console.error("[BoltcardStore] getCardsByOwner error:", (err as Error).message)
      return []
    }
  }

  /**
   * Derive keys for a card (for keysRequest endpoint)
   */
  async deriveKeysForCard(
    cardId: string,
    cardUid: string,
  ): Promise<DerivedKeysResult | null> {
    const card: BoltcardData | null = await this.getCard(cardId)

    if (!card) {
      return null
    }

    // Verify UID matches if provided
    if (cardUid && card.cardUid.toLowerCase() !== cardUid.toLowerCase()) {
      console.warn(
        `[BoltcardStore] UID mismatch for card ${cardId}: expected ${card.cardUid}, got ${cardUid}`,
      )
      return null
    }

    // Get IssuerKey
    const issuerKey: string | null = await this.getIssuerKey(card.ownerPubkey)
    if (!issuerKey) {
      console.error(`[BoltcardStore] IssuerKey not found for card ${cardId}`)
      return null
    }

    // Derive keys
    const keys = boltcardCrypto.deriveAllKeys(issuerKey, card.cardUid, card.version)

    return {
      k0: keys.k0,
      k1: keys.k1,
      k2: keys.k2,
      k3: keys.k3,
      k4: keys.k4,
    }
  }

  /**
   * Update card fields
   */
  async updateCard(cardId: string, updates: Record<string, unknown>): Promise<boolean> {
    const allowedFields: string[] = ["name", "max_tx_amount", "daily_limit"]
    const setClauses: string[] = []
    const values: unknown[] = [cardId]
    let paramIndex: number = 2

    for (const [key, value] of Object.entries(updates)) {
      const dbKey: string = key.replace(/([A-Z])/g, "_$1").toLowerCase()
      if (allowedFields.includes(dbKey)) {
        setClauses.push(`${dbKey} = $${paramIndex}`)
        values.push(value)
        paramIndex++
      }
    }

    if (setClauses.length === 0) {
      return false
    }

    try {
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards SET ${setClauses.join(", ")} WHERE id = $1 RETURNING id`,
        values,
      )

      return (result.rowCount ?? 0) > 0
    } catch (err: unknown) {
      console.error("[BoltcardStore] updateCard error:", (err as Error).message)
      return false
    }
  }

  /**
   * Update card balance (atomic operation)
   */
  async updateCardBalance(cardId: string, newBalance: number): Promise<boolean> {
    try {
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards SET balance = $2 WHERE id = $1 AND status = 'ACTIVE' RETURNING id`,
        [cardId, newBalance],
      )

      if ((result.rowCount ?? 0) > 0) {
        console.log(`[BoltcardStore] Updated balance for card ${cardId}: ${newBalance}`)
        return true
      }
      return false
    } catch (err: unknown) {
      console.error("[BoltcardStore] updateCardBalance error:", (err as Error).message)
      return false
    }
  }

  /**
   * Record a transaction for a card
   */
  async recordTransaction(
    cardId: string,
    txData: TransactionData,
  ): Promise<TransactionRecord | null> {
    const { type, amount, balanceAfter, paymentHash, description } = txData

    if (!Object.values(TxType).includes(type as (typeof TxType)[keyof typeof TxType])) {
      console.error(`[BoltcardStore] Invalid transaction type: ${type}`)
      return null
    }

    const now: number = Date.now()

    try {
      const result: QueryResult<DbRow> = await query(
        `INSERT INTO boltcard_transactions 
         (card_id, tx_type, amount, balance_after, payment_hash, description, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          cardId,
          type,
          amount,
          balanceAfter,
          paymentHash || null,
          description || null,
          now,
        ],
      )

      const row: DbRow = result.rows[0]
      console.log(
        `[BoltcardStore] Recorded ${type} transaction for card ${cardId}: ${amount} (balance: ${balanceAfter})`,
      )

      return {
        id: row.id as number,
        cardId: row.card_id as string,
        type: row.tx_type as string,
        amount: parseInt(row.amount as string, 10),
        balanceAfter: parseInt(row.balance_after as string, 10),
        paymentHash: row.payment_hash as string | null,
        description: row.description as string | null,
        createdAt: parseInt(row.created_at as string, 10),
      }
    } catch (err: unknown) {
      console.error("[BoltcardStore] recordTransaction error:", (err as Error).message)
      return null
    }
  }

  /**
   * Get transactions for a card
   */
  _rowToTransaction(row: DbRow): TransactionRecord {
    return {
      id: row.id as number,
      cardId: row.card_id as string,
      type: row.tx_type as string,
      amount: parseInt(row.amount as string, 10),
      balanceAfter: parseInt(row.balance_after as string, 10),
      paymentHash: row.payment_hash as string | null,
      description: row.description as string | null,
      createdAt: parseInt(row.created_at as string, 10),
    }
  }

  async getCardTransactions(
    cardId: string,
    limit: number = 50,
  ): Promise<TransactionRecord[]> {
    try {
      const result: QueryResult<DbRow> = await query(
        `SELECT * FROM boltcard_transactions 
         WHERE card_id = $1 
         ORDER BY created_at DESC 
         LIMIT $2`,
        [cardId, limit],
      )

      return result.rows.map(
        (row: DbRow): TransactionRecord => ({
          id: row.id as number,
          cardId: row.card_id as string,
          type: row.tx_type as string,
          amount: parseInt(row.amount as string, 10),
          balanceAfter: parseInt(row.balance_after as string, 10),
          paymentHash: row.payment_hash as string | null,
          description: row.description as string | null,
          createdAt: parseInt(row.created_at as string, 10),
        }),
      )
    } catch (err: unknown) {
      console.error("[BoltcardStore] getCardTransactions error:", (err as Error).message)
      return []
    }
  }

  /**
   * Increment daily spent amount (atomic operation with balance deduction)
   */
  async incrementDailySpent(cardId: string, amount: number): Promise<IncrementResult> {
    try {
      const now: number = Date.now()

      const card: BoltcardData | null = await this.getCard(cardId)
      if (!card) {
        return { success: false, error: "Card not found" }
      }

      if (card.status !== CardStatus.ACTIVE) {
        return { success: false, error: "Card is not active" }
      }

      // Reset, limit validation, balance deduction and daily-spent increment
      // in ONE conditional statement: checks and mutation see the same row,
      // so concurrent withdrawals can never jointly exceed the daily limit.
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards
         SET balance = balance - $2,
             daily_spent = CASE
               WHEN daily_reset_at IS NOT NULL AND daily_reset_at < $3 THEN $2
               ELSE daily_spent + $2
             END,
             daily_reset_at = CASE
               WHEN daily_reset_at IS NOT NULL AND daily_reset_at < $3 THEN $4
               ELSE daily_reset_at
             END,
             last_used_at = $3
         WHERE id = $1
           AND status = 'ACTIVE'
           AND balance >= $2
           AND (max_tx_amount IS NULL OR $2 <= max_tx_amount)
           AND (
             daily_limit IS NULL
             OR (CASE
                   WHEN daily_reset_at IS NOT NULL AND daily_reset_at < $3
                   THEN 0
                   ELSE daily_spent
                 END) + $2 <= daily_limit
           )
         RETURNING balance, daily_spent, daily_reset_at`,
        [cardId, amount, now, now + 24 * 60 * 60 * 1000],
      )

      if ((result.rowCount ?? 0) === 0) {
        return {
          success: false,
          error: "Payment declined (balance or spending limits)",
        }
      }

      const row: DbRow = result.rows[0]
      return {
        success: true,
        balance: parseInt(row.balance as string, 10),
        dailySpent: parseInt(row.daily_spent as string, 10),
        dailyResetAt: row.daily_reset_at
          ? parseInt(String(row.daily_reset_at), 10)
          : null,
      }
    } catch (err: unknown) {
      // A lost result is not a decline: the UPDATE may have committed.
      console.error("[BoltcardStore] incrementDailySpent error:", (err as Error).message)
      throw err
    }
  }

  /**
   * Reset daily spent for a card
   */
  async resetDailySpent(cardId: string): Promise<boolean> {
    try {
      const now: number = Date.now()
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards 
         SET daily_spent = 0, daily_reset_at = $2 
         WHERE id = $1 
         RETURNING id`,
        [cardId, now + 24 * 60 * 60 * 1000],
      )

      return (result.rowCount ?? 0) > 0
    } catch (err: unknown) {
      console.error("[BoltcardStore] resetDailySpent error:", (err as Error).message)
      return false
    }
  }

  /**
   * Rollback a failed spend (restore balance, and daily spent only if the
   * deduction still belongs to the card's current daily window).
   * Used when payment fails after balance was deducted.
   * dailyWindowResetAt is the window returned by incrementDailySpent; null
   * means the card has no window, so daily_spent is subtracted as before.
   */
  async rollbackSpend(
    cardId: string,
    amount: number,
    dailyWindowResetAt: number | null = null,
  ): Promise<boolean> {
    try {
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards
         SET balance = balance + $2,
             daily_spent = CASE
               WHEN $3::bigint IS NOT NULL
                    AND daily_reset_at IS DISTINCT FROM $3
               THEN daily_spent
               ELSE GREATEST(0, daily_spent - $2)
             END
         WHERE id = $1
         RETURNING id, balance, daily_spent`,
        [cardId, amount, dailyWindowResetAt],
      )

      if ((result.rowCount ?? 0) > 0) {
        const row: DbRow = result.rows[0]
        console.log(
          `[BoltcardStore] Rolled back spend for card ${cardId}: +${amount} (balance: ${row.balance})`,
        )
        return true
      }
      return false
    } catch (err: unknown) {
      // A lost result is not "restore failed": the UPDATE may have committed.
      // Callers must not queue another restore on top of that.
      console.error("[BoltcardStore] rollbackSpend error:", (err as Error).message)
      throw err
    }
  }

  /**
   * Update last counter (for replay protection)
   */
  async updateLastCounter(cardId: string, counter: number): Promise<boolean> {
    try {
      // Only update if new counter is greater (prevents replay)
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards 
         SET last_counter = $2 
         WHERE id = $1 AND last_counter < $2
         RETURNING id`,
        [cardId, counter],
      )

      return (result.rowCount ?? 0) > 0
    } catch (err: unknown) {
      console.error("[BoltcardStore] updateLastCounter error:", (err as Error).message)
      return false
    }
  }

  /**
   * Activate a pending card
   */
  async activateCard(cardId: string): Promise<boolean> {
    try {
      const now: number = Date.now()
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards 
         SET status = 'ACTIVE', activated_at = $2, disabled_at = NULL
         WHERE id = $1 AND status IN ('PENDING', 'DISABLED')
         RETURNING id`,
        [cardId, now],
      )

      if ((result.rowCount ?? 0) > 0) {
        console.log(`[BoltcardStore] Activated card: ${cardId}`)
        return true
      }
      return false
    } catch (err: unknown) {
      console.error("[BoltcardStore] activateCard error:", (err as Error).message)
      return false
    }
  }

  /**
   * Disable a card (temporary)
   */
  async disableCard(cardId: string): Promise<boolean> {
    try {
      const now: number = Date.now()
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards 
         SET status = 'DISABLED', disabled_at = $2
         WHERE id = $1 AND status = 'ACTIVE'
         RETURNING id`,
        [cardId, now],
      )

      if ((result.rowCount ?? 0) > 0) {
        console.log(`[BoltcardStore] Disabled card: ${cardId}`)
        return true
      }
      return false
    } catch (err: unknown) {
      console.error("[BoltcardStore] disableCard error:", (err as Error).message)
      return false
    }
  }

  /**
   * Enable a disabled card
   */
  async enableCard(cardId: string): Promise<boolean> {
    try {
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards 
         SET status = 'ACTIVE', disabled_at = NULL
         WHERE id = $1 AND status = 'DISABLED'
         RETURNING id`,
        [cardId],
      )

      if ((result.rowCount ?? 0) > 0) {
        console.log(`[BoltcardStore] Enabled card: ${cardId}`)
        return true
      }
      return false
    } catch (err: unknown) {
      console.error("[BoltcardStore] enableCard error:", (err as Error).message)
      return false
    }
  }

  /**
   * Wipe a card (permanent delete marker)
   */
  async wipeCard(cardId: string): Promise<boolean> {
    try {
      const now: number = Date.now()
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards 
         SET status = 'WIPED', disabled_at = $2
         WHERE id = $1 AND status != 'WIPED'
         RETURNING id`,
        [cardId, now],
      )

      if ((result.rowCount ?? 0) > 0) {
        console.log(`[BoltcardStore] Wiped card: ${cardId}`)
        return true
      }
      return false
    } catch (err: unknown) {
      console.error("[BoltcardStore] wipeCard error:", (err as Error).message)
      return false
    }
  }

  /**
   * Atomically record a tap-verified reset: advance the replay counter AND
   * stamp reset_verified_at, only if `counter` is newer than the stored one
   * and the card isn't wiped. Returns false if the tap was replayed / lost a
   * race / the card changed; throws on database errors. Callers must not
   * hand out card keys unless this returns true.
   */
  async recordVerifiedResetTap(cardId: string, counter: number): Promise<boolean> {
    const result: QueryResult<DbRow> = await query(
      `UPDATE boltcards
       SET last_counter = $2, reset_verified_at = $3
       WHERE id = $1 AND last_counter < $2 AND status != 'WIPED'
       RETURNING id`,
      [cardId, counter, Date.now()],
    )
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Mark the card WIPED only if a reset was tap-verified within `windowMs`.
   * Atomic; consumes the verification.
   */
  async wipeCardAfterVerifiedReset(cardId: string, windowMs: number): Promise<boolean> {
    try {
      const now: number = Date.now()
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards
         SET status = 'WIPED', disabled_at = $2, reset_verified_at = NULL
         WHERE id = $1 AND status != 'WIPED'
           AND reset_verified_at IS NOT NULL AND reset_verified_at > $3
         RETURNING id`,
        [cardId, now, now - windowMs],
      )
      if ((result.rowCount ?? 0) > 0) {
        console.log(`[BoltcardStore] Wiped card after verified reset: ${cardId}`)
        return true
      }
      return false
    } catch (err: unknown) {
      console.error(
        "[BoltcardStore] wipeCardAfterVerifiedReset error:",
        (err as Error).message,
      )
      return false
    }
  }

  // ==========================================================================
  // WITHDRAW SESSIONS (single-use, tap-bound LNURL-withdraw k1)
  // ==========================================================================

  /**
   * For a tap that already passed SUN/CMAC verification: in ONE statement,
   * advance last_counter (only if `counter` is newer and the card is ACTIVE)
   * and create a withdraw session. Returns the raw k1 (only ever returned to
   * the tapping wallet), or null if the tap was replayed / lost a race / the
   * card isn't active. Throws on database errors.
   */
  async startWithdrawSession(
    cardId: string,
    counter: number,
    maxMsats: number,
    ttlMs: number = WITHDRAW_SESSION_TTL_MS,
  ): Promise<string | null> {
    const k1: string = crypto.randomBytes(32).toString("hex")
    const now: number = Date.now()
    const result: QueryResult<DbRow> = await query(
      `WITH advanced AS (
         UPDATE boltcards SET last_counter = $2
         WHERE id = $1 AND last_counter < $2 AND status = 'ACTIVE'
         RETURNING id
       )
       INSERT INTO boltcard_withdraw_sessions
         (k1_hash, card_id, counter, max_msats, created_at, expires_at)
       SELECT $3, id, $2, $4, $5, $6 FROM advanced
       RETURNING k1_hash`,
      [cardId, counter, sha256Hex(k1), Math.floor(maxMsats), now, now + ttlMs],
    )
    return (result.rowCount ?? 0) > 0 ? k1 : null
  }

  /**
   * Tap-time maximum for an unused session, without consuming it. Null if the
   * k1 is unknown, for another card, expired, or already used.
   */
  async peekWithdrawSession(k1: string, cardId: string): Promise<number | null> {
    if (typeof k1 !== "string" || !/^[0-9a-f]{64}$/i.test(k1)) return null
    const result: QueryResult<DbRow> = await query(
      `SELECT max_msats FROM boltcard_withdraw_sessions
       WHERE k1_hash = $1 AND card_id = $2 AND used_at IS NULL AND expires_at > $3`,
      [sha256Hex(k1.toLowerCase()), cardId, Date.now()],
    )
    if ((result.rowCount ?? 0) === 0) return null
    return parseInt(String(result.rows[0].max_msats), 10)
  }

  /**
   * Atomically consume a withdraw session for `cardId`. Returns the tap-time
   * maximum in msats, or null if the k1 is unknown, for another card,
   * expired, or already used. Throws on database errors.
   */
  async consumeWithdrawSession(k1: string, cardId: string): Promise<number | null> {
    if (typeof k1 !== "string" || !/^[0-9a-f]{64}$/i.test(k1)) return null
    const now: number = Date.now()
    const result: QueryResult<DbRow> = await query(
      `UPDATE boltcard_withdraw_sessions
       SET used_at = $3
       WHERE k1_hash = $1 AND card_id = $2 AND used_at IS NULL AND expires_at > $3
       RETURNING max_msats`,
      [sha256Hex(k1.toLowerCase()), cardId, now],
    )
    if ((result.rowCount ?? 0) === 0) return null
    return parseInt(String(result.rows[0].max_msats), 10)
  }

  // ==========================================================================
  // PENDING WITHDRAWALS (in-flight / unknown-outcome card payments)
  // ==========================================================================

  /**
   * Record a withdrawal whose payment is not yet final, keyed by payment hash.
   * Same card, amount, and kind is idempotent. A different card or (while
   * unresolved) a different amount throws — the hash must not silently keep
   * stale data. An unresolved RESTORE_FAILED row is upgraded to PENDING or
   * UNKNOWN so reconciliation will not treat an in-flight retry as never sent.
   * A finished row is reopened for the new attempt (the hash is the primary
   * key). Throws on database errors — callers must not report success unless
   * this persists.
   */
  async recordPendingWithdrawal(
    paymentHash: string,
    cardId: string,
    amount: number,
    balanceAfter: number,
    kind: "PENDING" | "UNKNOWN" | "RESTORE_FAILED" = "PENDING",
    dailyWindowResetAt: number | null = null,
  ): Promise<void> {
    const amountInt = Math.floor(amount)
    const inserted: QueryResult<DbRow> = await query(
      `INSERT INTO boltcard_pending_withdrawals
         (payment_hash, card_id, amount, balance_after, created_at, kind, daily_window_reset_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (payment_hash) DO NOTHING
       RETURNING payment_hash`,
      [
        paymentHash,
        cardId,
        amountInt,
        Math.floor(balanceAfter),
        Date.now(),
        kind,
        dailyWindowResetAt,
      ],
    )
    if ((inserted.rowCount ?? 0) > 0) return

    // The hash is the primary key, so a blind DO NOTHING would keep a stale
    // row (wrong card, amount, or kind) and reconciliation would act on it.
    const existing: QueryResult<DbRow> = await query(
      `SELECT card_id, amount, kind, resolved_at
       FROM boltcard_pending_withdrawals
       WHERE payment_hash = $1`,
      [paymentHash],
    )
    const row = existing.rows[0]
    if (!row) {
      throw new Error("pending withdrawal conflict: row vanished during insert")
    }

    const sameCard = row.card_id === cardId
    const sameAmount = parseInt(String(row.amount), 10) === amountInt
    const existingKind = String(row.kind)
    const resolved = row.resolved_at != null

    if (!sameCard) {
      throw new Error(
        "pending withdrawal conflict: payment hash already recorded for a different card",
      )
    }
    if (!resolved && !sameAmount) {
      throw new Error(
        "pending withdrawal conflict: payment hash already recorded for a different amount",
      )
    }
    if (!resolved && existingKind === kind) return

    // An in-flight attempt must not stay marked "never sent", or reconciliation
    // can restore it while the payment is still in flight. Never downgrade.
    if (
      !resolved &&
      existingKind === "RESTORE_FAILED" &&
      (kind === "PENDING" || kind === "UNKNOWN")
    ) {
      const upgraded: QueryResult<DbRow> = await query(
        `UPDATE boltcard_pending_withdrawals
         SET kind = $2, daily_window_reset_at = $3
         WHERE payment_hash = $1
           AND resolved_at IS NULL
           AND card_id = $4
           AND amount = $5
           AND kind = 'RESTORE_FAILED'`,
        [paymentHash, kind, dailyWindowResetAt, cardId, amountInt],
      )
      if ((upgraded.rowCount ?? 0) === 0) {
        throw new Error("pending withdrawal conflict: kind upgrade lost the race")
      }
      return
    }
    if (!resolved) return

    // Only a finished FAILED attempt can be reopened. A SUCCESS row means the
    // invoice was spent and must not be deducted again.
    const reopened: QueryResult<DbRow> = await query(
      `UPDATE boltcard_pending_withdrawals
       SET amount = $2,
           balance_after = $3,
           created_at = $4,
           kind = $5,
           daily_window_reset_at = $6,
           resolved_at = NULL,
           outcome = NULL
       WHERE payment_hash = $1
          AND resolved_at IS NOT NULL
          AND outcome = 'FAILED'
          AND card_id = $7`,
      [
        paymentHash,
        amountInt,
        Math.floor(balanceAfter),
        Date.now(),
        kind,
        dailyWindowResetAt,
        cardId,
      ],
    )
    if ((reopened.rowCount ?? 0) === 0) {
      throw new Error(
        "pending withdrawal conflict: payment hash is already spent or not reclaimable",
      )
    }
  }

  /**
   * Unresolved withdrawal for a payment hash, if one is still being reconciled.
   * A second attempt of that invoice must not deduct again.
   */
  async getUnresolvedWithdrawal(paymentHash: string): Promise<{
    cardId: string
    amount: number
    kind: string
  } | null> {
    const result: QueryResult<DbRow> = await query(
      `SELECT card_id, amount, kind
       FROM boltcard_pending_withdrawals
       WHERE payment_hash = $1 AND resolved_at IS NULL`,
      [paymentHash],
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      cardId: row.card_id as string,
      amount: parseInt(String(row.amount), 10),
      kind: String(row.kind),
    }
  }

  /**
   * Claim this invoice hash and deduct in one transaction. A conflicting hash
   * is already taken (in flight or spent) unless it is a finished FAILED
   * attempt for the same card, which can be re-claimed. Zero-row deduction
   * rolls the claim back (definite decline). A database error throws: the
   * transaction may have committed, and callers must not treat that as a decline.
   */
  async claimAndDeductWithdrawal(
    paymentHash: string,
    cardId: string,
    amount: number,
  ): Promise<
    | {
        status: "claimed"
        balance: number
        dailySpent: number
        dailyResetAt: number | null
      }
    | { status: "spent" }
    | { status: "declined" }
  > {
    const client = await getClient()
    const now = Date.now()
    const amountInt = Math.floor(amount)
    try {
      await client.query("BEGIN")
      const inserted: QueryResult<DbRow> = await client.query(
        `INSERT INTO boltcard_pending_withdrawals
           (payment_hash, card_id, amount, balance_after, created_at, kind, daily_window_reset_at)
         VALUES ($1, $2, $3, 0, $4, 'CLAIMED', NULL)
         ON CONFLICT (payment_hash) DO NOTHING
         RETURNING payment_hash`,
        [paymentHash, cardId, amountInt, now],
      )
      let owned = (inserted.rowCount ?? 0) > 0
      if (!owned) {
        const reclaimed: QueryResult<DbRow> = await client.query(
          `UPDATE boltcard_pending_withdrawals
           SET amount = $3,
               balance_after = 0,
               created_at = $4,
               kind = 'CLAIMED',
               daily_window_reset_at = NULL,
               resolved_at = NULL,
               outcome = NULL
           WHERE payment_hash = $1
             AND resolved_at IS NOT NULL
             AND outcome = 'FAILED'
             AND card_id = $2
           RETURNING payment_hash`,
          [paymentHash, cardId, amountInt, now],
        )
        owned = (reclaimed.rowCount ?? 0) > 0
      }
      if (!owned) {
        await client.query("ROLLBACK")
        return { status: "spent" }
      }

      const deducted: QueryResult<DbRow> = await client.query(
        `UPDATE boltcards
         SET balance = balance - $2,
             daily_spent = CASE
               WHEN daily_reset_at IS NOT NULL AND daily_reset_at < $3 THEN $2
               ELSE daily_spent + $2
             END,
             daily_reset_at = CASE
               WHEN daily_reset_at IS NOT NULL AND daily_reset_at < $3 THEN $4
               ELSE daily_reset_at
             END,
             last_used_at = $3
         WHERE id = $1
           AND status = 'ACTIVE'
           AND balance >= $2
           AND (max_tx_amount IS NULL OR $2 <= max_tx_amount)
           AND (
             daily_limit IS NULL
             OR (CASE
                   WHEN daily_reset_at IS NOT NULL AND daily_reset_at < $3
                   THEN 0
                   ELSE daily_spent
                 END) + $2 <= daily_limit
           )
         RETURNING balance, daily_spent, daily_reset_at`,
        [cardId, amountInt, now, now + 24 * 60 * 60 * 1000],
      )
      if ((deducted.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK")
        return { status: "declined" }
      }

      const row = deducted.rows[0]
      const balance = parseInt(String(row.balance), 10)
      const dailyResetAt = row.daily_reset_at
        ? parseInt(String(row.daily_reset_at), 10)
        : null
      await client.query(
        `UPDATE boltcard_pending_withdrawals
         SET balance_after = $2, daily_window_reset_at = $3
         WHERE payment_hash = $1`,
        [paymentHash, balance, dailyResetAt],
      )
      await client.query("COMMIT")
      return {
        status: "claimed",
        balance,
        dailySpent: parseInt(String(row.daily_spent), 10),
        dailyResetAt,
      }
    } catch (err: unknown) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Hand a CLAIMED withdrawal to the pay path. UNKNOWN is not auto-restored
   * when Blink has no transaction, so a balance tap during the payment call
   * cannot undo a live send. False means the claim is no longer CLAIMED:
   * do not pay.
   */
  async beginWithdrawalSend(paymentHash: string): Promise<boolean> {
    const result: QueryResult<DbRow> = await query(
      `UPDATE boltcard_pending_withdrawals
       SET kind = 'UNKNOWN'
       WHERE payment_hash = $1 AND resolved_at IS NULL AND kind = 'CLAIMED'
       RETURNING payment_hash`,
      [paymentHash],
    )
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Move a claimed withdrawal to its post-payment state. SUCCESS resolves the
   * row so the hash stays spent. PENDING and UNKNOWN stay open for
   * reconciliation. Throws if the claim row is no longer unresolved.
   */
  async finalizeWithdrawal(
    paymentHash: string,
    kind: "PENDING" | "UNKNOWN" | "SUCCESS",
  ): Promise<void> {
    const result: QueryResult<DbRow> = await query(
      `UPDATE boltcard_pending_withdrawals
       SET kind = $2,
           resolved_at = CASE WHEN $2 = 'SUCCESS' THEN $3::bigint ELSE NULL END,
           outcome = CASE WHEN $2 = 'SUCCESS' THEN 'SUCCESS' ELSE NULL END
       WHERE payment_hash = $1 AND resolved_at IS NULL`,
      [paymentHash, kind, Date.now()],
    )
    if ((result.rowCount ?? 0) === 0) {
      throw new Error("pending withdrawal finalize lost the claim row")
    }
  }

  /**
   * Unresolved pending withdrawals (optionally for one card): in-flight or
   * unknown-outcome payments awaiting reconciliation.
   */
  async getPendingWithdrawals(cardId?: string): Promise<
    Array<{
      paymentHash: string
      cardId: string
      amount: number
      createdAt: number
      kind: string
    }>
  > {
    const result: QueryResult<DbRow> = await query(
      `SELECT payment_hash, card_id, amount, created_at, kind
       FROM boltcard_pending_withdrawals
       WHERE resolved_at IS NULL AND ($1::text IS NULL OR card_id = $1)
       ORDER BY created_at ASC`,
      [cardId ?? null],
    )
    return result.rows.map((row: DbRow) => ({
      paymentHash: row.payment_hash as string,
      cardId: row.card_id as string,
      amount: parseInt(String(row.amount), 10),
      createdAt: parseInt(String(row.created_at), 10),
      kind: String(row.kind),
    }))
  }

  /**
   * Resolve a pending withdrawal without touching the card (payment settled,
   * or nothing to restore). One-shot: already-resolved rows return false.
   * For terminal failures of a live card use resolvePendingWithdrawalFailed.
   */
  async resolvePendingWithdrawal(
    paymentHash: string,
    outcome: "SUCCESS" | "FAILED" = "SUCCESS",
  ): Promise<boolean> {
    const result: QueryResult<DbRow> = await query(
      `UPDATE boltcard_pending_withdrawals
       SET resolved_at = $2, outcome = $3
       WHERE payment_hash = $1 AND resolved_at IS NULL
       RETURNING payment_hash`,
      [paymentHash, Date.now(), outcome],
    )
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Terminal failure: mark resolved AND restore the card's deduction in ONE
   * statement. If the row was already resolved (or is missing), zero rows are
   * returned and nothing is restored; if the card write fails, the statement
   * rolls back and the row stays unresolved. The deduction is restored at
   * most once.
   *
   * abandonedClaimedBefore: compare-and-set for a claim the process never
   * handed to pay. Restores only if the row is still CLAIMED and older than
   * that cutoff. A row that has moved to UNKNOWN, or whose stamp is newer,
   * matches nothing and is not restored.
   */
  async resolvePendingWithdrawalFailed(
    paymentHash: string,
    abandonedClaimedBefore?: number,
  ): Promise<boolean> {
    const abandoned = abandonedClaimedBefore !== undefined
    const result: QueryResult<DbRow> = await query(
      `WITH resolved AS (
         UPDATE boltcard_pending_withdrawals
         SET resolved_at = $2, outcome = 'FAILED'
         WHERE payment_hash = $1 AND resolved_at IS NULL
           ${abandoned ? "AND kind = 'CLAIMED' AND created_at < $3" : ""}
         RETURNING card_id, amount, daily_window_reset_at
       )
       UPDATE boltcards
       SET balance = balance + r.amount,
           -- Only subtract from the same daily window the deduction happened
           -- in; after a reset, daily_spent belongs to a NEW window.
           daily_spent = CASE
             WHEN r.daily_window_reset_at IS NOT NULL
                  AND boltcards.daily_reset_at IS DISTINCT FROM r.daily_window_reset_at
             THEN daily_spent
             ELSE GREATEST(0, daily_spent - r.amount)
           END
       FROM resolved r
       WHERE boltcards.id = r.card_id
       RETURNING boltcards.id`,
      abandoned
        ? [paymentHash, Date.now(), abandonedClaimedBefore]
        : [paymentHash, Date.now()],
    )
    return (result.rowCount ?? 0) > 0
  }

  // ==========================================================================
  // PENDING TOP-UP MANAGEMENT (for LNURL-pay)
  // ==========================================================================

  /**
   * Store a pending top-up in the database
   */
  async storePendingTopUp(
    cardId: string,
    paymentHash: string,
    amount: number,
    currency: string = "BTC",
  ): Promise<boolean> {
    const now: number = Date.now()
    const expiresAt: number = now + 60 * 60 * 1000 // 1 hour expiry

    try {
      await query(
        `INSERT INTO boltcard_pending_topups 
         (payment_hash, card_id, amount, currency, created_at, expires_at, processed)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE)
         ON CONFLICT (payment_hash) DO UPDATE SET
           card_id = $2, amount = $3, currency = $4, expires_at = $6, processed = FALSE`,
        [paymentHash, cardId, amount, currency, now, expiresAt],
      )

      console.log(
        `[BoltcardStore] Stored pending top-up: ${paymentHash.substring(0, 16)}... for card ${cardId}`,
      )
      return true
    } catch (err: unknown) {
      console.error("[BoltcardStore] storePendingTopUp error:", (err as Error).message)
      return false
    }
  }

  /**
   * Get a pending top-up by payment hash
   */
  async getPendingTopUp(paymentHash: string): Promise<PendingTopUp | null> {
    try {
      const result: QueryResult<DbRow> = await query(
        `SELECT * FROM boltcard_pending_topups 
         WHERE payment_hash = $1 AND processed = FALSE AND expires_at > $2`,
        [paymentHash, Date.now()],
      )

      if (result.rows.length === 0) {
        return null
      }

      const row: DbRow = result.rows[0]
      return {
        paymentHash: row.payment_hash as string,
        cardId: row.card_id as string,
        amount: parseInt(row.amount as string, 10),
        currency: row.currency as string,
        createdAt: parseInt(row.created_at as string, 10),
        expiresAt: parseInt(row.expires_at as string, 10),
      }
    } catch (err: unknown) {
      console.error("[BoltcardStore] getPendingTopUp error:", (err as Error).message)
      return null
    }
  }

  /**
   * Mark a pending top-up as processed
   */
  async markTopUpProcessed(paymentHash: string): Promise<boolean> {
    // Zero rows = already claimed (definite). A database error throws: the
    // claim may have committed, and callers must not treat that as "already
    // processed and done".
    const result: QueryResult<DbRow> = await query(
      `UPDATE boltcard_pending_topups 
       SET processed = TRUE, processed_at = $2
       WHERE payment_hash = $1 AND processed = FALSE
       RETURNING payment_hash`,
      [paymentHash, Date.now()],
    )

    return (result.rowCount ?? 0) > 0
  }

  /** True when a TOPUP audit row exists for this payment hash. */
  async hasTopUpTransaction(paymentHash: string): Promise<boolean> {
    const result: QueryResult<DbRow> = await query(
      `SELECT 1 FROM boltcard_transactions
       WHERE payment_hash = $1 AND tx_type = 'TOPUP'
       LIMIT 1`,
      [paymentHash],
    )
    return result.rows.length > 0
  }

  /**
   * Flag a claimed top-up as needing (manual) review, with a reason. Review
   * rows are excluded from cleanup and stay queryable until resolved.
   */
  async setTopUpReviewReason(paymentHash: string, reason: string): Promise<void> {
    await query(
      `UPDATE boltcard_pending_topups
       SET needs_review = TRUE, review_reason = $2
       WHERE payment_hash = $1`,
      [paymentHash, reason],
    )
  }

  /**
   * Flag a processed claim that has no credit, without replacing a reason
   * that an earlier failure already recorded.
   */
  async flagUncreditedTopUp(paymentHash: string): Promise<void> {
    await query(
      `UPDATE boltcard_pending_topups
       SET needs_review = TRUE, review_reason = $2
       WHERE payment_hash = $1 AND NOT needs_review`,
      [paymentHash, "processed claim has no credit"],
    )
  }

  /** Clear the review flag after an operator resolved the situation. */
  async clearTopUpReview(paymentHash: string): Promise<boolean> {
    const result: QueryResult<DbRow> = await query(
      `UPDATE boltcard_pending_topups
       SET needs_review = FALSE, review_reason = NULL
       WHERE payment_hash = $1 AND needs_review
       RETURNING payment_hash`,
      [paymentHash],
    )
    return (result.rowCount ?? 0) > 0
  }

  /** Claimed top-ups awaiting manual review. */
  async getTopUpsNeedingReview(): Promise<
    Array<{ paymentHash: string; cardId: string; reason: string | null }>
  > {
    const result: QueryResult<DbRow> = await query(
      `SELECT payment_hash, card_id, review_reason
       FROM boltcard_pending_topups
       WHERE processed = TRUE AND needs_review
       ORDER BY processed_at ASC`,
    )
    return result.rows.map((row: DbRow) => ({
      paymentHash: row.payment_hash as string,
      cardId: row.card_id as string,
      reason: row.review_reason as string | null,
    }))
  }

  /**
   * Release a top-up claim (markTopUpProcessed) when nothing was credited or
   * transferred, so it can be processed again later.
   */
  async unmarkTopUpProcessed(paymentHash: string): Promise<boolean> {
    try {
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcard_pending_topups
         SET processed = FALSE, processed_at = NULL, needs_review = FALSE, review_reason = NULL
         WHERE payment_hash = $1 AND processed = TRUE
         RETURNING payment_hash`,
        [paymentHash],
      )
      return (result.rowCount ?? 0) > 0
    } catch (err: unknown) {
      console.error("[BoltcardStore] unmarkTopUpProcessed error:", (err as Error).message)
      return false
    }
  }

  /**
   * Delete a pending top-up
   */
  async deletePendingTopUp(paymentHash: string): Promise<boolean> {
    try {
      const result: QueryResult<DbRow> = await query(
        `DELETE FROM boltcard_pending_topups WHERE payment_hash = $1 RETURNING payment_hash`,
        [paymentHash],
      )

      return (result.rowCount ?? 0) > 0
    } catch (err: unknown) {
      console.error("[BoltcardStore] deletePendingTopUp error:", (err as Error).message)
      return false
    }
  }

  /**
   * Get all pending (unprocessed) top-ups - for debugging/admin
   */
  async getAllPendingTopUps(): Promise<PendingTopUp[]> {
    try {
      const result: QueryResult<DbRow> = await query(
        `SELECT * FROM boltcard_pending_topups 
         WHERE processed = FALSE AND expires_at > $1
         ORDER BY created_at DESC`,
        [Date.now()],
      )

      return result.rows.map(
        (row: DbRow): PendingTopUp => ({
          paymentHash: row.payment_hash as string,
          cardId: row.card_id as string,
          amount: parseInt(row.amount as string, 10),
          currency: row.currency as string,
          createdAt: parseInt(row.created_at as string, 10),
          expiresAt: parseInt(row.expires_at as string, 10),
        }),
      )
    } catch (err: unknown) {
      console.error("[BoltcardStore] getAllPendingTopUps error:", (err as Error).message)
      return []
    }
  }

  /**
   * Get pending (unprocessed) top-ups for a specific card
   */
  async getPendingTopUpsForCard(cardId: string): Promise<PendingTopUp[]> {
    try {
      const result: QueryResult<DbRow> = await query(
        `SELECT * FROM boltcard_pending_topups 
         WHERE card_id = $1 AND processed = FALSE AND expires_at > $2
         ORDER BY created_at ASC`,
        [cardId, Date.now()],
      )

      return result.rows.map(
        (row: DbRow): PendingTopUp => ({
          paymentHash: row.payment_hash as string,
          cardId: row.card_id as string,
          amount: parseInt(row.amount as string, 10),
          currency: row.currency as string,
          createdAt: parseInt(row.created_at as string, 10),
          expiresAt: parseInt(row.expires_at as string, 10),
        }),
      )
    } catch (err: unknown) {
      console.error(
        "[BoltcardStore] getPendingTopUpsForCard error:",
        (err as Error).message,
      )
      return []
    }
  }

  /**
   * Cleanup expired/processed pending top-ups
   */
  async cleanupPendingTopUps(): Promise<number> {
    try {
      const result: QueryResult<DbRow> = await query(
        `SELECT cleanup_boltcard_pending_topups()`,
      )
      return (result.rows[0]?.cleanup_boltcard_pending_topups as number) || 0
    } catch (err: unknown) {
      console.error("[BoltcardStore] cleanupPendingTopUps error:", (err as Error).message)
      return 0
    }
  }

  /**
   * Top up a card's balance (for LNURL-pay)
   */
  async topUpCard(
    cardId: string,
    amount: number,
    paymentHash: string,
    description: string | null = null,
  ): Promise<TopUpResult> {
    // Balance mutation AND its audit record in ONE statement: no credited
    // balance without its transaction row, and no window between them.
    // Zero rows = definite failure (card missing / not active, nothing
    // written); a thrown database error is AMBIGUOUS (the write may have
    // committed) and is rethrown so callers keep the top-up claim.
    const result: QueryResult<DbRow> = await query(
      `WITH credited AS (
         UPDATE boltcards
         SET balance = balance + $2
         WHERE id = $1 AND status = 'ACTIVE'
         RETURNING id, balance
       )
       INSERT INTO boltcard_transactions
         (card_id, tx_type, amount, balance_after, payment_hash, description, created_at)
       SELECT id, $3, $2, balance, $4, $5, $6 FROM credited
       RETURNING *`,
      [
        cardId,
        amount,
        TxType.TOPUP,
        paymentHash || null,
        description || "Card top-up",
        Date.now(),
      ],
    )

    if ((result.rowCount ?? 0) === 0) {
      return { success: false, error: "Card not found or not active" }
    }

    const newBalance: number = parseInt(result.rows[0].balance_after as string, 10)
    console.log(
      `[BoltcardStore] Topped up card ${cardId}: +${amount} (new balance: ${newBalance})`,
    )

    return {
      success: true,
      balance: newBalance,
      transaction: this._rowToTransaction(result.rows[0]),
    }
  }

  /**
   * Get store statistics
   */
  async getStats(): Promise<StoreStats> {
    const defaultStats: StoreStats = {
      total: 0,
      pending: 0,
      active: 0,
      disabled: 0,
      wiped: 0,
      btcCards: 0,
      usdCards: 0,
      totalBtcBalanceSats: 0,
      totalUsdBalanceCents: 0,
      issuerKeys: 0,
      pendingRegistrations: 0,
    }

    try {
      const result: QueryResult<DbRow> = await query(`SELECT * FROM boltcard_stats`)

      if (result.rows.length === 0) {
        return defaultStats
      }

      const row: DbRow = result.rows[0]
      return {
        total: parseInt(row.total as string, 10),
        pending: parseInt(row.pending as string, 10),
        active: parseInt(row.active as string, 10),
        disabled: parseInt(row.disabled as string, 10),
        wiped: parseInt(row.wiped as string, 10),
        btcCards: parseInt(row.btc_cards as string, 10),
        usdCards: parseInt(row.usd_cards as string, 10),
        totalBtcBalanceSats: parseInt(row.total_btc_balance_sats as string, 10),
        totalUsdBalanceCents: parseInt(row.total_usd_balance_cents as string, 10),
        issuerKeys: parseInt((row.issuer_keys as string) || "0", 10),
        pendingRegistrations: parseInt((row.pending_registrations as string) || "0", 10),
      }
    } catch (err: unknown) {
      console.error("[BoltcardStore] getStats error:", (err as Error).message)
      return defaultStats
    }
  }
}

// Export singleton instance and constants
const boltcardStore: BoltcardStore = new BoltcardStore()
export default boltcardStore
export { BoltcardStore, CardStatus, TxType, PendingStatus, CARD_ACTIVATION_FAILED }
