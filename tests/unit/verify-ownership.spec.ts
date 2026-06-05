/**
 * Security tests for POST /api/auth/verify-ownership (external-signer login).
 *
 * Pre-hardening risk: the endpoint verified that *a* challenge was signed but
 * minted a session for whatever pubkey signed it, with the challenge not bound
 * to that pubkey. Post-hardening invariants verified here:
 *
 *   - the verified signer pubkey is passed to verifyChallenge (binding)
 *   - a failed/mismatched challenge binding yields 401 and NO session
 *   - only kind 22242 is accepted (no 27235 fallback)
 *   - a valid flow mints a session for nostr:<pubkey>
 *
 * Schnorr signature verification is mocked at the @noble/curves boundary so the
 * test exercises the authorization logic, not the curve math. The event id IS
 * computed for real, so id-tampering is still covered.
 */

import crypto from "crypto"

import type { NextApiRequest, NextApiResponse } from "next"

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (h: unknown) => h,
  RATE_LIMIT_AUTH: { max: 10 },
}))

// Mock the Schnorr verify so we control signature validity deterministically.
let schnorrValid = true
jest.mock("@noble/curves/secp256k1", () => ({
  schnorr: {
    verify: () => schnorrValid,
  },
}))

const mockVerifyChallenge = jest.fn()
jest.mock("../../lib/auth/challengeStore", () => ({
  verifyChallenge: (...a: unknown[]) => mockVerifyChallenge(...a),
}))

const mockGenerateSession = jest.fn((..._a: unknown[]) => "session-jwt")
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: {
    generateSession: (...a: unknown[]) => mockGenerateSession(...a),
  },
}))

import handler from "../../pages/api/auth/verify-ownership"

function realEventId(ev: {
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}): string {
  const serialized = JSON.stringify([
    0,
    ev.pubkey,
    ev.created_at,
    ev.kind,
    ev.tags,
    ev.content,
  ])
  return crypto.createHash("sha256").update(serialized).digest("hex")
}

const PUBKEY = "a".repeat(64)
const SIG = "f".repeat(128)
const CHALLENGE = "blinkpos:1700000000:deadbeef"

function buildSignedEvent(
  overrides: Partial<{
    pubkey: string
    kind: number
    content: string
    created_at: number
    tags: string[][]
    sig: string
    id: string
  }> = {},
) {
  const base = {
    pubkey: overrides.pubkey ?? PUBKEY,
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    kind: overrides.kind ?? 22242,
    tags: overrides.tags ?? [["challenge", CHALLENGE]],
    content: overrides.content ?? CHALLENGE,
  }
  const id = overrides.id ?? realEventId(base)
  return { ...base, id, sig: overrides.sig ?? SIG }
}

function mockReqRes(body: unknown) {
  const req = { method: "POST", body, headers: {}, cookies: {} } as NextApiRequest
  const headers: Record<string, string> = {}
  const res = {
    _status: 200,
    _json: null as any,
    setHeader(k: string, v: string) {
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
      getHeader: (k: string) => string | undefined
    },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  schnorrValid = true
  mockVerifyChallenge.mockResolvedValue({ valid: true })
})

describe("verify-ownership security", () => {
  it("passes the verified signer pubkey to verifyChallenge (binding)", async () => {
    const { req, res } = mockReqRes({ signedEvent: buildSignedEvent() })
    await handler(req, res)
    expect(res._status).toBe(200)
    expect(mockVerifyChallenge).toHaveBeenCalledWith(CHALLENGE, PUBKEY)
    expect(mockGenerateSession).toHaveBeenCalledWith(`nostr:${PUBKEY}`)
    expect(res.getHeader("Set-Cookie")).toContain("auth-token=")
  })

  it("SECURITY: 401 and no session when challenge binding fails", async () => {
    mockVerifyChallenge.mockResolvedValue({
      valid: false,
      error: "Challenge bound to a different pubkey",
    })
    const { req, res } = mockReqRes({ signedEvent: buildSignedEvent() })
    await handler(req, res)
    expect(res._status).toBe(401)
    expect(mockGenerateSession).not.toHaveBeenCalled()
    expect(res.getHeader("Set-Cookie")).toBeUndefined()
  })

  it("SECURITY: rejects an invalid signature (401, no challenge consumed)", async () => {
    schnorrValid = false
    const { req, res } = mockReqRes({ signedEvent: buildSignedEvent() })
    await handler(req, res)
    expect(res._status).toBe(401)
    expect(mockVerifyChallenge).not.toHaveBeenCalled()
    expect(mockGenerateSession).not.toHaveBeenCalled()
  })

  it("SECURITY: rejects a tampered event id before signature check", async () => {
    const ev = buildSignedEvent({ id: "0".repeat(64) })
    const { req, res } = mockReqRes({ signedEvent: ev })
    await handler(req, res)
    expect(res._status).toBe(400)
    expect(mockVerifyChallenge).not.toHaveBeenCalled()
  })

  it("rejects kind 27235 (no NIP-98 fallback on this endpoint)", async () => {
    const ev = buildSignedEvent({ kind: 27235 })
    const { req, res } = mockReqRes({ signedEvent: ev })
    await handler(req, res)
    expect(res._status).toBe(400)
    expect(res._json.details).toMatch(/22242/)
    expect(mockVerifyChallenge).not.toHaveBeenCalled()
  })

  it("rejects a challenge not prefixed with blinkpos:", async () => {
    const ev = buildSignedEvent({
      content: "evil:challenge",
      tags: [["challenge", "evil:challenge"]],
    })
    const { req, res } = mockReqRes({ signedEvent: ev })
    await handler(req, res)
    expect(res._status).toBe(400)
    expect(mockVerifyChallenge).not.toHaveBeenCalled()
  })

  it("returns 400 when signedEvent is missing", async () => {
    const { req, res } = mockReqRes({})
    await handler(req, res)
    expect(res._status).toBe(400)
  })
})
