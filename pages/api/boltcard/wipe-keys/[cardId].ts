import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../../lib/auth"
import * as boltcard from "../../../../lib/boltcard"
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

/**
 * Verify request has valid NIP-98 session
 */
function verifySession(req: NextApiRequest): {
  valid: boolean
  pubkey?: string
  error?: string
} {
  const token = req.cookies?.["auth-token"]

  if (!token) {
    return { valid: false, error: "Authentication required - no session token" }
  }

  const session = AuthManager.verifySession(token)

  if (!session) {
    return { valid: false, error: "Invalid or expired session" }
  }

  if (!session.username?.startsWith("nostr:")) {
    return { valid: false, error: "Not a Nostr session" }
  }

  const pubkey = session.username.replace("nostr:", "")
  return { valid: true, pubkey }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const cardId = req.query.cardId as string | undefined

  if (!cardId) {
    return res.status(400).json({ error: "Missing cardId" })
  }

  try {
    // Verify session authentication
    const verification = verifySession(req)

    if (!verification.valid) {
      return res.status(401).json({
        error: "Authentication required",
        message: verification.error,
      })
    }

    const userPubkey = verification.pubkey as string

    // Get the card
    const card = await boltcard.store.getCard(cardId)

    if (!card) {
      return res.status(404).json({ error: "Card not found" })
    }

    // Verify ownership
    if (card.ownerPubkey !== userPubkey) {
      console.warn(
        `[WipeKeys] Unauthorized access attempt: user ${userPubkey.substring(0, 8)}... tried to access card owned by ${card.ownerPubkey.substring(0, 8)}...`,
      )
      return res.status(403).json({
        error: "Access denied",
        message: "You do not own this card",
      })
    }

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
