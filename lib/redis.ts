/**
 * Shared Redis client lifecycle.
 *
 * Several modules each hand-rolled "get a client, connect it, remember whether it is up", and
 * each got the trade-off between a bounded first connection and a recoverable established
 * connection wrong in a different way (PR #71, and the follow-up reviews of #73 and #74):
 *
 *  - The default reconnect strategy retries an unreachable INITIAL connection forever, so
 *    connect() never rejects and the caller hangs instead of failing fast. Measured against
 *    redis@4.7.0: still pending after 7s and 20 connection errors.
 *  - socket.connectTimeout bounds only the TCP handshake, not the Redis handshake: a peer that
 *    accepts TCP and never answers still leaves connect() pending past the timeout (measured
 *    with a silent listener).
 *  - Bounding the strategy globally kills established recovery: once the retry budget is
 *    exhausted the client is permanently closed and every later operation fails until the
 *    process restarts (measured: connect → outage → exhaustion → Redis restart → still closed).
 *
 * The two policies are incompatible inside one reconnectStrategy, so they live at different
 * layers here:
 *
 *  - INITIAL connect is bounded by an OVERALL deadline (a race, not socket.connectTimeout, so it
 *    covers the handshake). On expiry the client is disposed so it cannot reconnect later as an
 *    orphan, and the caller gets a rejection.
 *  - ESTABLISHED recovery is left to node-redis's default unbounded strategy. Once a client has
 *    reported ready, a later drop reconnects it in the background.
 *
 * Commands issued while disconnected reject immediately (disableOfflineQueue) rather than
 * queueing until a possibly-never reconnection.
 */
import { createClient, type RedisClientType } from "redis"

/**
 * The overall deadline for the INITIAL connection, including the Redis handshake. Read per call
 * (not at module load) so tests can shrink it via the environment without import-order tricks.
 * A mocked client can never reproduce a hang being bounded by real configuration.
 */
function initialConnectDeadlineMs(): number {
  const v = parseInt(process.env.REDIS_CONNECT_DEADLINE_MS || "", 10)
  return Number.isFinite(v) && v > 0 ? v : 5000
}

const UNREACHABLE = "Redis is configured but unreachable"

let client: RedisClientType | null = null
let ready = false
let initPromise: Promise<RedisClientType> | null = null

function buildClient(): RedisClientType {
  const c = createClient({
    socket: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
    },
    // An offline queue would hold commands until the connection returns; in a disconnect
    // window that is unbounded, so commands must reject immediately instead.
    disableOfflineQueue: true,
    password: process.env.REDIS_PASSWORD || undefined,
    database: parseInt(process.env.REDIS_DB || "0", 10),
  }) as RedisClientType

  c.on("error", () => {
    // The error event is noisy during an outage; readiness, not error count, is the signal.
    ready = false
  })
  c.on("ready", () => {
    ready = true
  })
  c.on("end", () => {
    ready = false
  })
  return c
}

/**
 * The shared client, or a rejection when Redis is configured but the initial connection cannot
 * be established within the deadline.
 *
 * - Not ready and a client exists that is reconnecting (isOpen) → wait for it to report ready;
 *   do NOT build a second client.
 * - A client exists but is permanently closed (!isOpen) → dispose and build a fresh one, so a
 *   budget-exhausted initial attempt can still recover on the next call.
 * - The INITIAL connect is the only bounded phase; recovery of an established connection is
 *   unbounded and owned by node-redis.
 */
async function connectInitial(): Promise<RedisClientType> {
  if (client && ready) return client

  if (client && client.isOpen) {
    // Dropped after connecting: node-redis is already reconnecting. Wait for `ready` with the
    // same deadline; do not build a second client.
    await waitForReady(client, initialConnectDeadlineMs())
    ready = true
    return client
  }

  if (client) {
    // Permanently closed (an earlier bounded attempt gave up). Start clean.
    await client.quit().catch(() => undefined)
    client = null
  }

  const next = buildClient()
  client = next
  try {
    await withDeadline(next.connect(), initialConnectDeadlineMs(), () => {
      // The deadline elapsed: dispose so the client cannot reconnect later as an orphan.
      // quit() on a still-connecting socket can block, so destroy the socket directly and let
      // the rejection propagate first.
      next.disconnect()
    })
  } catch (error: unknown) {
    client = null
    ready = false
    throw error instanceof Error ? error : new Error(UNREACHABLE)
  }
  ready = true
  return next
}

function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout()
      } finally {
        reject(new Error(UNREACHABLE))
      }
    }, ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

/** Await `ready` on a client that is already connected/reconnecting, with the same deadline. */
function waitForReady(c: RedisClientType, ms: number): Promise<void> {
  if (ready) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(UNREACHABLE))
    }, ms)
    const onReady = (): void => {
      clearTimeout(timer)
      resolve()
    }
    c.once("ready", onReady)
    // If it never reports ready in time, reject; the caller treats it as unavailable.
  })
}

/**
 * The shared Redis client, or null when Redis is not configured at all (the only null case;
 * callers treat that as "use the in-process backend").
 *
 * Throws an Error when Redis IS configured but unavailable — a failed initial connect or a
 * reconnect that has not reported ready within the deadline. Callers decide what that means
 * (sessionStore throws; the rate limiter and challenge store degrade to memory).
 */
export async function getSharedRedisClient(): Promise<RedisClientType | null> {
  if (process.env.ENABLE_HYBRID_STORAGE !== "true") return null
  if (client && ready) return client
  if (!initPromise) initPromise = connectInitial()
  try {
    return await initPromise
  } finally {
    initPromise = null
  }
}

/** Whether the shared client is currently ready. Callers must not build their own. */
export function sharedRedisReady(): boolean {
  return ready
}

/** Test-only: close the shared client and reset all state so a test process can exit. */
export async function __closeSharedRedisForTests(): Promise<void> {
  const c = client
  client = null
  ready = false
  initPromise = null
  if (c) await c.quit().catch(() => undefined)
}
