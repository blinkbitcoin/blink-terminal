/**
 * Verify Ownership API
 *
 * Verifies that a user owns a pubkey by validating a signed challenge.
 * This enables secure authentication for external signers (Amber, Nostash)
 * that cannot do inline NIP-98 signing.
 *
 * Flow:
 * 1. Client gets challenge from GET /api/auth/challenge
 * 2. External signer signs the challenge (kind 22242 event)
 * 3. Client submits signed event here
 * 4. Server verifies signature + challenge validity
 * 5. Server creates session cookie (same as NIP-98 login)
 *
 * Event format (kind 22242 - AUTH):
 * {
 *   kind: 22242,
 *   content: "blinkpos:timestamp:nonce",  // The challenge
 *   tags: [
 *     ["relay", "https://track.twentyone.ist"],
 *     ["challenge", "blinkpos:timestamp:nonce"]
 *   ],
 *   pubkey: "...",
 *   sig: "..."
 * }
 */

import crypto from "crypto"

import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import { verifyChallenge } from "../../../lib/auth/challengeStore"
import { buildSessionCookie } from "../../../lib/auth/cookies"
import { withRateLimit, RATE_LIMIT_AUTH } from "../../../lib/rate-limit"

interface CryptoModules {
  secp256k1: typeof import("@noble/curves/secp256k1") | null
  sha256: ((data: Uint8Array) => Uint8Array) | null
}

// Cache for dynamically imported modules
let secp256k1: CryptoModules["secp256k1"] = null
let sha256Fn: CryptoModules["sha256"] = null
let modulesLoaded = false

/**
 * Load crypto modules for BIP-340 Schnorr signatures
 */
async function loadModules(): Promise<CryptoModules> {
  if (modulesLoaded) return { secp256k1, sha256: sha256Fn }

  try {
    const curvesModule = await import("@noble/curves/secp256k1")
    const hashesModule = await import("@noble/hashes/sha256")

    secp256k1 = curvesModule
    sha256Fn = hashesModule.sha256
    modulesLoaded = true

    return { secp256k1, sha256: sha256Fn }
  } catch (e) {
    console.error("[verify-ownership] Failed to load @noble/curves:", e)
    modulesLoaded = true
    return { secp256k1: null, sha256: null }
  }
}

/**
 * Hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return bytes
}

/**
 * Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Calculate the event ID (SHA256 hash of serialized event)
 */
async function calculateEventId(event: {
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}): Promise<string> {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ])

  const { sha256 } = await loadModules()

  if (sha256) {
    const hash = sha256(new TextEncoder().encode(serialized))
    return bytesToHex(hash)
  } else {
    return crypto.createHash("sha256").update(serialized).digest("hex")
  }
}

/**
 * Verify a BIP-340 Schnorr signature
 */
async function verifySchnorrSignature(
  signature: string,
  message: string,
  publicKey: string,
): Promise<boolean> {
  const { secp256k1 } = await loadModules()

  if (!secp256k1?.schnorr) {
    console.error("[verify-ownership] schnorr not available")
    return false
  }

  try {
    const sigBytes = hexToBytes(signature)
    const msgBytes = hexToBytes(message)
    const pubBytes = hexToBytes(publicKey)

    return secp256k1.schnorr.verify(sigBytes, msgBytes, pubBytes)
  } catch (error: unknown) {
    console.error("[verify-ownership] Signature verification error:", error)
    return false
  }
}

/**
 * Get tag value from event tags
 */
function getTagValue(tags: string[][], tagName: string): string | null {
  const tag = tags.find((t) => Array.isArray(t) && t[0] === tagName)
  return tag ? tag[1] : null
}

interface SignedEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

/**
 * Validate the signed event structure and content
 */
