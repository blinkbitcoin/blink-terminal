/**
 * Tests for useServerSync display-currency seeding.
 *
 * Focus: the login-time seed of display currency from server preferences must
 * only apply when the server response represents genuinely stored user data.
 * The GET /api/user/sync endpoint returns default preferences (displayCurrency
 * "BTC") for never-synced users, with `lastSynced` absent — seeding from those
 * defaults would clobber the account's real preferred currency on first login.
 *
 * @module tests/unit/hooks/useServerSync.spec
 */

import { renderHook, waitFor } from "@testing-library/react"

// Avoid pulling the heavy TransactionDetail component graph. The hook awaits
// initTransactionLabels() *after* deciding whether to seed the display
// currency, so tests use it as a deterministic "effect settled" signal.
let resolveLabelsCalled: () => void
let labelsCalled: Promise<void>
const initTransactionLabels = jest.fn().mockImplementation(() => {
  resolveLabelsCalled()
  return Promise.resolve()
})
jest.mock("../../../components/TransactionDetail", () => ({
  initTransactionLabels: () => initTransactionLabels(),
}))

import { useServerSync } from "../../../lib/hooks/useServerSync"

const DISPLAY_CURRENCY_KEY = "blinkpos-display-currency"

type Params = Parameters<typeof useServerSync>[0]

/** Build a full params object with jest.fn() setters and sane defaults. */
function makeParams(overrides: Partial<Params> = {}): Params {
  return {
    publicKey: "npub-test",
    soundEnabled: true,
    setSoundEnabled: jest.fn(),
    soundTheme: "success",
    setSoundTheme: jest.fn(),
    tipsEnabled: false,
    setTipsEnabled: jest.fn(),
    tipPresets: [],
    setTipPresets: jest.fn(),
    displayCurrency: "USD",
    setDisplayCurrency: jest.fn(),
    numberFormat: "auto",
    setNumberFormat: jest.fn(),
    numpadLayout: "calculator",
    setNumpadLayout: jest.fn(),
    voucherCurrencyMode: "BTC",
    setVoucherCurrencyMode: jest.fn(),
    voucherExpiry: "24h",
    setVoucherExpiry: jest.fn(),
    voucherWallet: null,
    setVoucherWallet: jest.fn(),
    setVoucherWalletBalance: jest.fn(),
    setVoucherWalletUsdBalance: jest.fn(),
    ...overrides,
  }
}

/** Stub the server GET /api/user/sync response body. */
function mockSyncResponse(body: Record<string, unknown>): void {
  ;(global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => body,
  })
}

/**
 * Wait until the fetch effect has fully settled: the display-currency decision
 * runs before `await initTransactionLabels()`, so once that has been called and
 * pending microtasks flush, any `setDisplayCurrency` call has already happened.
 */
async function waitForEffectSettled(): Promise<void> {
  await labelsCalled
  // Flush any microtasks queued after the seed decision.
  await Promise.resolve()
  await Promise.resolve()
}

describe("useServerSync display-currency seeding", () => {
  beforeEach(() => {
    localStorage.clear()
    ;(global.fetch as jest.Mock).mockReset()
    initTransactionLabels.mockClear()
    labelsCalled = new Promise<void>((resolve) => {
      resolveLabelsCalled = resolve
    })
  })

  it("does not seed from server defaults on a fresh device (no lastSynced)", async () => {
    // Never-synced user: server returns default prefs (BTC) and no lastSynced.
    mockSyncResponse({
      preferences: { displayCurrency: "BTC" },
      voucherWallet: null,
    })

    const setDisplayCurrency = jest.fn()
    renderHook(() => useServerSync(makeParams({ setDisplayCurrency })))

    await waitForEffectSettled()
    expect(setDisplayCurrency).not.toHaveBeenCalled()
  })

  it("seeds from server prefs for a genuinely-synced user (lastSynced present)", async () => {
    mockSyncResponse({
      preferences: { displayCurrency: "BTC" },
      voucherWallet: null,
      lastSynced: "2026-01-01T00:00:00.000Z",
    })

    const setDisplayCurrency = jest.fn()
    renderHook(() => useServerSync(makeParams({ setDisplayCurrency })))

    await waitFor(() => expect(setDisplayCurrency).toHaveBeenCalledWith("BTC"))
  })

  it("never seeds when a device choice is already persisted", async () => {
    localStorage.setItem(DISPLAY_CURRENCY_KEY, "BTC")
    mockSyncResponse({
      preferences: { displayCurrency: "USD" },
      voucherWallet: null,
      lastSynced: "2026-01-01T00:00:00.000Z",
    })

    const setDisplayCurrency = jest.fn()
    renderHook(() => useServerSync(makeParams({ setDisplayCurrency })))

    await waitForEffectSettled()
    expect(setDisplayCurrency).not.toHaveBeenCalled()
  })
})
