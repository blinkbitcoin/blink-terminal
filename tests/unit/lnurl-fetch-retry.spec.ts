/**
 * Tests for fetchWithRetry in lib/lnurl.ts
 *
 * Server-side LNURL fetches to blink.sv / lnurl.blink.sv intermittently fail
 * with "fetch failed" under Node's undici. fetchWithRetry retries transient
 * failures so a single blip does not surface as "address not found".
 */

// nostr-tools (pulled in transitively by lib/lnurl.ts) ships ESM that jest's
// default transform can't load; stub it so the module imports cleanly.
jest.mock("nostr-tools", () => ({
  nip19: { decode: () => ({ type: "npub", data: "x" }) },
}))

import { fetchWithRetry } from "../../lib/lnurl"

const okResponse = () => ({ ok: true, status: 200 }) as unknown as Response

beforeEach(() => {
  jest.clearAllMocks()
})

describe("fetchWithRetry", () => {
  it("returns the response on first success", async () => {
    const fetchMock = jest.fn(async () => okResponse())
    global.fetch = fetchMock as unknown as typeof fetch

    const res = await fetchWithRetry("https://blink.sv/x", {}, 2, 1000)

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("retries on transient failure then succeeds", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(okResponse())
    global.fetch = fetchMock as unknown as typeof fetch

    const res = await fetchWithRetry("https://blink.sv/x", {}, 2, 1000)

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("throws after exhausting all retries", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("fetch failed"))
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(fetchWithRetry("https://blink.sv/x", {}, 2, 1000)).rejects.toThrow(
      "fetch failed",
    )
    // initial attempt + 2 retries = 3
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("sends Connection: close and merges caller headers", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => okResponse())
    global.fetch = fetchMock as unknown as typeof fetch

    await fetchWithRetry(
      "https://blink.sv/x",
      { headers: { Accept: "application/json" } },
      0,
      1000,
    )

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.headers).toMatchObject({
      Connection: "close",
      Accept: "application/json",
    })
    expect(init.signal).toBeDefined()
  })
})
