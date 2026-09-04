/**
 * NostrConnectClient — the browser half of the server-held NIP-46 flow (#70).
 *
 * Replaces nip98-abort.spec.ts: the abort/header-receipt invariants it guarded
 * used to live in nip98Login's NIP-46 signing path, which no longer exists. The
 * same invariants now apply to consumeSession, which is what turns a
 * server-verified approval into a session cookie.
 *
 * @jest-environment jsdom
 */

import {
  cancelSession,
  consumeSession,
  createSession,
  pollSession,
} from "../../lib/nostr/NostrConnectClient"

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let fetchMock: jest.Mock

beforeEach(() => {
  fetchMock = jest.fn()
  global.fetch = fetchMock as unknown as typeof fetch
})

describe("createSession", () => {
  it("posts with credentials and returns the ready URI", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        sessionId: "abc",
        uri: "nostrconnect://pk?relay=wss%3A%2F%2Fa",
        expiresAt: 42,
      }),
    )

    const result = await createSession()

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/nostr-connect/sessions",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    )
    expect(result).toMatchObject({
      success: true,
      sessionId: "abc",
      uri: "nostrconnect://pk?relay=wss%3A%2F%2Fa",
    })
  })

  it("surfaces the machine-readable reason when no relay is available", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, { error: "No relay", reason: "relays_unavailable" }),
    )

    const result = await createSession()

    expect(result.success).toBe(false)
    expect(result.reason).toBe("relays_unavailable")
    // Critically, no URI is produced — there is nobody listening for it.
    expect(result.uri).toBeUndefined()
  })

  it("reports an abort distinctly so the caller can stay silent", async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          )
        }),
    )

    const pending = createSession(controller.signal)
    controller.abort()

    expect(await pending).toMatchObject({ success: false, reason: "aborted" })
  })
})

describe("pollSession", () => {
  // The poll loop sleeps between attempts; drive it with fake timers rather
  // than making the suite wait out real intervals.
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  /** Run a poll to completion, flushing its sleeps. */
  async function drain<T>(promise: Promise<T>): Promise<T> {
    await jest.advanceTimersByTimeAsync(30_000)
    return promise
  }

  it("returns once the session is approved", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: "pending" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { status: "approved", pubkey: "a".repeat(64) }),
      )

    const controller = new AbortController()
    const result = await drain(pollSession("abc", { signal: controller.signal }))

    expect(result).toMatchObject({ status: "approved", pubkey: "a".repeat(64) })
  })

  it("returns the failure reason so the modal can explain it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { status: "failed", error: "signing_timeout" }),
    )

    const result = await drain(
      pollSession("abc", { signal: new AbortController().signal }),
    )

    expect(result).toMatchObject({ status: "failed", error: "signing_timeout" })
  })

  it("keeps polling through a transient network failure", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(
        jsonResponse(200, { status: "approved", pubkey: "b".repeat(64) }),
      )

    const result = await drain(
      pollSession("abc", { signal: new AbortController().signal }),
    )

    // The session lives on the server; a blip must not end the sign-in.
    expect(result.status).toBe("approved")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("treats rate-limit push-back as still pending", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(
        jsonResponse(200, { status: "approved", pubkey: "c".repeat(64) }),
      )

    const result = await drain(
      pollSession("abc", { signal: new AbortController().signal }),
    )
    expect(result.status).toBe("approved")
  })

  it("stops when aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await drain(pollSession("abc", { signal: controller.signal }))

    expect(result).toMatchObject({ status: "failed", error: "aborted" })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("consumeSession", () => {
  it("returns the verified pubkey on success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        user: { pubkey: "a".repeat(64), authMethod: "nostr" },
      }),
    )

    const result = await consumeSession("abc")

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/nostr-connect/sessions/abc/consume",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    )
    expect(result).toEqual({ success: true, publicKey: "a".repeat(64) })
  })

  /**
   * The server sets the auth-token cookie with the response HEADERS; reading the
   * JSON body is a second await. An abort landing in that window must NOT be
   * reported as "no session", or the caller skips its compensating logout and a
   * live cookie survives for a cancelled attempt (PR #69).
   */
  it("reports the session as established when the body is aborted after the headers arrived", async () => {
    const controller = new AbortController()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          )
        }),
    } as unknown as Response)

    const pending = consumeSession("abc", controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()

    const result = await pending

    // NOT "superseded": the cookie exists, so the caller must compensate.
    expect(result.success).toBe(true)
    expect(result.errorType).toBeUndefined()
  })

  it("still reports failure when the body fails on a NON-ok response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => {
        throw new Error("unparsable")
      },
    } as unknown as Response)

    const result = await consumeSession("abc")

    // No session was created, so this is a genuine failure.
    expect(result.success).toBe(false)
  })

  it("reports a pre-header abort as superseded so no compensation runs", async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          )
        }),
    )

    const pending = consumeSession("abc", controller.signal)
    controller.abort()
    const result = await pending

    expect(result).toMatchObject({ success: false, errorType: "superseded" })
  })

  it("surfaces a rejected consume as a session error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: "Session already used" }))

    const result = await consumeSession("abc")

    expect(result).toMatchObject({
      success: false,
      error: "Session already used",
      errorType: "session",
    })
  })
})

describe("cancelSession", () => {
  it("releases the server's relay sockets and never throws", async () => {
    fetchMock.mockRejectedValue(new Error("offline"))

    await expect(cancelSession("abc")).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/nostr-connect/sessions/abc",
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    )
  })
})
