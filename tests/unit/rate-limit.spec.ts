/**
 * Unit Tests for lib/rate-limit.ts
 *
 * Tests the withRateLimit HOF, tier presets, IP extraction,
 * and sliding-window behaviour.
 */

import type { Socket } from "net"

import type { NextApiRequest, NextApiResponse } from "next"

import {
  withRateLimit,
  RATE_LIMIT_AUTH,
  RATE_LIMIT_PUBLIC,
  RATE_LIMIT_WRITE,
  RATE_LIMIT_READ,
} from "../../lib/rate-limit"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    headers: {},
    socket: { remoteAddress: "127.0.0.1" } as Socket,
    ...overrides,
  } as unknown as NextApiRequest
}

function mockRes(): NextApiResponse & {
  _status: number | null
  _json: unknown
} {
  const res = {
    _status: null as number | null,
    _json: null as unknown,
    status(code: number) {
      res._status = code
      return res
    },
    json(body: unknown) {
      res._json = body
      return res
    },
  }
  return res as unknown as NextApiResponse & {
    _status: number | null
    _json: unknown
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lib/rate-limit", () => {
  describe("tier presets", () => {
    it("should define AUTH tier with max 10", () => {
      expect(RATE_LIMIT_AUTH).toEqual({ max: 10 })
    })

    it("should define PUBLIC tier with max 30", () => {
      expect(RATE_LIMIT_PUBLIC).toEqual({ max: 30 })
    })

    it("should define WRITE tier with max 30", () => {
      expect(RATE_LIMIT_WRITE).toEqual({ max: 30 })
    })

    it("should define READ tier with max 120", () => {
      expect(RATE_LIMIT_READ).toEqual({ max: 120 })
    })
  })

  describe("withRateLimit()", () => {
    it("should call through to the handler when under limit", async () => {
      const inner = jest.fn((_req, res) => res.status(200).json({ ok: true }))
      const handler = withRateLimit(inner, { max: 5 }, "test-route")

      const req = mockReq()
      const res = mockRes()
      await handler(req, res)

      expect(inner).toHaveBeenCalledWith(req, res)
      expect(res._status).toBe(200)
    })

    it("should return 429 after exceeding max requests", async () => {
      const inner = jest.fn((_req, res) => res.status(200).json({ ok: true }))
      const handler = withRateLimit(inner, { max: 3 }, "test-route")

      const req = mockReq()

      // First 3 requests should pass
      for (let i = 0; i < 3; i++) {
        const res = mockRes()
        await handler(req, res)
        expect(res._status).toBe(200)
      }

      // 4th request should be rate-limited
      const res = mockRes()
      await handler(req, res)
      expect(res._status).toBe(429)
      expect(res._json).toEqual({
        error: "Too many requests. Please wait a moment and try again.",
      })
      expect(inner).toHaveBeenCalledTimes(3)
    })

    it("should track limits per IP independently", async () => {
      const inner = jest.fn((_req, res) => res.status(200).json({ ok: true }))
      const handler = withRateLimit(inner, { max: 2 }, "test-route")

      // IP A: 2 requests
      const reqA = mockReq({
        headers: { "x-forwarded-for": "1.1.1.1" },
      } as Partial<NextApiRequest>)
      for (let i = 0; i < 2; i++) {
        const res = mockRes()
        await handler(reqA, res)
        expect(res._status).toBe(200)
      }

      // IP A: 3rd request → 429
      const resA3 = mockRes()
      await handler(reqA, resA3)
      expect(resA3._status).toBe(429)

      // IP B: should still be allowed
      const reqB = mockReq({
        headers: { "x-forwarded-for": "2.2.2.2" },
      } as Partial<NextApiRequest>)
      const resB = mockRes()
      await handler(reqB, resB)
      expect(resB._status).toBe(200)
    })

    it("should extract IP from x-forwarded-for header (first value)", async () => {
      const inner = jest.fn((_req, res) => res.status(200).json({ ok: true }))
      const handler = withRateLimit(inner, { max: 1 }, "test-route")

      const req = mockReq({
        headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2, 10.0.0.3" },
      } as Partial<NextApiRequest>)

      const res1 = mockRes()
      await handler(req, res1)
      expect(res1._status).toBe(200)

      // Should be limited now for 10.0.0.1
      const res2 = mockRes()
      await handler(req, res2)
      expect(res2._status).toBe(429)
    })

    it("should extract IP from x-real-ip header", async () => {
      const inner = jest.fn((_req, res) => res.status(200).json({ ok: true }))
      const handler = withRateLimit(inner, { max: 1 }, "test-route")

      const req = mockReq({
        headers: { "x-real-ip": "192.168.1.1" },
      } as Partial<NextApiRequest>)

      const res1 = mockRes()
      await handler(req, res1)
      expect(res1._status).toBe(200)

      const res2 = mockRes()
      await handler(req, res2)
      expect(res2._status).toBe(429)
    })

    it("should fall back to socket.remoteAddress when no headers", async () => {
      const inner = jest.fn((_req, res) => res.status(200).json({ ok: true }))
      const handler = withRateLimit(inner, { max: 1 }, "test-route")

      const req = mockReq({
        headers: {},
        socket: { remoteAddress: "::1" } as Socket,
      })

      const res1 = mockRes()
      await handler(req, res1)
      expect(res1._status).toBe(200)

      const res2 = mockRes()
      await handler(req, res2)
      expect(res2._status).toBe(429)
    })

    it("should reset the window after the windowMs elapses", async () => {
      jest.useFakeTimers()

      const inner = jest.fn((_req, res) => res.status(200).json({ ok: true }))
      const handler = withRateLimit(inner, { max: 1, windowMs: 1000 }, "test-route")

      const req = mockReq()

      // First request passes
      const res1 = mockRes()
      await handler(req, res1)
      expect(res1._status).toBe(200)

      // Second request blocked
      const res2 = mockRes()
      await handler(req, res2)
      expect(res2._status).toBe(429)

      // Advance time past the window
      jest.advanceTimersByTime(1100)

      // Should be allowed again
      const res3 = mockRes()
      await handler(req, res3)
      expect(res3._status).toBe(200)

      jest.useRealTimers()
    })

    it("should use 'unknown' IP when no IP source available", async () => {
      const inner = jest.fn((_req, res) => res.status(200).json({ ok: true }))
      const handler = withRateLimit(inner, { max: 1 }, "test-route")

      const req = mockReq({
        headers: {},
        socket: {} as Socket,
      })

      const res1 = mockRes()
      await handler(req, res1)
      expect(res1._status).toBe(200)
    })
  })
})
