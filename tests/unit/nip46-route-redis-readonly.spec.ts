/**
 * @jest-environment node
 *
 * POST /api/nostr-connect/sessions against a Redis that is REACHABLE but REJECTS WRITES.
 *
 * This is the staging regression, reproduced at the route level. The connection is fine and
 * reads succeed — so every connectivity-oriented guard (the bounded initial connect of #75, the
 * unreachable-degrade of #71) sees a perfectly healthy Redis and does nothing. Only the initial
 * SET fails, which the store turned into Nip46StorageError and the route into a 503:
 *
 *     {"error":"Sign-in is temporarily unavailable. Please try again.",
 *      "reason":"storage_unavailable"}
 *
 * Sign-in was then 100% broken while /api/health still reported `redis: up`, because the health
 * probe only reads. Reproduced locally with `redis-cli CONFIG SET maxmemory 1` +
 * `maxmemory-policy noeviction`; the same class covers a MISCONF "can't persist to disk" Redis,
 * a readonly replica, and an ACL that denies SET.
 *
 * Creation is PRE-COMMIT — no backend is chosen until a write lands — so the correct behaviour is
 * to degrade this session to the in-process Map and keep sign-in up, exactly as for an
 * unreachable Redis. The limiter is REAL here (as in the outage spec) so the whole wrapped route
 * is exercised; only the relay transport is stubbed.
 */

process.env.ENABLE_HYBRID_STORAGE = "true"
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-nip46-readonly"

const OOM = new Error("OOM command not allowed when used memory > 'maxmemory'.")

/**
 * A connected client whose writes are refused. `get` resolves normally, which is what makes this
 * distinct from an outage: nothing about the connection looks wrong.
 */
const redisCommands = {
  set: jest.fn(async () => {
    throw OOM
  }),
  incr: jest.fn(async () => {
    throw OOM
  }),
  expire: jest.fn(async () => {
    throw OOM
  }),
  get: jest.fn(async () => null),
  del: jest.fn(async () => 0),
  eval: jest.fn(async () => {
    throw OOM
  }),
  connect: jest.fn(async () => undefined),
  disconnect: jest.fn(() => undefined),
  quit: jest.fn(async () => undefined),
  isOpen: true,
  on: jest.fn((event: string, handler: () => void) => {
    // Report readiness immediately: the connection is healthy, the commands are not.
    if (event === "ready" || event === "connect") handler()
  }),
}

jest.mock("redis", () => ({
  createClient: jest.fn(() => redisCommands),
}))

// The relay side is stubbed so the route reaches session storage, which is the subject here.
jest.mock("../../lib/nip46-server/transport", () => ({
  __esModule: true,
  NOSTR_CONNECT_KIND: 24133,
  Nip46TransportError: class extends Error {},
  Nip46Transport: class {
    readonly clientPubkey = "b".repeat(64)
    readonly readyRelays = ["wss://relay.example"]
    async open(): Promise<{ relays: string[] }> {
      return { relays: ["wss://relay.example"] }
    }
    readonly pinnedSignerPubkey = undefined
    close(): void {}
    async request(): Promise<never> {
      await new Promise(() => {})
      throw new Error("unreachable")
    }
    async waitForConnectAck(): Promise<void> {
      // Never resolves: the signer has not approved yet, so the browser is still
      // polling when the assertions run. The worker must not be what ends the test.
      await new Promise(() => {})
    }
  },
}))

import { __resetSessionStoreForTests } from "../../lib/nip46-server/sessionStore"
import { __closeSharedRedisForTests } from "../../lib/redis"
import handler from "../../pages/api/nostr-connect/sessions/index"

interface Res {
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

function makeReq(ip = "203.0.113.9"): unknown {
  return {
    method: "POST",
    headers: { "host": "localhost:3000", "x-forwarded-for": ip },
    socket: { remoteAddress: ip },
    body: {},
    query: {},
    cookies: {},
  }
}

afterEach(async () => {
  __resetSessionStoreForTests()
  await __closeSharedRedisForTests()
  jest.clearAllMocks()
})

describe("POST /api/nostr-connect/sessions against a write-rejecting Redis", () => {
  it("starts the sign-in instead of 503-ing (staging regression)", async () => {
    const res = makeRes()

    await (handler as unknown as (q: unknown, s: Res) => Promise<void>)(makeReq(), res)

    // The regression: this was 503 / storage_unavailable, so sign-in could never start.
    expect(res.statusCode).toBe(201)
    expect(res.body).toMatchObject({
      sessionId: expect.any(String),
      uri: expect.stringContaining("nostrconnect://"),
    })

    // The write was genuinely attempted and genuinely refused — the degrade is real, not a
    // side effect of Redis being skipped.
    expect(redisCommands.set).toHaveBeenCalled()
  })

  it("still binds the session to the browser with the HttpOnly cookie", async () => {
    const res = makeRes()

    await (handler as unknown as (q: unknown, s: Res) => Promise<void>)(makeReq(), res)

    // Degrading the BACKEND must not degrade the SECURITY: the session id alone is still not a
    // login capability, because every later read/consume requires this cookie.
    const cookie = String(res.headers["Set-Cookie"] ?? "")
    expect(cookie).toContain("blinkpos-nip46=")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
  })
})
