/**
 * TTL-bound metadata for server-held NIP-46 sign-in sessions.
 *
 * SCOPE: this store holds *status*, not transport. The ephemeral NIP-46 private
 * key, the relay pool and the worker live in sessionManager's in-process map and
 * are never persisted — a leaked store must not become a signing capability.
 *
 * What is persisted per session:
 *   - status: pending -> approved -> consumed (or failed)
 *   - bindingHash: SHA-256 of the HttpOnly cookie secret handed to the browser
 *     that created the session. Every read and the consume step require it, so
 *     a leaked or pasted status URL is not by itself a login capability.
 *   - expectedUrl / challenge: the canonical NIP-98 `u` value and the
 *     per-session challenge the signed kind-27235 event must carry.
 *   - pubkey: set on approval, returned by consume.
 *
 * Consumption is atomic and single-use (Redis WATCH/MULTI compare-and-swap,
 * mirroring lib/auth/challengeStore.ts), so one approval mints at most one
 * session cookie.
 *
 * Backed by Redis when ENABLE_HYBRID_STORAGE is set — the same flag that gates
 * the rest of the Redis stack — and by a per-process Map otherwise.
 */

import crypto from "crypto"

import { createClient, type RedisClientType } from "redis"

// ---------- Types ----------

export type Nip46SessionStatus = "pending" | "approved" | "failed" | "consumed"

export interface Nip46SessionRecord {
  id: string
  status: Nip46SessionStatus
  createdAt: number
  expiresAt: number
  /** SHA-256 (hex) of the browser-binding cookie secret. */
  bindingHash: string
  /** Canonical NIP-98 `u` value the signed event must carry. */
  expectedUrl: string
  /** Per-session challenge the signed event must carry in a `challenge` tag. */
  challenge: string
  /** Set once the signer's identity is verified. */
  pubkey?: string
  /** Machine-readable failure reason (see Nip46FailureReason). */
  error?: string
}

export type Nip46FailureReason =
  | "relays_unavailable"
  | "connect_timeout"
  | "signing_timeout"
  | "signer_rejected"
  | "verification_failed"
  | "server_restarted"
  | "cancelled"
  | "expired"
  | "internal_error"

export interface ConsumeResult {
  ok: boolean
  pubkey?: string
  error?: string
}

// ---------- Constants ----------

const REDIS_KEY_PREFIX = "blink-terminal:nip46:"
export const SESSION_TTL_SECONDS = 300

// ---------- In-memory fallback ----------

const memoryStore: Map<string, Nip46SessionRecord> = new Map()

const cleanupTimer = setInterval((): void => {
  const now = Date.now()
  for (const [id, record] of memoryStore.entries()) {
    if (record.expiresAt < now) memoryStore.delete(id)
  }
}, 60 * 1000)
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
        console.error("NIP-46 session store Redis error:", err.message)
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
        "NIP-46 session store Redis connection failed; falling back to in-memory:",
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

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

export function generateSessionId(): string {
  return crypto.randomBytes(16).toString("hex")
}

export function generateBindingSecret(): string {
  return crypto.randomBytes(32).toString("hex")
}

export function generateSessionChallenge(): string {
  return crypto.randomBytes(32).toString("hex")
}

/** Constant-time comparison of two equal-length hex digests. */
export function bindingMatches(expected: string, presented?: string): boolean {
  if (!presented || presented.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(presented))
}

function isExpired(record: Nip46SessionRecord): boolean {
  return record.expiresAt < Date.now()
}

// ---------- API ----------

export interface CreateSessionInput {
  id: string
  bindingHash: string
  expectedUrl: string
  challenge: string
  ttlSeconds?: number
}

export async function createSession(
  input: CreateSessionInput,
): Promise<Nip46SessionRecord> {
  const ttlSeconds = input.ttlSeconds ?? SESSION_TTL_SECONDS
  const now = Date.now()
  const record: Nip46SessionRecord = {
    id: input.id,
    status: "pending",
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
    bindingHash: input.bindingHash,
    expectedUrl: input.expectedUrl,
    challenge: input.challenge,
  }

  const redis = await getRedisClient()
  if (redis && redisConnected) {
    try {
      await redis.set(REDIS_KEY_PREFIX + record.id, JSON.stringify(record), {
        EX: ttlSeconds,
        NX: true,
      })
      return record
    } catch (error: unknown) {
      console.warn(
        "NIP-46 session store Redis set failed; using in-memory:",
        (error as Error).message,
      )
    }
  }

  memoryStore.set(record.id, record)
  return record
}

export async function getSession(id: string): Promise<Nip46SessionRecord | null> {
  const redis = await getRedisClient()
  if (redis && redisConnected) {
    try {
      const raw = await redis.get(REDIS_KEY_PREFIX + id)
      if (!raw) return null
      const record = JSON.parse(raw) as Nip46SessionRecord
      return isExpired(record) ? null : record
    } catch (error: unknown) {
      console.warn(
        "NIP-46 session store Redis get failed; using in-memory:",
        (error as Error).message,
      )
    }
  }

  const record = memoryStore.get(id)
  if (!record) return null
  if (isExpired(record)) {
    memoryStore.delete(id)
    return null
  }
  return record
}

