/**
 * Voucher Store - PostgreSQL-backed storage for voucher charges
 *
 * Migrated from file-based storage to ensure vouchers persist across deployments.
 * Uses the same connection pool pattern as lib/network/db.js
 *
 * Storage Interface Contract:
 * - createVoucher(amount, apiKey, walletId, options) -> voucher object
 * - getVoucher(chargeId) -> voucher object or null
 * - getVoucherWithStatus(chargeId) -> voucher object with status or null
 * - claimVoucher(chargeId) -> boolean success
 * - unclaimVoucher(chargeId) -> boolean success (for payment failure rollback)
 * - cancelVoucher(chargeId) -> boolean success
 * - getUnclaimedCountByWallet(walletId) -> number
 * - getAllVouchers() -> array of voucher objects
 * - getStats() -> stats object
 */

import crypto from "crypto"

import type { QueryResult } from "pg"

import AuthManager from "./auth"
import { getSharedPool } from "./db"
import {
  MAX_UNCLAIMED_PER_WALLET,
  getExpiryMs,
  DEFAULT_EXPIRY_ID,
  getVoucherStatus,
} from "./voucher-expiry"

/**
 * BACKING INVARIANT (blink-wip#1665)
 *
 *   live Blink wallet balance >= SUM(liability of unexpired ACTIVE + CLAIMED)
 *
 * is enforced per wallet under pg_advisory_xact_lock(hashtext(wallet_id)).
 * Every step that READS the balance against the sum, or REMOVES a liability
 * after a debit, must hold that lock, or the two can interleave (a creation
 * reading the pre-debit balance, then summing after the debited voucher left
 * the set):
 *   - createVoucher with `backing`: balance/rate fetch -> sum -> insert, all
 *     inside one locked transaction (the callback runs under the lock)
 *   - markVoucherPaid (CLAIMED -> PAID, the only post-debit removal), also
 *     used by scripts/reconcile-voucher-claims.js via MARK_VOUCHER_PAID_SQL
 * Transitions that remove a liability WITHOUT a debit (cancel, expiry,
 * definite-failure unclaim) leave the balance untouched and need no lock.
 * Lock waits are bounded (LOCK_TIMEOUT) so a slow Blink call under the lock
 * cannot wedge the wallet or the pool.
 */
export const WALLET_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1))"
export const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '15s'"
/**
 * markVoucherPaid retries on lock timeout: a create's locked section is
 * bounded by its 8 s backing deadline (pages/api/voucher/create.ts), so a
 * settlement that loses one lock wait almost always wins the next.
 */
const MARK_PAID_LOCK_RETRIES = 2
const MARK_PAID_RETRY_DELAY_MS = 500

/** Postgres lock_timeout: SQLSTATE 55P03 (lock_not_available). */
function isLockTimeout(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null
  return e?.code === "55P03" || /lock timeout/i.test(e?.message ?? "")
}

/**
 * Aggregate liabilities of unsettled vouchers for one wallet, in the wallet's
 * minor units. Exported as constants so the PGlite spec executes the exact
 * SQL the store runs (PR #94 review: mocked client.query let a Postgres
 * parameter-type failure ship).
 *
 * Expiry only applies to ACTIVE: an unclaimed voucher past expiry can never be
 * redeemed. CLAIMED is counted regardless of expiry because claim happens
 * BEFORE the payment round trip (callback.ts): a voucher claimed just before
 * expiry may still settle (PENDING/unknown outcome) and debit the wallet.
 * Settlement (PAID), cancellation and definite-failure unclaim (CLAIMED ->
 * ACTIVE, which then expires normally) exit the set (blink-wip#1665). CLAIMED
 * is never aged out by cleanup: an unresolved claim stays a liability until
 * reconciliation, unclaim or cancel resolves it (migration 029).
 *
 * $1 = walletId, $2 = now (ms). USD also takes $3 = server cents-per-sat rate
 * (cast to numeric: amount_sats is BIGINT, and an uncast "0.05" parameter would
 * be inferred as bigint and rejected).
 */
