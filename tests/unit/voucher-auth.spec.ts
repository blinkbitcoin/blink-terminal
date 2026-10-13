/** @jest-environment node */

const mockGetWalletInfo = jest.fn()
const mockBlinkApiCtor = jest.fn()
jest.mock("../../lib/blink-api", () => {
  class BlinkAPI {
    constructor(apiKey: string, apiUrl: string) {
      mockBlinkApiCtor(apiKey, apiUrl)
    }
    getWalletInfo() {
      return mockGetWalletInfo()
    }
  }
  class BlinkAuthError extends Error {}
  return { __esModule: true, default: BlinkAPI, BlinkAPI, BlinkAuthError }
})

import { BlinkAuthError } from "../../lib/blink-api"
import {
  getOwnedWallets,
  getVoucherApiKey,
  toEnvironment,
  VOUCHER_API_KEY_HEADER,
} from "../../lib/voucher-auth"

const req = (value: unknown) =>
  ({ headers: value === undefined ? {} : { [VOUCHER_API_KEY_HEADER]: value } }) as never

beforeEach(() => jest.clearAllMocks())

describe("getVoucherApiKey", () => {
  it("reads and trims the header", () => {
    expect(getVoucherApiKey(req("  blink_key  "))).toBe("blink_key")
  })

  it("uses the first value of a repeated header", () => {
    expect(getVoucherApiKey(req(["blink_a", "blink_b"]))).toBe("blink_a")
  })

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["oversized", "k".repeat(513)],
    ["empty array", []],
  ])("returns null when %s", (_name, value) => {
    expect(getVoucherApiKey(req(value))).toBeNull()
  })
})

describe("toEnvironment", () => {
  it.each([
    ["staging", "staging"],
    ["production", "production"],
    [undefined, "production"],
    ["STAGING", "production"],
    [["staging"], "production"],
  ])("%p -> %p", (input, expected) => {
    expect(toEnvironment(input)).toBe(expected)
  })
})

describe("getOwnedWallets", () => {
  it("maps wallet id -> currency from a live Blink lookup", async () => {
    mockGetWalletInfo.mockResolvedValueOnce([
      { id: "w1", walletCurrency: "BTC" },
      { id: "w2", walletCurrency: "USD" },
    ])

    const result = await getOwnedWallets("blink_key", "staging")

    expect(result).toEqual({
      ok: true,
      wallets: new Map([
        ["w1", "BTC"],
        ["w2", "USD"],
      ]),
    })
    expect(mockBlinkApiCtor).toHaveBeenCalledWith(
      "blink_key",
      "https://api.staging.blink.sv/graphql",
    )
  })

  it("reports a key Blink refuses as invalid", async () => {
    mockGetWalletInfo.mockRejectedValueOnce(new BlinkAuthError("rejected (401)"))
    await expect(getOwnedWallets("blink_key", "production")).resolves.toEqual({
      ok: false,
      reason: "invalid",
    })
  })

  it.each([
    [
      "a transport/5xx error",
      () => mockGetWalletInfo.mockRejectedValueOnce(new Error("502")),
    ],
    ["a malformed response", () => mockGetWalletInfo.mockResolvedValueOnce(null)],
  ])("reports %s as unavailable", async (_name, arrange) => {
    arrange()
    await expect(getOwnedWallets("blink_key", "production")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    })
  })

  it("does not cache: every call hits Blink", async () => {
    mockGetWalletInfo.mockResolvedValue([{ id: "w1", walletCurrency: "BTC" }])
    await getOwnedWallets("blink_key", "production")
    await getOwnedWallets("blink_key", "production")
    expect(mockGetWalletInfo).toHaveBeenCalledTimes(2)
  })
})
