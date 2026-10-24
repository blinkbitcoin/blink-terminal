import type { NextApiRequest, NextApiResponse } from "next"

import boltcardStore from "../../../../../lib/boltcard/store"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../../../lib/rate-limit"

/** How long after a tap-verified reset request the wipe may be confirmed. */
const RESET_CONFIRM_WINDOW_MS = 10 * 60 * 1000

/**
 * API endpoint to confirm card reset completion
 *
 * Called by NFC Programmer app after successfully resetting the card to factory defaults.
 * Marks the card as WIPED in the database — only within RESET_CONFIRM_WINDOW_MS
 * of a tap-verified reset request (POST /api/boltcard/reset/[cardId]), so a
 * bare cardId cannot wipe someone else's card.
 *
 * POST /api/boltcard/reset/[cardId]/confirm
 * Body: {} (empty) or { success: true }
 *
 * Returns:
 * { status: 'OK' }
 */

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Set CORS headers for NFC Programmer app
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      status: "ERROR",
      reason: "Method not allowed",
    })
  }

  const cardId = req.query.cardId as string | undefined

  if (!cardId) {
    return res.status(400).json({
      status: "ERROR",
      reason: "Missing card ID",
    })
  }

  try {
    // Get the card
    const card = await boltcardStore.getCard(cardId)

    if (!card) {
      return res.status(404).json({
        status: "ERROR",
        reason: "Card not found",
      })
    }

    // Card must not already be wiped
    if (card.status === "WIPED") {
      return res.status(400).json({
        status: "ERROR",
        reason: "Card is already wiped",
      })
    }

    // Mark card as wiped (only after a recent tap-verified reset)
    const success = await boltcardStore.wipeCardAfterVerifiedReset(
      cardId,
      RESET_CONFIRM_WINDOW_MS,
    )

    if (!success) {
      return res.status(403).json({
        status: "ERROR",
        reason: "Reset not verified - tap the card in the reset flow first",
      })
    }

    console.log(`[ResetConfirmAPI] Card ${cardId} marked as WIPED`)

    res.status(200).json({
      status: "OK",
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[ResetConfirmAPI] Error:", error)

    res.status(500).json({
      status: "ERROR",
      reason: "Failed to confirm reset",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "boltcard/reset/[cardId]/confirm")