export const ACTIVE_LIABILITY_SUM_SQL_BTC = `SELECT COALESCE(SUM(amount_sats), 0) AS total FROM vouchers
   WHERE wallet_id = $1 AND (status = 'CLAIMED' OR (status = 'ACTIVE' AND expires_at > $2))`

export const ACTIVE_LIABILITY_SUM_SQL_USD = `SELECT COALESCE(
     SUM(GREATEST(COALESCE(usd_amount_cents, 0), CEIL(amount_sats * $3::numeric))),
     0
   ) AS total FROM vouchers
   WHERE wallet_id = $1 AND (status = 'CLAIMED' OR (status = 'ACTIVE' AND expires_at > $2))`

/**
 * Voucher redemption transitions, exported so the PGlite spec can run the
 * exact production statements through a full lifecycle. $1 = chargeId,
 * $2 = now (ms).
 *
 * CLAIMED is entered BEFORE the payment round trip and exited only by
 * settlement (PAID, via markVoucherPaid), definite-failure unclaim (back to
 * ACTIVE), cancellation or expiry — see the liability comment above.
 */
export const CLAIM_VOUCHER_SQL = `UPDATE vouchers
   SET claimed = true, claimed_at = $2, status = 'CLAIMED'
   WHERE id = $1
     AND status = 'ACTIVE'
     AND NOT claimed
     AND expires_at > $2
   RETURNING id`

export const MARK_VOUCHER_PAID_SQL = `UPDATE vouchers
   SET status = 'PAID'
   WHERE id = $1 AND status = 'CLAIMED'
   RETURNING id`

interface Voucher {
  id: string
  amount: number
  claimed: boolean
  claimedAt: number | null
  createdAt: number
  expiresAt: number
  expiryId: string
  cancelledAt: number | null
  apiKey: string | null
  walletId: string
  commissionPercent: number
  displayAmount: string | null
  displayCurrency: string | null
  status: string
  environment: string
  walletCurrency: string
  usdAmountCents: number | null
}

interface CreateVoucherOptions {
  expiryId?: string
  commissionPercent?: number
  displayAmount?: string
  displayCurrency?: string
  environment?: string
  walletCurrency?: string
  usdAmount?: number
  /**
   * Backing ceiling in minor units (sats for BTC wallets, cents for USD).
   * When set, the insert runs in a per-wallet transaction that sums existing
   * unsettled voucher liabilities (unexpired ACTIVE + in-flight CLAIMED) and
   * refuses when existing + liabilityMinor exceeds this ceiling
   * (blink-wip#1665: each create used to check only its own amount against the
   * live balance, so sequential/concurrent creates could aggregate beyond it).
   */
  maxLiabilityMinor?: number
  /**
   * This voucher's liability in the same minor units as maxLiabilityMinor.
   * Defaults to the stored amount (sats) / usdAmountCents (USD).
   */
  liabilityMinor?: number
  /**
   * Server-side USD cents-per-sat rate. Required when a USD voucher is
   * created with a backing ceiling: existing ACTIVE USD vouchers are summed
   * at max(stored cents, ceil(amount_sats × rate)) — the same conservative
   * formula the route applies to the new voucher — because only the smaller
   * display cents are persisted (PR #94 review). Liabilities are evaluated at
   * the current rate: redemption pays sats at today's value.
   */
  usdCentsPerSat?: number
  /**
   * Fetches the backing inputs UNDER the per-wallet lock (see BACKING
   * INVARIANT). Takes precedence over maxLiabilityMinor/liabilityMinor/
   * usdCentsPerSat: the live balance must be read after the lock is held, or
   * a settlement (CLAIMED -> PAID) can land between the balance read and the
   * liability sum. Throw to abort (rolled back, nothing inserted).
   */
  backing?: () => Promise<BackingInputs>
}

interface BackingInputs {
  maxLiabilityMinor: number
  liabilityMinor: number
  usdCentsPerSat?: number
}

interface VoucherStats {
  total: number
  active: number
  claimed: number
  cancelled: number
  expired: number
  expiringSoon: number
}

