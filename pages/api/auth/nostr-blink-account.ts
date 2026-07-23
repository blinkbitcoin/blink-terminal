/**
 * Nostr Blink Account API
 *
 * Manages Blink accounts for Nostr-authenticated users.
 * API keys are stored server-side (encrypted) for security.
 *
 * Endpoints:
 * - POST: Add/update Blink account
 * - GET: Retrieve Blink account info (not the API key itself)
 * - DELETE: Remove Blink account
 */

import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import BlinkAPI from "../../../lib/blink-api"
import { withRateLimit, RATE_LIMIT_AUTH } from "../../../lib/rate-limit"
import StorageManager from "../../../lib/storage"

/**
 * Extract Nostr pubkey from session username
 * @param {string} username - Session username (format: nostr:pubkey)
 * @returns {string|null}
 */
function extractPubkey(username: string): string | null {
  if (!username?.startsWith("nostr:")) return null
  return username.replace("nostr:", "")
}

/**
 * Verify the request is from a Nostr-authenticated user
 * @param {Object} req
 * @returns {{valid: boolean, session?: Object, pubkey?: string, error?: string}}
 */
function verifyNostrSession(req: NextApiRequest): {
  valid: boolean
  session?: { username: string }
  pubkey?: string
  error?: string
} {
  const token = req.cookies["auth-token"]
  const session = AuthManager.verifySession(token)

  if (!session) {
    return { valid: false, error: "Unauthorized - no valid session" }
  }

  const pubkey = extractPubkey(session.username)
  if (!pubkey) {
    return { valid: false, error: "Not a Nostr session" }
  }

  return { valid: true, session, pubkey }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log("[nostr-blink-account] Request method:", req.method)

  // SECURITY FIX: Remove unauthenticated pubkey-based access
  // Previously, anyone could GET or POST API keys just by knowing a pubkey.
  // This was a critical vulnerability - API keys could be stolen.
  //
  // For external signers (Amber):
  // - Client stores API keys locally (encrypted with device key)
  // - Server storage is only used for cross-device sync when NIP-98 session exists
  // - If no NIP-98 session, user must re-add their Blink account on new device

  // Log if someone tries the old unauthenticated endpoints
  if (req.method === "GET" && req.query.pubkey && !req.cookies["auth-token"]) {
    console.warn(
      "[nostr-blink-account] BLOCKED: Unauthenticated GET by pubkey attempt:",
      (req.query.pubkey as string)?.substring(0, 8),
    )
    return res.status(401).json({
      error: "Authentication required - pubkey-only access is no longer supported",
    })
  }

  if (req.method === "POST" && req.body?.pubkey && !req.cookies["auth-token"]) {
    console.warn(
      "[nostr-blink-account] BLOCKED: Unauthenticated POST by pubkey attempt:",
      req.body?.pubkey?.substring(0, 8),
    )
    return res.status(401).json({
      error: "Authentication required - pubkey-only access is no longer supported",
    })
  }

  // All requests now require full session verification
  const verification = verifyNostrSession(req)
  if (!verification.valid) {
    return res.status(401).json({ error: verification.error })
  }

  const { pubkey, session } = verification

  try {
    switch (req.method) {
      case "GET":
        return handleGet(req, res, pubkey!, session!.username)
      case "POST":
        return handlePost(req, res, pubkey!, session!.username)
      case "DELETE":
        return handleDelete(req, res, pubkey!, session!.username)
      default:
        return res.status(405).json({ error: "Method not allowed" })
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Nostr Blink account error:", error)
    return res.status(500).json({
      error: "Server error",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

/**
 * GET - Retrieve Blink account info
 * For cross-device sync, also returns the API key (user is already authenticated)
 */
async function handleGet(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  console.log("[nostr-blink-account] GET for user:", username)

  const userData = await StorageManager.loadUserData(username)

  if (!userData?.apiKey) {
    console.log("[nostr-blink-account] No account found for:", username)
    return res.status(200).json({
      hasAccount: false,
      pubkey,
    })
  }

  console.log(
    "[nostr-blink-account] Found account with apiKey:",
    userData.apiKey ? "yes" : "no",
  )

  // Get user info from Blink
  try {
    const blinkApi = new BlinkAPI(userData.apiKey)
    const result = await blinkApi.getUserInfo()
    const userInfo = result?.me

    console.log("[nostr-blink-account] Blink user info:", userInfo?.username)

    // Return account info INCLUDING the API key for cross-device sync
    // This is safe because user is already authenticated via NIP-98 or pubkey verification
    return res.status(200).json({
      hasAccount: true,
      pubkey,
      blinkUsername: userInfo?.username || userData.blinkUsername || null,
      accountLabel:
        userData.accountLabel || userInfo?.username || userData.blinkUsername || null,
      preferredCurrency: userData.preferredCurrency || "BTC",
      // Include API key for cross-device sync
      apiKey: userData.apiKey,
    })
  } catch (error: unknown) {
    console.error("[nostr-blink-account] Blink API error:", error)
    // API key might be invalid, but still return it so user can update
    return res.status(200).json({
      hasAccount: true,
      pubkey,
      blinkUsername: userData.blinkUsername || null,
      accountLabel: userData.accountLabel || userData.blinkUsername || null,
      preferredCurrency: userData.preferredCurrency || "BTC",
      apiKey: userData.apiKey,
      error: "Failed to fetch Blink account info",
    })
  }
}

/**
 * POST - Add/update Blink account
 */
async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  console.log("[nostr-blink-account] POST request for:", username)

  const {
    apiKey,
    preferredCurrency = "BTC",
    label,
  } = req.body as { apiKey: string; preferredCurrency?: string; label?: string }

  if (!apiKey) {
    console.log("[nostr-blink-account] Missing API key")
    return res.status(400).json({ error: "API key is required" })
  }

  console.log("[nostr-blink-account] Validating API key with Blink...")

  // Validate the API key with Blink
  const blinkApi = new BlinkAPI(apiKey)
  let userInfo

  try {
    const result = await blinkApi.getUserInfo()
    // getUserInfo returns { me: { id, username, defaultAccount: { id } } }
    userInfo = result?.me
    if (!userInfo?.id) {
      console.log("[nostr-blink-account] Invalid API key - no user ID. Result:", result)
      return res.status(400).json({ error: "Invalid Blink API key" })
    }
    console.log("[nostr-blink-account] API key valid for user:", userInfo.username)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[nostr-blink-account] API validation error:", error)
    return res.status(400).json({
      error: "Failed to validate API key",
      details: message,
    })
  }

  // Store API key - StorageManager.saveUserData will encrypt it
  // Don't double-encrypt!
  console.log("[nostr-blink-account] Storing user data...")
  const saveResult = await StorageManager.saveUserData(username, {
    apiKey: apiKey, // Will be encrypted by saveUserData
    blinkUsername: userInfo.username,
    blinkUserId: userInfo.id,
    preferredCurrency,
    accountLabel: label || userInfo.username, // Store user-defined label
    pubkey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  console.log("[nostr-blink-account] Save result:", saveResult)

  if (!saveResult) {
    console.error("[nostr-blink-account] Failed to save user data")
    return res.status(500).json({ error: "Failed to save account data" })
  }

  console.log("[nostr-blink-account] ✓ Account stored successfully")

  return res.status(200).json({
    success: true,
    blinkUsername: userInfo.username,
    preferredCurrency,
  })
}

/**
 * DELETE - Remove Blink account
 */
async function handleDelete(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  // Load existing data to preserve some fields if needed
  const existingData = await StorageManager.loadUserData(username)

  if (!existingData) {
    return res.status(404).json({ error: "No account found" })
  }

  // Remove the API key but keep the record
  await StorageManager.saveUserData(username, {
    ...existingData,
    apiKey: null,
    blinkUsername: null,
    blinkUserId: null,
    removedAt: new Date().toISOString(),
  })

  return res.status(200).json({ success: true })
}

export default withRateLimit(handler, RATE_LIMIT_AUTH, "auth/nostr-blink-account")
