/** @jest-environment node */

/**
 * Bolt Card withdrawal reconciliation scheduler (blink-wip#1619): runs
 * lnurlw.reconcilePendingWithdrawals() on a cadence under a non-blocking
 * advisory lock, logs rows that stay unresolved, keeps going after errors,
 * and stops cleanly.
 */

const mockClientQuery = jest.fn()
const mockRelease = jest.fn()
jest.mock("../../lib/db", () => ({
  getClient: async () => ({ query: mockClientQuery, release: mockRelease }),
  getSharedPool: () => ({ query: jest.fn() }),
}))

const mockReconcile = jest.fn()
jest.mock("../../lib/boltcard/lnurlw", () => ({
  __esModule: true,
  reconcilePendingWithdrawals: (...args: unknown[]) => mockReconcile(...args),
}))

const mockStale = jest.fn()
const mockCount = jest.fn()
jest.mock("../../lib/boltcard/store", () => ({
  __esModule: true,
  default: {
    getStaleWithdrawals: (...args: unknown[]) => mockStale(...args),
    countPendingWithdrawals: (...args: unknown[]) => mockCount(...args),
  },
}))

const logs: Record<string, unknown[][]> = { info: [], warn: [], error: [], debug: [] }
jest.mock("../../lib/logger", () => ({
  __esModule: true,
  baseLogger: {
    child: () => ({
      info: (...a: unknown[]) => logs.info.push(a),
      warn: (...a: unknown[]) => logs.warn.push(a),
      error: (...a: unknown[]) => logs.error.push(a),
      debug: (...a: unknown[]) => logs.debug.push(a),
    }),
  },
}))

import {
  DEFAULT_BATCH,
  DEFAULT_PASS_TIMEOUT_MS,
} from "../../lib/boltcard/reconcile-config"
import {
  DEFAULT_INTERVAL_MS,
  RECONCILE_LOCK_KEY,
  reconcileTick,
  startBoltcardReconcileScheduler,
  stopBoltcardReconcileScheduler,
} from "../../lib/boltcard/reconcile-scheduler"

const lockAnswer = (locked: boolean) =>
  mockClientQuery.mockImplementation(async (sql: string) =>
    sql.includes("pg_try_advisory_lock") ? { rows: [{ locked }] } : { rows: [] },
  )

beforeEach(() => {
  jest.useFakeTimers()
  mockClientQuery.mockReset()
  mockRelease.mockReset()
  mockReconcile.mockReset().mockResolvedValue({ checked: 0, resolved: 0, restored: 0 })
  mockStale.mockReset().mockResolvedValue([])
  mockCount.mockReset().mockResolvedValue(0)
  for (const k of Object.keys(logs)) logs[k] = []
  delete process.env.BOLTCARD_RECONCILE_INTERVAL_MS
  delete process.env.BOLTCARD_WITHDRAWAL_STALE_MINUTES
  delete process.env.BOLTCARD_RECONCILE_PASS_TIMEOUT_MS
  delete process.env.BOLTCARD_RECONCILE_BATCH
  lockAnswer(true)
})
afterEach(() => {
  stopBoltcardReconcileScheduler()
  jest.useRealTimers()
})

