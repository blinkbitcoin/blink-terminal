/**
 * Rate limiting for API endpoints.
 *
 * Provides a `withRateLimit` higher-order function that wraps any Next.js API
 * handler with per-IP fixed-window rate limiting.
 *
 * Backed by Redis (atomic INCR + EXPIRE) so limits are shared across all app
 * instances / serverless invocations. If Redis is unavailable, it falls back to
 * a per-process in-memory store so the limiter still degrades safely.
 *
 * IMPORTANT: client IP is taken from `x-forwarded-for` / `x-real-ip`. This is
 * only trustworthy when the app runs behind a proxy that overwrites these
 * headers. Ensure your ingress/load balancer sets them.
 *
 * Tier presets:
 *   - AUTH        10 req/min  (login, challenge, verify)
 *   - PUBLIC      30 req/min  (public-invoice, lnurlp, lnurl-proxy)
 *   - WRITE       30 req/min  (create-invoice, pay-invoice, forward-*)
 *   - READ       120 req/min  (balance, wallets, transactions, exchange-rate)
 *
 * @module lib/rate-limit
 */

import type { NextApiRequest, NextApiResponse, NextApiHandler } from "next"
import { createClient, type RedisClientType } from "redis"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RateLimitRecord {
  count: number
  resetAt: number
}

interface RateLimitOptions {
  /** Maximum requests allowed in the window. */
  max: number
  /** Window duration in milliseconds (default: 60 000 — 1 minute). */
  windowMs?: number
}

// ---------------------------------------------------------------------------
// Tier presets
// ---------------------------------------------------------------------------

/** Auth endpoints — strict to prevent brute force. */
export const RATE_LIMIT_AUTH: RateLimitOptions = { max: 10 }

/** Public / unauthenticated endpoints. */
export const RATE_LIMIT_PUBLIC: RateLimitOptions = { max: 30 }

/** Authenticated write endpoints (create, pay, forward). */
export const RATE_LIMIT_WRITE: RateLimitOptions = { max: 30 }

/** Authenticated read endpoints (balance, wallets, transactions). */
export const RATE_LIMIT_READ: RateLimitOptions = { max: 120 }

const DEFAULT_WINDOW_MS = 60_000 // 1 minute
const REDIS_KEY_PREFIX = "blink-terminal:ratelimit:"

// ---------------------------------------------------------------------------
// Shared Redis client (lazy singleton)
// ---------------------------------------------------------------------------

let redisClient: RedisClientType | null = null
let redisConnected = false
let redisInitPromise: Promise<RedisClientType | null> | null = null

/**
 * Redis-backed limiting is opt-in via ENABLE_HYBRID_STORAGE (the same flag that
 * gates the rest of the Redis/Postgres stack). When disabled — including in unit
 * tests — the limiter stays purely in-memory and never attempts a connection.
 */
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
        console.error("Rate limit Redis error:", err.message)
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
        "Rate limit Redis connection failed; falling back to in-memory:",
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

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

/**
 * Create a rate limiter. Uses Redis when available (shared across instances),
 * otherwise an isolated in-memory store per limiter instance.
 */
function createRateLimiter(opts: RateLimitOptions) {
  const { max, windowMs = DEFAULT_WINDOW_MS } = opts
  const windowSec = Math.ceil(windowMs / 1000)

  // In-memory fallback store, isolated per limiter instance.
  const store = new Map<string, RateLimitRecord>()

  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [ip, record] of store.entries()) {
      if (now > record.resetAt) store.delete(ip)
    }
  }, windowMs)
  if (cleanupTimer.unref) cleanupTimer.unref()

  function checkInMemory(ip: string): boolean {
    const now = Date.now()
    const record = store.get(ip)
    if (!record || now > record.resetAt) {
      store.set(ip, { count: 1, resetAt: now + windowMs })
      return true
    }
    if (record.count >= max) return false
    record.count++
    return true
  }

  return {
    /**
     * Returns `true` if the request is allowed, `false` if rate-limited.
     * Bucketed by `key` (the limiter's identity) + client IP so different
     * routes don't share a counter.
     */
    async check(key: string, ip: string): Promise<boolean> {
      const redis = await getRedisClient()
      if (!redis || !redisConnected) {
        return checkInMemory(ip)
      }

      try {
        const redisKey = `${REDIS_KEY_PREFIX}${key}:${ip}`
        const count = await redis.incr(redisKey)
        if (count === 1) {
          // First hit in this window — set expiry.
          await redis.expire(redisKey, windowSec)
        }
        return count <= max
      } catch (error: unknown) {
        // On any Redis error, degrade to in-memory rather than failing open/closed unexpectedly.
        console.warn(
          "Rate limit Redis check failed; using in-memory fallback:",
          (error as Error).message,
        )
        return checkInMemory(ip)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Client IP extraction
// ---------------------------------------------------------------------------

function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"]
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim()
  }
  const realIp = req.headers["x-real-ip"]
  if (typeof realIp === "string") {
    return realIp.trim()
  }
  return req.socket?.remoteAddress || "unknown"
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let limiterSeq = 0

/**
 * Wrap a Next.js API handler with rate limiting.
 *
 * ```ts
 * import { withRateLimit, RATE_LIMIT_AUTH } from "../../../lib/rate-limit"
 *
 * function handler(req, res) { ... }
 * export default withRateLimit(handler, RATE_LIMIT_AUTH)
 * ```
 */
export function withRateLimit(
  handler: NextApiHandler,
  opts: RateLimitOptions,
): NextApiHandler {
  const limiter = createRateLimiter(opts)
  // Stable per-wrap key so Redis counters are isolated per route group.
  const key = `${opts.max}:${opts.windowMs ?? DEFAULT_WINDOW_MS}:${limiterSeq++}`

  return async (req: NextApiRequest, res: NextApiResponse) => {
    const ip = getClientIp(req)

    const allowed = await limiter.check(key, ip)
    if (!allowed) {
      return res.status(429).json({
        error: "Too many requests. Please wait a moment and try again.",
      })
    }

    return handler(req, res)
  }
}
