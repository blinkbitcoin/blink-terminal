import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"
import voucherStore from "../../../lib/voucher-store"

/**
 * API endpoint to cancel a voucher
 *
 * POST /api/voucher/cancel
 * Body: { chargeId: string }
 *
 * Returns:
 * - 200: { success: true }
 * - 400: { error: string } - Invalid request or voucher state
 * - 404: { error: string } - Voucher not found
 * - 405: { error: string } - Method not allowed
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Add CORS headers for compatibility
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { chargeId } = req.body as { chargeId: string }

    // Validate required field
    if (!chargeId) {
      return res.status(400).json({
        error: "Missing required field: chargeId",
      })
    }

    // Get voucher with status to check current state (async)
    const voucher = await voucherStore.getVoucherWithStatus(chargeId)

    if (!voucher) {
      return res.status(404).json({
        error: "Voucher not found",
      })
    }

    // Check if already claimed
    if (voucher.claimed) {
      return res.status(400).json({
        error: "Cannot cancel - voucher has already been claimed",
      })
    }

    // Check if already cancelled
    if (voucher.cancelledAt) {
      return res.status(400).json({
        error: "Voucher is already cancelled",
      })
    }

    // Cancel the voucher (async)
    const success = await voucherStore.cancelVoucher(chargeId)

    if (!success) {
      return res.status(500).json({
        error: "Failed to cancel voucher",
      })
    }

    console.log("🚫 Voucher cancelled via API:", chargeId)

    res.status(200).json({
      success: true,
      message: "Voucher cancelled successfully",
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Voucher cancellation error:", error)

    res.status(500).json({
      error: "Failed to cancel voucher",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "voucher/cancel")