describe("reconcileTick", () => {
  it("runs reconciliation under the advisory lock and releases it", async () => {
    mockReconcile.mockResolvedValue({ checked: 3, resolved: 1, restored: 1 })
    mockCount.mockResolvedValue(3)
    const summary = await reconcileTick()

    expect(summary).toMatchObject({
      checked: 3,
      resolved: 1,
      restored: 1,
      skipped: 0,
      timedOut: false,
      backlog: 3,
      deferred: 0,
      stale: 0,
    })
    const sql = mockClientQuery.mock.calls.map((c) => String(c[0]))
    expect(sql[0]).toContain("pg_try_advisory_lock")
    expect(mockClientQuery.mock.calls[0][1]).toEqual([RECONCILE_LOCK_KEY])
    expect(sql[sql.length - 1]).toContain("pg_advisory_unlock")
    // All cards, bounded: a batch cap and the pass deadline's abort signal
    expect(mockReconcile).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal),
      limit: DEFAULT_BATCH,
    })
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it("skips the tick when another replica holds the lock", async () => {
    lockAnswer(false)
    expect(await reconcileTick()).toBeNull()
    expect(mockReconcile).not.toHaveBeenCalled()
    expect(mockStale).not.toHaveBeenCalled()
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it("logs unresolved withdrawals older than the threshold with their payment hashes", async () => {
    process.env.BOLTCARD_WITHDRAWAL_STALE_MINUTES = "20"
    mockStale.mockResolvedValue([
      {
        paymentHash: "ab".repeat(32),
        cardId: "card-1",
        amount: 1000,
        kind: "UNKNOWN",
        attempt: 1,
        createdAt: 0,
        ageMs: 25 * 60_000,
      },
    ])
    const summary = await reconcileTick()

    expect(mockStale).toHaveBeenCalledWith(20 * 60_000)
    expect(summary?.stale).toBe(1)
    expect(logs.warn).toHaveLength(1)
    const [payload, message] = logs.warn[0] as [Record<string, unknown>, string]
    expect(message).toContain("1 Bolt Card withdrawal(s) unresolved for more than 20 min")
    expect(payload.withdrawals).toEqual([
      expect.objectContaining({
        paymentHash: "ab".repeat(32),
        cardId: "card-1",
        kind: "UNKNOWN",
        ageMinutes: 25,
      }),
    ])
  })

  it("releases the lock and the client even when reconciliation throws", async () => {
    mockReconcile.mockRejectedValue(new Error("Blink down"))
    await expect(reconcileTick()).rejects.toThrow("Blink down")
    const sql = mockClientQuery.mock.calls.map((c) => String(c[0]))
    expect(sql[sql.length - 1]).toContain("pg_advisory_unlock")
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })
})

describe("pass deadline (a slow or non-terminating Blink must not wedge the scheduler)", () => {
  it("a reconciliation that never settles ends at the deadline: signal aborted, lock and client released", async () => {
    let seenSignal: AbortSignal | undefined
    mockReconcile.mockImplementation(
      (_cardId: unknown, opts: { signal: AbortSignal }) =>
        new Promise(() => {
          seenSignal = opts.signal // never settles (hung upstream)
        }),
    )
    const pending = reconcileTick()
    await jest.advanceTimersByTimeAsync(DEFAULT_PASS_TIMEOUT_MS)
    const summary = await pending

    expect(seenSignal?.aborted).toBe(true) // the in-flight fetch is cancelled
    expect(summary).toMatchObject({ timedOut: true, checked: 0 })
    const sql = mockClientQuery.mock.calls.map((c) => String(c[0]))
    expect(sql[sql.length - 1]).toContain("pg_advisory_unlock")
    expect(mockRelease).toHaveBeenCalledTimes(1)
    expect(logs.warn.some((l) => String(l[1]).includes("hit its deadline"))).toBe(true)
  })

  it("after a timed-out pass the next tick still runs", async () => {
    mockReconcile
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ checked: 1, resolved: 1, restored: 0 })
    startBoltcardReconcileScheduler()
    await jest.advanceTimersByTimeAsync(5_000) // first pass starts, hangs
    await jest.advanceTimersByTimeAsync(DEFAULT_PASS_TIMEOUT_MS) // deadline
    expect(mockReconcile).toHaveBeenCalledTimes(1)
    expect(mockRelease).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS) // re-armed
    expect(mockReconcile).toHaveBeenCalledTimes(2)
    expect(mockRelease).toHaveBeenCalledTimes(2)
  })

  it("a backlog larger than one pass is reported from the database, not the batch", async () => {
    // 350 unresolved rows, batch 100: the pass examines 100 (the batch is
    // all it ever sees) and the summary says how many remain for later
    // passes — which the fair selection order (migration 031) guarantees are
    // reached, two more passes here.
    mockReconcile.mockResolvedValue({ checked: 100, resolved: 10, restored: 0 })
    mockCount.mockResolvedValue(350)
    const summary = await reconcileTick()
    expect(summary).toMatchObject({
      checked: 100,
      backlog: 350,
      deferred: 250,
      skipped: 0,
    })
    expect(mockCount).toHaveBeenCalledTimes(1)
  })

  it("pass timeout and batch come from the env, timeout clamped below the interval", async () => {
    process.env.BOLTCARD_RECONCILE_PASS_TIMEOUT_MS = "90000" // > 60 s interval
    process.env.BOLTCARD_RECONCILE_BATCH = "7"
    mockReconcile.mockImplementation(() => new Promise(() => {}))
    const pending = reconcileTick()
    await jest.advanceTimersByTimeAsync(45_000) // clamped to 75% of the interval
    const summary = await pending
    expect(summary).toMatchObject({ timedOut: true })
    expect(mockReconcile.mock.calls[0][1]).toMatchObject({ limit: 7 })
  })
})

describe("scheduler loop", () => {
  it("runs a first pass shortly after start, then every interval, re-armed after each tick", async () => {
    startBoltcardReconcileScheduler()
    expect(mockReconcile).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(5_000)
    expect(mockReconcile).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS)
    expect(mockReconcile).toHaveBeenCalledTimes(2)

    await jest.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS)
    expect(mockReconcile).toHaveBeenCalledTimes(3)
  })

  it("is idempotent", async () => {
    startBoltcardReconcileScheduler()
    startBoltcardReconcileScheduler()
    await jest.advanceTimersByTimeAsync(5_000)
    expect(mockReconcile).toHaveBeenCalledTimes(1)
  })

  it("honours BOLTCARD_RECONCILE_INTERVAL_MS and 0 disables", async () => {
    process.env.BOLTCARD_RECONCILE_INTERVAL_MS = "10000"
    startBoltcardReconcileScheduler()
    await jest.advanceTimersByTimeAsync(5_000)
    expect(mockReconcile).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(10_000)
    expect(mockReconcile).toHaveBeenCalledTimes(2)
    stopBoltcardReconcileScheduler()

    mockReconcile.mockClear()
    process.env.BOLTCARD_RECONCILE_INTERVAL_MS = "0"
    startBoltcardReconcileScheduler()
    await jest.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS * 3)
    expect(mockReconcile).not.toHaveBeenCalled()
    expect(logs.info.some((l) => String(l[0]).includes("disabled"))).toBe(true)
  })

  it("a failing tick is logged and the loop keeps running", async () => {
    mockReconcile.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({
      checked: 0,
      resolved: 0,
      restored: 0,
    })
    startBoltcardReconcileScheduler()
    await jest.advanceTimersByTimeAsync(5_000)
    expect(logs.error).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS)
    expect(mockReconcile).toHaveBeenCalledTimes(2)
  })

  it("stop clears the timer: no further ticks", async () => {
    startBoltcardReconcileScheduler()
    await jest.advanceTimersByTimeAsync(5_000)
    expect(mockReconcile).toHaveBeenCalledTimes(1)
    stopBoltcardReconcileScheduler()
    await jest.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS * 3)
    expect(mockReconcile).toHaveBeenCalledTimes(1)
  })
})