function validateSignedEvent(event: SignedEvent): { valid: boolean; error?: string } {
  // Check required fields
  const requiredFields: (keyof SignedEvent)[] = [
    "id",
    "pubkey",
    "created_at",
    "kind",
    "tags",
    "content",
    "sig",
  ]
  for (const field of requiredFields) {
    if (!(field in event)) {
      return { valid: false, error: `Missing required field: ${field}` }
    }
  }

  // Validate kind. This challenge flow is exclusively kind 22242 (NIP-42 AUTH).
  // We deliberately do NOT accept 27235 here: NIP-98 (kind 27235) has its own
  // endpoint (/api/auth/nostr-login) with a tighter 60-120s freshness window.
  // Accepting it here would expose a second, more lenient verification path.
  if (event.kind !== 22242) {
    return {
      valid: false,
      error: `Invalid event kind: ${event.kind}, expected 22242`,
    }
  }

  // Validate pubkey format (64 char hex)
  if (!/^[0-9a-f]{64}$/i.test(event.pubkey)) {
    return { valid: false, error: "Invalid pubkey format" }
  }

  // Validate signature format (128 char hex for Schnorr)
  if (!/^[0-9a-f]{128}$/i.test(event.sig)) {
    return { valid: false, error: "Invalid signature format" }
  }

  // Validate id format (64 char hex)
  if (!/^[0-9a-f]{64}$/i.test(event.id)) {
    return { valid: false, error: "Invalid event id format" }
  }

  // Validate tags is array
  if (!Array.isArray(event.tags)) {
    return { valid: false, error: "Tags must be an array" }
  }

  // Validate timestamp (not too old, not in future).
  // 5 minutes matches the challenge TTL while staying lenient enough for the
  // external-signer (Amber) redirect round-trip. The challenge's own single-use
  // + expiry is the primary replay defense; this is a secondary bound.
  const now = Math.floor(Date.now() / 1000)
  const maxAge = 300 // 5 minutes

  if (now - event.created_at > maxAge) {
    return {
      valid: false,
      error: `Event too old: ${now - event.created_at}s (max: ${maxAge}s)`,
    }
  }

  if (event.created_at > now + 60) {
    return { valid: false, error: "Event timestamp is in the future" }
  }

  return { valid: true }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only accept POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { signedEvent } = req.body as { signedEvent: SignedEvent }

    if (!signedEvent) {
      return res.status(400).json({
        error: "Missing signedEvent in request body",
        hint: "Submit the signed challenge event from your external signer",
      })
    }

    console.log(
      "[verify-ownership] Verifying signed event for pubkey:",
      signedEvent.pubkey?.substring(0, 8) + "...",
    )

    // 1. Validate event structure
    const structureResult = validateSignedEvent(signedEvent)
    if (!structureResult.valid) {
      console.warn(
        "[verify-ownership] Structure validation failed:",
        structureResult.error,
      )
      return res.status(400).json({
        error: "Invalid event structure",
        details: structureResult.error,
      })
    }

    // 2. Verify event ID matches calculated hash
    const calculatedId = await calculateEventId(signedEvent)
    if (calculatedId.toLowerCase() !== signedEvent.id.toLowerCase()) {
      console.warn("[verify-ownership] Event ID mismatch")
      return res.status(400).json({
        error: "Event ID does not match calculated hash",
      })
    }

    // 3. Verify signature
    const sigValid = await verifySchnorrSignature(
      signedEvent.sig,
      signedEvent.id,
      signedEvent.pubkey,
    )
    if (!sigValid) {
      console.warn("[verify-ownership] Signature verification failed")
      return res.status(401).json({
        error: "Invalid signature",
      })
    }

    // 4. Extract and verify challenge
    // Challenge should be in the content field, or in a challenge tag
    let challenge = signedEvent.content

    // If content is empty, check challenge tag
    if (!challenge || challenge.trim() === "") {
      challenge = getTagValue(signedEvent.tags, "challenge") || ""
    }

    if (!challenge) {
      console.warn("[verify-ownership] No challenge found in event")
      return res.status(400).json({
        error: "Missing challenge in event content or tags",
      })
    }

    // Validate challenge format (should start with "blinkpos:")
    if (!challenge.startsWith("blinkpos:")) {
      console.warn(
        "[verify-ownership] Invalid challenge format:",
        challenge.substring(0, 20),
      )
      return res.status(400).json({
        error: "Invalid challenge format",
      })
    }

    // 5. Verify challenge was issued by us, hasn't been used/expired, and bind
    //    it to the verified signer pubkey. Because the Schnorr signature was
    //    already checked (step 3), `signedEvent.pubkey` is the cryptographically
    //    proven signer. Binding here ensures a challenge can only ever mint a
    //    session for the single pubkey that first presents it — a victim who is
    //    phished into signing a challenge cannot have it replayed by an attacker
    //    for a different identity, and vice versa.
    const pubkey = signedEvent.pubkey.toLowerCase()
    const challengeResult = await verifyChallenge(challenge, pubkey)
    if (!challengeResult.valid) {
      console.warn(
        "[verify-ownership] Challenge verification failed:",
        challengeResult.error,
      )
      return res.status(401).json({
        error: "Challenge verification failed",
        details: challengeResult.error,
      })
    }

    // 6. All validations passed! Create session
    const sessionUsername = `nostr:${pubkey}`
    const token = AuthManager.generateSession(sessionUsername)

    // Set session cookie (centralized attributes)
    res.setHeader("Set-Cookie", buildSessionCookie(token))

    console.log(
      "[verify-ownership] ✓ Session created for:",
      pubkey.substring(0, 8) + "...",
    )

    // Return success
    return res.status(200).json({
      success: true,
      user: {
        pubkey,
        username: sessionUsername,
        authMethod: "nostr-challenge",
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[verify-ownership] Error:", error)
    return res.status(500).json({
      error: "Verification failed",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_AUTH)