interface VoucherRow {
  id: string
  amount_sats: string
  claimed: boolean
  claimed_at: string | null
  created_at: string
  expires_at: string
  expiry_id: string
  cancelled_at: string | null
  api_key_encrypted: string
  wallet_id: string
  commission_percent: string
  display_amount: string | null
  display_currency: string | null
  status: string
  environment: string | null
  wallet_currency: string | null
  usd_amount_cents: string | null
  [key: string]: unknown
}

/** Max vouchers returned by the owner-scoped listing (newest first). */
const OWNER_LIST_LIMIT = 500

// Database connection pool (delegates to shared pool)
function getPool() {
  return getSharedPool()
}

/**
 * Execute a query with parameters
 */
async function query(text: string, params?: unknown[]): Promise<QueryResult<VoucherRow>> {
  const start: number = Date.now()
  const result: QueryResult<VoucherRow> = await getPool().query(text, params)
  const duration: number = Date.now() - start

  if (duration > 1000) {
    console.warn(`[VoucherStore] Slow query (${duration}ms):`, text.substring(0, 100))
  }

  return result
}

class VoucherStore {
  lastCleanup: number
  CLEANUP_INTERVAL_MS: number

  constructor() {
    // Lazy cleanup flag - tracks when we last ran cleanup
    this.lastCleanup = 0
    this.CLEANUP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
  }

  /**
   * Run lazy cleanup if enough time has passed
   * Updates expired vouchers and removes old ones
   */
  async lazyCleanup(): Promise<void> {
    const now: number = Date.now()
    if (now - this.lastCleanup < this.CLEANUP_INTERVAL_MS) {
      return // Skip cleanup, ran recently
    }

    this.lastCleanup = now

    try {
      // Update expired vouchers
      const expiredResult: QueryResult<VoucherRow> = await query(
        `SELECT update_expired_vouchers()`,
      )
      const expiredCount: number =
        ((expiredResult.rows[0] as Record<string, unknown>)
          ?.update_expired_vouchers as number) || 0

      // Cleanup old vouchers
      const cleanedResult: QueryResult<VoucherRow> = await query(
        `SELECT cleanup_old_vouchers()`,
      )
      const cleanedCount: number =
        ((cleanedResult.rows[0] as Record<string, unknown>)
          ?.cleanup_old_vouchers as number) || 0

      if (expiredCount > 0 || cleanedCount > 0) {
        console.log(
          `[VoucherStore] Lazy cleanup: ${expiredCount} expired, ${cleanedCount} removed`,
        )
      }
    } catch (err: unknown) {
      console.error("[VoucherStore] Lazy cleanup error:", (err as Error).message)
    }
  }

  /**
   * Generate a unique charge ID
   * @returns 32-character hex string
   */
  generateChargeId(): string {
    return crypto.randomBytes(16).toString("hex")
  }

  /**
   * Get count of unclaimed vouchers for a wallet
   * Used to enforce MAX_UNCLAIMED_PER_WALLET limit
   * @param walletId - Wallet identifier
   * @returns Count of unclaimed vouchers
   */
  async getUnclaimedCountByWallet(walletId: string): Promise<number> {
    try {
      const result: QueryResult<VoucherRow> = await query(
        `SELECT COUNT(*) as count FROM vouchers 
         WHERE wallet_id = $1 AND status = 'ACTIVE'`,
        [walletId],
      )
      return parseInt(
        ((result.rows[0] as Record<string, unknown>)?.count as string) || "0",
        10,
      )
    } catch (err: unknown) {
      console.error(
        "[VoucherStore] getUnclaimedCountByWallet error:",
        (err as Error).message,
      )
      return 0
    }
  }

