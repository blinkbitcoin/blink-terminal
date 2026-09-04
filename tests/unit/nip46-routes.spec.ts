/**
 * @jest-environment node
 *
 * NIP-46 session API routes.
 *
 * The properties that matter here are security properties, not plumbing:
 *   - the binding cookie is required on every read/consume/cancel, and a caller
 *     without it cannot even tell that the session exists;
 *   - polling never mints an auth cookie;
 *   - consume is single-use;
 *   - no relay means a 503 rather than a URI nobody is listening for.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-nip46-routes"

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_AUTH: { max: 10 },
  RATE_LIMIT_POLL: { max: 240 },
}))

jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: { generateSession: jest.fn(() => "signed-jwt") },
}))

const managerMock = {
  create: jest.fn(),
  resolveStatus: jest.fn(),
  consume: jest.fn(),
  cancel: jest.fn(),
}
const getSessionMock = jest.fn()

jest.mock("../../lib/nip46-server", () => {
  // Only the error classes are real — they live in their own module precisely
  // so routes can branch on them without loading the relay transport.
  const errors = jest.requireActual("../../lib/nip46-server/errors")
  return {
    getNip46SessionManager: () => managerMock,
    getSession: (...args: unknown[]) => getSessionMock(...args),
    Nip46CapacityError: errors.Nip46CapacityError,
    Nip46RelayUnavailableError: errors.Nip46RelayUnavailableError,
    Nip46StorageError: errors.Nip46StorageError,
  }
})

import type { NextApiRequest, NextApiResponse } from "next"

import { NIP46_COOKIE_NAME } from "../../lib/auth/cookies"
import {
  Nip46CapacityError,
  Nip46RelayUnavailableError,
  Nip46StorageError,
} from "../../lib/nip46-server/errors"
import { sha256Hex } from "../../lib/nip46-server/sessionStore"
import consumeRoute from "../../pages/api/nostr-connect/sessions/[id]/consume"
import statusRoute from "../../pages/api/nostr-connect/sessions/[id]/index"
import createRoute from "../../pages/api/nostr-connect/sessions/index"

const SESSION_ID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
const BINDING_SECRET = "s".repeat(64)
const PUBKEY = "a".repeat(64)

interface MockResponse extends NextApiResponse {
  _status: number
  _json: unknown
  _headers: Record<string, string | string[]>
}

function makeRes(): MockResponse {
  const res = {
    _status: 0,
    _json: undefined,
    _headers: {},
    status(code: number) {
      this._status = code
      return this
    },
    json(payload: unknown) {
      this._json = payload
      return this
    },
    setHeader(name: string, value: string | string[]) {
      this._headers[name] = value
      return this
    },
    getHeader(name: string) {
      return this._headers[name]
    },
  } as unknown as MockResponse
  return res
}

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: "GET",
    query: {},
    cookies: {},
    headers: { "host": "pos.example", "x-forwarded-proto": "https" },
    socket: { remoteAddress: "1.2.3.4" },
    ...overrides,
  } as unknown as NextApiRequest
}

function pendingRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    bindingHash: sha256Hex(BINDING_SECRET),
    expectedUrl: `https://pos.example/api/nostr-connect/sessions/${SESSION_ID}/consume`,
    challenge: "challenge",
    ...overrides,
  }
}

function cookies(secret = BINDING_SECRET): Record<string, string> {
  return { [NIP46_COOKIE_NAME]: secret }
}

beforeEach(() => {
  jest.clearAllMocks()
  managerMock.resolveStatus.mockImplementation(
    async (record: {
      status: string
      pubkey?: string
      error?: string
      expiresAt: number
    }) => ({
      status: record.status,
      pubkey: record.pubkey,
      error: record.error,
      expiresAt: record.expiresAt,
    }),
  )
})

describe("POST /api/nostr-connect/sessions", () => {
  it("returns the URI and sets a strict, HttpOnly binding cookie", async () => {
    managerMock.create.mockResolvedValue({
      sessionId: SESSION_ID,
      uri: "nostrconnect://abc?relay=wss%3A%2F%2Fa",
      bindingSecret: BINDING_SECRET,
      expiresAt: 1234,
      readyRelays: ["wss://a"],
    })

    const res = makeRes()
    await createRoute(makeReq({ method: "POST" }), res)

    expect(res._status).toBe(201)
    expect(res._json).toEqual({
      sessionId: SESSION_ID,
      uri: "nostrconnect://abc?relay=wss%3A%2F%2Fa",
      expiresAt: 1234,
    })

    const cookie = res._headers["Set-Cookie"] as string
    expect(cookie).toContain(`${NIP46_COOKIE_NAME}=${BINDING_SECRET}`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).toContain("Path=/api/nostr-connect")

    // The binding secret must never be exposed to JS.
    expect(JSON.stringify(res._json)).not.toContain(BINDING_SECRET)
  })

  it("passes the caller's previous binding so a retry supersedes it", async () => {
    managerMock.create.mockResolvedValue({
      sessionId: SESSION_ID,
      uri: "nostrconnect://abc",
      bindingSecret: BINDING_SECRET,
      expiresAt: 1,
      readyRelays: ["wss://a"],
    })

    await createRoute(
      makeReq({ method: "POST", cookies: cookies("old-secret") }),
      makeRes(),
    )

    expect(managerMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "https://pos.example",
        previousBindingHash: sha256Hex("old-secret"),
      }),
    )
  })

  it("returns 503 rather than a URI when no relay is listening", async () => {
    managerMock.create.mockRejectedValue(
      new Nip46RelayUnavailableError("all relays failed"),
    )

    const res = makeRes()
    await createRoute(makeReq({ method: "POST" }), res)

    expect(res._status).toBe(503)
    expect((res._json as { reason: string }).reason).toBe("relays_unavailable")
    expect(res._headers["Set-Cookie"]).toBeUndefined()
  })

  it("returns 429 when the concurrent-session caps are hit", async () => {
    managerMock.create.mockRejectedValue(new Nip46CapacityError("too many"))

    const res = makeRes()
    await createRoute(makeReq({ method: "POST" }), res)

    expect(res._status).toBe(429)
  })

  it("rejects non-POST", async () => {
    const res = makeRes()
    await createRoute(makeReq({ method: "GET" }), res)
    expect(res._status).toBe(405)
  })
})

describe("GET /api/nostr-connect/sessions/:id", () => {
  it("reports status to the bound browser without minting an auth cookie", async () => {
    getSessionMock.mockResolvedValue(
      pendingRecord({ status: "approved", pubkey: PUBKEY }),
    )

    const res = makeRes()
    await statusRoute(
      makeReq({ method: "GET", query: { id: SESSION_ID }, cookies: cookies() }),
      res,
    )

    expect(res._status).toBe(200)
    expect(res._json).toMatchObject({ status: "approved", pubkey: PUBKEY })
    // Polling must never authenticate. Only POST .../consume does.
    expect(res._headers["Set-Cookie"]).toBeUndefined()
  })

  it("hides the session from a caller without the binding cookie", async () => {
    getSessionMock.mockResolvedValue(pendingRecord())

    const res = makeRes()
    await statusRoute(makeReq({ method: "GET", query: { id: SESSION_ID } }), res)

    expect(res._status).toBe(404)
    expect(res._json).toEqual({ error: "Session not found or expired" })
  })

  it("hides the session from a caller with the wrong binding cookie", async () => {
    getSessionMock.mockResolvedValue(pendingRecord())

    const res = makeRes()
    await statusRoute(
      makeReq({
        method: "GET",
        query: { id: SESSION_ID },
        cookies: cookies("x".repeat(64)),
      }),
      res,
    )

    expect(res._status).toBe(404)
  })

  it("404s an unknown or malformed session id without touching the store", async () => {
    const res = makeRes()
    await statusRoute(
      makeReq({ method: "GET", query: { id: "not-a-session" }, cookies: cookies() }),
      res,
    )

    expect(res._status).toBe(404)
    expect(getSessionMock).not.toHaveBeenCalled()
  })

  it("surfaces a restarted session as failed", async () => {
    getSessionMock.mockResolvedValue(pendingRecord())
    managerMock.resolveStatus.mockResolvedValue({
      status: "failed",
      error: "server_restarted",
      expiresAt: 1,
    })

    const res = makeRes()
    await statusRoute(
      makeReq({ method: "GET", query: { id: SESSION_ID }, cookies: cookies() }),
      res,
    )

    expect(res._json).toMatchObject({ status: "failed", error: "server_restarted" })
  })
})

describe("DELETE /api/nostr-connect/sessions/:id", () => {
  it("cancels the session and clears the binding cookie", async () => {
    getSessionMock.mockResolvedValue(pendingRecord())

    const res = makeRes()
    await statusRoute(
      makeReq({ method: "DELETE", query: { id: SESSION_ID }, cookies: cookies() }),
      res,
    )

    expect(managerMock.cancel).toHaveBeenCalledWith(SESSION_ID)
    expect(res._status).toBe(200)
    expect(res._headers["Set-Cookie"]).toContain("Max-Age=0")
  })

  it("refuses to cancel someone else's session", async () => {
    getSessionMock.mockResolvedValue(pendingRecord())

    const res = makeRes()
    await statusRoute(makeReq({ method: "DELETE", query: { id: SESSION_ID } }), res)

    expect(res._status).toBe(404)
    expect(managerMock.cancel).not.toHaveBeenCalled()
  })
})

describe("POST /api/nostr-connect/sessions/:id/consume", () => {
  it("mints the session cookie for the bound browser", async () => {
    getSessionMock.mockResolvedValue(
      pendingRecord({ status: "approved", pubkey: PUBKEY }),
    )
    managerMock.consume.mockResolvedValue({ ok: true, pubkey: PUBKEY })

    const res = makeRes()
    await consumeRoute(
      makeReq({ method: "POST", query: { id: SESSION_ID }, cookies: cookies() }),
      res,
    )

    expect(res._status).toBe(200)
    expect(res._json).toEqual({
      success: true,
      user: {
        pubkey: PUBKEY,
        username: `nostr:${PUBKEY}`,
        authMethod: "nostr",
      },
    })

    const setCookie = res._headers["Set-Cookie"] as string[]
    expect(setCookie[0]).toContain("auth-token=signed-jwt")
    expect(setCookie[0]).toContain("HttpOnly")
    // The binding cookie is retired along with the session it protected.
    expect(setCookie[1]).toContain(`${NIP46_COOKIE_NAME}=`)
    expect(setCookie[1]).toContain("Max-Age=0")
  })

  it("passes the presented binding secret through to the atomic consume", async () => {
    getSessionMock.mockResolvedValue(
      pendingRecord({ status: "approved", pubkey: PUBKEY }),
    )
    managerMock.consume.mockResolvedValue({ ok: true, pubkey: PUBKEY })

    await consumeRoute(
      makeReq({ method: "POST", query: { id: SESSION_ID }, cookies: cookies() }),
      makeRes(),
    )

    expect(managerMock.consume).toHaveBeenCalledWith(SESSION_ID, BINDING_SECRET)
  })

  it("returns 409 without a cookie when the approval was already used", async () => {
    getSessionMock.mockResolvedValue(
      pendingRecord({ status: "consumed", pubkey: PUBKEY }),
    )
    managerMock.consume.mockResolvedValue({ ok: false, error: "Session already used" })

    const res = makeRes()
    await consumeRoute(
      makeReq({ method: "POST", query: { id: SESSION_ID }, cookies: cookies() }),
      res,
    )

    expect(res._status).toBe(409)
    expect(res._headers["Set-Cookie"]).toBeUndefined()
  })

  it("refuses a caller without the binding cookie and never reaches consume", async () => {
    getSessionMock.mockResolvedValue(
      pendingRecord({ status: "approved", pubkey: PUBKEY }),
    )

    const res = makeRes()
    await consumeRoute(makeReq({ method: "POST", query: { id: SESSION_ID } }), res)

    expect(res._status).toBe(404)
    expect(managerMock.consume).not.toHaveBeenCalled()
    expect(res._headers["Set-Cookie"]).toBeUndefined()
  })

  it("rejects non-POST", async () => {
    const res = makeRes()
    await consumeRoute(
      makeReq({ method: "GET", query: { id: SESSION_ID }, cookies: cookies() }),
      res,
    )
    expect(res._status).toBe(405)
  })
})

/**
 * A session-store outage must surface as a retryable 503, never as a 404. A 404
 * tells the browser the session is gone and to start over, but the relay worker
 * is still running server-side and the signer may be mid-approval.
 */
