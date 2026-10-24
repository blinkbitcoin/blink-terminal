/** @jest-environment node */

/**
 * Browser build of safe-fetch-json (client bundles only). Same API, error
 * codes and https / byte-cap semantics as the server build; see the file
 * header for the intentional differences.
 */

import {
  SafeFetchError,
  safeFetchJson,
  safeFetchJsonResponse,
} from "../../lib/server/safe-fetch-json.browser"

const fetchMock = jest.fn()

const respond = (
  body: string | Uint8Array<ArrayBuffer>,
  {
    status = 200,
    url = "https://service.example/data",
    headers = {},
  }: { status?: number; url?: string; headers?: Record<string, string> } = {},
) => {
  const response = new Response(body, { status, headers })
  Object.defineProperty(response, "url", { value: url })
  return response
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SafeFetchError)
    return (error as SafeFetchError).code
  }
  return "resolved"
}

beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
})

describe("safe-fetch-json (browser build)", () => {
  it("returns parsed JSON and the final URL", async () => {
    fetchMock.mockResolvedValueOnce(
      respond('{"value":42}', { url: "https://other.example/final" }),
    )

    await expect(safeFetchJsonResponse("https://service.example/data")).resolves.toEqual({
      data: { value: 42 },
      url: "https://other.example/final",
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "https://service.example/data",
      expect.objectContaining({ redirect: "follow" }),
    )
  })

  it("rejects malformed and non-https input before fetching", async () => {
    expect(await codeOf(safeFetchJson("not a url"))).toBe("INVALID_URL")
    expect(await codeOf(safeFetchJson("http://service.example/"))).toBe("NOT_HTTPS")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a redirect that ends on a non-https URL", async () => {
    fetchMock.mockResolvedValueOnce(
      respond("{}", { url: "http://service.example/final" }),
    )
    expect(await codeOf(safeFetchJson("https://service.example/data"))).toBe("NOT_HTTPS")
  })

  it("maps network failures to NETWORK", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    expect(await codeOf(safeFetchJson("https://service.example/data"))).toBe("NETWORK")
  })

  it("maps the deadline abort to TIMEOUT", async () => {
    jest.useFakeTimers()
    try {
      fetchMock.mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")))
          }),
      )
      const result = codeOf(safeFetchJson("https://service.example/data"))
      await jest.advanceTimersByTimeAsync(15_000)
      expect(await result).toBe("TIMEOUT")
    } finally {
      jest.useRealTimers()
    }
  })

  it("maps non-2xx responses to HTTP_STATUS", async () => {
    fetchMock.mockResolvedValueOnce(respond("{}", { status: 404 }))
    const promise = safeFetchJson("https://service.example/data")
    await expect(promise).rejects.toThrow("upstream returned HTTP 404")
    fetchMock.mockResolvedValueOnce(respond("{}", { status: 503 }))
    expect(await codeOf(safeFetchJson("https://service.example/data"))).toBe(
      "HTTP_STATUS",
    )
  })

  it("maps invalid JSON to INVALID_JSON", async () => {
    fetchMock.mockResolvedValueOnce(respond("not-json"))
    expect(await codeOf(safeFetchJson("https://service.example/data"))).toBe(
      "INVALID_JSON",
    )
  })

  it("rejects early on a declared Content-Length over the cap", async () => {
    fetchMock.mockResolvedValueOnce(
      respond("{}", { headers: { "content-length": String(16 * 1024 + 1) } }),
    )
    expect(await codeOf(safeFetchJson("https://service.example/data"))).toBe("TOO_LARGE")
  })

  it("enforces the cap in bytes, not UTF-16 code units", async () => {
    // 6,000 × "€" = 6,000 code units but 18,000 UTF-8 bytes (> 16 KiB).
    const body = `{"s":"${"€".repeat(6_000)}"}`
    expect(body.length).toBeLessThan(16 * 1024)
    fetchMock.mockResolvedValueOnce(respond(new TextEncoder().encode(body)))
    expect(await codeOf(safeFetchJson("https://service.example/data"))).toBe("TOO_LARGE")
  })

  it("honours a larger maxBodyBytes", async () => {
    const pad = "x".repeat(20 * 1024)
    fetchMock.mockResolvedValueOnce(respond(`{"pad":"${pad}"}`))
    await expect(
      safeFetchJson("https://service.example/data", { maxBodyBytes: 64 * 1024 }),
    ).resolves.toEqual({ pad })
  })
})
