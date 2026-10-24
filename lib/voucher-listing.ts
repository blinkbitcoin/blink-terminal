/**
 * Owner voucher listing: SQL, status filters and the page cursor
 * (blink-wip#1617). Pure — no database or auth imports — so the route, the
 * store and tests share it without pulling in lib/auth.
 */

import crypto from "crypto"

/** Max vouchers per owner-listing page (newest first). */
export const OWNER_LIST_LIMIT = 500

/**
 * Status filters for the owner listing, in SQL. They mirror getVoucherStatus()
 * (lib/voucher-expiry.ts): PAID > CLAIMED > CANCELLED > EXPIRED > ACTIVE.
 * CLAIMED is the redeemed bucket (CLAIMED + PAID), like voucher_stats and
 * the dashboard. $NOW is replaced by the parameter holding "now" (ms).
 * Fixed strings only: no caller input reaches the SQL text.
 */
export const OWNER_STATUS_SQL = {
  PAID: "status = 'PAID'",
  CLAIMED: "(status = 'PAID' OR claimed)",
  CANCELLED: "(status <> 'PAID' AND NOT claimed AND cancelled_at IS NOT NULL)",
  EXPIRED:
    "(status <> 'PAID' AND NOT claimed AND cancelled_at IS NULL AND expires_at < $NOW)",
  ACTIVE:
    "(status <> 'PAID' AND NOT claimed AND cancelled_at IS NULL AND expires_at >= $NOW)",
} as const

export type OwnerListStatus = keyof typeof OWNER_STATUS_SQL

export const OWNER_LIST_STATUSES = Object.keys(OWNER_STATUS_SQL) as OwnerListStatus[]

/**
 * Tiebreak for equal created_at: SHA-256 of the voucher id, never the id
 * itself. Voucher ids are LNURL-withdraw redemption secrets, and the cursor
 * travels in request URLs (and so in proxy / ingress / trace logs); a hash of
 * a 128-bit random id reveals nothing. convert_to (not ::bytea, which reads
 * backslash escapes) hashes the same UTF-8 bytes as voucherTiebreak().
 */
const TIEBREAK_SQL = "encode(sha256(convert_to(id, 'UTF8')), 'hex')"

/** The listing's tiebreak for a voucher id (matches TIEBREAK_SQL). */
export function voucherTiebreak(id: string): string {
  return crypto.createHash("sha256").update(id, "utf8").digest("hex")
}

/**
 * Owner-scoped listing, newest first, keyset-paginated on
 * (created_at, sha256(id)) (created_at alone can tie). Shaped for
 * idx_vouchers_env_wallet_created (migration 021); exported so the Postgres
 * suite can EXPLAIN the exact statements. $1 = wallet ids (text[]),
 * $2 = environment, $3 = limit, then (with a cursor) $4 = created_at,
 * $5 = tiebreak, then (EXPIRED / ACTIVE) now.
 */
export function ownerListingSql({
  cursor = false,
  status,
}: { cursor?: boolean; status?: OwnerListStatus } = {}): string {
  const where = [`COALESCE(environment, 'production') = $2`, `wallet_id = ANY($1)`]
  let next = 4
  if (cursor) {
    where.push(`(created_at < $4 OR (created_at = $4 AND ${TIEBREAK_SQL} < $5))`)
    next = 6
  }
  if (status) where.push(OWNER_STATUS_SQL[status].replace("$NOW", `$${next}`))
  return `SELECT * FROM vouchers
   WHERE ${where.join("\n     AND ")}
   ORDER BY created_at DESC, ${TIEBREAK_SQL} DESC
   LIMIT $3`
}

export const OWNER_LISTING_SQL = ownerListingSql()

/**
 * Position after a voucher in the owner listing:
 * "<created_at>_<sha256(id) hex>". Contains no voucher id.
 */
export interface VoucherCursor {
  createdAt: number
  tiebreak: string
}

export function encodeVoucherCursor(v: { createdAt: number; id: string }): string {
  return `${v.createdAt}_${voucherTiebreak(v.id)}`
}

/** Parses a cursor from a request; null if malformed. */
export function decodeVoucherCursor(value: unknown): VoucherCursor | null {
  if (typeof value !== "string") return null
  const m = /^(\d{1,16})_([0-9a-f]{64})$/.exec(value)
  if (!m) return null
  const createdAt = Number(m[1])
  return Number.isSafeInteger(createdAt) ? { createdAt, tiebreak: m[2] } : null
}
