/** @jest-environment node */

/**
 * Configuration boundary for the Bolt Card reconciliation settings
 * (blink-wip#1619 review): one validated source, zero disables, invalid
 * values fall back to defaults with a warning instead of taking the app down.
 */

const mockWarn = jest.fn()
jest.mock("../../lib/logger", () => ({
  __esModule: true,
  baseLogger: {
    child: () => ({
      warn: (...a: unknown[]) => mockWarn(...a),
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  },
}))

import {
  DEFAULT_BATCH,
  DEFAULT_INTERVAL_MS,
  DEFAULT_PASS_TIMEOUT_MS,
  DEFAULT_STALE_MINUTES,
  getReconcileConfig,
} from "../../lib/boltcard/reconcile-config"

beforeEach(() => mockWarn.mockClear())

describe("getReconcileConfig", () => {
  it("defaults when unset or empty", () => {
    for (const env of [
      {},
      { BOLTCARD_RECONCILE_INTERVAL_MS: "", BOLTCARD_RECONCILE_BATCH: "" },
    ]) {
      expect(getReconcileConfig(env)).toEqual({
        intervalMs: DEFAULT_INTERVAL_MS,
        passTimeoutMs: DEFAULT_PASS_TIMEOUT_MS,
        staleMinutes: DEFAULT_STALE_MINUTES,
        batch: DEFAULT_BATCH,
      })
    }
    expect(mockWarn).not.toHaveBeenCalled()
  })

  it("interval 0 disables (valid), negative / fractional / malformed fall back with a warning", () => {
    expect(getReconcileConfig({ BOLTCARD_RECONCILE_INTERVAL_MS: "0" }).intervalMs).toBe(0)
    expect(mockWarn).not.toHaveBeenCalled()

    for (const bad of ["-1", "1.5", "abc", "60s"]) {
      mockWarn.mockClear()
      expect(getReconcileConfig({ BOLTCARD_RECONCILE_INTERVAL_MS: bad }).intervalMs).toBe(
        DEFAULT_INTERVAL_MS,
      )
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          variable: "BOLTCARD_RECONCILE_INTERVAL_MS",
          value: bad,
        }),
        expect.any(String),
      )
    }
  })

  it("stale minutes, batch and pass timeout must be positive integers", () => {
    for (const variable of [
      "BOLTCARD_WITHDRAWAL_STALE_MINUTES",
      "BOLTCARD_RECONCILE_BATCH",
      "BOLTCARD_RECONCILE_PASS_TIMEOUT_MS",
    ]) {
      for (const bad of ["0", "-5", "2.5", "x"]) {
        mockWarn.mockClear()
        const config = getReconcileConfig({ [variable]: bad })
        expect(config).toMatchObject({
          staleMinutes: DEFAULT_STALE_MINUTES,
          batch: DEFAULT_BATCH,
          passTimeoutMs: DEFAULT_PASS_TIMEOUT_MS,
        })
        expect(mockWarn).toHaveBeenCalledWith(
          expect.objectContaining({ variable, value: bad }),
          expect.any(String),
        )
      }
    }
    expect(
      getReconcileConfig({
        BOLTCARD_WITHDRAWAL_STALE_MINUTES: "30",
        BOLTCARD_RECONCILE_BATCH: "10",
        BOLTCARD_RECONCILE_PASS_TIMEOUT_MS: "20000",
      }),
    ).toMatchObject({ staleMinutes: 30, batch: 10, passTimeoutMs: 20_000 })
  })

  it("clamps the pass timeout below the interval so ticks cannot queue", () => {
    const config = getReconcileConfig({
      BOLTCARD_RECONCILE_INTERVAL_MS: "10000",
      BOLTCARD_RECONCILE_PASS_TIMEOUT_MS: "10000",
    })
    expect(config.passTimeoutMs).toBe(7_500)
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ clamped: 7_500 }),
      expect.stringContaining("clamped"),
    )
    // Disabled scheduler: nothing to clamp against
    expect(
      getReconcileConfig({
        BOLTCARD_RECONCILE_INTERVAL_MS: "0",
        BOLTCARD_RECONCILE_PASS_TIMEOUT_MS: "90000",
      }).passTimeoutMs,
    ).toBe(90_000)
  })
})
