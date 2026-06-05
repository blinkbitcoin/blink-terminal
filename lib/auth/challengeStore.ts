/**
 * Challenge Store for Pubkey Ownership Verification
 *
 * Shared module for generating, storing, and verifying challenges.
 * Used by both /api/auth/challenge and /api/auth/verify-ownership.
 *
 * SECURITY model:
 *   - Challenges are single-use. `verifyChallenge` atomically consumes the
 *     challenge so it can never authenticate more than one request.
 *   - Challenges are bound to a single pubkey on first verification
 *     ("trust on first verify"). The external-signer flow fetches the
 *     challenge BEFORE the signer reveals the pubkey, so we cannot bind at
 *     issue time without breaking Amber. Instead, the first pubkey that
 *     successfully presents a challenge claims it; any other pubkey presenting
 *     the same challenge is rejected. Combined with single-use, a challenge can
 *     therefore only ever mint a session for exactly one pubkey.
 *
 * Backed by Redis (shared across instances) when ENABLE_HYBRID_STORAGE is set —
 * the same flag that gates the rest of the Redis/Postgres stack and the rate
 * limiter. When disabled (including in unit tests) it falls back to a
 * per-process in-memory Map so it still degrades safely.
 */

import crypto from "crypto"

import { createClient, type RedisClientType } from "redis"

// ---------- Type Definitions ----------

interface ChallengeData {
  createdAt: number
  expiresAt: number
  used: boolean
  /** Pubkey this challenge has been bound to (set on first verify). */
  boundPubkey?: string
  /**
   * SHA-256 (hex) of the high-entropy secret that was handed to the requesting
   * browser via an HttpOnly cookie at issue time. Redemption requires the
   * caller to present the matching secret, so a signed challenge event is NOT a
   * pure bearer artifact: it can only be redeemed by the browser that requested
   * the challenge. We store only the hash so a leak of the store does not
   * reveal the redemption secret.
   */
  boundSecretHash?: string
}

interface ChallengeVerifyResult {
  valid: boolean
  error?: string
}

// ---------- Constants ----------

const REDIS_KEY_PREFIX = "blink-terminal:challenge:"
const DEFAULT_TTL_SECONDS = 300

// ---------- In-memory challenge store (fallback) ----------

const challengeStore: Map<string, ChallengeData> = new Map()

// Clean up expired challenges periodically (every 5 minutes)
const cleanupTimer = setInterval(
  (): void => {
    const now: number = Date.now()
    for (const [key, data] of challengeStore.entries()) {
      if (data.expiresAt < now) {
        challengeStore.delete(key)
      }
    }
  },
  5 * 60 * 1000,
)
if (cleanupTimer.unref) cleanupTimer.unref()

// ---------- Redis (lazy singleton, opt-in) ----------

let redisClient: RedisClientType | null = null
let redisConnected = false
let redisInitPromise: Promise<RedisClientType | null> | null = null

function redisEnabled(): boolean {
  return process.env.ENABLE_HYBRID_STORAGE === "true"
}

async function getRedisClient(): Promise<RedisClientType | null> {
  if (!redisEnabled()) return null
  if (redisClient && redisConnected) return redisClient
  if (redisInitPromise) return redisInitPromise

  redisInitPromise = (async () => {
    try {
      const client = createClient({
        socket: {
          host: process.env.REDIS_HOST || "localhost",
          port: parseInt(process.env.REDIS_PORT || "6379", 10),
        },
        password: process.env.REDIS_PASSWORD || undefined,
        database: parseInt(process.env.REDIS_DB || "0", 10),
      }) as RedisClientType

      client.on("error", (err: Error) => {
        console.error("Challenge store Redis error:", err.message)
        redisConnected = false
      })
      client.on("connect", () => {
        redisConnected = true
      })

      await client.connect()
      redisClient = client
      redisConnected = true
      return client
    } catch (error: unknown) {
      console.warn(
        "Challenge store Redis connection failed; falling back to in-memory:",
        (error as Error).message,
      )
      redisConnected = false
      redisClient = null
      return null
    } finally {
      redisInitPromise = null
    }
  })()

  return redisInitPromise
}

// ---------- Helpers ----------

