/**
 * @jest-environment node
 *
 * POST /api/nostr-connect/sessions with Redis configured but unreachable — the COMPLETE wrapped
 * route, rate limiter included.
 *
 * The #75 review named this gap twice: every other test exercises the route with the limiter
 * mocked away, so neither of the two hangs it found was observable. Both lived in the wrapper:
 *
 *   - `withRateLimit` awaited its own Redis connect before the handler ran, so a cold-start
 *     outage stalled the endpoint before any session logic executed;
 *   - the limiter's timed-out attempt was then discarded, so the session store rebuilt a client
 *     and waited the whole deadline a second time — one request, two deadlines.
 *
 * So the limiter here is REAL and Redis is a dead port. The relay transport is the only thing
 * stubbed, because opening real sockets to public relays is not this test's subject.
 */

process.env.ENABLE_HYBRID_STORAGE = "true"
process.env.REDIS_HOST = "127.0.0.1"
// Nothing listens here; every connection is refused.
process.env.REDIS_PORT = "16399"
const DEADLINE_MS = 400
process.env.REDIS_CONNECT_DEADLINE_MS = String(DEADLINE_MS)
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-nip46-outage"

import { __closeSharedRedisForTests } from "../../lib/redis"

// The relay side is stubbed: a transport that reports itself open on one relay, so the route
// reaches session storage — which is what the Redis outage must be observed through.
jest.mock("../../lib/nip46-server/transport", () => ({
  __esModule: true,
  NOSTR_CONNECT_KIND: 24133,
  Nip46TransportError: class extends Error {},
  Nip46Transport: class {
    async open(): Promise<{ relays: string[] }> {
      return { relays: ["wss://relay.example"] }
    }
    async close(): Promise<void> {}
    onAck(): void {}
  },
}))

import handler from "../../pages/api/nostr-connect/sessions/index"

type Res = {
  statusCode: number
  body: unknown
  headers: Record<string, unknown>
  status: (c: number) => Res
  json: (b: unknown) => Res
  setHeader: (k: string, v: unknown) => void
  end: () => Res
}

function makeRes(): Res {
  const res: Res = {
    statusCode: 0,
    body: undefined,
    headers: {},
    status(c: number) {
      res.statusCode = c
      return res
    },
    json(b: unknown) {
      res.body = b
      return res
    },
    setHeader(k: string, v: unknown) {
      res.headers[k] = v
    },
    end() {
      return res
    },
  }
  return res
}

function makeReq(): unknown {
  return {
    method: "POST",
    headers: { "host": "localhost:3000", "x-forwarded-for": "203.0.113.7" },
    socket: { remoteAddress: "203.0.113.7" },
    body: {},
    query: {},
    cookies: {},
  }
}

afterEach(async () => {
  await __closeSharedRedisForTests()
})

describe("POST /api/nostr-connect/sessions during a Redis outage (PR #75 review)", () => {
  it("answers within a single connect deadline instead of hanging at the limiter", async () => {
    const res = makeRes()
    const t0 = Date.now()

    await (handler as unknown as (q: unknown, s: Res) => Promise<void>)(makeReq(), res)
    const elapsed = Date.now() - t0

    // A definite answer: the limiter degraded to in-memory rather than taking the request down,
    // and the store failed closed (503) rather than silently using a different backend.
    expect(res.statusCode).toBeGreaterThan(0)
    expect(res.statusCode).not.toBe(200)

    // ONE deadline for the whole route. Two sequential Redis consumers used to mean two.
    expect(elapsed).toBeLessThan(DEADLINE_MS * 2)
  })
})
