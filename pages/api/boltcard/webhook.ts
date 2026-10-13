import type { NextApiRequest, NextApiResponse } from "next"

import * as boltcard from "../../../lib/boltcard"
import { isBoltcardSpendEnabled } from "../../../lib/config/features"

/**
 * Webhook endpoint for Boltcard payment notifications
 *
 * POST /api/boltcard/webhook
 *
 * This endpoint can be called directly for boltcard top-up notifications.
 * However, the primary integration is via the main Blink webhook (/api/blink/webhook)
 * which checks for boltcard top-ups before processing normal BlinkPOS forwarding.
 *
 * Body:
 * {
 *   paymentHash: string,
 *   status: 'PAID' | 'PENDING' | 'FAILED',
 *   ...
 * }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isBoltcardSpendEnabled()) {
    return res.status(503).json({
      status: "ERROR",
      reason: "Bolt Card payments are temporarily unavailable",
    })
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { paymentHash, status } = req.body as { paymentHash?: string; status?: string }

    if (!paymentHash) {
      return res.status(400).json({ error: "Missing paymentHash" })
    }

    console.log("[Boltcard Webhook] Received:", {
      paymentHash: paymentHash.substring(0, 16) + "...",
      status,
    })

    // Only process paid invoices
    if (status !== "PAID") {
      console.log("[Boltcard Webhook] Ignoring non-PAID status:", status)
      return res.status(200).json({ ok: true, message: "Ignored non-PAID status" })
    }

    // Check if this is a pending top-up (now uses database)
    const pendingTopUp = await boltcard.lnurlp.getPendingTopUp(paymentHash)

    if (!pendingTopUp) {
      console.log(
        "[Boltcard Webhook] No pending top-up found for:",
        paymentHash.substring(0, 16) + "...",
      )
      // Return 404 to indicate this payment hash doesn't match any pending top-up
      // This helps debugging and prevents silent failures
      return res.status(404).json({
        ok: false,
        error: "No pending top-up found for this payment hash",
      })
    }

    // Process the top-up
    const result = await boltcard.lnurlp.processTopUpPayment(paymentHash)

    if (result.success) {
      console.log("✅ [Boltcard Webhook] Top-up processed:", {
        cardId: result.cardId,
        amount: result.amount,
        newBalance: result.balance,
      })

      return res.status(200).json({
        ok: true,
        message: "Top-up processed",
        cardId: result.cardId,
        amount: result.amount,
        balance: result.balance,
      })
    } else {
      console.error("❌ [Boltcard Webhook] Top-up failed:", result.error)
      return res.status(500).json({
        ok: false,
        error: result.error,
      })
    }
  } catch (error: unknown) {
    console.error("❌ [Boltcard Webhook] Error:", error)
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
    })
  }
}

/**
 * Also handle GET for health check
 */
export const config = {
  api: {
    bodyParser: true,
  },
}
