import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_READ } from "../../../../lib/rate-limit"
import voucherStore from "../../../../lib/voucher-store"

/**
 * API endpoint to check voucher status
 * Used for polling to detect when voucher has been redeemed
 *
 * GET /api/voucher/status/[chargeId]
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Add CORS headers for compatibility
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { chargeId } = req.query as { chargeId: string }

    if (!chargeId) {
      return res.status(400).json({
        error: "Missing chargeId parameter",
      })
    }

    // Get voucher from store (PostgreSQL)
    // Use getVoucherWithStatus to include claimed/cancelled/expired vouchers
    // so the polling client can detect when redemption succeeds
    const voucher = await voucherStore.getVoucherWithStatus(chargeId)

    if (!voucher) {
      // Voucher truly doesn't exist
      return res.status(200).json({
        found: false,
        status: "NOT_FOUND",
        claimed: false,
      })
    }

    return res.status(200).json({
      found: true,
      status: voucher.status,
      claimed: voucher.claimed || voucher.status === "CLAIMED",
      amount: voucher.amount,
      createdAt: voucher.createdAt,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Voucher status check error:", error)

    res.status(500).json({
      error: "Failed to check voucher status",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "voucher/status/[chargeId]")
