/**
 * @jest-environment node
 *
 * Citrusrate poller (lib/rate-providers/poller.ts).
 *
 * The poller keeps the shared Redis cache warm on a fixed schedule so client
 * requests fan out from cache instead of multiplying upstream calls.
 * Verified here with the upstream client and the cache mocked:
 * - no-op when CITRUSRATE_API_KEY is unset
 * - one /btc/all snapshot warms official keys for exclusive AND _CITRUS alt ids
 * - street rates are fetched per base and cached under the _STREET ids
 * - a failing street currency is skipped without stalling the rest of the tick
 * - the tick repeats on the poll interval
 * - ticks never overlap: the next tick is scheduled only after the current
 *   one settles, even when an upstream request hangs across the 60s boundary
 */

type BulkRates = Record<string, Record<string, unknown>>

const mockSetCachedRatesBulk = jest.fn<Promise<void>, [string, BulkRates, number?]>(
  async () => undefined,
)
const mockGetAllOfficialRates = jest.fn()
const mockGetBlackMarketRate = jest.fn()

jest.mock("../../lib/rate-providers/cache", () => ({
  __esModule: true,
  setCachedRatesBulk: (provider: string, rates: BulkRates, ttl?: number) =>
    mockSetCachedRatesBulk(provider, rates, ttl),
}))

jest.mock("../../lib/rate-providers/citrusrate", () => ({
  __esModule: true,
  getCitrusrateAPI: () => ({
    getAllOfficialRates: () => mockGetAllOfficialRates(),
    getBlackMarketRate: (currency: string) => mockGetBlackMarketRate(currency),
  }),
}))

import { CITRUSRATE_ALT_CURRENCIES } from "../../lib/rate-providers/citrusrate-currencies"
import { startCitrusratePoller } from "../../lib/rate-providers/poller"

const globalState = globalThis as typeof globalThis & {
  __citrusratePollerStarted?: boolean
}

const OFFICIAL_SNAPSHOT = {
  timestamp: "2026-09-14T13:19:40.772Z",
  rates: {
    VUV: {
      currency: "VUV",
      satPriceInCurrency: 0.009,
      btcRate: 9002353.74,
      timestamp: "2026-09-14T13:19:40.772Z",
      source: "citrusrate_official",
      provider: "citrusrate",
    },
    NGN: {
      currency: "NGN",
      satPriceInCurrency: 0.103,
      btcRate: 103011056.22,
      timestamp: "2026-09-14T13:19:40.772Z",
      source: "citrusrate_official",
      provider: "citrusrate",
    },
    EGP: {
      currency: "EGP",
      satPriceInCurrency: 0.04,
      btcRate: 4029084.64,
      timestamp: "2026-09-14T13:19:40.772Z",
      source: "citrusrate_official",
      provider: "citrusrate",
    },
  },
}

const streetRate = (currency: string) => ({
  currency,
  satPriceInCurrency: 0.06,
  btcRate: 5951836.43,
  timestamp: "2026-09-14T13:19:50.936Z",
  source: "estimated",
  provider: "citrusrate_street",
})

/** Flush the immediate tick: official write + 13 street calls spaced 500ms apart. */
const runFirstTick = async (): Promise<void> => {
  await jest.advanceTimersByTimeAsync(13 * 500 + 100)
}

