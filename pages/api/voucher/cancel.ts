import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"
import {
  getOwnedWallets,
  getVoucherApiKey,
  toEnvironment,
} from "../../../lib/voucher-auth"
import voucherStore from "../../../lib/voucher-store"

/**
 * API endpoint to cancel a voucher
 *
 * POST /api/voucher/cancel
 * Header: x-voucher-api-key: <API key whose account currently owns the
 *         voucher's wallet (checked live against Blink)>
 * Body: { chargeId: string }
 *
 * Returns:
 * - 200: { success: true }
 * - 400: { error: string } - Invalid request or voucher state
 * - 401: { error: string } - Missing API key
 * - 404: { error: string } - Voucher not found (or not owned by the caller)
 * - 405: { error: string } - Method not allowed
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const apiKey = getVoucherApiKey(req)
  if (!apiKey) {
    return res.status(401).json({ error: "Voucher wallet API key required" })
  }

  try {
    const { chargeId } = (req.body ?? {}) as { chargeId?: unknown }

    // Validate required field
    if (!chargeId || typeof chargeId !== "string") {
      return res.status(400).json({
        error: "Missing required field: chargeId",
      })
    }

    // Get voucher with status to check current state (async)
    const voucher = await voucherStore.getVoucherWithStatus(chargeId)

    // Ownership is checked live in the voucher's own environment. Same
    // response for "doesn't exist", "not yours" and "key not valid" (no oracle).
    const ownedWallets = voucher
      ? await getOwnedWallets(apiKey, toEnvironment(voucher.environment))
      : null
    if (!voucher || !ownedWallets?.has(voucher.walletId)) {
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
