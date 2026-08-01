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

// Avoid pulling the heavy TransactionDetail component graph; the hook only
// calls initTransactionLabels() for a side effect we don't assert on here.
jest.mock("../../../components/TransactionDetail", () => ({
  initTransactionLabels: jest.fn().mockResolvedValue(undefined),
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

describe("useServerSync display-currency seeding", () => {
  beforeEach(() => {
    localStorage.clear()
    ;(global.fetch as jest.Mock).mockReset()
  })

  it("does not seed from server defaults on a fresh device (no lastSynced)", async () => {
    // Never-synced user: server returns default prefs (BTC) and no lastSynced.
    mockSyncResponse({
      preferences: { displayCurrency: "BTC" },
      voucherWallet: null,
    })

    const setDisplayCurrency = jest.fn()
    renderHook(() => useServerSync(makeParams({ setDisplayCurrency })))

    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    // Give the resolved fetch microtasks a chance to run.
    await waitFor(() => {
      expect(setDisplayCurrency).not.toHaveBeenCalled()
    })
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

    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    await waitFor(() => {
      expect(setDisplayCurrency).not.toHaveBeenCalled()
    })
  })
})