  /**
   * Create a new voucher
   * @param amount - Amount in sats
   * @param apiKey - Blink API key (will be encrypted)
   * @param walletId - Wallet ID
   * @param options - Additional options
   * @returns Created voucher object
   * @throws If wallet limit exceeded
   */
  async createVoucher(
    amount: number,
    apiKey: string,
    walletId: string,
    options: CreateVoucherOptions = {},
  ): Promise<Voucher> {
    // Check wallet limit
    const unclaimedCount: number = await this.getUnclaimedCountByWallet(walletId)
    if (unclaimedCount >= MAX_UNCLAIMED_PER_WALLET) {
      throw new Error(
        `Maximum unclaimed vouchers (${MAX_UNCLAIMED_PER_WALLET}) reached for this wallet`,
      )
    }

    const chargeId: string = this.generateChargeId()
    const now: number = Date.now()
    const expiryId: string = options.expiryId || DEFAULT_EXPIRY_ID
    const expiryMs: number = getExpiryMs(expiryId)
    const expiresAt: number = now + expiryMs
    const environment: string = options.environment || "production"
    const walletCurrency: string = options.walletCurrency || "BTC"
    const usdAmountCents: number | null = options.usdAmount || null

    // Validate USD voucher has usdAmount
    if (walletCurrency === "USD" && !usdAmountCents) {
      throw new Error("USD vouchers require usdAmount (in cents)")
    }

    // Encrypt API key for storage
    const apiKeyEncrypted: string = AuthManager.encryptApiKey(apiKey)

    const insertSql = `INSERT INTO vouchers
         (id, amount_sats, wallet_id, api_key_encrypted, status, claimed,
          created_at, expires_at, expiry_id, display_amount, display_currency, commission_percent, environment,
          wallet_currency, usd_amount_cents)
         VALUES ($1, $2, $3, $4, 'ACTIVE', false, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`
    const insertParams = [
      chargeId,
      amount,
      walletId,
      apiKeyEncrypted,
      now,
      expiresAt,
      expiryId,
      options.displayAmount || null,
      options.displayCurrency || null,
      options.commissionPercent || 0,
      environment,
      walletCurrency,
      usdAmountCents,
    ]

    try {
      let row: VoucherRow

      if (options.maxLiabilityMinor === undefined && !options.backing) {
        const result: QueryResult<VoucherRow> = await query(insertSql, insertParams)
        row = result.rows[0]
      } else {
        // Balance read, liability sum and insert must be atomic per wallet
        // (BACKING INVARIANT): serialize on the wallet, then fetch the live
        // balance and count existing liabilities inside the transaction.
        const client = await getPool().connect()
        try {
          await client.query("BEGIN")
          await client.query(LOCK_TIMEOUT_SQL)
          await client.query(WALLET_LOCK_SQL, [walletId])

          const backing: BackingInputs = options.backing
            ? await options.backing()
            : {
                maxLiabilityMinor: options.maxLiabilityMinor as number,
                liabilityMinor:
                  options.liabilityMinor ??
                  (walletCurrency === "USD" ? (usdAmountCents as number) : amount),
                usdCentsPerSat: options.usdCentsPerSat,
              }
          const liability: number = backing.liabilityMinor

          let existing: number
          if (walletCurrency === "USD") {
            // Only the display cents are persisted; existing USD vouchers
            // must be re-rated conservatively or the aggregate undercounts.
            const rate = backing.usdCentsPerSat
            if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
              throw new Error("USD liability check requires the current rate")
            }
            const existingResult = await client.query(ACTIVE_LIABILITY_SUM_SQL_USD, [
              walletId,
              now,
              rate,
            ])
            // numeric SUM can return "103.000000"; round UP (conservative).
            existing = Math.ceil(Number(existingResult.rows[0]?.total ?? 0))
          } else {
            const existingResult = await client.query(ACTIVE_LIABILITY_SUM_SQL_BTC, [
              walletId,
              now,
            ])
            existing = parseInt(String(existingResult.rows[0]?.total ?? "0"), 10)
          }
          if (existing + liability > backing.maxLiabilityMinor) {
            throw new Error("Voucher amount exceeds the wallet balance")
          }

          const result = await client.query(insertSql, insertParams)
          await client.query("COMMIT")
          row = result.rows[0] as VoucherRow
        } catch (txErr: unknown) {
          await client.query("ROLLBACK").catch(() => {})
          throw txErr
        } finally {
          client.release()
        }
      }

      const voucher: Voucher = this._rowToVoucher(row, apiKey) as Voucher // Pass original apiKey to avoid decryption

      const expiryDate: string = new Date(voucher.expiresAt).toISOString()
      const currencyInfo: string =
        walletCurrency === "USD"
          ? ` [USD: $${((usdAmountCents as number) / 100).toFixed(2)}]`
          : ""
      console.log(
        `[VoucherStore] Created voucher: ${chargeId} for ${amount} sats${currencyInfo}, expires: ${expiryDate}${options.commissionPercent ? ` (${options.commissionPercent}% commission)` : ""}${environment !== "production" ? ` [${environment}]` : ""}`,
      )

      return voucher
    } catch (err: unknown) {
      console.error("[VoucherStore] createVoucher error:", (err as Error).message)
      throw err
    }
  }

  /**
   * Convert database row to voucher object
   * @param row - Database row
   * @param decryptedApiKey - Optional pre-decrypted API key
   * @returns Voucher object
   */
  _rowToVoucher(
    row: VoucherRow | null,
    decryptedApiKey: string | null = null,
    decrypt: boolean = true,
  ): Voucher | null {
    if (!row) return null

    return {
      id: row.id,
      amount: parseInt(row.amount_sats, 10),
      claimed: row.claimed,
      claimedAt: row.claimed_at ? parseInt(row.claimed_at, 10) : null,
      createdAt: parseInt(row.created_at, 10),
      expiresAt: parseInt(row.expires_at, 10),
      expiryId: row.expiry_id,
      cancelledAt: row.cancelled_at ? parseInt(row.cancelled_at, 10) : null,
      apiKey:
        decryptedApiKey ||
        (decrypt ? AuthManager.decryptApiKey(row.api_key_encrypted) : null),
      walletId: row.wallet_id,
      commissionPercent: parseFloat(row.commission_percent) || 0,
      displayAmount: row.display_amount,
      displayCurrency: row.display_currency,
      status: row.status,
      environment: row.environment || "production",
      // USD voucher fields
      walletCurrency: row.wallet_currency || "BTC",
      usdAmountCents: row.usd_amount_cents ? parseInt(row.usd_amount_cents, 10) : null,
    }
  }

  /**
   * Get voucher by charge ID
   * Returns null for expired, cancelled, or non-existent vouchers
   * @param chargeId - Voucher charge ID
   * @returns Voucher object or null
   */
  async getVoucher(chargeId: string): Promise<Voucher | null> {
    try {
      // Run lazy cleanup
      await this.lazyCleanup()

      const now: number = Date.now()

      // Get active, non-expired voucher
      const result: QueryResult<VoucherRow> = await query(
        `SELECT * FROM vouchers 
         WHERE id = $1 
           AND status = 'ACTIVE' 
           AND NOT claimed
           AND expires_at > $2`,
        [chargeId, now],
      )

      if (result.rows.length === 0) {
        console.log(`[VoucherStore] Voucher not found or not active: ${chargeId}`)
        return null
      }

      return this._rowToVoucher(result.rows[0])
    } catch (err: unknown) {
      console.error("[VoucherStore] getVoucher error:", (err as Error).message)
      return null
    }
  }

  /**
   * Get voucher by charge ID (including cancelled/expired for history)
   * @param chargeId - Voucher charge ID
   * @returns Voucher object with status or null
   */
  async getVoucherWithStatus(chargeId: string): Promise<Voucher | null> {
    try {
      const result: QueryResult<VoucherRow> = await query(
        `SELECT * FROM vouchers WHERE id = $1`,
        [chargeId],
      )

      if (result.rows.length === 0) {
        return null
      }

      const voucher: Voucher | null = this._rowToVoucher(result.rows[0])

      if (voucher) {
        // Recalculate status in case it's stale (e.g., expired but not updated)
        voucher.status = getVoucherStatus(voucher)
      }

      return voucher
    } catch (err: unknown) {
      console.error("[VoucherStore] getVoucherWithStatus error:", (err as Error).message)
      return null
    }
  }

  /**
   * Mark voucher as claimed (atomic operation)
   * @param chargeId - Voucher charge ID
   * @returns Success
   */
  async claimVoucher(chargeId: string): Promise<boolean> {
    try {
      const now: number = Date.now()

      // Atomic update - only claims if ACTIVE and not already claimed
      const result: QueryResult<VoucherRow> = await query(CLAIM_VOUCHER_SQL, [
        chargeId,
        now,
      ])

      if (result.rowCount === 0) {
        console.log(`[VoucherStore] Cannot claim voucher: ${chargeId}`)
        return false
      }

      console.log(`[VoucherStore] Voucher claimed: ${chargeId}`)
      return true
    } catch (err: unknown) {
      console.error("[VoucherStore] claimVoucher error:", (err as Error).message)
      return false
    }
  }

  /**
   * Mark a claimed voucher paid after the redemption payment settled
   * (SUCCESS only — ALREADY_PAID leaves no net debit). Settled vouchers must
   * leave the liability
   * aggregate — Blink has already debited the wallet (PR #94 review).
   * PENDING/unknown outcomes stay CLAIMED (counted) by simply not calling
   * this. claimed stays true: the voucher was redeemed.
   *
   * @param chargeId - Voucher charge ID
   * @returns Success (false if the voucher was not CLAIMED)
   */
  async markVoucherPaid(chargeId: string): Promise<boolean> {
    // Under the wallet lock (BACKING INVARIANT): this removes a liability
    // after a debit, so it must not land between a creation's balance read
    // and its liability sum. The payment has already executed, so losing the
    // lock race to a (bounded) create must not lose the settlement: retry a
    // few times on lock timeout before giving up (the voucher then stays
    // CLAIMED — counted — until reconciliation).
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.tryMarkVoucherPaid(chargeId)
      if (outcome !== "lock-timeout") return outcome
      if (attempt > MARK_PAID_LOCK_RETRIES) {
        console.error(
          `[VoucherStore] markVoucherPaid gave up after ${attempt} lock timeouts: ${chargeId}`,
        )
        return false
      }
      console.warn(
        `[VoucherStore] markVoucherPaid lock timeout (attempt ${attempt}), retrying: ${chargeId}`,
      )
      await new Promise((resolve) => setTimeout(resolve, MARK_PAID_RETRY_DELAY_MS))
    }
  }

  /** One locked CLAIMED -> PAID attempt. */
  private async tryMarkVoucherPaid(chargeId: string): Promise<boolean | "lock-timeout"> {
    const client = await getPool().connect()
    try {
      await client.query("BEGIN")
      await client.query(LOCK_TIMEOUT_SQL)
      const owner = await client.query("SELECT wallet_id FROM vouchers WHERE id = $1", [
        chargeId,
      ])
      const walletId: string | undefined = owner.rows[0]?.wallet_id
      if (!walletId) {
        await client.query("ROLLBACK")
        console.error(`[VoucherStore] Cannot mark voucher paid (not found): ${chargeId}`)
        return false
      }
      await client.query(WALLET_LOCK_SQL, [walletId])

      const result = await client.query(MARK_VOUCHER_PAID_SQL, [chargeId])
      await client.query("COMMIT")

      if (result.rowCount === 0) {
        console.error(
          `[VoucherStore] Cannot mark voucher paid (not CLAIMED): ${chargeId}`,
        )
        return false
      }

      console.log(`[VoucherStore] Voucher paid: ${chargeId}`)
      return true
    } catch (err: unknown) {
      await client.query("ROLLBACK").catch(() => {})
      if (isLockTimeout(err)) return "lock-timeout"
      console.error("[VoucherStore] markVoucherPaid error:", (err as Error).message)
      return false
    } finally {
      client.release()
    }
  }

  /**
   * Unclaim voucher (rollback after payment failure)
   * @param chargeId - Voucher charge ID
   * @returns Success
   */
  async unclaimVoucher(chargeId: string): Promise<boolean> {
    try {
      const now: number = Date.now()

      // Only unclaim if recently claimed and not expired
      const result: QueryResult<VoucherRow> = await query(
        `UPDATE vouchers 
         SET claimed = false, claimed_at = NULL, status = 'ACTIVE'
         WHERE id = $1 
           AND status = 'CLAIMED'
           AND expires_at > $2
         RETURNING id`,
        [chargeId, now],
      )

      if (result.rowCount === 0) {
        console.log(`[VoucherStore] Cannot unclaim voucher: ${chargeId}`)
        return false
      }

      console.log(`[VoucherStore] Voucher unclaimed (payment failed): ${chargeId}`)
      return true
    } catch (err: unknown) {
      console.error("[VoucherStore] unclaimVoucher error:", (err as Error).message)
      return false
    }
  }

  /**
   * Cancel a voucher (mark as cancelled, keep in history)
   * @param chargeId - Voucher charge ID
   * @returns Success
   */
  async cancelVoucher(chargeId: string): Promise<boolean> {
    try {
      const now: number = Date.now()

      const result: QueryResult<VoucherRow> = await query(
        `UPDATE vouchers 
         SET cancelled_at = $2, status = 'CANCELLED'
         WHERE id = $1 
           AND status = 'ACTIVE' 
           AND NOT claimed
         RETURNING id`,
        [chargeId, now],
      )

      if (result.rowCount === 0) {
        console.log(`[VoucherStore] Cannot cancel voucher: ${chargeId}`)
        return false
      }

      console.log(`[VoucherStore] Voucher cancelled: ${chargeId}`)
      return true
    } catch (err: unknown) {
      console.error("[VoucherStore] cancelVoucher error:", (err as Error).message)
      return false
    }
  }

  /**
   * Get the vouchers drawn from any of `walletIds` in `environment`
   * (owner-scoped listing). Stored API keys are NOT decrypted.
   * @param walletIds - Wallet ids the caller currently owns
   * @param environment - 'production' or 'staging'
   * @param limit - Max rows, newest first (default/max OWNER_LIST_LIMIT)
   * @returns Array of voucher objects with status (apiKey always null)
   */
  async getVouchersByWalletIds(
    walletIds: string[],
    environment: string,
    limit: number = OWNER_LIST_LIMIT,
  ): Promise<Voucher[]> {
    if (walletIds.length === 0) return []
    try {
      await this.lazyCleanup()

      const result: QueryResult<VoucherRow> = await query(
        `SELECT * FROM vouchers
         WHERE COALESCE(environment, 'production') = $2
           AND wallet_id = ANY($1)
         ORDER BY created_at DESC
         LIMIT $3`,
        [walletIds, environment, Math.min(Math.max(1, limit), OWNER_LIST_LIMIT)],
      )

      return result.rows.map((row: VoucherRow) => {
        const voucher: Voucher = this._rowToVoucher(row, null, false) as Voucher
        voucher.status = getVoucherStatus(voucher)
        return voucher
      })
    } catch (err: unknown) {
      console.error(
        "[VoucherStore] getVouchersByWalletIds error:",
        (err as Error).message,
      )
      throw err
    }
  }

  /**
   * Status counts over ALL vouchers drawn from `walletIds` in `environment`
   * (not capped like the listing). Mirrors getVoucherStatus():
   * claimed > cancelled > expired > active.
   */
  async getVoucherStatsByWalletIds(
    walletIds: string[],
    environment: string,
  ): Promise<VoucherStats> {
    const empty: VoucherStats = {
      total: 0,
      active: 0,
      claimed: 0,
      cancelled: 0,
      expired: 0,
      expiringSoon: 0,
    }
    if (walletIds.length === 0) return empty

    const now = Date.now()
    const result = await query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE claimed) AS claimed,
         COUNT(*) FILTER (WHERE NOT claimed AND cancelled_at IS NOT NULL) AS cancelled,
         COUNT(*) FILTER (
           WHERE NOT claimed AND cancelled_at IS NULL AND expires_at < $3
         ) AS expired,
         COUNT(*) FILTER (
           WHERE NOT claimed AND cancelled_at IS NULL AND expires_at >= $3
         ) AS active,
         COUNT(*) FILTER (
           WHERE NOT claimed AND cancelled_at IS NULL
             AND expires_at >= $3 AND expires_at < $4
         ) AS expiring_soon
       FROM vouchers
       WHERE COALESCE(environment, 'production') = $2
         AND wallet_id = ANY($1)`,
      [walletIds, environment, now, now + 24 * 60 * 60 * 1000],
    )
    const row = (result.rows[0] ?? {}) as Record<string, unknown>
    const n = (value: unknown): number => parseInt(String(value ?? 0), 10) || 0
    return {
      total: n(row.total),
      active: n(row.active),
      claimed: n(row.claimed),
      cancelled: n(row.cancelled),
      expired: n(row.expired),
      expiringSoon: n(row.expiring_soon),
    }
  }

  /**
   * Get all vouchers (for listing/management)
   * @returns Array of voucher objects with status
   */
  async getAllVouchers(): Promise<Voucher[]> {
    try {
      // Run lazy cleanup first
      await this.lazyCleanup()

      const result: QueryResult<VoucherRow> = await query(
        `SELECT * FROM vouchers ORDER BY created_at DESC`,
      )

      return result.rows.map((row: VoucherRow) => {
        const voucher: Voucher = this._rowToVoucher(row) as Voucher
        // Recalculate status in case it's stale
        voucher.status = getVoucherStatus(voucher)
        return voucher
      })
    } catch (err: unknown) {
      console.error("[VoucherStore] getAllVouchers error:", (err as Error).message)
      return []
    }
  }

  /**
   * Get store statistics
   * @returns Stats object
   */
  async getStats(): Promise<VoucherStats> {
    try {
      // Update expired vouchers first
      await query(`SELECT update_expired_vouchers()`)

      const result: QueryResult<VoucherRow> = await query(`SELECT * FROM voucher_stats`)

      if (result.rows.length === 0) {
        return {
          total: 0,
          active: 0,
          claimed: 0,
          cancelled: 0,
          expired: 0,
          expiringSoon: 0,
        }
      }

      const row: Record<string, unknown> = result.rows[0] as Record<string, unknown>
      return {
        total: parseInt(row.total as string, 10),
        active: parseInt(row.active as string, 10),
        claimed: parseInt(row.claimed as string, 10),
        cancelled: parseInt(row.cancelled as string, 10),
        expired: parseInt(row.expired as string, 10),
        expiringSoon: parseInt(row.expiring_soon as string, 10),
      }
    } catch (err: unknown) {
      console.error("[VoucherStore] getStats error:", (err as Error).message)
      return {
        total: 0,
        active: 0,
        claimed: 0,
        cancelled: 0,
        expired: 0,
        expiringSoon: 0,
      }
    }
  }

  /**
   * Cleanup old vouchers based on retention policies
   * Called lazily, not on interval
   * @returns Number of vouchers cleaned up
   */
  async cleanup(): Promise<number> {
    try {
      const result: QueryResult<VoucherRow> = await query(`SELECT cleanup_old_vouchers()`)
      const cleaned: number =
        ((result.rows[0] as Record<string, unknown>)?.cleanup_old_vouchers as number) || 0

      if (cleaned > 0) {
        console.log(`[VoucherStore] Cleanup: removed ${cleaned} old voucher(s)`)
      }

      return cleaned
    } catch (err: unknown) {
      console.error("[VoucherStore] cleanup error:", (err as Error).message)
      return 0
    }
  }
}

// Export singleton instance
const voucherStore: VoucherStore = new VoucherStore()
export default voucherStore
export { VoucherStore, OWNER_LIST_LIMIT }

export type { Voucher, CreateVoucherOptions, BackingInputs, VoucherStats, VoucherRow }
