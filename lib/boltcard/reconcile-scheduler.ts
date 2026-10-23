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
 * 2. reconcilePendingWithdrawals() over every card, bounded end to end:
 *    at most BOLTCARD_RECONCILE_BATCH rows (oldest first), under a pass
 *    deadline (BOLTCARD_RECONCILE_PASS_TIMEOUT_MS, default 45s, always below
 *    the interval). The deadline aborts the in-flight Blink lookup via
 *    AbortSignal and the pass stops before its next row, so a slow or
 *    non-terminating upstream cannot hold the lock, the pool client, or the
 *    next tick. Selection is never-checked first, then least recently
 *    checked (last_checked_at, migration 031), so a stuck prefix cannot
 *    starve later rows: the whole backlog is covered in ceil(backlog/batch)
 *    passes.
 * 3. Log unresolved rows older than BOLTCARD_WITHDRAWAL_STALE_MINUTES
 *    (default 15) with their payment hashes — the ops signal for a payment
 *    Blink still has not reported either way.
 * 4. Release the lock, re-arm the timer. Completion-based (setTimeout after
 *    the tick settles), not setInterval, so a slow Blink stretches the gap
 *    instead of stacking ticks. Errors are logged; the loop keeps running.
 *
 * Deadlines, outermost first: interval (60s) > pass timeout (45s) > each
 * Blink fetch (aborted by the pass signal). Settings come from
 * lib/boltcard/reconcile-config.ts.
 *
 * Runs regardless of BOLTCARD_SPEND_ENABLED: the rows to settle may predate
 * the flag. Started from instrumentation.node.ts; stopped via lib/shutdown.
 */

import type { PoolClient } from "pg"

import { getClient } from "../db"
import { baseLogger } from "../logger"

import * as lnurlw from "./lnurlw"
import { getReconcileConfig } from "./reconcile-config"
import boltcardStore from "./store"

const logger = baseLogger.child({ module: "boltcard-reconcile" })

export { DEFAULT_INTERVAL_MS, DEFAULT_STALE_MINUTES } from "./reconcile-config"
/** hashtext('boltcard-reconcile') would do; a literal keeps it greppable. */
export const RECONCILE_LOCK_KEY = 7_201_619

// Persist across module re-instantiation (Next.js dev re-imports modules)
const globalState = globalThis as typeof globalThis & {
  __boltcardReconcileTimer?: NodeJS.Timeout | null
  __boltcardReconcileStarted?: boolean
}

/**
 * Run `work` under one deadline. The signal is aborted when the deadline
 * passes (cancelling the in-flight Blink fetch) and the returned promise
 * rejects with PassTimeoutError, so a hung await can never outlive it.
 */
class PassTimeoutError extends Error {
  constructor(ms: number) {
    super(`reconciliation pass exceeded ${ms} ms`)
    this.name = "PassTimeoutError"
  }
}
const withDeadline = <T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
      reject(new PassTimeoutError(ms))
    }, ms)
    work(controller.signal).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })

/**
 * One reconciliation pass under the advisory lock. Exported for tests and
 * for an operator to run on demand. Resolves to null when another holder
 * had the lock.
 */
export async function reconcileTick(): Promise<{
  /** Rows examined this pass. */
  checked: number
  resolved: number
  restored: number
  /** Rows selected for this pass but not reached because of the deadline. */
  skipped: number
  timedOut: boolean
  /** Unresolved rows in total (from the database, not from the batch). */
  backlog: number
  /** backlog - checked: rows left for later passes. */
  deferred: number
  stale: number
  durationMs: number
} | null> {
  const started = Date.now()
  const config = getReconcileConfig()
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

    let result: Awaited<ReturnType<typeof lnurlw.reconcilePendingWithdrawals>> = {
      checked: 0,
      resolved: 0,
      restored: 0,
    }
    let timedOut = false
    try {
      result = await withDeadline(
        (signal) =>
          lnurlw.reconcilePendingWithdrawals(undefined, { signal, limit: config.batch }),
        config.passTimeoutMs,
      )
    } catch (err: unknown) {
      if (!(err instanceof PassTimeoutError)) throw err
      // The signal has aborted the in-flight lookup; whatever the pass did
      // before the deadline is committed row by row. Nothing is lost: the
      // rows not reached are examined on the next tick.
      timedOut = true
      logger.warn(
        { passTimeoutMs: config.passTimeoutMs, batch: config.batch },
        "Reconciliation pass hit its deadline; remaining rows deferred to the next tick",
      )
    }

    const [backlog, stale] = await Promise.all([
      boltcardStore.countPendingWithdrawals(),
      boltcardStore.getStaleWithdrawals(config.staleMinutes * 60_000),
    ])
    if (stale.length > 0) {
      logger.warn(
        {
          staleMinutes: config.staleMinutes,
          withdrawals: stale.map((w) => ({
            paymentHash: w.paymentHash,
            cardId: w.cardId,
            amount: w.amount,
            kind: w.kind,
            attempt: w.attempt,
            ageMinutes: Math.floor(w.ageMs / 60_000),
          })),
        },
        `${stale.length} Bolt Card withdrawal(s) unresolved for more than ${config.staleMinutes} min`,
      )
    }

    const summary = {
      checked: result.checked,
      resolved: result.resolved,
      restored: result.restored,
      skipped: result.skipped ?? 0,
      timedOut,
      backlog,
      deferred: Math.max(0, backlog - result.checked),
      stale: stale.length,
      durationMs: Date.now() - started,
    }
    if (result.checked > 0 || backlog > 0 || timedOut) {
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
    if (globalState.__boltcardReconcileStarted) arm(getReconcileConfig().intervalMs)
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
  const config = getReconcileConfig()
  if (config.intervalMs === 0) {
    logger.info(
      "BOLTCARD_RECONCILE_INTERVAL_MS=0 — withdrawal reconciliation scheduler disabled",
    )
    return
  }
  globalState.__boltcardReconcileStarted = true
  logger.info(config, "Bolt Card withdrawal reconciliation scheduler started")
  // First pass shortly after boot (let the pool come up), then every interval.
  arm(Math.min(config.intervalMs, 5_000))
}

export function stopBoltcardReconcileScheduler(): void {
  globalState.__boltcardReconcileStarted = false
  if (globalState.__boltcardReconcileTimer) {
    clearTimeout(globalState.__boltcardReconcileTimer)
    globalState.__boltcardReconcileTimer = null
  }
}
