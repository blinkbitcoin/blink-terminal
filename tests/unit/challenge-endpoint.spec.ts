/**
 * Tests for GET /api/auth/challenge.
 *
 * Verifies the endpoint issues a challenge AND hands the requesting browser an
 * HttpOnly redemption-secret cookie, storing only the secret's hash. This is
 * the issue half of the anti-bearer binding redeemed in verify-ownership.
 */

import type { NextApiRequest, NextApiResponse } from "next"

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (h: unknown) => h,
  RATE_LIMIT_AUTH: { max: 10 },
}))

const mockStoreChallenge = jest.fn()
jest.mock("../../lib/auth/challengeStore", () => ({
  generateChallenge: () => "blinkpos:1700000000:abc",
  generateChallengeSecret: () => "S".repeat(64),
  storeChallenge: (...a: unknown[]) => mockStoreChallenge(...a),
}))

import { CHALLENGE_COOKIE_NAME } from "../../lib/auth/cookies"
import handler from "../../pages/api/auth/challenge"

function mockReqRes() {
  const req = { method: "GET", headers: { host: "localhost:3000" } } as NextApiRequest
  const headers: Record<string, string | string[]> = {}
  const res = {
    _status: 200,
    _json: null as any,
    setHeader(k: string, v: string | string[]) {
      headers[k.toLowerCase()] = v
    },
    getHeader(k: string) {
      return headers[k.toLowerCase()]
    },
    status(code: number) {
      this._status = code
      return this
    },
    json(payload: unknown) {
      this._json = payload
      return this
    },
  }
  return {
    req,
    res: res as unknown as NextApiResponse & {
      _status: number
      _json: any
      getHeader: (k: string) => string | string[] | undefined
    },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("GET /api/auth/challenge", () => {
  it("returns a challenge and sets the HttpOnly challenge-secret cookie", async () => {
    const { req, res } = mockReqRes()
    await handler(req, res)

    expect(res._status).toBe(200)
    expect(res._json.challenge).toBe("blinkpos:1700000000:abc")

    const setCookie = res.getHeader("Set-Cookie")
    const cookie = Array.isArray(setCookie) ? setCookie.join("\n") : String(setCookie)
    expect(cookie).toContain(`${CHALLENGE_COOKIE_NAME}=`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
  })

  it("stores the challenge bound to the generated secret (hash only, in the store)", async () => {
    const { req, res } = mockReqRes()
    await handler(req, res)

    // storeChallenge(challenge, ttl, secret) — the raw secret is passed so the
    // store persists sha256(secret); the secret itself only leaves via the cookie.
    expect(mockStoreChallenge).toHaveBeenCalledWith(
      "blinkpos:1700000000:abc",
      300,
      "S".repeat(64),
    )
  })

  it("rejects non-GET methods", async () => {
    const { req, res } = mockReqRes()
    ;(req as { method: string }).method = "POST"
    await handler(req, res)
    expect(res._status).toBe(405)
  })
})
