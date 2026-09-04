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
 *
 * ONE BACKEND PER SESSION. The backend is chosen by CONFIGURATION, never by
 * whether Redis happens to be reachable right now: with ENABLE_HYBRID_STORAGE
 * set, Redis is the backend and nothing is ever written to the Map. Any Redis
 * unavailability — a command failure, a failed initial connection, or a client
 * that dropped after connecting — raises Nip46StorageError, which the routes
 * turn into a retryable 503.
 *
 * Both halves matter. Falling back per-command split a session across two
 * stores (a failed SET wrote to memory; the next GET against a recovered Redis
 * missed and 404'd a session whose relay worker was still running). Falling
 * back on connection state did the same one layer up: a session created in
 * memory during an outage vanished when Redis recovered, and a Redis-backed
 * session read during a drop looked expired (PR #71 review). Failing closed on
 * both keeps every session on exactly one backend for its whole life.
 */

import crypto from "crypto"

import { createClient, type RedisClientType } from "redis"

import { Nip46StorageError } from "./errors"

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
let redisInitPromise: Promise<RedisClientType> | null = null

function redisEnabled(): boolean {
  return process.env.ENABLE_HYBRID_STORAGE === "true"
}

/**
 * The single Redis client, created once and reused across connection attempts.
 *
 * Returns null ONLY when Redis is not configured — that is the one case in which the
 * in-process Map is the session backend. When Redis IS configured but unavailable (the
 * initial connection failed, or a connected client has since dropped), this throws
 * Nip46StorageError rather than returning null. Returning null there silently switched every
 * subsequent operation to the Map, which split sessions across backends exactly as the
 * header forbids: a session created in memory during an outage vanished when Redis recovered,
 * and a Redis-backed session read during a drop 404'd while its relay worker was still live
 * (PR #71 review). Failing closed turns both into a retryable 503.
 *
 * One client, not one per attempt: a failed connect used to null the client and build a fresh
 * one on the next call. node-redis reconnects on its own; the same instance is kept and its
 * readiness re-checked, so a recovering Redis is picked up without a pile of half-built clients.
 */
async function getRedisClient(): Promise<RedisClientType | null> {
  if (!redisEnabled()) return null
  if (redisClient && redisConnected) return redisClient

  // A client exists but is not ready: it dropped after connecting. node-redis is already
  // reconnecting it; `ready` will flip the flag back. Do NOT fall back to memory and do NOT
  // build a second client — fail closed until it recovers.
  if (redisClient) {
    throw new Nip46StorageError("Redis is configured but currently disconnected")
  }

  if (!redisInitPromise) {
    redisInitPromise = (async (): Promise<RedisClientType> => {
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
      // `ready` (not `connect`): the socket can be open before the handshake completes,
      // and a command sent in that gap fails. Readiness is what "connected" means here.
      client.on("ready", () => {
        redisConnected = true
      })
      client.on("end", () => {
        redisConnected = false
      })

      try {
        await client.connect()
      } catch (error: unknown) {
        // The initial connection never came up, so there is nothing for node-redis to
        // reconnect. Leave `redisClient` unset so the next call retries from scratch — but
        // that retry is the ONLY thing that happens; nothing is written to memory meanwhile.
        redisConnected = false
        throw error
      }

      redisClient = client
      redisConnected = true
      return client
    })().finally(() => {
      redisInitPromise = null
    })
  }

  try {
    return await redisInitPromise
  } catch (error: unknown) {
    throw new Nip46StorageError(
      `Redis is configured but unavailable: ${(error as Error).message}`,
    )
  }
}

// ---------- Helpers ----------

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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

  // Non-null means connected; configured-but-unavailable throws, unconfigured is null.
  const redis = await getRedisClient()
  if (redis) {
    try {
      await redis.set(REDIS_KEY_PREFIX + record.id, JSON.stringify(record), {
        // The Redis TTL is a garbage-collection bound, not the expiry rule:
        // `expiresAt` is the authority, and every read re-checks it. They are
        // clamped apart because Redis rejects a non-positive EX outright, which
        // would turn an already-expired record into a hard storage error.
        EX: Math.max(1, Math.ceil(ttlSeconds)),
        NX: true,
      })
      return record
    } catch (error: unknown) {
      throw new Nip46StorageError(`could not persist session: ${asMessage(error)}`)
    }
  }

  memoryStore.set(record.id, record)
  return record
}

export async function getSession(id: string): Promise<Nip46SessionRecord | null> {
  // Non-null means connected; configured-but-unavailable throws, unconfigured is null.
  const redis = await getRedisClient()
  if (redis) {
    try {
      const raw = await redis.get(REDIS_KEY_PREFIX + id)
      if (!raw) return null
      const record = JSON.parse(raw) as Nip46SessionRecord
      return isExpired(record) ? null : record
    } catch (error: unknown) {
      throw new Nip46StorageError(`could not read session: ${asMessage(error)}`)
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

// ---------- Atomic state transitions ----------

/**
 * Every state change is a CONDITIONAL transition executed inside Redis.
 *
 * The previous implementation used WATCH/MULTI on the shared singleton
 * connection, which is not a compare-and-swap: WATCH state is connection-scoped,
 * so two overlapping requests on the same client both read `approved`, the first
 * EXEC clears the connection's watch, and the second EXEC then runs unguarded —
 * both succeed and one approval mints two sessions (PR #71 review).
 *
 * A Lua script is atomic by construction: Redis runs it to completion on a
 * single thread, so the read, the checks and the write cannot interleave with
 * anything, on any connection. It also removes the read-then-write window that
 * let a late worker resurrect a cancelled session.
 *
 * Returns a flat array: { outcome, recordJson? }.
 */
const TRANSITION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'notfound'} end

local rec = cjson.decode(raw)

-- Binding is checked first so a caller without the cookie cannot tell
-- "wrong session" from "expired" or "already used".
if ARGV[1] ~= '' and rec.bindingHash ~= ARGV[1] then return {'binding'} end
if tonumber(rec.expiresAt) < tonumber(ARGV[4]) then return {'expired'} end

local allowed = cjson.decode(ARGV[2])
local ok = false
for i = 1, #allowed do
  if rec.status == allowed[i] then ok = true break end
end
if not ok then return {'status', rec.status} end

if ARGV[5] == '1' and (rec.pubkey == nil or rec.pubkey == '') then
  return {'nopubkey'}
end

rec.status = ARGV[3]
local patch = cjson.decode(ARGV[6])
for k, v in pairs(patch) do rec[k] = v end

local ttl = tonumber(rec.expiresAt) - tonumber(ARGV[4])
if ttl < 1 then ttl = 1 end
redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ttl)

return {'ok', cjson.encode(rec)}
`

type TransitionFailure = "notfound" | "binding" | "expired" | "status" | "nopubkey"

interface TransitionOptions {
  /** Statuses the session may currently be in. */
  from: Nip46SessionStatus[]
  to: Nip46SessionStatus
  /** When set, the stored bindingHash must equal this. */
  bindingHash?: string
  /** Require a verified pubkey to be present (consumption). */
  requirePubkey?: boolean
  patch?: Partial<Nip46SessionRecord>
}

type TransitionResult =
  | { ok: true; record: Nip46SessionRecord }
  | { ok: false; reason: TransitionFailure; status?: Nip46SessionStatus }

async function transition(
  id: string,
  options: TransitionOptions,
): Promise<TransitionResult> {
  // Non-null means connected; configured-but-unavailable throws, unconfigured is null.
  const redis = await getRedisClient()
  if (redis) {
    try {
      return await transitionRedis(redis, id, options)
    } catch (error: unknown) {
      throw new Nip46StorageError(`could not update session: ${asMessage(error)}`)
    }
  }
  return transitionInMemory(id, options)
}

async function transitionRedis(
  redis: RedisClientType,
  id: string,
  options: TransitionOptions,
): Promise<TransitionResult> {
  const reply = (await redis.eval(TRANSITION_SCRIPT, {
    keys: [REDIS_KEY_PREFIX + id],
    arguments: [
      options.bindingHash ?? "",
      JSON.stringify(options.from),
      options.to,
      String(Date.now()),
      options.requirePubkey ? "1" : "0",
      JSON.stringify(options.patch ?? {}),
    ],
  })) as unknown as [string, string?]

  const [outcome, payload] = reply
  if (outcome === "ok" && payload) {
    return { ok: true, record: JSON.parse(payload) as Nip46SessionRecord }
  }
  return {
    ok: false,
    reason: outcome as TransitionFailure,
    status: payload as Nip46SessionStatus | undefined,
  }
}

function transitionInMemory(id: string, options: TransitionOptions): TransitionResult {
  const record = memoryStore.get(id)
  if (!record) return { ok: false, reason: "notfound" }
  if (options.bindingHash && record.bindingHash !== options.bindingHash) {
    return { ok: false, reason: "binding" }
  }
  if (isExpired(record)) return { ok: false, reason: "expired" }
  if (!options.from.includes(record.status)) {
    return { ok: false, reason: "status", status: record.status }
  }
  if (options.requirePubkey && !record.pubkey) {
    return { ok: false, reason: "nopubkey" }
  }

  const updated: Nip46SessionRecord = {
    ...record,
    ...options.patch,
    status: options.to,
  }
  memoryStore.set(id, updated)
  return { ok: true, record: updated }
}

/**
 * Record a verified approval. Only a pending session can be approved, so a late
 * worker can never resurrect a cancelled or already-consumed session.
 */
export async function markApproved(id: string, pubkey: string): Promise<boolean> {
  const result = await transition(id, {
    from: ["pending"],
    to: "approved",
    patch: { pubkey },
  })
  return result.ok
}

/** Terminal states stay terminal: only pending or approved can fail. */
export async function markFailed(
  id: string,
  reason: Nip46FailureReason,
): Promise<boolean> {
  const result = await transition(id, {
    from: ["pending", "approved"],
    to: "failed",
    patch: { error: reason },
  })
  return result.ok
}

export async function deleteSession(id: string): Promise<void> {
  // Non-null means connected; configured-but-unavailable throws, unconfigured is null.
  const redis = await getRedisClient()
  if (redis) {
    try {
      await redis.del(REDIS_KEY_PREFIX + id)
    } catch (error: unknown) {
      // Deletion is best-effort cleanup: the TTL removes the record anyway, and
      // no caller's correctness depends on it. Nothing is written to memory,
      // which would split the session across two backends.
      console.warn("NIP-46 session store delete failed:", asMessage(error))
    }
    return
  }
  memoryStore.delete(id)
}

/**
 * Atomically move an approved session to consumed and return its pubkey.
 *
 * This is the single point where an approval becomes a login, so it must be
 * exactly-once. The transition runs as one Lua script inside Redis, so two
 * concurrent consumes (double-clicked button, duplicated request, two app
 * instances) can never both succeed.
 */
export async function consumeSession(
  id: string,
  presentedBindingSecret: string | undefined,
): Promise<ConsumeResult> {
  // The binding is compared in constant time HERE, in Node, because it is the
  // secret that authorises the consume. The Lua script re-checks it inside the
  // atomic step; that second compare is a plain equality on a SHA-256 digest,
  // which is not a useful timing oracle.
  const presentedHash = presentedBindingSecret
    ? sha256Hex(presentedBindingSecret)
    : undefined

  const existing = await getSession(id)
  if (!existing || !bindingMatches(existing.bindingHash, presentedHash)) {
    return { ok: false, error: "Session not found or expired" }
  }

  const result = await transition(id, {
    from: ["approved"],
    to: "consumed",
    bindingHash: existing.bindingHash,
    requirePubkey: true,
  })

  if (result.ok) {
    return { ok: true, pubkey: result.record.pubkey }
  }

  return { ok: false, error: describeTransitionFailure(result) }
}

function describeTransitionFailure(
  result: Extract<TransitionResult, { ok: false }>,
): string {
  switch (result.reason) {
    case "expired":
      return "Session expired"
    case "nopubkey":
      return "Session has no verified pubkey"
    case "status":
      return result.status === "consumed"
        ? "Session already used"
        : "Session is not approved"
    default:
      // notfound / binding are deliberately indistinguishable.
      return "Session not found or expired"
  }
}

/** Test-only: drop the in-memory contents between cases. */
export function __resetSessionStoreForTests(): void {
  memoryStore.clear()
}

/** Test-only: close the Redis connection so a test process can exit. */
export async function __closeSessionStoreRedisForTests(): Promise<void> {
  const client = redisClient
  redisClient = null
  redisConnected = false
  redisInitPromise = null
  if (client) await client.quit().catch(() => undefined)
}
