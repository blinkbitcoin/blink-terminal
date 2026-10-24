/**
 * Payment Status Polling Endpoint
 *
 * GET /api/payment-status/{paymentHash}
 *
 * Returns the current status of a payment by looking up the payment_splits table.
 * This is used by the client to poll for payment completion after an invoice is displayed.
 *
 * NO API KEYS REQUIRED - This endpoint only reads payment status from our database.
 * The payment hash itself acts as the identifier (unpredictable, safe to use).
 *
 * Response:
 * {
 *   status: 'pending' | 'processing' | 'completed' | 'expired' | 'failed' | 'not_found',
 *   paymentHash: string,
 *   timestamp: string
 * }
 */

import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"
import { getHybridStore } from "../../../lib/storage/hybrid-store"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const { paymentHash } = req.query as { paymentHash: string }

  // Validate payment hash format (64 hex characters)
  if (!paymentHash || !/^[a-f0-9]{64}$/i.test(paymentHash)) {
    return res.status(400).json({
      error: "Invalid payment hash format",
      status: "invalid",
    })
  }

  try {
    const store = await getHybridStore()
    const paymentData = await store.getTipData(paymentHash)

    if (!paymentData) {
      return res.status(200).json({
        status: "not_found",
        paymentHash,
        timestamp: new Date().toISOString(),
      })
    }

    // Return only the status - no sensitive data
    return res.status(200).json({
      status: paymentData.status || "pending",
      paymentHash,
      timestamp: new Date().toISOString(),
    })
  } catch (error: unknown) {
    console.error("Error checking payment status:", error)

    // Return error but don't expose internal details
    return res.status(500).json({
      status: "error",
      error: "Failed to check payment status",
      paymentHash,
      timestamp: new Date().toISOString(),
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "payment-status/[paymentHash]")
