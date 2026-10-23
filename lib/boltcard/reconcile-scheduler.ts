/**
 * Bolt Card withdrawal reconciliation scheduler (blink-wip#1619).
 *
 * A card payment whose Lightning send answered PENDING (or whose outcome was
 * lost) keeps its deduction and a row in boltcard_pending_withdrawals.
 * lnurlw.reconcilePendingWithdrawals() settles those rows against Blink
 * (PAID -> resolved, terminal failure -> deduction restored); until this
 * module it only ran when the card's owner tapped for a balance check, so
 * rows of idle cards stayed in flight indefinitely.
 *
 * Every tick (BOLTCARD_RECONCILE_INTERVAL_MS, default 60s; 0 disables):
 * 1. Take pg_try_advisory_lock(RECONCILE_LOCK_KEY) on a dedicated client.
 *    Non-blocking: if another replica holds it, skip this tick. The chart
 *    runs one replica today; this keeps a scale-out from running N
 *    reconciliations (and N x the Blink calls) against the same rows.
 * 2. reconcilePendingWithdrawals() over every card.
 * 3. Log unresolved rows older than BOLTCARD_WITHDRAWAL_STALE_MINUTES
 *    (default 15) with their payment hashes — the ops signal for a payment
 *    Blink still has not reported either way.
 * 4. Release the lock, re-arm the timer. Completion-based (setTimeout after
 *    the tick settles), not setInterval, so a slow Blink stretches the gap
 *    instead of stacking ticks. Errors are logged; the loop keeps running.
 *
 * Runs regardless of BOLTCARD_SPEND_ENABLED: the rows to settle may predate
 * the flag. Started from instrumentation.node.ts; stopped via lib/shutdown.
 */

import type { PoolClient } from "pg"

import { getClient } from "../db"
import { baseLogger } from "../logger"

import * as lnurlw from "./lnurlw"
import boltcardStore from "./store"

const logger = baseLogger.child({ module: "boltcard-reconcile" })

export const DEFAULT_INTERVAL_MS = 60_000
export const DEFAULT_STALE_MINUTES = 15
/** hashtext('boltcard-reconcile') would do; a literal keeps it greppable. */
export const RECONCILE_LOCK_KEY = 7_201_619

// Persist across module re-instantiation (Next.js dev re-imports modules)
const globalState = globalThis as typeof globalThis & {
  __boltcardReconcileTimer?: NodeJS.Timeout | null
  __boltcardReconcileStarted?: boolean
}

function intervalMs(): number {
  const raw = process.env.BOLTCARD_RECONCILE_INTERVAL_MS
  if (raw === undefined || raw === "") return DEFAULT_INTERVAL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVAL_MS
}

function staleMinutes(): number {
  const n = Number(process.env.BOLTCARD_WITHDRAWAL_STALE_MINUTES)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_MINUTES
}

/**
 * One reconciliation pass under the advisory lock. Exported for tests and
 * for an operator to run on demand. Resolves to null when another holder
 * had the lock.
 */
export async function reconcileTick(): Promise<{
  checked: number
  resolved: number
  restored: number
  stale: number
  durationMs: number
} | null> {
  const started = Date.now()
  let client: PoolClient | null = null
  try {
    client = await getClient()
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [RECONCILE_LOCK_KEY],
    )
    if (!lock.rows[0]?.locked) {
      logger.debug("Another replica holds the reconcile lock; skipping tick")
      return null
    }

    const result = await lnurlw.reconcilePendingWithdrawals()

    const stale = await boltcardStore.getStaleWithdrawals(staleMinutes() * 60_000)
    if (stale.length > 0) {
      logger.warn(
        {
          staleMinutes: staleMinutes(),
          withdrawals: stale.map((w) => ({
            paymentHash: w.paymentHash,
            cardId: w.cardId,
            amount: w.amount,
            kind: w.kind,
            attempt: w.attempt,
            ageMinutes: Math.floor(w.ageMs / 60_000),
          })),
        },
        `${stale.length} Bolt Card withdrawal(s) unresolved for more than ${staleMinutes()} min`,
      )
    }

    const summary = {
      ...result,
      stale: stale.length,
      durationMs: Date.now() - started,
    }
    if (result.checked > 0 || stale.length > 0) {
      logger.info(summary, "Bolt Card withdrawal reconciliation tick")
    }
    return summary
  } finally {
    if (client) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [RECONCILE_LOCK_KEY])
        .catch(() => undefined)
      client.release()
    }
  }
}

function arm(delayMs: number): void {
  const timer = setTimeout(async () => {
    globalState.__boltcardReconcileTimer = null
    try {
      await reconcileTick()
    } catch (err: unknown) {
      logger.error({ err }, "Bolt Card withdrawal reconciliation tick failed")
    }
    if (globalState.__boltcardReconcileStarted) arm(intervalMs())
  }, delayMs)
  timer.unref?.()
  globalState.__boltcardReconcileTimer = timer
}

/**
 * Start the scheduler. Idempotent. No-op (with a log line) when the interval
 * is 0.
 */
export function startBoltcardReconcileScheduler(): void {
  if (globalState.__boltcardReconcileStarted) return
  const interval = intervalMs()
  if (interval === 0) {
    logger.info(
      "BOLTCARD_RECONCILE_INTERVAL_MS=0 — withdrawal reconciliation scheduler disabled",
    )
    return
  }
  globalState.__boltcardReconcileStarted = true
  logger.info(
    { intervalMs: interval, staleMinutes: staleMinutes() },
    "Bolt Card withdrawal reconciliation scheduler started",
  )
  // First pass shortly after boot (let the pool come up), then every interval.
  arm(Math.min(interval, 5_000))
}

export function stopBoltcardReconcileScheduler(): void {
  globalState.__boltcardReconcileStarted = false
  if (globalState.__boltcardReconcileTimer) {
    clearTimeout(globalState.__boltcardReconcileTimer)
    globalState.__boltcardReconcileTimer = null
  }
}