function isValidPubkey(pubkey: string): boolean {
  return /^[0-9a-f]{64}$/i.test(pubkey)
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

/**
 * Generate a cryptographically secure challenge.
 * Format: blinkpos:{timestamp}:{random_nonce}
 */
function generateChallenge(): string {
  const timestamp: number = Math.floor(Date.now() / 1000)
  const nonce: string = crypto.randomBytes(16).toString("hex")
  return `blinkpos:${timestamp}:${nonce}`
}

/**
 * Generate the high-entropy redemption secret handed to the requesting browser
 * via an HttpOnly cookie. The caller stores `sha256(secret)` with the challenge
 * (via storeChallenge) and must present the raw secret at verify time.
 */
function generateChallengeSecret(): string {
  return crypto.randomBytes(32).toString("hex")
}

/**
 * Store a challenge for later verification.
 * @param challenge - The challenge string
 * @param ttlSeconds - Time to live in seconds (default: 300)
 * @param secret - The raw redemption secret handed to the requesting browser.
 *   Only its SHA-256 hash is persisted. When provided, verifyChallenge requires
 *   the same secret to be presented (anti-bearer binding). Optional for
 *   backward compatibility, but production callers always set it.
 */
async function storeChallenge(
  challenge: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  secret?: string,
): Promise<void> {
  const data: ChallengeData = {
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlSeconds * 1000,
    used: false,
    boundSecretHash: secret ? sha256Hex(secret) : undefined,
  }

  const redis = await getRedisClient()
  if (redis && redisConnected) {
    try {
      // NX = only set if absent; EX = expiry. Prevents accidental overwrite.
      await redis.set(REDIS_KEY_PREFIX + challenge, JSON.stringify(data), {
        EX: ttlSeconds,
        NX: true,
      })
      return
    } catch (error: unknown) {
      console.warn(
        "Challenge store Redis set failed; using in-memory:",
        (error as Error).message,
      )
    }
  }

  challengeStore.set(challenge, data)
}

/**
 * Verify and consume a challenge, binding it to `pubkey` and the issuing
 * browser's redemption secret.
 *
 * Enforces:
 *   1. Challenge exists and is not expired.
 *   2. Challenge has not already been used (single-use).
 *   3. The presented secret matches the one issued to the requesting browser
 *      (anti-bearer: a signed challenge can only be redeemed by the browser
 *      that requested it). Rejected with the challenge left intact-but-burnable.
 *   4. Challenge is bound to `pubkey` on first verify; any later attempt with a
 *      different pubkey is rejected.
 *
 * The pubkey MUST be the cryptographically verified signer pubkey from the
 * caller (i.e. the caller has already checked the Schnorr signature).
 *
 * @param challenge - The challenge to verify
 * @param pubkey - The verified signer pubkey (64-hex)
 * @param presentedSecret - The raw redemption secret from the challenge cookie
 * @returns An object indicating validity, with an optional error message
 */
async function verifyChallenge(
  challenge: string,
  pubkey: string,
  presentedSecret?: string,
): Promise<ChallengeVerifyResult> {
  if (!pubkey || !isValidPubkey(pubkey)) {
    return { valid: false, error: "Invalid or missing pubkey for challenge binding" }
  }
  const normalizedPubkey = pubkey.toLowerCase()
  const presentedSecretHash = presentedSecret ? sha256Hex(presentedSecret) : undefined

  const redis = await getRedisClient()
  if (redis && redisConnected) {
    try {
      return await verifyChallengeRedis(
        redis,
        challenge,
        normalizedPubkey,
        presentedSecretHash,
      )
    } catch (error: unknown) {
      console.warn(
        "Challenge store Redis verify failed; using in-memory:",
        (error as Error).message,
      )
    }
  }

  return verifyChallengeInMemory(challenge, normalizedPubkey, presentedSecretHash)
}

/**
 * Constant-time-ish comparison of two hex hashes. Both are server-computed
 * SHA-256 digests of equal length, so this is defense-in-depth rather than a
 * strict requirement, but we use timingSafeEqual when lengths match.
 */
function secretHashMatches(expected?: string, presented?: string): boolean {
  if (!expected) return true // challenge issued without a secret (legacy/none)
  if (!presented || presented.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(presented))
}

function verifyChallengeInMemory(
  challenge: string,
  pubkey: string,
  presentedSecretHash?: string,
): ChallengeVerifyResult {
  const data: ChallengeData | undefined = challengeStore.get(challenge)

  if (!data) {
    return { valid: false, error: "Challenge not found or expired" }
  }

  if (data.expiresAt < Date.now()) {
    challengeStore.delete(challenge)
    return { valid: false, error: "Challenge expired" }
  }

  if (data.used) {
    return { valid: false, error: "Challenge already used" }
  }

  if (!secretHashMatches(data.boundSecretHash, presentedSecretHash)) {
    return { valid: false, error: "Challenge secret mismatch" }
  }

  if (data.boundPubkey && data.boundPubkey !== pubkey) {
    // Someone else already claimed this challenge — reject and burn it.
    return { valid: false, error: "Challenge bound to a different pubkey" }
  }

  // Mark as used and bind to this pubkey (one-time use).
  data.used = true
  data.boundPubkey = pubkey

  // Delete after short grace period (in case of retries).
  const t = setTimeout((): void => {
    challengeStore.delete(challenge)
  }, 30000)
  if (t.unref) t.unref()

  return { valid: true }
}

async function verifyChallengeRedis(
  redis: RedisClientType,
  challenge: string,
  pubkey: string,
  presentedSecretHash?: string,
): Promise<ChallengeVerifyResult> {
  const key = REDIS_KEY_PREFIX + challenge

  // WATCH the key so the MULTI/EXEC below aborts if any other instance mutates
  // it between our read and our claim. Redis is single-threaded, so a watched
  // transaction gives us a compare-and-swap to consume the challenge exactly
  // once across all app instances.
  await redis.watch(key)

  const raw = await redis.get(key)

  if (!raw) {
    await redis.unwatch()
    return { valid: false, error: "Challenge not found or expired" }
  }

  const data = JSON.parse(raw) as ChallengeData

  if (data.expiresAt < Date.now()) {
    await redis.unwatch()
    await redis.del(key)
    return { valid: false, error: "Challenge expired" }
  }

  if (data.used) {
    await redis.unwatch()
    return { valid: false, error: "Challenge already used" }
  }

  if (!secretHashMatches(data.boundSecretHash, presentedSecretHash)) {
    await redis.unwatch()
    return { valid: false, error: "Challenge secret mismatch" }
  }

  if (data.boundPubkey && data.boundPubkey !== pubkey) {
    await redis.unwatch()
    return { valid: false, error: "Challenge bound to a different pubkey" }
  }

  const consumed: ChallengeData = { ...data, used: true, boundPubkey: pubkey }
  const ttlMs = Math.max(1, data.expiresAt - Date.now())

  const result = await redis
    .multi()
    .set(key, JSON.stringify(consumed), { PX: ttlMs })
    .exec()

  if (!result) {
    // Transaction aborted (watched key changed) — another request consumed it.
    return { valid: false, error: "Challenge already used" }
  }

  return { valid: true }
}

export { generateChallenge, generateChallengeSecret, storeChallenge, verifyChallenge }
export type { ChallengeData, ChallengeVerifyResult }