describe("session store outage", () => {
  const outage = (): Nip46StorageError => new Nip46StorageError("could not read session")

  it("returns 503 from create", async () => {
    managerMock.create.mockRejectedValue(outage())

    const res = makeRes()
    await createRoute(makeReq({ method: "POST" }), res)

    expect(res._status).toBe(503)
    expect((res._json as { reason: string }).reason).toBe("storage_unavailable")
    expect(res._headers["Set-Cookie"]).toBeUndefined()
  })

  it("returns 503 from the status poll, not 404", async () => {
    getSessionMock.mockRejectedValue(outage())

    const res = makeRes()
    await statusRoute(
      makeReq({ method: "GET", query: { id: SESSION_ID }, cookies: cookies() }),
      res,
    )

    expect(res._status).toBe(503)
    expect((res._json as { reason: string }).reason).toBe("storage_unavailable")
  })

  it("returns 503 from consume and mints no session cookie", async () => {
    getSessionMock.mockResolvedValue(
      pendingRecord({ status: "approved", pubkey: PUBKEY }),
    )
    managerMock.consume.mockRejectedValue(outage())

    const res = makeRes()
    await consumeRoute(
      makeReq({ method: "POST", query: { id: SESSION_ID }, cookies: cookies() }),
      res,
    )

    expect(res._status).toBe(503)
    expect(res._headers["Set-Cookie"]).toBeUndefined()
  })

  it("returns 503 from cancel", async () => {
    getSessionMock.mockRejectedValue(outage())

    const res = makeRes()
    await statusRoute(
      makeReq({ method: "DELETE", query: { id: SESSION_ID }, cookies: cookies() }),
      res,
    )

    expect(res._status).toBe(503)
  })
})
