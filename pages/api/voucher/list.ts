import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"
import {
  getOwnedWallets,
  getVoucherApiKey,
  OWNERSHIP_UNAVAILABLE,
  toEnvironment,
} from "../../../lib/voucher-auth"
import { isRedeemedStatus } from "../../../lib/voucher-expiry"
import voucherStore, { OWNER_LIST_LIMIT } from "../../../lib/voucher-store"

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
 *   alone is settled redemptions only. Default: returns all vouchers
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

  try {
    const filterStatus =
      typeof req.query.status === "string" ? req.query.status : undefined
    const now = Date.now()

    // Only vouchers drawn from wallets the caller currently owns
    const allVouchers: VoucherRecord[] = await voucherStore.getVouchersByWalletIds(
      [...ownedWallets.keys()],
      environment,
    )

    // Format vouchers for response
    let vouchers = allVouchers.map((voucher: VoucherRecord) => {
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

    // Filter by status if requested
    if (filterStatus && filterStatus !== "all") {
      const validStatuses = ["ACTIVE", "CLAIMED", "PAID", "CANCELLED", "EXPIRED"]
      const normalizedFilter = filterStatus.toUpperCase()

      if (validStatuses.includes(normalizedFilter)) {
        // PAID is terminal CLAIMED: the redeemed bucket covers both, matching
        // voucher_stats and the dashboard UI.
        vouchers = vouchers.filter((v: VoucherRecord) =>
          normalizedFilter === "CLAIMED"
            ? isRedeemedStatus(v.status)
            : v.status === normalizedFilter,
        )
      }
    }

    // Stats cover all of the caller's vouchers, not just the capped list
    const stats = await voucherStore.getVoucherStatsByWalletIds(
      [...ownedWallets.keys()],
      environment,
    )

    return res.status(200).json({
      success: true,
      vouchers: vouchers,
      count: vouchers.length,
      // The listing is capped (newest first); stats are not.
      truncated: allVouchers.length >= OWNER_LIST_LIMIT,
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
