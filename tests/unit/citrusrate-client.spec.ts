/**
 * @jest-environment node
 *
 * CitrusrateAPI client guards (PR #81 review follow-up).
 *
 * The poller bulk-publishes whatever these methods return into the shared
 * cache for up to 300s, and the exchange-rate route returns cache hits with
 * success: true — so malformed upstream payloads must be rejected BEFORE
 * conversion/caching, not trusted after a cast. A string/object rate would
 * otherwise become NaN, serialize as null, and reach checkout math.
 *
 * Conversions must use each currency's real fractionDigits (minor units per
 * sat): consumers scale amounts by 10^fractionDigits before dividing, so a
 * fixed x100 would misprice zero-decimal (VUV/RWF/UGX/XAF/XOF) and
 * 3-decimal (LYD/TND) invoices by 100x/10x.
 */

import { getCurrencyById } from "../../lib/currency-utils"
import { CitrusrateAPI, CitrusrateError } from "../../lib/rate-providers/citrusrate"

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
})

const errorJson = (status: number, body: unknown) => ({
  ok: false,
  status,
  json: async () => body,
})

const apiWithKey = (): CitrusrateAPI => {
  process.env.CITRUSRATE_API_KEY = "test-key"
  delete process.env.CITRUSRATE_BASE_URL
  return new CitrusrateAPI()
}

describe("CitrusrateAPI configuration", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.CITRUSRATE_API_KEY
    delete process.env.CITRUSRATE_BASE_URL
  })

  it("defaults to the api.citrusrate.com V1 host", async () => {
    const api = apiWithKey()
    mockFetch.mockResolvedValue(
      okJson({ status: "success", data: { pair: "BTC/NGN", rate: 100_000_000 } }),
    )

    await api.getOfficialRate("NGN")

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toMatch(/^https:\/\/api\.citrusrate\.com\/v1\/btc\?currency=NGN$/)
  })

  it("honors CITRUSRATE_BASE_URL override", async () => {
    process.env.CITRUSRATE_API_KEY = "test-key"
    process.env.CITRUSRATE_BASE_URL = "https://staging.example.com"
    mockFetch.mockResolvedValue(
      okJson({ status: "success", data: { pair: "BTC/NGN", rate: 100_000_000 } }),
    )

    await new CitrusrateAPI().getOfficialRate("NGN")

    expect(mockFetch.mock.calls[0][0]).toMatch(/^https:\/\/staging\.example\.com\//)
  })

  it("fails fast without calling fetch when the API key is not configured", async () => {
    delete process.env.CITRUSRATE_API_KEY
    const api = new CitrusrateAPI()

    await expect(api.getOfficialRate("NGN")).rejects.toThrow(/not configured/)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe("CitrusrateAPI rate validation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("converts a valid black-market rate to satPriceInCurrency", async () => {
    const api = apiWithKey()
    mockFetch.mockResolvedValue(
      okJson({
        status: "success",
        data: {
          pair: "BTC/MZN",
          rate: 5_951_836.43,
          timestamp: "2026-09-14T00:00:00Z",
          source: "estimated",
        },
      }),
    )

    const result = await api.getBlackMarketRate("mzn")
    // MZN is 2-decimal: minor units (centavos) per sat
    expect(result.satPriceInCurrency).toBeCloseTo((5_951_836.43 / 100_000_000) * 100, 10)
    expect(result.currency).toBe("MZN")
    expect(result.provider).toBe("citrusrate_street")
    expect(result.source).toBe("estimated")
  })

  it("converts a zero-decimal currency (VUV) without the cents multiplier", async () => {
    const api = apiWithKey()
    mockFetch.mockResolvedValue(
      okJson({
        status: "success",
        data: { pair: "BTC/VUV", rate: 9_002_353.74, timestamp: "2026-09-14T00:00:00Z" },
      }),
    )

    const result = await api.getOfficialRate("VUV")
    // VUV has 0 fraction digits: price per sat in whole vatu (x1, not x100)
    expect(result.satPriceInCurrency).toBeCloseTo(9_002_353.74 / 100_000_000, 12)
  })

  it("converts a three-decimal currency (LYD) with the x1000 multiplier", async () => {
    const api = apiWithKey()
    mockFetch.mockResolvedValue(
      okJson({
        status: "success",
        data: { pair: "BTC/LYD", rate: 555_000, timestamp: "2026-09-14T00:00:00Z" },
      }),
    )

    const result = await api.getOfficialRate("LYD")
    // LYD has 3 fraction digits: price per sat in dirhams
    expect(result.satPriceInCurrency).toBeCloseTo((555_000 / 100_000_000) * 1000, 10)
  })

  it("converts a zero-decimal street rate (RWF) without the cents multiplier", async () => {
    const api = apiWithKey()
    mockFetch.mockResolvedValue(
      okJson({
        status: "success",
        data: {
          pair: "BTC/RWF",
          rate: 115_361_018.9,
          timestamp: "2026-09-14T00:00:00Z",
          source: "estimated",
        },
      }),
    )

    const result = await api.getBlackMarketRate("RWF")
    expect(result.satPriceInCurrency).toBeCloseTo(115_361_018.9 / 100_000_000, 10)
  })

  it("route-to-checkout contract: a 1,000 VUV sale yields ~11,108 sats (PR #81 review example)", async () => {
    const api = apiWithKey()
    mockFetch.mockResolvedValue(
      okJson({
        status: "success",
        data: { pair: "BTC/VUV", rate: 9_002_353.74, timestamp: "2026-09-14T00:00:00Z" },
      }),
    )

    const rate = await api.getOfficialRate("VUV")

    // Mirror POS.tsx convertToSatoshis: minor units / per-sat minor price
    const currencyInfo = getCurrencyById("VUV", [])
    expect(currencyInfo?.fractionDigits).toBe(0)
    const amountInMinorUnits = 1000 * 10 ** (currencyInfo?.fractionDigits ?? 2)
    const satsAmount = Math.round(amountInMinorUnits / rate.satPriceInCurrency)

    expect(satsAmount).toBe(11_108)
  })

  it("converts a valid official rate to satPriceInCurrency", async () => {
    const api = apiWithKey()
    mockFetch.mockResolvedValue(
      okJson({
        status: "success",
        data: { pair: "BTC/NGN", rate: 100_000_000, timestamp: "2026-09-14T00:00:00Z" },
      }),
    )

    const result = await api.getOfficialRate("ngn")
    // 100M NGN per BTC -> 1 NGN per sat -> 100 cents per sat
    expect(result.satPriceInCurrency).toBe(100)
    expect(result.currency).toBe("NGN")
    expect(result.provider).toBe("citrusrate")
  })

  // Malformed shapes the API could plausibly return in a degraded state
  const MALFORMED_RATES: Array<[string, unknown]> = [
    ["string", "103011056.22"],
    ["object", { rate: 123 }],
    ["null", null],
    ["zero", 0],
    ["negative", -42],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["missing", undefined],
  ]

  it.each(MALFORMED_RATES)("getOfficialRate rejects a %s rate", async (_label, rate) => {
    const api = apiWithKey()
    mockFetch.mockResolvedValue(
      okJson({ status: "success", data: { pair: "BTC/NGN", rate } }),
    )

    await expect(api.getOfficialRate("NGN")).rejects.toThrow(
      /No valid official rate available for NGN/,
    )
  })

  it.each(MALFORMED_RATES)(
    "getBlackMarketRate rejects a %s rate",
    async (_label, rate) => {
      const api = apiWithKey()
      mockFetch.mockResolvedValue(
        okJson({ status: "success", data: { pair: "BTC/MZN", rate } }),
      )

      await expect(api.getBlackMarketRate("MZN")).rejects.toThrow(
        /No valid black market rate available for MZN/,
      )
    },
  )

  it("getAllOfficialRates skips malformed entries but keeps valid ones", async () => {
    const api = apiWithKey()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    mockFetch.mockResolvedValue(
      okJson({
        status: "success",
        data: {
          rates: {
            NGN: 103_011_056.22,
            VUV: 9_002_353.74,
            BAD_STRING: "not-a-number",
            BAD_ZERO: 0,
            BAD_NEGATIVE: -1,
            BAD_OBJECT: { nested: true },
          },
          timestamp: "2026-09-14T00:00:00Z",
        },
      }),
    )

    const result = await api.getAllOfficialRates()

    expect(Object.keys(result.rates).sort()).toEqual(["NGN", "VUV"])
    // NGN is 2-decimal (x100), VUV is zero-decimal (x1) — per-currency denominations
    expect(result.rates.NGN.satPriceInCurrency).toBeCloseTo(
      (103_011_056.22 / 100_000_000) * 100,
      10,
    )
    expect(result.rates.VUV.satPriceInCurrency).toBeCloseTo(
      9_002_353.74 / 100_000_000,
      12,
    )
    expect(warn).toHaveBeenCalledTimes(4)
    warn.mockRestore()
  })
})

