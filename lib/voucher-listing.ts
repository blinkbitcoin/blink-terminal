/**
 * Owner voucher listing: SQL, status filters and the page cursor
 * (blink-wip#1617). Pure — no database or auth imports — so the route, the
 * store and tests share it without pulling in lib/auth.
 */

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
 * Owner-scoped listing, newest first, keyset-paginated on (created_at, id)
 * (created_at alone can tie). Shaped for idx_vouchers_env_wallet_created
 * (migration 021); exported so the Postgres suite can EXPLAIN the exact
 * statements. $1 = wallet ids (text[]), $2 = environment, $3 = limit,
 * then (with a cursor) $4 = created_at, $5 = id, then (EXPIRED / ACTIVE) now.
 */
export function ownerListingSql({
  cursor = false,
  status,
}: { cursor?: boolean; status?: OwnerListStatus } = {}): string {
  const where = [`COALESCE(environment, 'production') = $2`, `wallet_id = ANY($1)`]
  let next = 4
  if (cursor) {
    where.push(`(created_at < $4 OR (created_at = $4 AND id < $5))`)
    next = 6
  }
  if (status) where.push(OWNER_STATUS_SQL[status].replace("$NOW", `$${next}`))
  return `SELECT * FROM vouchers
   WHERE ${where.join("\n     AND ")}
   ORDER BY created_at DESC, id DESC
   LIMIT $3`
}

export const OWNER_LISTING_SQL = ownerListingSql()

/** Position after a voucher in the owner listing: "<created_at>_<id>". */
export interface VoucherCursor {
  createdAt: number
  id: string
}

export function encodeVoucherCursor(v: { createdAt: number; id: string }): string {
  return `${v.createdAt}_${v.id}`
}

/** Parses a cursor from a request; null if malformed. */
export function decodeVoucherCursor(value: unknown): VoucherCursor | null {
  if (typeof value !== "string") return null
  const m = /^(\d{1,16})_([A-Za-z0-9-]{1,32})$/.exec(value)
  if (!m) return null
  const createdAt = Number(m[1])
  return Number.isSafeInteger(createdAt) ? { createdAt, id: m[2] } : null
}
