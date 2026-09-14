/**
 * @jest-environment node
 *
 * Rate cache (lib/rate-providers/cache.ts) against the shared Redis lifecycle.
 *
 * PR #81 review follow-up: the poller suite mocks this module, so the real
 * bulk-write path is exercised here — pipeline key/TTL serialization,
 * no-client degradation, and pipeline rejection handling.
 */

const mockGetSharedRedisClient = jest.fn()

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  getSharedRedisClient: () => mockGetSharedRedisClient(),
}))

import {
  getCachedRate,
  setCachedRate,
  setCachedRatesBulk,
  invalidateCachedRate,
  RATE_CACHE_TTL,
} from "../../lib/rate-providers/cache"

interface FakePipeline {
  setEx: jest.Mock
  exec: jest.Mock
}

const makeClient = () => {
  const pipeline: FakePipeline = {
    setEx: jest.fn(),
    exec: jest.fn(async () => []),
  }
  pipeline.setEx.mockReturnValue(pipeline)
  return {
    get: jest.fn(),
    setEx: jest.fn(async () => "OK"),
    del: jest.fn(async () => 1),
    keys: jest.fn(async () => []),
    multi: jest.fn(() => pipeline),
    pipeline,
  }
}

describe("rate cache with an available shared client", () => {
  let client: ReturnType<typeof makeClient>

  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(console, "log").mockImplementation(() => undefined)
    jest.spyOn(console, "warn").mockImplementation(() => undefined)
    client = makeClient()
    mockGetSharedRedisClient.mockResolvedValue(client)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("setCachedRatesBulk writes one pipelined setEx per currency with prefix key and TTL", async () => {
    await setCachedRatesBulk(
      "citrusrate_official",
      {
        VUV: { satPriceInCurrency: 0.009, currency: "VUV" },
        NGN_CITRUS: { satPriceInCurrency: 0.103, currency: "NGN_CITRUS" },
      },
      120,
    )

    expect(client.multi).toHaveBeenCalledTimes(1)
    expect(client.pipeline.setEx).toHaveBeenCalledTimes(2)

    const [vuvKey, vuvTtl, vuvPayload] = client.pipeline.setEx.mock.calls[0] as [
      string,
      number,
      string,
    ]
    expect(vuvKey).toBe("blink-terminal:rate:citrusrate_official:VUV")
    expect(vuvTtl).toBe(120)
    const parsed = JSON.parse(vuvPayload as string)
    expect(parsed.satPriceInCurrency).toBe(0.009)
    expect(typeof parsed.cachedAt).toBe("string")

    expect(client.pipeline.setEx.mock.calls[1][0]).toBe(
      "blink-terminal:rate:citrusrate_official:NGN_CITRUS",
    )
    expect(client.pipeline.exec).toHaveBeenCalledTimes(1)
  })

  it("setCachedRate uses the default 45s TTL", async () => {
    await setCachedRate("blink", "USD", { satPriceInCurrency: 0.05 })

    const [key, ttl] = client.setEx.mock.calls[0] as unknown as [string, number]
    expect(key).toBe("blink-terminal:rate:blink:USD")
    expect(ttl).toBe(RATE_CACHE_TTL)
    expect(ttl).toBe(45)
  })

  it("getCachedRate returns the parsed payload on hit and null on miss", async () => {
    client.get.mockResolvedValueOnce(
      JSON.stringify({ satPriceInCurrency: 0.05, cachedAt: "x" }),
    )
    const hit = await getCachedRate("blink", "USD")
    expect(hit?.satPriceInCurrency).toBe(0.05)

    client.get.mockResolvedValueOnce(null)
    const miss = await getCachedRate("blink", "USD")
    expect(miss).toBeNull()
  })

  it("invalidateCachedRate deletes the prefixed key", async () => {
    await invalidateCachedRate("citrusrate_street", "MZN_STREET")
    expect(client.del).toHaveBeenCalledWith(
      "blink-terminal:rate:citrusrate_street:MZN_STREET",
    )
  })

  it("swallows a pipeline rejection (warn, no throw)", async () => {
    client.pipeline.exec.mockRejectedValue(new Error("EXEC failed"))

    await expect(
      setCachedRatesBulk("citrusrate_official", { VUV: { satPriceInCurrency: 1 } }),
    ).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith("Rate cache bulk set error:", "EXEC failed")
  })
})

describe("rate cache without a shared client", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(console, "log").mockImplementation(() => undefined)
    jest.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("degrades to no-op / cache-miss when hybrid storage is off (null client)", async () => {
    mockGetSharedRedisClient.mockResolvedValue(null)

    await expect(
      setCachedRatesBulk("citrusrate_official", { VUV: { satPriceInCurrency: 1 } }),
    ).resolves.toBeUndefined()
    await expect(
      setCachedRate("blink", "USD", { satPriceInCurrency: 0.05 }),
    ).resolves.toBeUndefined()
    await expect(getCachedRate("blink", "USD")).resolves.toBeNull()
    await expect(invalidateCachedRate("blink", "USD")).resolves.toBeUndefined()
  })

  it("degrades to no-op / cache-miss when Redis is configured but unreachable", async () => {
    mockGetSharedRedisClient.mockRejectedValue(
      new Error("Redis is configured but unreachable"),
    )

    await expect(getCachedRate("blink", "USD")).resolves.toBeNull()
    await expect(
      setCachedRatesBulk("citrusrate_official", { VUV: { satPriceInCurrency: 1 } }),
    ).resolves.toBeUndefined()
  })
})
