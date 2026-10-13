/**
 * Tests for fetchJsonWithRetry in lib/lnurl.ts
 *
 * All LNURL fetches go through safeFetchJson (SSRF guard). Transient transport failures are retried so a single blip does
 * not surface as "address not found"; policy rejections are not retried.
 */

// nostr-tools (pulled in transitively by lib/lnurl.ts) ships ESM that jest's
// default transform can't load; stub it so the module imports cleanly.
jest.mock("nostr-tools", () => ({
  nip19: { decode: () => ({ type: "npub", data: "x" }) },
}))

const mockSafeFetchJson = jest.fn()
jest.mock("../../lib/server/safe-fetch-json", () => {
  class SafeFetchError extends Error {}
  return {
    SafeFetchError,
    safeFetchJson: (...args: unknown[]) => mockSafeFetchJson(...args),
  }
})

import { fetchJsonWithRetry, getInvoiceFromLightningAddress } from "../../lib/lnurl"
import { SafeFetchError } from "../../lib/server/safe-fetch-json"

beforeEach(() => {
  jest.clearAllMocks()
})

describe("fetchJsonWithRetry", () => {
  it("returns the parsed JSON on first success via safeFetchJson", async () => {
    mockSafeFetchJson.mockResolvedValueOnce({ ok: 1 })

    await expect(fetchJsonWithRetry("https://blink.sv/x", 2)).resolves.toEqual({ ok: 1 })
    expect(mockSafeFetchJson).toHaveBeenCalledTimes(1)
    expect(mockSafeFetchJson).toHaveBeenCalledWith("https://blink.sv/x", {
      maxBodyBytes: 256 * 1024,
    })
  })

  it("retries a transient transport failure then succeeds", async () => {
    mockSafeFetchJson
      .mockRejectedValueOnce(new SafeFetchError("upstream request failed"))
      .mockResolvedValueOnce({ ok: 1 })

    await expect(fetchJsonWithRetry("https://blink.sv/x", 2)).resolves.toEqual({ ok: 1 })
    expect(mockSafeFetchJson).toHaveBeenCalledTimes(2)
  })

  it("throws after exhausting all retries", async () => {
    mockSafeFetchJson.mockRejectedValue(new SafeFetchError("upstream request timed out"))

    await expect(fetchJsonWithRetry("https://blink.sv/x", 2)).rejects.toThrow(
      "upstream request timed out",
    )
    expect(mockSafeFetchJson).toHaveBeenCalledTimes(3)
  })

  it.each([
    "hostname does not resolve to a public address",
    "only https URLs are allowed",
    "upstream returned HTTP 404",
  ])("does not retry policy/HTTP rejections (%s)", async (message) => {
    mockSafeFetchJson.mockRejectedValue(new SafeFetchError(message))

    await expect(fetchJsonWithRetry("https://blink.sv/x", 2)).rejects.toThrow(message)
    expect(mockSafeFetchJson).toHaveBeenCalledTimes(1)
  })
})

describe("getInvoiceFromLightningAddress (SSRF)", () => {
  it("never fetches the LNURL callback with raw fetch", async () => {
    const rawFetch = jest.fn()
    global.fetch = rawFetch as unknown as typeof fetch
    mockSafeFetchJson
      .mockResolvedValueOnce({
        tag: "payRequest",
        callback: "https://10.0.0.5:8080/internal",
        minSendable: 1000,
        maxSendable: 1_000_000,
        metadata: "[]",
      })
      .mockRejectedValueOnce(
        new SafeFetchError("hostname does not resolve to a public address"),
      )

    await expect(getInvoiceFromLightningAddress("a@evil.example", 10)).rejects.toThrow(
      "hostname does not resolve to a public address",
    )
    expect(rawFetch).not.toHaveBeenCalled()
    expect(mockSafeFetchJson.mock.calls[0][0]).toBe(
      "https://evil.example/.well-known/lnurlp/a",
    )
    expect(mockSafeFetchJson.mock.calls[1][0]).toContain("https://10.0.0.5:8080/")
  })
})
