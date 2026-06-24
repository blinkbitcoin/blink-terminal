/**
 * Tests for POST /api/blink/resolve-receiver
 *
 * Validates the username-resolution endpoint used by the validation gates:
 *   - custodial receiver  => 200 { exists, type: "custodial" }
 *   - lnaddress receiver  => 200 { exists, type: "lnaddress" }
 *   - not found           => 404 { exists: false }
 *   - resolve failure     => 502
 */

import type { NextApiRequest, NextApiResponse } from "next"

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (h: unknown) => h,
  RATE_LIMIT_PUBLIC: { max: 30 },
}))

jest.mock("../../lib/config/api", () => ({
  getApiUrlForEnvironment: () => "https://api.blink.test/graphql",
}))

const mockResolveReceiver = jest.fn()
jest.mock("../../lib/receiver-resolver", () => {
  class ReceiverNotFoundError extends Error {
    constructor(identifier: string) {
      super(`'${identifier}' is not a Blink address that exists.`)
      this.name = "ReceiverNotFoundError"
    }
  }
  return {
    resolveReceiver: (...a: unknown[]) => mockResolveReceiver(...a),
    ReceiverNotFoundError,
  }
})

import handler from "../../pages/api/blink/resolve-receiver"

const { ReceiverNotFoundError } = jest.requireMock<{
  ReceiverNotFoundError: new (id: string) => Error
}>("../../lib/receiver-resolver")

function mockReqRes(body: unknown, method = "POST") {
  const req = { method, body, headers: {}, socket: {} } as NextApiRequest
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
  return {
    req,
    res: res as unknown as NextApiResponse & { _status: number; _json: any },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("resolve-receiver", () => {
  it("rejects non-POST", async () => {
    const { req, res } = mockReqRes({}, "GET")
    await handler(req, res)
    expect(res._status).toBe(405)
  })

  it("requires a username", async () => {
    const { req, res } = mockReqRes({})
    await handler(req, res)
    expect(res._status).toBe(400)
  })

  it("returns custodial type for a custodial receiver", async () => {
    mockResolveReceiver.mockResolvedValue({
      type: "custodial",
      username: "alice",
      walletId: "w1",
      walletCurrency: "BTC",
    })
    const { req, res } = mockReqRes({ username: "alice" })
    await handler(req, res)
    expect(res._status).toBe(200)
    expect(res._json).toMatchObject({
      exists: true,
      type: "custodial",
      username: "alice",
      walletCurrency: "BTC",
    })
  })

  it("returns lnaddress type for a self-custodial receiver", async () => {
    mockResolveReceiver.mockResolvedValue({
      type: "lnaddress",
      username: "yasar",
      lightningAddress: "yasar@blink.sv",
      domain: "blink.sv",
      isBlinkDomain: true,
      metadata: {},
    })
    const { req, res } = mockReqRes({ username: "yasar" })
    await handler(req, res)
    expect(res._status).toBe(200)
    expect(res._json).toMatchObject({
      exists: true,
      type: "lnaddress",
      username: "yasar",
      lightningAddress: "yasar@blink.sv",
      walletCurrency: "BTC",
    })
  })

  it("returns 404 when not found", async () => {
    mockResolveReceiver.mockRejectedValue(new ReceiverNotFoundError("ghost"))
    const { req, res } = mockReqRes({ username: "ghost" })
    await handler(req, res)
    expect(res._status).toBe(404)
    expect(res._json.exists).toBe(false)
  })

  it("returns 502 on unexpected resolve failure", async () => {
    mockResolveReceiver.mockRejectedValue(new Error("network down"))
    const { req, res } = mockReqRes({ username: "alice" })
    await handler(req, res)
    expect(res._status).toBe(502)
  })
})
