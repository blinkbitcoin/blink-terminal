/**
 * NIP-98 HTTP Auth Verification
 *
 * Server-side verification of NIP-98 authentication tokens.
 * NIP-98 uses kind 27235 events to authenticate HTTP requests.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/98.md
 */

import crypto from "crypto"

import * as secp256k1Module from "@noble/curves/secp256k1"
import { sha256 as nobleSha256 } from "@noble/hashes/sha256"

/**
 * Shape of a Nostr event used in NIP-98 authentication.
 */
interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

/**
 * Validation result returned by each verification step.
 */
interface ValidationResult {
  valid: boolean
  error?: string
}

/**
 * Full verification result including the extracted pubkey on success.
 */
interface VerifyResult extends ValidationResult {
  pubkey?: string
  event?: NostrEvent
}

/**
 * Options common to header-based and event-based verification.
 */
interface VerifyCommonOptions {
  url: string
  method: string
  maxAgeSeconds?: number
  /**
   * Per-session challenge that the event MUST carry in a `challenge` tag.
   *
   * Plain NIP-98 has no nonce, so a signed event is a bearer artifact for its
   * whole freshness window. The server-held NIP-46 flow mints a challenge per
   * session and asks the signer to include it, which binds the signature to one
   * specific sign-in attempt. Omitted for the legacy header flow, which relies
   * on the freshness window alone.
   */
  challenge?: string
  /**
   * Pubkey the event MUST be signed by. Used by the NIP-46 worker to require
   * that the key which answered `get_public_key` is the key that signed.
   */
  expectedPubkey?: string
}

/**
 * Options passed to the main verify() method.
 */
interface VerifyOptions extends VerifyCommonOptions {
  authHeader: string
}

/**
 * Options for verifying an already-decoded event (server-held NIP-46 flow,
 * where the signed event arrives over a relay rather than in a header).
 */
interface VerifySignedEventOptions extends VerifyCommonOptions {
  event: unknown
}

// Cache for dynamically imported modules
let secp256k1: typeof secp256k1Module | null = null
let sha256Fn: typeof nobleSha256 | null = null
let modulesLoaded = false

interface LoadModulesResult {
  secp256k1: typeof secp256k1Module | null
  sha256: typeof nobleSha256 | null
}

/**
 * Load crypto modules for BIP-340 Schnorr signatures (required for Nostr)
 * Uses @noble/curves which provides CommonJS-compatible exports
 */
function loadModules(): LoadModulesResult {
  if (modulesLoaded) return { secp256k1, sha256: sha256Fn }

  try {
    secp256k1 = secp256k1Module
    sha256Fn = nobleSha256
    modulesLoaded = true

    if ((secp256k1 as Record<string, unknown>)?.schnorr) {
      console.log("NIP-98: ✓ Loaded @noble/curves with Schnorr support")
    } else {
      console.error("NIP-98: ✗ @noble/curves loaded but schnorr not available")
    }

    return { secp256k1, sha256: sha256Fn }
  } catch (e: unknown) {
    console.error("NIP-98: Failed to load @noble/curves:", e)
    modulesLoaded = true // Mark as loaded even on failure to prevent retries
    return { secp256k1: null, sha256: null }
  }
}

/**
 * NIP-98 HTTP Auth event kind
 */
const NIP98_KIND = 27235

/**
 * Maximum age of a NIP-98 event (in seconds)
 * Events older than this are rejected to prevent replay attacks
 */
const MAX_EVENT_AGE_SECONDS = 60

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
    .map((b: number) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Calculate the event ID (SHA256 hash of serialized event)
 */
function calculateEventId(event: NostrEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ])

  // Try to use @noble/hashes first
  const { sha256 } = loadModules()

  if (sha256) {
    const hash = sha256(new TextEncoder().encode(serialized))
    return bytesToHex(hash)
  } else {
    // Fallback to Node.js crypto
    return crypto.createHash("sha256").update(serialized).digest("hex")
  }
}

/**
 * Verify a BIP-340 Schnorr signature using @noble/curves
 */
function verifySchnorrSignature(
  signature: string,
  message: string,
  publicKey: string,
): boolean {
  const { secp256k1: sec } = loadModules()

  if (!sec) {
    console.error("NIP-98: @noble/curves library not available")
    return false
  }

  const schnorr = (sec as Record<string, unknown>).schnorr as
    | { verify: (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array) => boolean }
    | undefined

  if (!schnorr) {
    console.error("NIP-98: schnorr not available in loaded module")
    return false
  }

  try {
    const sigBytes = hexToBytes(signature)
    const msgBytes = hexToBytes(message)
    const pubBytes = hexToBytes(publicKey)

    // @noble/curves/secp256k1 schnorr.verify(sig, msg, pubkey)
    const result: boolean = schnorr.verify(sigBytes, msgBytes, pubBytes)
    console.log("NIP-98: Schnorr verification result:", result)
    return result
  } catch (err: unknown) {
    console.error("NIP-98: Signature verification error:", err)
    return false
  }
}

