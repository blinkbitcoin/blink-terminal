/**
 * One validated source for the Bolt Card withdrawal reconciliation settings
 * (blink-wip#1619), consumed by the scheduler, /api/boltcard/stats and the
 * detailed /api/health view, so the same thresholds are read the same way
 * everywhere.
 *
 * Reconciliation is a recovery path: a malformed value must not take the app
 * down, so each field falls back to its default with a warning naming the
 * variable. `BOLTCARD_RECONCILE_INTERVAL_MS=0` disables the scheduler; any
 * other value below MIN_INTERVAL_MS is raised to it, which is what keeps the
 * pass timeout strictly below the interval.
 */

import { z } from "zod"

import { baseLogger } from "../logger"

const logger = baseLogger.child({ module: "boltcard-reconcile-config" })

export const DEFAULT_INTERVAL_MS = 60_000
/** Smallest supported non-zero interval (0 still means disabled). */
export const MIN_INTERVAL_MS = 1_000
export const DEFAULT_PASS_TIMEOUT_MS = 45_000
export const DEFAULT_STALE_MINUTES = 15
export const DEFAULT_BATCH = 100

export interface ReconcileConfig {
  /** Tick cadence; 0 disables the scheduler. */
  intervalMs: number
  /** Hard deadline for one pass (lock hold); always below intervalMs. */
  passTimeoutMs: number
  /** Age after which an unresolved withdrawal is reported to ops. */
  staleMinutes: number
  /** Max rows one pass examines (oldest first). */
  batch: number
}

const nonNegativeInt = z.coerce.number().int().nonnegative()
const positiveInt = z.coerce.number().int().positive()

type Env = Record<string, string | undefined>

function read(name: string, schema: z.ZodTypeAny, fallback: number, env: Env): number {
  const raw = env[name]
  if (raw === undefined || raw === "") return fallback
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data as number
  logger.warn(
    { variable: name, value: raw, fallback },
    "Invalid reconciliation setting ignored; using the default",
  )
  return fallback
}

export function getReconcileConfig(env: Env = process.env): ReconcileConfig {
  let intervalMs = read(
    "BOLTCARD_RECONCILE_INTERVAL_MS",
    nonNegativeInt,
    DEFAULT_INTERVAL_MS,
    env,
  )
  if (intervalMs > 0 && intervalMs < MIN_INTERVAL_MS) {
    logger.warn(
      { intervalMs, minimum: MIN_INTERVAL_MS },
      "BOLTCARD_RECONCILE_INTERVAL_MS below the supported minimum; raised",
    )
    intervalMs = MIN_INTERVAL_MS
  }
  let passTimeoutMs = read(
    "BOLTCARD_RECONCILE_PASS_TIMEOUT_MS",
    positiveInt,
    DEFAULT_PASS_TIMEOUT_MS,
    env,
  )
  // A pass must end before the next tick would be due, or ticks could queue
  // behind a slow Blink. Clamp (and say so) rather than refuse to start.
  // intervalMs >= MIN_INTERVAL_MS here, so floor(0.75 x) is >= 750 and
  // strictly below the interval.
  if (intervalMs > 0 && passTimeoutMs >= intervalMs) {
    const clamped = Math.floor(intervalMs * 0.75)
    logger.warn(
      { passTimeoutMs, intervalMs, clamped },
      "BOLTCARD_RECONCILE_PASS_TIMEOUT_MS must be below the interval; clamped",
    )
    passTimeoutMs = clamped
  }
  return {
    intervalMs,
    passTimeoutMs,
    staleMinutes: read(
      "BOLTCARD_WITHDRAWAL_STALE_MINUTES",
      positiveInt,
      DEFAULT_STALE_MINUTES,
      env,
    ),
    batch: read("BOLTCARD_RECONCILE_BATCH", positiveInt, DEFAULT_BATCH, env),
  }
}
