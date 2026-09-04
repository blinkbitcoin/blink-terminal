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
 *    reported ready, a later drop reconnects it in the background and callers fail IMMEDIATELY
 *    in the meantime — they never wait out the deadline. Waiting there would only add latency:
 *    disableOfflineQueue means a command issued during the gap rejects at once anyway, so the
 *    wait delayed every rate-limited endpoint and every fail-closed 503 for no gain
 *    (review of #75). The deadline is for FIRST establishment only.
 *
 * Because nothing waits for `ready` any more, the helper that did so is gone — with it the
 * listener it registered per timeout and never removed, which accumulated until Node emitted
 * MaxListenersExceededWarning (review of #75). The leak is fixed by the code path not existing.
 *
 * A failed initial connect is remembered briefly (UNAVAILABLE_BACKOFF_MS). Without that memo,
 * consumers that run in sequence within one request each rebuild a client and each wait the full
 * deadline — the rate limiter, then the session store, so a single cold-start request paid the
 * deadline twice (review of #75). The window is short so a recovered Redis is picked up on the
 * next request rather than being masked.
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

/**
 * How long a failed initial connect is remembered. Consumers arriving inside this window fail
 * immediately instead of each paying the deadline again. Short, so recovery is noticed promptly.
 */
const UNAVAILABLE_BACKOFF_MS = 1500

let client: RedisClientType | null = null
let ready = false
let initPromise: Promise<RedisClientType> | null = null
let unavailableUntil = 0

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
 * - Not ready and a client exists that is reconnecting (isOpen) → fail IMMEDIATELY and let
 *   node-redis reconnect in the background; do NOT wait and do NOT build a second client.
 * - A client exists but is permanently closed (!isOpen) → dispose and build a fresh one, so a
 *   budget-exhausted initial attempt can still recover on the next call.
 * - The INITIAL connect is the only bounded phase; recovery of an established connection is
 *   unbounded and owned by node-redis.
 */
async function connectInitial(): Promise<RedisClientType> {
  if (client && ready) return client

  if (client && client.isOpen) {
    // Dropped after connecting: node-redis is already reconnecting on its own. Fail now rather
    // than holding the request for the deadline — a command issued during the gap would reject
    // immediately anyway (disableOfflineQueue), so waiting only added latency. The `ready` event
    // handler restores readiness when the reconnect lands; no second client is built.
    throw new Error(UNREACHABLE)
  }

  if (client) {
    // Permanently closed (an earlier bounded attempt gave up). Start clean.
    client.disconnect()
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
    // Remember the failure briefly so the next consumer in this request fails fast instead of
    // paying the whole deadline over again.
    unavailableUntil = Date.now() + UNAVAILABLE_BACKOFF_MS
    throw error instanceof Error ? error : new Error(UNREACHABLE)
  }
  ready = true
  unavailableUntil = 0
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
  // A recent initial connect already timed out: fail now rather than rebuilding and waiting the
  // deadline again for every consumer in the same request.
  if (Date.now() < unavailableUntil) throw new Error(UNREACHABLE)
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

/**
 * Test-only: close the shared client and reset all state so a test process can exit.
 *
 * Uses disconnect(), not quit(): quit() waits for a graceful exchange with the server, which
 * never completes while the client is mid-reconnect, so cleanup hung (review of #75). This also
 * matches how a timed-out initial connect is disposed.
 */
export async function __closeSharedRedisForTests(): Promise<void> {
  const c = client
  client = null
  ready = false
  initPromise = null
  unavailableUntil = 0
  if (c) {
    try {
      c.disconnect()
    } catch {
      // Already closed; nothing to release.
    }
  }
}