describe("CitrusrateAPI timeout covers body parsing", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("rejects when the response body stalls (headers received, json() never resolves)", async () => {
    const api = apiWithKey()
    api.timeout = 50
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise(() => undefined), // never resolves
    })

    const started = Date.now()
    await expect(api.getOfficialRate("NGN")).rejects.toThrow(/timed out/)
    // Must reject near the configured 50ms deadline, not hang
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("rejects when the error-body parse stalls too", async () => {
    const api = apiWithKey()
    api.timeout = 50
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => new Promise(() => undefined),
    })

    await expect(api.getOfficialRate("NGN")).rejects.toThrow(/timed out/)
  })
})

describe("CitrusrateAPI error handling", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("surfaces 429 with retryAfter", async () => {
    const api = apiWithKey()
    mockFetch.mockResolvedValue(errorJson(429, { retryAfter: 30 }))

    const promise = api.getOfficialRate("NGN")
    await expect(promise).rejects.toThrow(/Rate limited/)
    await promise.catch((error: CitrusrateError) => {
      expect(error.status).toBe(429)
      expect(error.retryAfter).toBe(30)
    })
  })

  it("defaults retryAfter to 60 when the 429 body omits it", async () => {
    const api = apiWithKey()
    mockFetch.mockResolvedValue(errorJson(429, {}))

    await api.getOfficialRate("NGN").catch((error: CitrusrateError) => {
      expect(error.status).toBe(429)
      expect(error.retryAfter).toBe(60)
    })
  })

  it("throws the API message on other error statuses", async () => {
    const api = apiWithKey()
    mockFetch.mockResolvedValue(
      errorJson(403, { message: "Forbidden: Missing required scope" }),
    )

    await expect(api.getOfficialRate("NGN")).rejects.toThrow(/Forbidden/)
  })

  it("throws on a non-success status payload", async () => {
    const api = apiWithKey()
    mockFetch.mockResolvedValue(okJson({ status: "error", message: "payment_required" }))

    await expect(api.getOfficialRate("NGN")).rejects.toThrow(/payment_required/)
  })
})
