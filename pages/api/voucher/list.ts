import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"
import {
  getOwnedWallets,
  getVoucherApiKey,
  OWNERSHIP_UNAVAILABLE,
  toEnvironment,
} from "../../../lib/voucher-auth"
import {
  decodeVoucherCursor,
  encodeVoucherCursor,
  OWNER_LIST_LIMIT,
  OWNER_LIST_STATUSES,
  type OwnerListStatus,
} from "../../../lib/voucher-listing"
import voucherStore from "../../../lib/voucher-store"

/** Shape of a voucher record from the store */
interface VoucherRecord {
  id: string
  amount: number
  claimed: boolean
  createdAt: number
  claimedAt?: number | null
  expiresAt?: number | null
  expiryId?: string | null
  cancelledAt?: number | null
  displayAmount?: string | null
  displayCurrency?: string | null
  commissionPercent?: number
  status: string
  walletCurrency?: string
  usdAmountCents?: number | null
}

/**
 * API endpoint to list the caller's vouchers
 *
 * GET /api/voucher/list
 * Header: x-voucher-api-key: <voucher wallet API key>
 * Returns the vouchers drawn from wallets the key's account currently owns
 * (checked live against Blink), with status information (ACTIVE, CLAIMED,
 * PAID, CANCELLED, EXPIRED). Voucher ids are LNURL-withdraw redemption secrets, so
 * they are never returned to anyone but the current owner. Same-origin only.
 *
 * Query params:
 * - environment: 'production' (default) or 'staging'
 * - status: Filter by status (optional): 'ACTIVE', 'CLAIMED', 'PAID', 'CANCELLED',
 *   'EXPIRED', 'all'. CLAIMED is the redeemed bucket (CLAIMED + PAID); PAID
 *   alone is settled redemptions only. Default: returns all vouchers.
 *   Applied in the query, so older matches stay reachable page by page.
 * - limit: page size, 1..OWNER_LIST_LIMIT (default OWNER_LIST_LIMIT, as before
 *   pagination existed, so clients that do not page keep getting 500)
 * - before: the previous page's `nextCursor` (blink-wip#1617)
 *
 * Newest first. `nextCursor` is null on the last page (`truncated` mirrors
 * it for older clients). Stats always cover all of the caller's vouchers.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store")

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const apiKey = getVoucherApiKey(req)
  if (!apiKey) {
    return res.status(401).json({ error: "Voucher wallet API key required" })
  }

  const environment = toEnvironment(req.query.environment)
  const ownership = await getOwnedWallets(apiKey, environment)
  if (!ownership.ok) {
    return ownership.reason === "invalid"
      ? res.status(401).json({ error: "Voucher wallet API key is not valid" })
      : res.status(OWNERSHIP_UNAVAILABLE.status).json(OWNERSHIP_UNAVAILABLE.body)
  }
  const ownedWallets = ownership.wallets

  const rawStatus =
    typeof req.query.status === "string" ? req.query.status.toUpperCase() : "ALL"
  if (
    rawStatus !== "ALL" &&
    !OWNER_LIST_STATUSES.includes(rawStatus as OwnerListStatus)
  ) {
    return res.status(400).json({ error: "Invalid status filter" })
  }
  const status = rawStatus === "ALL" ? undefined : (rawStatus as OwnerListStatus)

  const rawLimit = req.query.limit
  const limit = rawLimit === undefined ? OWNER_LIST_LIMIT : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > OWNER_LIST_LIMIT) {
    return res.status(400).json({ error: `limit must be 1-${OWNER_LIST_LIMIT}` })
  }

  const before =
    req.query.before === undefined ? null : decodeVoucherCursor(req.query.before)
  if (req.query.before !== undefined && !before) {
    return res.status(400).json({ error: "Invalid cursor" })
  }

  try {
    const now = Date.now()

    // Only vouchers drawn from wallets the caller currently owns. One extra
    // row tells whether there is a next page.
    const page: VoucherRecord[] = await voucherStore.getVouchersByWalletIds(
      [...ownedWallets.keys()],
      environment,
      limit + 1,
      { before, status },
    )
    const hasMore = page.length > limit
    const pageVouchers = hasMore ? page.slice(0, limit) : page
    const last = pageVouchers[pageVouchers.length - 1]
    const nextCursor = hasMore && last ? encodeVoucherCursor(last) : null

    // Format vouchers for response
    const vouchers = pageVouchers.map((voucher: VoucherRecord) => {
      // Calculate time remaining for active vouchers
      let timeRemaining: number | null = null
      if (voucher.status === "ACTIVE" && voucher.expiresAt) {
        timeRemaining = Math.max(0, voucher.expiresAt - now)
      }

      return {
        id: voucher.id,
        shortId: voucher.id.substring(0, 8).toUpperCase(),
        amount: voucher.amount,
        claimed: voucher.claimed,
        createdAt: voucher.createdAt,
        claimedAt: voucher.claimedAt,
        expiresAt: voucher.expiresAt,
        expiryId: voucher.expiryId,
        cancelledAt: voucher.cancelledAt,
        displayAmount: voucher.displayAmount,
        displayCurrency: voucher.displayCurrency,
        commissionPercent: voucher.commissionPercent || 0,
        timeRemaining: timeRemaining,
        status: voucher.status,
        // USD voucher fields
        walletCurrency: voucher.walletCurrency || "BTC",
        usdAmountCents: voucher.usdAmountCents || null,
      }
    })

    // Stats cover all of the caller's vouchers, not just this page
    const stats = await voucherStore.getVoucherStatsByWalletIds(
      [...ownedWallets.keys()],
      environment,
    )

    return res.status(200).json({
      success: true,
      vouchers: vouchers,
      count: vouchers.length,
      nextCursor,
      // Older clients: more vouchers exist beyond this page.
      truncated: nextCursor !== null,
      stats: stats,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Voucher list error:", error)

    res.status(500).json({
      error: "Failed to list vouchers",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "voucher/list")