async function writeExisting(record: Nip46SessionRecord): Promise<void> {
  const redis = await getRedisClient()
  if (redis && redisConnected) {
    try {
      const ttlMs = Math.max(1, record.expiresAt - Date.now())
      await redis.set(REDIS_KEY_PREFIX + record.id, JSON.stringify(record), {
        PX: ttlMs,
      })
      return
    } catch (error: unknown) {
      console.warn(
        "NIP-46 session store Redis update failed; using in-memory:",
        (error as Error).message,
      )
    }
  }
  memoryStore.set(record.id, record)
}

/**
 * Record a verified approval. Only a pending session can be approved, so a late
 * worker can never resurrect a cancelled or already-consumed session.
 */
export async function markApproved(id: string, pubkey: string): Promise<boolean> {
  const record = await getSession(id)
  if (!record || record.status !== "pending") return false
  await writeExisting({ ...record, status: "approved", pubkey })
  return true
}

export async function markFailed(
  id: string,
  reason: Nip46FailureReason,
): Promise<boolean> {
  const record = await getSession(id)
  if (!record) return false
  // Terminal states stay terminal.
  if (record.status === "consumed" || record.status === "failed") return false
  await writeExisting({ ...record, status: "failed", error: reason })
  return true
}

export async function deleteSession(id: string): Promise<void> {
  const redis = await getRedisClient()
  if (redis && redisConnected) {
    try {
      await redis.del(REDIS_KEY_PREFIX + id)
      return
    } catch {
      // fall through to memory
    }
  }
  memoryStore.delete(id)
}

/**
 * Atomically move an approved session to consumed and return its pubkey.
 *
 * This is the single point where an approval becomes a login, so it must be
 * exactly-once: the Redis path uses WATCH/MULTI so two concurrent consume calls
 * (double-clicked button, duplicated request) cannot both mint a cookie.
 */
export async function consumeSession(
  id: string,
  presentedBindingSecret: string | undefined,
): Promise<ConsumeResult> {
  const redis = await getRedisClient()
  if (redis && redisConnected) {
    try {
      return await consumeSessionRedis(redis, id, presentedBindingSecret)
    } catch (error: unknown) {
      console.warn(
        "NIP-46 session store Redis consume failed; using in-memory:",
        (error as Error).message,
      )
    }
  }
  return consumeSessionInMemory(id, presentedBindingSecret)
}

function checkConsumable(
  record: Nip46SessionRecord | null,
  presentedBindingSecret: string | undefined,
): string | null {
  if (!record) return "Session not found or expired"
  // Binding is checked before anything else so that a caller without the cookie
  // cannot distinguish "wrong session", "expired" and "already used".
  const presentedHash = presentedBindingSecret
    ? sha256Hex(presentedBindingSecret)
    : undefined
  if (!bindingMatches(record.bindingHash, presentedHash)) {
    return "Session not found or expired"
  }
  if (isExpired(record)) return "Session expired"
  if (record.status === "consumed") return "Session already used"
  if (record.status !== "approved") return "Session is not approved"
  if (!record.pubkey) return "Session has no verified pubkey"
  return null
}

function consumeSessionInMemory(
  id: string,
  presentedBindingSecret: string | undefined,
): ConsumeResult {
  const record = memoryStore.get(id) ?? null
  const error = checkConsumable(record, presentedBindingSecret)
  if (error || !record) return { ok: false, error: error ?? "Session not found" }

  memoryStore.set(id, { ...record, status: "consumed" })
  return { ok: true, pubkey: record.pubkey }
}

async function consumeSessionRedis(
  redis: RedisClientType,
  id: string,
  presentedBindingSecret: string | undefined,
): Promise<ConsumeResult> {
  const key = REDIS_KEY_PREFIX + id

  await redis.watch(key)
  const raw = await redis.get(key)
  const record = raw ? (JSON.parse(raw) as Nip46SessionRecord) : null

  const error = checkConsumable(record, presentedBindingSecret)
  if (error || !record) {
    await redis.unwatch()
    return { ok: false, error: error ?? "Session not found" }
  }

  const consumed: Nip46SessionRecord = { ...record, status: "consumed" }
  const ttlMs = Math.max(1, record.expiresAt - Date.now())
  const result = await redis
    .multi()
    .set(key, JSON.stringify(consumed), { PX: ttlMs })
    .exec()

  if (!result) {
    // Watched key changed — another request consumed it first.
    return { ok: false, error: "Session already used" }
  }

  return { ok: true, pubkey: record.pubkey }
}

/** Test-only: drop the in-memory contents between cases. */
export function __resetSessionStoreForTests(): void {
  memoryStore.clear()
}
