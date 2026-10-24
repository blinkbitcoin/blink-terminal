/**
 * Migration API - Migrate legacy API key user to Nostr authentication
 *
 * This endpoint:
 * 1. Verifies the current legacy session is valid
 * 2. Retrieves the user's encrypted API key
 * 3. Returns it for storage in the Nostr profile
 * 4. Optionally marks the account as migrated
 *
 * Security:
 * - Requires valid legacy auth-token cookie
 * - Only transfers credentials from the authenticated session
 * - API key is decrypted only for the authenticated user
 */

import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import { withRateLimit, RATE_LIMIT_AUTH } from "../../../lib/rate-limit"
import StorageManager from "../../../lib/storage"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { nostrPublicKey, legacyUsername } = req.body as {
      nostrPublicKey: string
      legacyUsername?: string
    }

    if (!nostrPublicKey) {
      return res.status(400).json({ error: "Nostr public key is required" })
    }

    // Verify the legacy session
    const token = req.cookies["auth-token"]
    const session = AuthManager.verifySession(token)

    if (!session) {
      return res.status(401).json({ error: "No valid legacy session" })
    }

    // Security: Ensure the session username matches the migration request
    if (legacyUsername && session.username !== legacyUsername) {
      return res.status(403).json({
        error: "Username mismatch - can only migrate your own account",
      })
    }

    // Load user data
    const userData = await StorageManager.loadUserData(session.username)

    if (!userData) {
      return res.status(404).json({ error: "User data not found" })
    }

    if (!userData.apiKey) {
      return res.status(400).json({ error: "No API key found for user" })
    }

    // Record the migration (link Nostr pubkey to legacy account)
    const migrationData = {
      ...userData,
      migratedToNostr: true,
      nostrPublicKey: nostrPublicKey.toLowerCase(),
      migrationDate: new Date().toISOString(),
    }

    await StorageManager.saveUserData(session.username, migrationData)

    // Also create a Nostr-keyed entry for future lookups
    await StorageManager.saveUserData(`nostr_${nostrPublicKey.toLowerCase()}`, {
      legacyUsername: session.username,
      linkedAt: new Date().toISOString(),
    })

    console.log(
      `Migration completed: ${session.username} → ${nostrPublicKey.slice(0, 16)}...`,
    )

    // Return the API key for storage in Nostr profile
    // Note: The API key is already decrypted by StorageManager
    return res.status(200).json({
      success: true,
      message: "Migration successful",
      apiKey: userData.apiKey,
      blinkUsername: session.username,
      preferences: {
        preferredCurrency: userData.preferredCurrency || "BTC",
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Migration error:", error)
    return res.status(500).json({
      error: "Migration failed",
      message,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_AUTH, "auth/migrate-to-nostr")