describe("startCitrusratePoller", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    delete globalState.__citrusratePollerStarted
    delete process.env.CITRUSRATE_API_KEY
    process.env.ENABLE_HYBRID_STORAGE = "true"

    mockGetAllOfficialRates.mockResolvedValue(OFFICIAL_SNAPSHOT)
    mockGetBlackMarketRate.mockImplementation(async (currency: string) =>
      streetRate(currency),
    )
  })

  afterEach(() => {
    jest.useRealTimers()
    delete process.env.ENABLE_HYBRID_STORAGE
  })

  it("no-ops when CITRUSRATE_API_KEY is not set", async () => {
    startCitrusratePoller()
    await runFirstTick()

    expect(mockGetAllOfficialRates).not.toHaveBeenCalled()
    expect(mockSetCachedRatesBulk).not.toHaveBeenCalled()
    // flag stays unset so a later call (e.g. after config fix) can start it
    expect(globalState.__citrusratePollerStarted).toBeUndefined()
  })

  it("no-ops when hybrid storage is off even with a key (no shared cache to warm)", async () => {
    process.env.CITRUSRATE_API_KEY = "test-key"
    delete process.env.ENABLE_HYBRID_STORAGE

    startCitrusratePoller()
    await runFirstTick()

    expect(mockGetAllOfficialRates).not.toHaveBeenCalled()
    expect(mockSetCachedRatesBulk).not.toHaveBeenCalled()
    expect(globalState.__citrusratePollerStarted).toBeUndefined()
  })

  it("warms official rates for exclusive and _CITRUS alt ids from one snapshot", async () => {
    process.env.CITRUSRATE_API_KEY = "test-key"
    startCitrusratePoller()
    await runFirstTick()

    const officialWrite = mockSetCachedRatesBulk.mock.calls.find(
      ([provider]) => provider === "citrusrate_official",
    )
    expect(officialWrite).toBeDefined()

    const [, rawRates, ttl] = officialWrite as NonNullable<typeof officialWrite>
    const rates = rawRates as unknown as Record<string, { currency: string }>
    // exclusive id kept as-is
    expect(rates.VUV?.currency).toBe("VUV")
    // alt ids keyed by their _CITRUS id, sourced from the base rate
    expect(rates.NGN_CITRUS?.currency).toBe("NGN_CITRUS")
    expect(rates.EGP_CITRUS?.currency).toBe("EGP_CITRUS")
    // cache TTL must outlive the 60s poll interval
    expect(ttl).toBeGreaterThan(60)
  })

  it("does not invent official entries for alt bases missing from the snapshot", async () => {
    process.env.CITRUSRATE_API_KEY = "test-key"
    startCitrusratePoller()
    await runFirstTick()

    const officialCall = mockSetCachedRatesBulk.mock.calls.find(
      ([provider]) => provider === "citrusrate_official",
    )
    const rates = officialCall?.[1] ?? {}
    // GHS is not in the mocked snapshot, so GHS_CITRUS must not be written
    const ghostAlts = CITRUSRATE_ALT_CURRENCIES.filter(
      (alt) => !(alt.baseId in OFFICIAL_SNAPSHOT.rates) && alt.id in rates,
    )
    expect(ghostAlts).toEqual([])
  })

  it("writes one cached street rate per supported currency under its _STREET id", async () => {
    process.env.CITRUSRATE_API_KEY = "test-key"
    startCitrusratePoller()
    await runFirstTick()

    const streetWrites = mockSetCachedRatesBulk.mock.calls.filter(
      ([provider]) => provider === "citrusrate_street",
    )
    expect(streetWrites).toHaveLength(13)

    const mznWrite = streetWrites.find(([, rates]) => "MZN_STREET" in rates)
    expect(mznWrite).toBeDefined()
    expect(mockGetBlackMarketRate).toHaveBeenCalledWith("MZN")
    expect(mockGetBlackMarketRate).toHaveBeenCalledWith("RWF")
  })

  it("skips a failing street currency and completes the rest of the tick", async () => {
    process.env.CITRUSRATE_API_KEY = "test-key"
    mockGetBlackMarketRate.mockImplementation(async (currency: string) => {
      if (currency === "GHS") throw new Error("upstream 500")
      return streetRate(currency)
    })

    startCitrusratePoller()
    await runFirstTick()

    const streetWrites = mockSetCachedRatesBulk.mock.calls.filter(
      ([provider]) => provider === "citrusrate_street",
    )
    expect(streetWrites).toHaveLength(12)
    expect(streetWrites.some(([, rates]) => "GHS_STREET" in rates)).toBe(false)
  })

  it("repeats the tick after the previous one settles (completion-based scheduling)", async () => {
    process.env.CITRUSRATE_API_KEY = "test-key"
    startCitrusratePoller()
    await runFirstTick()

    const callsAfterFirstTick = mockSetCachedRatesBulk.mock.calls.length
    expect(callsAfterFirstTick).toBeGreaterThan(0)

    // The next tick is scheduled 60s after tick 1 COMPLETED (not started).
    // Advance well past that: 60s interval + street-call spacing + slack.
    await jest.advanceTimersByTimeAsync(60_000 + 13 * 500 + 1000)
    expect(mockSetCachedRatesBulk.mock.calls.length).toBeGreaterThan(callsAfterFirstTick)
  })

  it("never launches a second tick while an upstream request is still pending", async () => {
    process.env.CITRUSRATE_API_KEY = "test-key"

    // Degraded upstream: the /btc/all call hangs past the 60s boundary
    let resolvePending: (value: typeof OFFICIAL_SNAPSHOT) => void = () => undefined
    mockGetAllOfficialRates.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve
        }),
    )

    startCitrusratePoller()
    // Advance across TWO interval boundaries while tick 1 is still in flight
    await jest.advanceTimersByTimeAsync(130_000)

    // No second tick: /btc/all called exactly once, street phase never reached
    expect(mockGetAllOfficialRates).toHaveBeenCalledTimes(1)
    expect(mockGetBlackMarketRate).not.toHaveBeenCalled()

    // Upstream recovers: tick 1 completes and the next tick is scheduled
    resolvePending(OFFICIAL_SNAPSHOT)
    await jest.advanceTimersByTimeAsync(13 * 500 + 100) // finish tick 1 streets
    await jest.advanceTimersByTimeAsync(60_000 + 100) // reach tick 2
    expect(mockGetAllOfficialRates).toHaveBeenCalledTimes(2)
  })

  it("is idempotent — a second call does not start a second interval", async () => {
    process.env.CITRUSRATE_API_KEY = "test-key"
    startCitrusratePoller()
    startCitrusratePoller()
    await runFirstTick()

    const officialWrites = mockSetCachedRatesBulk.mock.calls.filter(
      ([provider]) => provider === "citrusrate_official",
    )
    expect(officialWrites).toHaveLength(1)
  })
})
