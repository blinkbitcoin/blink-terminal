import type { NextApiRequest, NextApiResponse } from "next"

import * as boltcardCrypto from "../../../../lib/boltcard/crypto"
import boltcardStore from "../../../../lib/boltcard/store"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../../lib/rate-limit"

/**
 * API endpoint for NFC Programmer app to reset a card
 *
 * This endpoint implements the reset flow per DEEPLINK.md:
 * 1. User initiates card reset in BlinkPOS
 * 2. BlinkPOS shows QR code with boltcard://reset?url=...
 * 3. NFC Programmer app scans QR and taps the card to get LNURLW
 * 4. App POSTs { LNURLW } (with p= and c= params) to this endpoint
 * 5. This endpoint verifies the card and returns keys for reset
 * 6. App resets the card to factory defaults
 * 7. App confirms reset by POSTing to /confirm
 *
 * POST /api/boltcard/reset/[cardId]
 * Body: { LNURLW: string } (URL with p= and c= params from card tap)
 *
 * Returns:
 * {
 *   K0: string,      // Current AppMasterKey (to authenticate reset)
 *   K1: string,      // Current EncryptionKey
 *   K2: string,      // Current AuthenticationKey
 *   K3: string,      // Reserved
 *   K4: string       // Reserved
 * }
 *
 * POST /api/boltcard/reset/[cardId]/confirm
 * Body: {} (empty)
 *
 * Marks the card as WIPED in the database.
 *
 * References:
 * - https://github.com/boltcard/boltcard/blob/main/docs/DEEPLINK.md
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
    // Get the card with keys
    const card = await boltcardStore.getCard(cardId, true)

    if (!card) {
      return res.status(404).json({
        status: "ERROR",
        reason: "Card not found",
      })
    }

    // Card must be in a valid state for reset
    if (card.status === "WIPED") {
      return res.status(400).json({
        status: "ERROR",
        reason: "Card is already wiped",
      })
    }

    // Get LNURLW from request body
    const { LNURLW } = req.body as { LNURLW?: string }

    if (!LNURLW) {
      return res.status(400).json({
        status: "ERROR",
        reason: "Missing LNURLW in request body",
      })
    }

    // Extract p and c parameters from LNURLW
    const params = boltcardCrypto.extractPandC(LNURLW)

    if (!params) {
      return res.status(400).json({
        status: "ERROR",
        reason: "Invalid LNURLW format: missing p and c parameters",
      })
    }

    const { p: piccDataHex, c: sunMacHex } = params

    // Verify the card tap to prove ownership
    const verifyResult = boltcardCrypto.verifyCardTap(
      piccDataHex,
      sunMacHex,
      card.k1 ?? "",
      card.k2 ?? "",
      card.cardUid,
      card.lastCounter,
    )

    if (!verifyResult.valid) {
      console.log(
        `[ResetAPI] Card verification failed for ${cardId}: ${verifyResult.error}`,
      )
      return res.status(401).json({
        status: "ERROR",
        reason: verifyResult.error || "Card verification failed",
      })
    }

    // Update counter for replay protection
    await boltcardStore.updateLastCounter(cardId, verifyResult.counter ?? 0)

    console.log(
      `[ResetAPI] Card ${cardId} verified for reset. Counter: ${verifyResult.counter}`,
    )

    // Build the LNURLW URL that was on the card
    const host = req.headers.host
    const _protocol = req.headers["x-forwarded-proto"] || "https"
    const lnurlwUrl = `lnurlw://${host}/api/boltcard/lnurlw/${cardId}`

    // Return current keys for reset operation per DEEPLINK.md spec
    // The NFC Programmer app needs these to authenticate with the card
    // Reset response format uses UPPERCASE keys per spec
    res.status(200).json({
      LNURLW: lnurlwUrl,
      K0: (card.k0 ?? "").toUpperCase(),
      K1: (card.k1 ?? "").toUpperCase(),
      K2: (card.k2 ?? "").toUpperCase(),
      K3: (card.k3 || card.k0 || "").toUpperCase(),
      K4: (card.k4 || card.k0 || "").toUpperCase(),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[ResetAPI] Error:", error)

    res.status(500).json({
      status: "ERROR",
      reason: "Failed to process reset request",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "boltcard/reset/[cardId]")
