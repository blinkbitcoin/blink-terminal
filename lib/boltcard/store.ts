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
import { getSharedPool } from "../db"

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
  async getOrCreateIssuerKey(ownerPubkey: string): Promise<string> {
    if (!/^[0-9a-fA-F]{64}$/.test(ownerPubkey)) {
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
  async getIssuerKey(ownerPubkey: string): Promise<string | null> {
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
    const { ownerPubkey, walletId, apiKey } = data

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

    try {
      return await this._completeClaimedRegistration(
        registrationId,
        registration,
        cardUid,
      )
    } catch (err: unknown) {
      // Nothing was minted: release the claim so the owner can retry
      // (e.g. after tapping the wrong card).
      await query(
        `UPDATE boltcard_pending_registrations
         SET status = $2, completed_at = NULL
         WHERE id = $1 AND card_id IS NULL AND status = $3`,
        [registrationId, PendingStatus.PENDING, PendingStatus.COMPLETED],
      ).catch(() => undefined)
      throw err
    }
  }

  async _completeClaimedRegistration(
    registrationId: string,
    registration: PendingRegistrationRecord,
    cardUid: string,
  ): Promise<BoltcardData | null> {
    // Check if card UID already exists
    const existingCard: BoltcardData | null = await this.getCardByUid(cardUid)
    if (existingCard) {
      // If card is WIPED, delete it completely to allow fresh registration
      if (existingCard.status === CardStatus.WIPED) {
        console.log(
          `[BoltcardStore] Deleting WIPED card ${existingCard.id} to allow fresh registration`,
        )
        await query(`DELETE FROM boltcard_transactions WHERE card_id = $1`, [
          existingCard.id,
        ])
        await query(`DELETE FROM boltcard_pending_topups WHERE card_id = $1`, [
          existingCard.id,
        ])
        await query(`DELETE FROM boltcards WHERE id = $1`, [existingCard.id])
        // Fall through to create new card below
      } else if (existingCard.ownerPubkey === registration.ownerPubkey) {
        // Same owner, active card - this is a re-program, increment version
        const updated: BoltcardData | null = await this.reprogramCard(
          existingCard.id,
          cardUid,
        )
        if (updated) {
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

    // Auto-activate the card since NFC Programmer app doesn't have a confirmation callback
    // If programming fails, user can delete and re-register the card
    await this.activateCard(card.id)

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
    ownerPubkey: string,
  ): Promise<PendingRegistrationSummary[]> {
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
    const { cardUid, ownerPubkey, walletId, apiKey } = cardData

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
  async getCardsByOwner(ownerPubkey: string): Promise<BoltcardData[]> {
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

      // First check if daily limit needs reset
      const card: BoltcardData | null = await this.getCard(cardId)
      if (!card) {
        return { success: false, error: "Card not found" }
      }

      if (card.status !== CardStatus.ACTIVE) {
        return { success: false, error: "Card is not active" }
      }

      // Check if we need to reset daily spent
      if (card.dailyResetAt && card.dailyResetAt < now) {
        await query(
          `UPDATE boltcards 
           SET daily_spent = 0, daily_reset_at = $2 
           WHERE id = $1`,
          [cardId, now + 24 * 60 * 60 * 1000],
        )
        card.dailySpent = 0
      }

      // Check balance
      if (card.balance < amount) {
        return { success: false, error: "Insufficient balance" }
      }

      // Check per-transaction limit
      if (card.maxTxAmount && amount > card.maxTxAmount) {
        return { success: false, error: "Amount exceeds per-transaction limit" }
      }

      // Check daily limit
      if (card.dailyLimit && card.dailySpent + amount > card.dailyLimit) {
        return { success: false, error: "Amount exceeds daily limit" }
      }

      // Atomic update: deduct balance and increment daily spent
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards 
         SET balance = balance - $2,
             daily_spent = daily_spent + $2,
             last_used_at = $3
         WHERE id = $1 
           AND status = 'ACTIVE'
           AND balance >= $2
         RETURNING balance, daily_spent`,
        [cardId, amount, now],
      )

      if ((result.rowCount ?? 0) === 0) {
        return { success: false, error: "Failed to update card" }
      }

      const row: DbRow = result.rows[0]
      return {
        success: true,
        balance: parseInt(row.balance as string, 10),
        dailySpent: parseInt(row.daily_spent as string, 10),
      }
    } catch (err: unknown) {
      console.error("[BoltcardStore] incrementDailySpent error:", (err as Error).message)
      return { success: false, error: (err as Error).message }
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
   * Rollback a failed spend (restore balance and daily spent)
   * Used when payment fails after balance was deducted
   */
  async rollbackSpend(cardId: string, amount: number): Promise<boolean> {
    try {
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards 
         SET balance = balance + $2, daily_spent = GREATEST(0, daily_spent - $2)
         WHERE id = $1
         RETURNING id, balance, daily_spent`,
        [cardId, amount],
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
      console.error("[BoltcardStore] rollbackSpend error:", (err as Error).message)
      return false
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
   * Record that a reset of this card was just tap-verified (SUN/CMAC).
   */
  async markResetVerified(cardId: string): Promise<boolean> {
    try {
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards SET reset_verified_at = $2
         WHERE id = $1 AND status != 'WIPED'
         RETURNING id`,
        [cardId, Date.now()],
      )
      return (result.rowCount ?? 0) > 0
    } catch (err: unknown) {
      console.error("[BoltcardStore] markResetVerified error:", (err as Error).message)
      return false
    }
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
    try {
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcard_pending_topups 
         SET processed = TRUE, processed_at = $2
         WHERE payment_hash = $1 AND processed = FALSE
         RETURNING payment_hash`,
        [paymentHash, Date.now()],
      )

      return (result.rowCount ?? 0) > 0
    } catch (err: unknown) {
      console.error("[BoltcardStore] markTopUpProcessed error:", (err as Error).message)
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
    try {
      // Atomic update: add to balance
      const result: QueryResult<DbRow> = await query(
        `UPDATE boltcards 
         SET balance = balance + $2
         WHERE id = $1 AND status = 'ACTIVE'
         RETURNING balance`,
        [cardId, amount],
      )

      if ((result.rowCount ?? 0) === 0) {
        return { success: false, error: "Card not found or not active" }
      }

      const newBalance: number = parseInt(result.rows[0].balance as string, 10)

      // Record the top-up transaction
      const tx: TransactionRecord | null = await this.recordTransaction(cardId, {
        type: TxType.TOPUP,
        amount,
        balanceAfter: newBalance,
        paymentHash,
        description: description || "Card top-up",
      })

      console.log(
        `[BoltcardStore] Topped up card ${cardId}: +${amount} (new balance: ${newBalance})`,
      )

      return {
        success: true,
        balance: newBalance,
        transaction: tx,
      }
    } catch (err: unknown) {
      console.error("[BoltcardStore] topUpCard error:", (err as Error).message)
      return { success: false, error: (err as Error).message }
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
export { BoltcardStore, CardStatus, TxType, PendingStatus }
