/**
 * Security tests for GET /api/auth/migration-status.
 *
 * Pre-hardening risk: unauthenticated. Anyone could query any pubkey and learn
 * the linked legacy Blink username and whether a stored (write-scope) API key
 * existed — an enumeration / target-recon oracle and a PII leak.
 *
 * Post-hardening invariants verified here:
 *   - requires a valid Nostr session (401 otherwise)
 *   - only answers for the caller's OWN pubkey (403 on cross-pubkey query)
 *   - self query returns the migration status
 */

import type { NextApiRequest, NextApiResponse } from "next"

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (h: unknown) => h,
  RATE_LIMIT_AUTH: { max: 10 },
}))

const mockVerifySession = jest.fn()
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: {
    verifySession: (...a: unknown[]) => mockVerifySession(...a),
  },
}))

const mockLoadUserData = jest.fn()
jest.mock("../../lib/storage", () => ({
  __esModule: true,
  default: {
    loadUserData: (...a: unknown[]) => mockLoadUserData(...a),
  },
}))

import handler from "../../pages/api/auth/migration-status"

const PUBKEY = "a".repeat(64)
const OTHER_PUBKEY = "b".repeat(64)

function mockReqRes(query: Record<string, string>, cookies: Record<string, string> = {}) {
  const req = { method: "GET", query, cookies, headers: {} } as unknown as NextApiRequest
  const res = {
    _status: 200,
    _json: null as any,
    status(code: number) {
      this._status = code
      return this
    },
    json(payload: unknown) {
      this._json = payload
      return this
    },
  }
  return { req, res: res as unknown as NextApiResponse & { _status: number; _json: any } }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("migration-status security", () => {
  it("SECURITY: 401 when there is no session", async () => {
    mockVerifySession.mockReturnValue(null)
    const { req, res } = mockReqRes({ publicKey: PUBKEY })
    await handler(req, res)
    expect(res._status).toBe(401)
    expect(mockLoadUserData).not.toHaveBeenCalled()
  })

  it("SECURITY: 401 for a non-Nostr (legacy) session", async () => {
    mockVerifySession.mockReturnValue({ username: "alice" })
    const { req, res } = mockReqRes({ publicKey: PUBKEY }, { "auth-token": "t" })
    await handler(req, res)
    expect(res._status).toBe(401)
    expect(mockLoadUserData).not.toHaveBeenCalled()
  })

  it("SECURITY: 403 when querying a different pubkey than the session", async () => {
    mockVerifySession.mockReturnValue({ username: `nostr:${PUBKEY}` })
    const { req, res } = mockReqRes({ publicKey: OTHER_PUBKEY }, { "auth-token": "t" })
    await handler(req, res)
    expect(res._status).toBe(403)
    expect(mockLoadUserData).not.toHaveBeenCalled()
  })

  it("returns migrated:false for self when no link exists", async () => {
    mockVerifySession.mockReturnValue({ username: `nostr:${PUBKEY}` })
    mockLoadUserData.mockResolvedValue(null)
    const { req, res } = mockReqRes({ publicKey: PUBKEY }, { "auth-token": "t" })
    await handler(req, res)
    expect(res._status).toBe(200)
    expect(res._json.migrated).toBe(false)
  })

  it("returns migration details for self when link exists", async () => {
    mockVerifySession.mockReturnValue({ username: `nostr:${PUBKEY}` })
    mockLoadUserData
      .mockResolvedValueOnce({ legacyUsername: "alice", linkedAt: 123 }) // nostr_<pk>
      .mockResolvedValueOnce({ migratedToNostr: true, apiKey: "k" }) // legacy user
    const { req, res } = mockReqRes({ publicKey: PUBKEY }, { "auth-token": "t" })
    await handler(req, res)
    expect(res._status).toBe(200)
    expect(res._json.migrated).toBe(true)
    expect(res._json.legacyUsername).toBe("alice")
    expect(res._json.hasApiKey).toBe(true)
  })

  it("is case-insensitive on the pubkey self-match", async () => {
    mockVerifySession.mockReturnValue({ username: `nostr:${PUBKEY}` })
    mockLoadUserData.mockResolvedValue(null)
    const { req, res } = mockReqRes(
      { publicKey: PUBKEY.toUpperCase() },
      { "auth-token": "t" },
    )
    await handler(req, res)
    expect(res._status).toBe(200)
  })
})
