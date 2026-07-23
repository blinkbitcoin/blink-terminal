import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import * as boltcard from "../../../lib/boltcard"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"

/**
 * API endpoint to recover wipe keys for an orphaned Boltcard
 *
 * POST /api/boltcard/recover-keys
 * Body: { uid: "14 hex chars" }
 *
 * Use case: User deleted their card record but the physical card still
 * has keys programmed. Since we never delete the IssuerKey, we can still
 * derive the keys needed to wipe the card.
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
 * - Uses the user's IssuerKey to derive keys
 * - Only works if user has previously programmed a card (IssuerKey exists)
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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." })
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
    const { uid, version = 1 } = req.body as { uid?: string; version?: number }

    // Validate UID format
    if (!uid) {
      return res.status(400).json({
        error: "Missing UID",
        message: "Please provide the card UID (14 hex characters)",
      })
    }

    // Normalize and validate UID
    const normalizedUid = uid.toLowerCase().replace(/[:\s-]/g, "")

    if (!/^[0-9a-f]{14}$/.test(normalizedUid)) {
      return res.status(400).json({
        error: "Invalid UID format",
        message: "Card UID must be 14 hex characters (7 bytes). Example: 04A39493CC8680",
      })
    }

    // Get the user's IssuerKey
    const issuerKey = await boltcard.store.getIssuerKey(userPubkey)

    if (!issuerKey) {
      return res.status(404).json({
        error: "No IssuerKey found",
        message:
          "You have not previously programmed any cards. Recovery is only possible for cards you have programmed.",
      })
    }

    // Check if card is currently registered (it should NOT be for recovery)
    const existingCard = await boltcard.store.getCardByUid(normalizedUid)

    if (existingCard) {
      // Card exists - redirect to the proper endpoint
      if (existingCard.ownerPubkey === userPubkey) {
        return res.status(409).json({
          error: "Card is registered",
          message:
            "This card is still registered. Use the card details page to get wipe keys.",
          cardId: existingCard.id,
        })
      } else {
        // Card belongs to someone else
        return res.status(403).json({
          error: "Card belongs to another user",
          message: "This card is registered to a different account.",
        })
      }
    }

    // Validate version parameter
    const keyVersion = parseInt(String(version), 10)
    if (isNaN(keyVersion) || keyVersion < 1) {
      return res.status(400).json({
        error: "Invalid version",
        message: "Version must be a positive integer (default: 1)",
      })
    }

    // Derive keys for the card
    // We try version 1 by default, but user can specify a different version
    // if the card was re-programmed multiple times
    const keys = boltcard.crypto.deriveAllKeys(issuerKey, normalizedUid, keyVersion)

    // Build wipe JSON in the format expected by NFC Programmer app
    const wipeJson = {
      version: 1, // Protocol version, not key version
      action: "wipe",
      k0: keys.k0.toUpperCase(),
      k1: keys.k1.toUpperCase(),
      k2: keys.k2.toUpperCase(),
      k3: keys.k3.toUpperCase(),
      k4: keys.k4.toUpperCase(),
    }

    console.log(
      `[RecoverKeys] Generated recovery keys for UID ${normalizedUid} (key version ${keyVersion}) for user ${userPubkey.substring(0, 8)}...`,
    )

    res.status(200).json({
      success: true,
      uid: normalizedUid,
      keyVersion,
      wipeJson,
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
        versionNote:
          keyVersion > 1
            ? `Using key version ${keyVersion}. If reset fails, try version ${keyVersion - 1} or 1.`
            : "If reset fails, the card may have been programmed with a different account.",
        warning: "Keep these keys secure. Anyone with access can reset your card.",
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[RecoverKeys] Error:", error)
    res.status(500).json({
      error: "Failed to generate recovery keys",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "boltcard/recover-keys")
