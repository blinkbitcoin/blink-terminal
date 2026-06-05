/**
 * Migration Status API - Check if a Nostr user has migrated from legacy auth
 *
 * This endpoint checks if there's an existing link between a Nostr public key
 * and a legacy account, allowing seamless login for migrated users.
 */

import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import { withRateLimit, RATE_LIMIT_AUTH } from "../../../lib/rate-limit"
import StorageManager from "../../../lib/storage"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    // SECURITY: This endpoint reveals account linkage (legacy Blink username,
    // whether a stored write-scope API key exists). Previously it was
    // unauthenticated and answered for ANY pubkey — a recon/enumeration oracle
    // that let an attacker map pubkeys to Blink usernames and identify which
    // accounts hold a stored key. It now requires a valid Nostr session and
    // only answers for the caller's OWN pubkey.
    const session = AuthManager.verifySession(req.cookies["auth-token"])
    if (!session?.username?.startsWith("nostr:")) {
      return res.status(401).json({ error: "Authentication required" })
    }
    const sessionPubkey = session.username.replace("nostr:", "").toLowerCase()

    const { publicKey } = req.query as { publicKey: string }

    if (!publicKey) {
      return res.status(400).json({ error: "Public key is required" })
    }

    const normalizedKey = publicKey.toLowerCase()

    // Only allow a session to query its own migration status.
    if (normalizedKey !== sessionPubkey) {
      return res.status(403).json({ error: "Forbidden" })
    }

    // Check if there's a Nostr-keyed entry
    const nostrLink = await StorageManager.loadUserData(`nostr_${normalizedKey}`)

    if (nostrLink && nostrLink.legacyUsername) {
      // Load the legacy user data
      const userData = await StorageManager.loadUserData(
        nostrLink.legacyUsername as string,
      )

      if (userData && userData.migratedToNostr) {
        return res.status(200).json({
          migrated: true,
          legacyUsername: nostrLink.legacyUsername,
          linkedAt: nostrLink.linkedAt,
          hasApiKey: !!userData.apiKey,
        })
      }
    }

    return res.status(200).json({
      migrated: false,
    })
  } catch (error: unknown) {
    console.error("Migration status check error:", error)
    return res.status(500).json({
      error: "Failed to check migration status",
      migrated: false,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_AUTH)