/**
 * Extract a tag value from event tags
 */
function getTagValue(tags: string[][], tagName: string): string | null {
  const tag = tags.find((t: string[]) => Array.isArray(t) && t[0] === tagName)
  return tag ? tag[1] : null
}

/**
 * Normalize URL for comparison
 * Removes trailing slashes and standardizes format
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    // Remove trailing slash from pathname
    parsed.pathname = parsed.pathname.replace(/\/+$/, "")
    return parsed.toString().replace(/\/+$/, "")
  } catch {
    return url.replace(/\/+$/, "")
  }
}

class Nip98Verifier {
  /**
   * Extract NIP-98 token from Authorization header
   */
  static extractToken(authHeader: string): NostrEvent | null {
    if (!authHeader) return null

    // Format: "Nostr base64encodedEvent"
    const match = authHeader.match(/^Nostr\s+(.+)$/i)
    if (!match) return null

    try {
      const decoded = Buffer.from(match[1], "base64").toString("utf8")
      return JSON.parse(decoded) as NostrEvent
    } catch (err: unknown) {
      console.error("NIP-98: Failed to decode token:", err)
      return null
    }
  }

  /**
   * Validate the structure of a NIP-98 event
   */
  static validateEventStructure(event: unknown): ValidationResult {
    if (!event || typeof event !== "object") {
      return { valid: false, error: "Invalid event object" }
    }

    const ev = event as Record<string, unknown>

    // Check required fields
    const requiredFields: string[] = ["id", "pubkey", "created_at", "kind", "tags", "sig"]
    for (const field of requiredFields) {
      if (!(field in ev)) {
        return { valid: false, error: `Missing required field: ${field}` }
      }
    }

    // Validate kind
    if (ev.kind !== NIP98_KIND) {
      return {
        valid: false,
        error: `Invalid event kind: ${ev.kind}, expected ${NIP98_KIND}`,
      }
    }

    // Validate pubkey format (64 char hex)
    if (!/^[0-9a-f]{64}$/i.test(ev.pubkey as string)) {
      return { valid: false, error: "Invalid pubkey format" }
    }

    // Validate signature format (128 char hex for Schnorr)
    if (!/^[0-9a-f]{128}$/i.test(ev.sig as string)) {
      return { valid: false, error: "Invalid signature format" }
    }

    // Validate id format (64 char hex)
    if (!/^[0-9a-f]{64}$/i.test(ev.id as string)) {
      return { valid: false, error: "Invalid event id format" }
    }

    // Validate tags is array
    if (!Array.isArray(ev.tags)) {
      return { valid: false, error: "Tags must be an array" }
    }

    return { valid: true }
  }

  /**
   * Validate the event timestamp
   */
  static validateTimestamp(
    event: NostrEvent,
    maxAgeSeconds: number = MAX_EVENT_AGE_SECONDS,
  ): ValidationResult {
    const now = Math.floor(Date.now() / 1000)
    const eventTime = event.created_at

    // Check if event is too old
    if (now - eventTime > maxAgeSeconds) {
      return {
        valid: false,
        error: `Event too old: ${now - eventTime}s (max: ${maxAgeSeconds}s)`,
      }
    }

    // Check if event is in the future (with small tolerance)
    if (eventTime > now + 60) {
      return { valid: false, error: "Event timestamp is in the future" }
    }

    return { valid: true }
  }

  /**
   * Validate the URL tag matches the request URL
   */
  static validateUrlTag(event: NostrEvent, requestUrl: string): ValidationResult {
    const urlTag = getTagValue(event.tags, "u")

    if (!urlTag) {
      return { valid: false, error: "Missing u (URL) tag" }
    }

    const normalizedEventUrl = normalizeUrl(urlTag)
    const normalizedRequestUrl = normalizeUrl(requestUrl)

    if (normalizedEventUrl !== normalizedRequestUrl) {
      return {
        valid: false,
        error: `URL mismatch: event=${normalizedEventUrl}, request=${normalizedRequestUrl}`,
      }
    }

    return { valid: true }
  }

  /**
   * Validate the method tag matches the request method
   */
  static validateMethodTag(event: NostrEvent, requestMethod: string): ValidationResult {
    const methodTag = getTagValue(event.tags, "method")

    if (!methodTag) {
      return { valid: false, error: "Missing method tag" }
    }

    if (methodTag.toUpperCase() !== requestMethod.toUpperCase()) {
      return {
        valid: false,
        error: `Method mismatch: event=${methodTag}, request=${requestMethod}`,
      }
    }

    return { valid: true }
  }

  /**
   * Validate the per-session challenge tag.
   *
   * Compared in constant time: the challenge is the replay guard for the
   * server-held NIP-46 flow, so it is treated like a secret.
   */
  static validateChallengeTag(
    event: NostrEvent,
    expectedChallenge: string,
  ): ValidationResult {
    const challengeTag = getTagValue(event.tags, "challenge")

    if (!challengeTag) {
      return { valid: false, error: "Missing challenge tag" }
    }

    const expected = Buffer.from(expectedChallenge)
    const presented = Buffer.from(challengeTag)
    if (
      expected.length !== presented.length ||
      !crypto.timingSafeEqual(expected, presented)
    ) {
      return { valid: false, error: "Challenge mismatch" }
    }

    return { valid: true }
  }

  /**
   * Verify the event ID matches the calculated hash
   */
  static verifyEventId(event: NostrEvent): ValidationResult {
    const calculatedId = calculateEventId(event)

    if (calculatedId.toLowerCase() !== event.id.toLowerCase()) {
      return {
        valid: false,
        error: "Event ID does not match calculated hash",
      }
    }

    return { valid: true }
  }

  /**
   * Verify the event signature
   */
  static verifySignature(event: NostrEvent): ValidationResult {
    try {
      const isValid = verifySchnorrSignature(event.sig, event.id, event.pubkey)

      if (!isValid) {
        return { valid: false, error: "Invalid signature" }
      }

      return { valid: true }
    } catch (err: unknown) {
      return {
        valid: false,
        error: `Signature verification failed: ${(err as Error).message}`,
      }
    }
  }

  /**
   * Fully validate a NIP-98 authentication request
   */
  static async verify({ authHeader, ...rest }: VerifyOptions): Promise<VerifyResult> {
    // Extract token
    const event = this.extractToken(authHeader)
    if (!event) {
      return {
        valid: false,
        error: "Failed to extract NIP-98 token from Authorization header",
      }
    }

    return this.verifySignedEvent({ ...rest, event })
  }

  /**
   * Fully validate an already-decoded NIP-98 event.
   */
  static async verifySignedEvent({
    event: candidate,
    url,
    method,
    maxAgeSeconds = MAX_EVENT_AGE_SECONDS,
    challenge,
    expectedPubkey,
  }: VerifySignedEventOptions): Promise<VerifyResult> {
    // Validate structure
    const structureResult = this.validateEventStructure(candidate)
    if (!structureResult.valid) {
      return structureResult
    }
    const event = candidate as NostrEvent

    // Bind the signature to the expected signer, when the caller knows it.
    if (expectedPubkey && event.pubkey.toLowerCase() !== expectedPubkey.toLowerCase()) {
      return { valid: false, error: "Event pubkey does not match expected signer" }
    }

    // Validate the per-session challenge, when one is required.
    if (challenge) {
      const challengeResult = this.validateChallengeTag(event, challenge)
      if (!challengeResult.valid) {
        return challengeResult
      }
    }

    // Validate timestamp
    const timestampResult = this.validateTimestamp(event, maxAgeSeconds)
    if (!timestampResult.valid) {
      return timestampResult
    }

    // Validate URL tag
    const urlResult = this.validateUrlTag(event, url)
    if (!urlResult.valid) {
      return urlResult
    }

    // Validate method tag
    const methodResult = this.validateMethodTag(event, method)
    if (!methodResult.valid) {
      return methodResult
    }

    // Verify event ID
    const idResult = this.verifyEventId(event)
    if (!idResult.valid) {
      return idResult
    }

    // Verify signature
    const sigResult = this.verifySignature(event)
    if (!sigResult.valid) {
      return sigResult
    }

    // All validations passed
    return {
      valid: true,
      pubkey: event.pubkey.toLowerCase(),
      event,
    }
  }

  /**
   * Create a NIP-98 Authorization header value (for testing/client use)
   */
  static createAuthHeader(event: NostrEvent): string {
    const encoded = Buffer.from(JSON.stringify(event)).toString("base64")
    return `Nostr ${encoded}`
  }
}

export default Nip98Verifier
