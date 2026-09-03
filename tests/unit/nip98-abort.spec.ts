/**
 * The abortable NIP-98 login (PR #66 review).
 *
 * The hook-level tests mock NostrAuthService, so the new explicit-method unauthenticated
 * dispatch and the AbortSignal propagation through NIP-46 signing and the login fetch are
 * exercised here against the REAL service, with only the network and the NIP-46 signer mocked
 * at their boundaries.
 *
 * @jest-environment jsdom
 */

// The service's ESM nostr-tools imports cannot be parsed by jest; only the signing boundary is
// needed, so the whole NIP-46 service is stubbed as "connected and able to sign".
jest.mock("../../lib/nostr/NostrConnectService", () => ({
  __esModule: true,
  default: {
    isConnected: () => true,
    signEvent: async () => ({ success: true, event: { id: "evt", sig: "sig" } }),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports -- required after the module mock
const NostrAuthService = require("../../lib/nostr/NostrAuthService")
  .default as typeof import("../../lib/nostr/NostrAuthService").default

describe("NostrAuthService.nip98Login — abortable (PR #66)", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    jest.spyOn(console, "error").mockImplementation(() => {})
    jest.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const abortableFetch = (): jest.Mock => {
    const fetchMock = jest.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          )
        }),
    )
    global.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  it("reaches the network for a Nostr Connect login without stored auth, given an explicit method", async () => {
    const fetchMock = abortableFetch()
    const controller = new AbortController()

    const result = NostrAuthService.nip98Login({
      signWithMethod: "nostrConnect",
      signal: controller.signal,
    })
    await new Promise((r) => setTimeout(r, 0))

    // The explicit method let it sign and reach the login endpoint with no stored auth data.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/nostr-login",
      expect.objectContaining({ method: "POST" }),
    )

    controller.abort()
    const settled = await result
    expect(settled.success).toBe(false)
    expect(settled.errorType).toBe("superseded")
  })

  it("an abort during signing prevents the login fetch entirely", async () => {
    const fetchMock = abortableFetch()
    const controller = new AbortController()
    controller.abort() // already aborted before the call

    const result = await NostrAuthService.nip98Login({
      signWithMethod: "nostrConnect",
      signal: controller.signal,
    })

    expect(result.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("without an explicit method it still requires stored auth", async () => {
    const fetchMock = abortableFetch()
    // No stored auth data, no override → refuses before signing or the network.
    const result = await NostrAuthService.nip98Login()
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not signed in/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
