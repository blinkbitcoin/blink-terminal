/**
 * Split Profiles API
 *
 * Manages Split Profiles for Nostr-authenticated users.
 * Split Profiles are stored server-side for cross-device sync.
 *
 * A Split Profile consists of:
 * - id: Unique identifier (UUID)
 * - label: User-given name for the profile
 * - recipients: Array of recipients with Blink usernames and share percentages
 *   (Currently only 1 recipient at 100%, multi-recipient support planned)
 *
 * SECURITY: All requests require NIP-98 session authentication.
 * Pubkey-only access has been removed for consistency.
 *
 * Endpoints:
 * - GET: Retrieve all split profiles for user
 * - POST: Create/update a split profile
 * - DELETE: Remove a split profile
 */

import crypto from "crypto"

import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../lib/auth"
import { withRateLimit, RATE_LIMIT_READ } from "../../lib/rate-limit"
import StorageManager from "../../lib/storage"

/** Recipient in a split profile */
interface SplitRecipient {
  username: string
  share?: number
}

/** Split profile shape */
interface SplitProfile {
  id: string
  label: string
  recipients: SplitRecipient[]
  createdAt?: string
  updatedAt?: string
}

/**
 * Verify request has valid NIP-98 session
 * SECURITY: No longer accepts pubkey-only authentication
 */
function verifySession(req: NextApiRequest): {
  valid: boolean
  pubkey?: string
  username?: string
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
  return { valid: true, pubkey, username: session.username }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log("[split-profiles] Request method:", req.method)

  // SECURITY: Require NIP-98 session authentication
  const verification = verifySession(req)

  if (!verification.valid) {
    const attemptedPubkey = (req.query?.pubkey || req.body?.pubkey) as string | undefined
    if (attemptedPubkey) {
      console.warn(
        "[split-profiles] BLOCKED: Unauthenticated access attempt for pubkey:",
        attemptedPubkey?.substring(0, 8),
      )
    }
    return res.status(401).json({ error: verification.error })
  }

  const { pubkey, username } = verification
  console.log("[split-profiles] Authenticated user:", username)

  try {
    switch (req.method) {
      case "GET":
        return handleGet(req, res, pubkey!, username!)
      case "POST":
        return handlePost(req, res, pubkey!, username!)
      case "DELETE":
        return handleDelete(req, res, pubkey!, username!)
      default:
        return res.status(405).json({ error: "Method not allowed" })
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[split-profiles] Error:", error)
    return res.status(500).json({
      error: "Server error",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

/**
 * GET - Retrieve all split profiles
 */
async function handleGet(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  console.log("[split-profiles] GET for user:", username)

  const userData = await StorageManager.loadUserData(username)

  // Return split profiles (or empty array if none)
  const splitProfiles = (userData?.splitProfiles || []) as SplitProfile[]
  const activeSplitProfileId = userData?.activeSplitProfileId || null

  console.log("[split-profiles] Found", splitProfiles.length, "profiles")

  return res.status(200).json({
    splitProfiles,
    activeSplitProfileId,
    pubkey,
  })
}

/**
 * POST - Create or update a split profile
 * Body: { profile: { id?, label, recipients: [{ username, share }] }, setActive?: boolean }
 */
async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  console.log("[split-profiles] POST for user:", username)

  const { profile, setActive } = req.body as {
    profile: { id?: string; label: string; recipients: SplitRecipient[] }
    setActive?: boolean
  }

  if (!profile) {
    return res.status(400).json({ error: "Profile data is required" })
  }

  if (!profile.label || typeof profile.label !== "string") {
    return res.status(400).json({ error: "Profile label is required" })
  }

  if (
    !profile.recipients ||
    !Array.isArray(profile.recipients) ||
    profile.recipients.length === 0
  ) {
    return res.status(400).json({ error: "At least one recipient is required" })
  }

  // Validate recipients
  for (const recipient of profile.recipients) {
    if (!recipient.username || typeof recipient.username !== "string") {
      return res.status(400).json({ error: "Recipient username is required" })
    }
    // Share is optional now since we split evenly, but validate if provided
    if (
      recipient.share !== undefined &&
      (typeof recipient.share !== "number" ||
        recipient.share < 0 ||
        recipient.share > 100)
    ) {
      return res
        .status(400)
        .json({ error: "Recipient share must be a number between 0 and 100" })
    }
  }

  // Load existing data
  const userData = (await StorageManager.loadUserData(username)) || {}
  const splitProfiles = (userData.splitProfiles || []) as SplitProfile[]

  // Generate ID if new profile
  const profileId = profile.id || crypto.randomUUID()

  // Check if updating existing or creating new
  const existingIndex = splitProfiles.findIndex((p: SplitProfile) => p.id === profileId)

  const savedProfile = {
    id: profileId,
    label: profile.label.trim(),
    recipients: profile.recipients.map((r: SplitRecipient) => ({
      username: r.username
        .trim()
        .toLowerCase()
        .replace(/@blink\.sv$/, ""),
      share: r.share,
    })),
    createdAt:
      existingIndex >= 0
        ? splitProfiles[existingIndex].createdAt
        : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  if (existingIndex >= 0) {
    splitProfiles[existingIndex] = savedProfile
    console.log("[split-profiles] Updated profile:", profileId)
  } else {
    splitProfiles.push(savedProfile)
    console.log("[split-profiles] Created profile:", profileId)
  }

  // Update active profile if requested
  let activeSplitProfileId = userData.activeSplitProfileId
  if (setActive) {
    activeSplitProfileId = profileId
    console.log("[split-profiles] Set active profile:", profileId)
  }

  // Save back to storage
  const saveResult = await StorageManager.saveUserData(username, {
    ...userData,
    splitProfiles,
    activeSplitProfileId,
  })

  if (!saveResult) {
    return res.status(500).json({ error: "Failed to save profile" })
  }

  return res.status(200).json({
    success: true,
    profile: savedProfile,
    activeSplitProfileId,
  })
}

/**
 * DELETE - Remove a split profile
 * Body: { profileId: string }
 */
async function handleDelete(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  console.log("[split-profiles] DELETE for user:", username)

  const { profileId } = req.body as { profileId: string }

  if (!profileId) {
    return res.status(400).json({ error: "Profile ID is required" })
  }

  // Load existing data
  const userData = await StorageManager.loadUserData(username)

  if (!userData?.splitProfiles) {
    return res.status(404).json({ error: "No profiles found" })
  }

  const splitProfiles = (userData.splitProfiles as SplitProfile[]).filter(
    (p: SplitProfile) => p.id !== profileId,
  )

  if (splitProfiles.length === (userData.splitProfiles as SplitProfile[]).length) {
    return res.status(404).json({ error: "Profile not found" })
  }

  // Clear active profile if it was deleted
  let activeSplitProfileId = userData.activeSplitProfileId
  if (activeSplitProfileId === profileId) {
    activeSplitProfileId = null
  }

  // Save back to storage
  await StorageManager.saveUserData(username, {
    ...userData,
    splitProfiles,
    activeSplitProfileId,
  })

  console.log("[split-profiles] Deleted profile:", profileId)

  return res.status(200).json({ success: true })
}

export default withRateLimit(handler, RATE_LIMIT_READ, "split-profiles")
