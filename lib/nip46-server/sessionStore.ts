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
 * ONE BACKEND PER SESSION, CHOSEN ONCE AT CREATION. The backend is decided when
 * the session is created and never re-evaluated for that session's life:
 *
 *  - Redis configured and reachable, write succeeds → Redis.
 *  - Redis configured but the initial write does NOT land — unreachable
 *    (getRedisClient throws) OR reachable but rejecting the write (OOM, cannot
 *    persist to disk, readonly replica, ACL) → the in-process Map. Creation is
 *    the ONE point where this degrade is safe: no backend is committed until a
 *    write lands, so falling back cannot split an existing session. The record
 *    then lives in the Map for its whole short life; every read/transition/
 *    delete consults the Map FIRST, so a later Redis recovery cannot orphan it.
 *  - A command failing on an ALREADY-committed Redis session (getSession,
 *    transition, deleteSession) → Nip46StorageError (retryable 503). Degrading
 *    there WOULD split a live session across two backends, so it fails closed.
 *
 * This is the one-backend-per-session invariant the store promised: the earlier
 * bug was re-choosing the backend from live connectivity on every operation,
 * which split sessions across backends whenever Redis flapped — a session
 * created in memory during an outage vanished when Redis recovered, and a
 * Redis-backed session read during a drop looked expired while its relay worker
 * was still live (PR #71 review, then confirmed live on staging).
 *
 * A SEPARATE regression (fixed here): the create path used to fail closed on a
 * readable-but-write-rejecting Redis, 503'ing sign-in even though poll/consume
 * reads still worked. Because create is pre-commit, it now degrades like the
 * unreachable case (reproduced locally with `maxmemory 1` + noeviction).
 */

import crypto from "crypto"

import type { RedisClientType } from "redis"

import { getSharedRedisClient, __closeSharedRedisForTests } from "../redis"

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

// ---------- Redis (shared client, opt-in) ----------

function redisEnabled(): boolean {
  return process.env.ENABLE_HYBRID_STORAGE === "true"
}

/**
 * The session backend's Redis access goes through the shared client (lib/redis.ts), which owns
 * the connection lifecycle for the whole process: a bounded initial connect (covering the
 * handshake, which socket.connectTimeout does not) and recoverable established operation.
 *
 * Returns null ONLY when Redis is not configured — that is the one case in which the
 * in-process Map is a session backend. When Redis IS configured but unreachable at creation,
 * this throws: a session that is memory-resident for its whole life is fine, but re-choosing
 * the backend from live connectivity on every operation is what split sessions across backends
 * (PR #71 review, then live on staging). The degrade decision happens once, at creation, in
 * createSession below.
 */
async function getRedisClient(): Promise<RedisClientType | null> {
  if (!redisEnabled()) return null
  try {
    return await getSharedRedisClient()
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

  // The session's backend is chosen ONCE, here at creation, and never re-evaluated for its life
  // (PR #71 review). Creation is the ONE point where degrading to memory is safe, because nothing
  // is committed to a backend yet — the one-backend-per-session invariant is about a record that
  // already lives somewhere, and there is no such record until this write lands. So EVERY way the
  // initial persist can fail resolves the same way: put the record in the in-process Map and use
  // that as its backend for its whole short life. Sign-in stays up whether Redis is unreachable,
  // rejecting writes (OOM / MISCONF-can't-persist / READONLY replica), or ACL-denied.
  //
  // This is the fix for the staging regression: a readable-but-write-rejecting Redis threw here
  // and 503'd sign-in, even though reads (poll/consume) still worked. It is distinct from a write
  // failure on an ALREADY-committed Redis session (getSession/transition/deleteSession), which
  // still fails closed — degrading those WOULD split a live session across two backends.
  let redis: RedisClientType | null = null
  try {
    redis = await getRedisClient()
  } catch {
    // Configured-but-unreachable: degrade to memory below. Nothing is thrown.
    redis = null
  }

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
      // A reachable Redis that rejects THIS write (OOM, can't-persist, readonly replica) must not
      // take sign-in down: no backend is committed yet, so fall through to the Map. Reads consult
      // memory first, so the record stays coherent for its whole life even if Redis later heals.
      console.warn(
        "[nip46] session store write failed; degrading this session to memory:",
        asMessage(error),
      )
    }
  }

  memoryStore.set(record.id, record)
  return record
}

export async function getSession(id: string): Promise<Nip46SessionRecord | null> {
  // Memory is consulted FIRST. A session written to memory during a Redis outage must stay
  // readable for its whole life even after Redis recovers — re-deciding the backend from live
  // connectivity on every read is what orphaned those sessions (PR #71 review). Ids are
  // per-session and distinct across backends, so a memory hit is authoritative.
  const inMemory = memoryStore.get(id)
  if (inMemory) {
    if (isExpired(inMemory)) {
      memoryStore.delete(id)
      return null
    }
    return inMemory
  }

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

  return null
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
  // A session's backend is fixed at creation, so the Map is consulted first: a record written
  // there during an outage must transition in memory even after Redis recovers (PR #71 review).
  if (memoryStore.has(id)) {
    return transitionInMemory(id, options)
  }

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
  // Backend fixed at creation: delete where the record actually lives. A memory-resident record
  // is removed there even if Redis has recovered (PR #71 review).
  if (memoryStore.has(id)) {
    memoryStore.delete(id)
    return
  }

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
  await __closeSharedRedisForTests()
}
