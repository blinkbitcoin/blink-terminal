/**
 * @jest-environment node
 *
 * The rate limiter must degrade to in-memory, not hang, when Redis is down (PR #73/#74 review:
 * withRateLimit awaited its own default client.connect() before the handler ran, so a cold-start
 * outage stalled the wrapped endpoint before it ever reached the handler).
 *
 * This drives the REAL rate limiter against the shared client, with lib/redis's initial connect
 * forced to fail fast, and asserts the wrapped handler still runs.
 */

process.env.ENABLE_HYBRID_STORAGE = "true"
process.env.REDIS_CONNECT_DEADLINE_MS = "200"

// Force the shared client's initial connect to fail fast.
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  getSharedRedisClient: jest.fn(async () => {
    throw new Error("Redis is configured but unreachable")
  }),
  sharedRedisReady: jest.fn(() => false),
  __closeSharedRedisForTests: jest.fn(async () => undefined),
}))

import { withRateLimit, RATE_LIMIT_AUTH } from "../../lib/rate-limit"

interface FakeReq {
  method: string
  headers: Record<string, string>
}
interface FakeRes {
  statusCode: number
  body: unknown
  status: (code: number) => FakeRes
  json: (body: unknown) => FakeRes
  setHeader: (k: string, v: string) => void
}

const makeReq = (): FakeReq => ({
  method: "POST",
  headers: { "x-forwarded-for": "1.2.3.4" },
})
const makeRes = (): FakeRes => {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
    setHeader: () => undefined,
  }
  return res
}

describe("withRateLimit degrades when Redis is down (PR #73/#74 review)", () => {
  it("runs the handler instead of hanging on the limiter's Redis connect", async () => {
    let handled = false
    const handler = withRateLimit(
      (async (_req: unknown, res: FakeRes) => {
        handled = true
        res.status(201).json({ ok: true })
      }) as never,
      RATE_LIMIT_AUTH,
      "test-route",
    )

    const t0 = Date.now()
    await handler(makeReq() as never, makeRes() as never)

    expect(handled).toBe(true)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})
