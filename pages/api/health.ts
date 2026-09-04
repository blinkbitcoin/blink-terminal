/**
 * Health Check Endpoint
 *
 * Used by Docker and monitoring systems to verify service health.
 * Supports `?verbose=true` for detailed pool stats.
 *
 * Deep checks: PostgreSQL connectivity (via shared pool), Redis (via hybrid
 * store), voucher store, and Blink API credential presence.
 */

import type { NextApiRequest, NextApiResponse } from "next"

import { getSharedPool } from "../../lib/db"
import { baseLogger } from "../../lib/logger"
import { getHybridStore } from "../../lib/storage/hybrid-store"
import voucherStore from "../../lib/voucher-store"

const logger = baseLogger.child({ module: "health" })

interface CheckResult {
  status: string
  enabled?: boolean
  /** Redis only: whether a write probe succeeded, not just a PING. */
  writable?: boolean
  error?: string
  storage?: string
  stats?: unknown
  apiKey?: string
  walletId?: string
  latencyMs?: number
  pool?: {
    total: number
    idle: number
    waiting: number
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const startTime = Date.now()
  const verbose = req.query.verbose === "true"

  const health: {
    status: string
    timestamp: string
    checks: Record<string, CheckResult>
    uptime: number
    version: string
    responseTime?: number
  } = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    checks: {},
    uptime: process.uptime(),
    version: process.env.npm_package_version || "1.0.0",
  }

  try {
    // ------------------------------------------------------------------
    // Deep check: Shared PostgreSQL pool
    // ------------------------------------------------------------------
    try {
      const poolStart = Date.now()
      const pool = getSharedPool()
      await pool.query("SELECT 1")
      const poolLatency = Date.now() - poolStart

      const check: CheckResult = {
        status: "up",
        latencyMs: poolLatency,
      }

      if (verbose) {
        check.pool = {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        }
      }

      health.checks.sharedPool = check
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      health.checks.sharedPool = { status: "down", error: message }
      health.status = "unhealthy"
    }

    // ------------------------------------------------------------------
    // Check Hybrid Storage (Redis + PostgreSQL)
    // ------------------------------------------------------------------
    if (process.env.ENABLE_HYBRID_STORAGE === "true") {
      try {
        const hybridStore = await getHybridStore()
        const storageHealth = await hybridStore.healthCheck()

        // "up" requires Redis to accept a WRITE, not merely answer PING. A
        // Redis that is out of memory, cannot persist to disk, or is a
        // read-only replica pings fine while refusing writes; reporting that as
        // "up" is what hid a multi-hour NIP-46 sign-in outage on staging.
        const redisWriteRejected = storageHealth.redis && !storageHealth.redisWritable
        health.checks.redis = {
          status: !storageHealth.redis ? "down" : redisWriteRejected ? "degraded" : "up",
          enabled: true,
          writable: storageHealth.redisWritable,
          error: storageHealth.redisError,
        }

        health.checks.postgres = {
          status: storageHealth.postgres ? "up" : "down",
          enabled: true,
        }

        // If PostgreSQL is down, service is unhealthy
        if (!storageHealth.postgres) {
          health.status = "unhealthy"
        }
        // Redis down, or reachable but refusing writes, degrades the service
        // without failing it: sign-in and rate limiting fall back to in-process
        // state, so the app still serves. Degraded stays HTTP 200 deliberately
        // — a non-fatal condition must not restart-loop the container.
        else if (!storageHealth.redis || redisWriteRejected) {
          health.status = "degraded"
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error"
        health.checks.storage = {
          status: "down",
          error: message,
        }
        health.status = "unhealthy"
      }
    }

    // ------------------------------------------------------------------
    // Check voucher store (PostgreSQL)
    // ------------------------------------------------------------------
    try {
      const voucherStats = await voucherStore.getStats()
      health.checks.vouchers = {
        status: "up",
        storage: "postgresql",
        stats: verbose ? voucherStats : undefined,
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      health.checks.vouchers = {
        status: "down",
        error: message,
      }
      // Voucher store failure degrades but doesn't fully break service
      if (health.status === "healthy") {
        health.status = "degraded"
      }
    }

    // ------------------------------------------------------------------
    // Check Blink API credentials
    // ------------------------------------------------------------------
    health.checks.blinkConfig = {
      status:
        process.env.BLINKPOS_API_KEY && process.env.BLINKPOS_BTC_WALLET_ID
          ? "configured"
          : "missing",
      apiKey: process.env.BLINKPOS_API_KEY ? "set" : "missing",
      walletId: process.env.BLINKPOS_BTC_WALLET_ID ? "set" : "missing",
    }

    if (!process.env.BLINKPOS_API_KEY || !process.env.BLINKPOS_BTC_WALLET_ID) {
      health.status = "unhealthy"
    }

    // Response time
    health.responseTime = Date.now() - startTime

    // Set appropriate status code
    const statusCode =
      health.status === "healthy" ? 200 : health.status === "degraded" ? 200 : 503

    res.status(statusCode).json(health)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    logger.error({ err: error }, "Health check error")
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      error: message,
      responseTime: Date.now() - startTime,
    })
  }
}
