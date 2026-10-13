import type { NextApiRequest, NextApiResponse } from "next"

import * as boltcard from "../../../../lib/boltcard"
import { requireOwnedCard } from "../../../../lib/boltcard/owner-auth"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../../lib/rate-limit"

/**
 * API endpoint to get wipe keys for a registered Boltcard
 *
 * GET /api/boltcard/wipe-keys/[cardId]
 *
 * Returns the wipe JSON format expected by NFC Programmer app:
 * {
 *   "version": 1,
 *   "action": "wipe",
 *   "k0": "...", "k1": "...", "k2": "...", "k3": "...", "k4": "..."
 * }
 *
 * Security:
 * - Requires authenticated session (cookie-based NIP-98)
 * - Verifies card ownership via ownerPubkey
 * - Only returns keys for cards owned by the authenticated user
 */

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const cardId = req.query.cardId as string | undefined

  if (!cardId) {
    return res.status(400).json({ error: "Missing cardId" })
  }

  try {
    // Owner session required; another owner's card answers 404
    const owned = await requireOwnedCard(req, res, cardId)
    if (!owned) return
    const { card, pubkey: userPubkey } = owned

    // Get IssuerKey for the owner
    const issuerKey = await boltcard.store.getIssuerKey(userPubkey)

    if (!issuerKey) {
      console.error(
        `[WipeKeys] IssuerKey not found for owner: ${userPubkey.substring(0, 8)}...`,
      )
      return res.status(500).json({
        error: "IssuerKey not found",
        message: "Unable to derive card keys. Please contact support.",
      })
    }

    // Derive keys for the card's current version
    const keys = boltcard.crypto.deriveAllKeys(issuerKey, card.cardUid, card.version)

    // Build wipe JSON in the format expected by NFC Programmer app
    // Format documented at: https://github.com/nicklaros/bolt-card-programmer
    const wipeJson = {
      version: 1,
      action: "wipe",
      k0: keys.k0.toUpperCase(),
      k1: keys.k1.toUpperCase(),
      k2: keys.k2.toUpperCase(),
      k3: keys.k3.toUpperCase(),
      k4: keys.k4.toUpperCase(),
    }

    console.log(
      `[WipeKeys] Generated wipe keys for card ${cardId} (version ${card.version}) for user ${userPubkey.substring(0, 8)}...`,
    )

    res.status(200).json({
      success: true,
      card: {
        id: card.id,
        name: card.name,
        uid: card.cardUid,
        version: card.version,
        status: card.status,
      },
      wipeJson,
      // Also provide individual keys for manual entry
      keys: {
        k0: keys.k0.toUpperCase(),
        k1: keys.k1.toUpperCase(),
        k2: keys.k2.toUpperCase(),
        k3: keys.k3.toUpperCase(),
        k4: keys.k4.toUpperCase(),
      },
      instructions: {
        qrScan: "Scan the QR code with the NFC Programmer app to reset your card",
        manualEntry: "Or enter the keys manually in the app's reset screen",
        warning: "Keep these keys secure. Anyone with access can reset your card.",
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[WipeKeys] Error:", error)
    res.status(500).json({
      error: "Failed to generate wipe keys",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "boltcard/wipe-keys/[cardId]")
