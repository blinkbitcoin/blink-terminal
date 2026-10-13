import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"
import { apiKeyMatches, getVoucherApiKey } from "../../../lib/voucher-auth"
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
  apiKey?: string | null
}

/**
 * API endpoint to list the caller's vouchers
 *
 * GET /api/voucher/list
 * Header: x-voucher-api-key: <voucher wallet API key>
 * Returns only vouchers created with that API key, with status information
 * (ACTIVE, CLAIMED, CANCELLED, EXPIRED). Voucher ids are LNURL-withdraw
 * redemption secrets, so they are never returned to anyone but the owner.
 *
 * Query params:
 * - status: Filter by status (optional): 'ACTIVE', 'CLAIMED', 'CANCELLED', 'EXPIRED', 'all'
 *   Default: returns all vouchers
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

  try {
    const { status: filterStatus } = req.query as { status?: string }
    const now = Date.now()

    // Only the caller's vouchers (those funded by the presented API key)
    const allVouchers = (await voucherStore.getAllVouchers()).filter(
      (voucher: VoucherRecord) => apiKeyMatches(voucher.apiKey, apiKey),
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
      const validStatuses = ["ACTIVE", "CLAIMED", "CANCELLED", "EXPIRED"]
      const normalizedFilter = filterStatus.toUpperCase()

      if (validStatuses.includes(normalizedFilter)) {
        vouchers = vouchers.filter((v: VoucherRecord) => v.status === normalizedFilter)
      }
    }

    // Calculate summary stats
    const stats = {
      total: allVouchers.length,
      active: allVouchers.filter((v: VoucherRecord) => v.status === "ACTIVE").length,
      claimed: allVouchers.filter((v: VoucherRecord) => v.status === "CLAIMED").length,
      cancelled: allVouchers.filter((v: VoucherRecord) => v.status === "CANCELLED")
        .length,
      expired: allVouchers.filter((v: VoucherRecord) => v.status === "EXPIRED").length,
      // Count vouchers expiring within 24 hours
      expiringSoon: allVouchers.filter(
        (v: VoucherRecord) =>
          v.status === "ACTIVE" && v.expiresAt && v.expiresAt - now < 24 * 60 * 60 * 1000,
      ).length,
    }

    return res.status(200).json({
      success: true,
      vouchers: vouchers,
      count: vouchers.length,
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
