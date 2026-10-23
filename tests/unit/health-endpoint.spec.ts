/**
 * @jest-environment node
 *
 * GET /api/health — the externally visible contract for a write-rejecting Redis.
 *
 * The store-level probe is covered in hybrid-store-health.spec.ts; this pins the
 * part operators and orchestrators actually consume: the response body and the
 * status code. During the staging outage this endpoint answered
 * `{"status":"healthy","checks":{"redis":{"status":"up"}}}` while NIP-46
 * sign-in was completely broken, because the check was a bare PING.
 *
 * The status code matters as much as the body. A Redis that refuses writes is
 * degraded, not down: since PR #76 sign-in falls back to in-process state and
 * the app keeps serving, so this must stay HTTP 200. Returning 503 would make a
 * container orchestrator restart-loop a process that is working.
 */

process.env.ENABLE_HYBRID_STORAGE = "true"
process.env.BLINKPOS_API_KEY = "test-api-key"
process.env.BLINKPOS_BTC_WALLET_ID = "test-wallet-id"
process.env.HEALTH_TOKEN = "test-health-token-0123456789"

const healthCheck = jest.fn()

jest.mock("../../lib/storage/hybrid-store", () => ({
  __esModule: true,
  getHybridStore: async () => ({ healthCheck }),
}))

jest.mock("../../lib/db", () => ({
  __esModule: true,
  getSharedPool: () => ({
    query: async () => ({ rows: [{ ok: 1 }] }),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  }),
}))

jest.mock("../../lib/voucher-store", () => ({
  __esModule: true,
  default: { getStats: async () => ({ total: 0 }) },
}))

jest.mock("../../lib/logger", () => ({
  __esModule: true,
  baseLogger: { child: () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }) },
}))

import handler from "../../pages/api/health"

interface Res {
  statusCode: number
  body: Record<string, unknown>
  status: (c: number) => Res
  json: (b: unknown) => Res
}

function makeRes(): Res {
  const res: Res = {
    statusCode: 0,
    body: {},
    status(c: number) {
      res.statusCode = c
      return res
    },
    json(b: unknown) {
      res.body = b as Record<string, unknown>
      return res
    },
  }
  return res
}

/**
 * The existing contract tests read `checks.*`, which is the detailed view:
 * they present the health token. `callPublic` is what a probe / anyone on the
 * internet gets.
 */
async function callHealth(
  headers: Record<string, string> = {
    "x-health-token": process.env.HEALTH_TOKEN as string,
  },
  query: Record<string, string> = {},
): Promise<Res> {
  const res = makeRes()
  await (handler as unknown as (q: unknown, s: Res) => Promise<void>)(
    { query, method: "GET", headers },
    res,
  )
  return res
}
const callPublic = (query: Record<string, string> = {}) => callHealth({}, query)

function redisCheck(res: Res): Record<string, unknown> {
  return (res.body.checks as Record<string, Record<string, unknown>>).redis
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("GET /api/health Redis reporting", () => {
  it("reports up and healthy when Redis accepts writes", async () => {
    healthCheck.mockResolvedValue({
      redis: true,
      redisWritable: true,
      postgres: true,
      overall: true,
    })

    const res = await callHealth()

    expect(res.statusCode).toBe(200)
    expect(res.body.status).toBe("healthy")
    expect(redisCheck(res)).toMatchObject({ status: "up", writable: true })
  })

  it("reports degraded — not up — when a reachable Redis refuses writes", async () => {
    // The staging condition: PING succeeded, every write refused.
    healthCheck.mockResolvedValue({
      redis: true,
      redisWritable: false,
      redisError: "OOM command not allowed when used memory > 'maxmemory'.",
      postgres: true,
      overall: true,
    })

    const res = await callHealth()

    // The regression this closes: the old check called this "healthy"/"up".
    expect(res.body.status).toBe("degraded")
    expect(redisCheck(res)).toMatchObject({ status: "degraded", writable: false })
    // And the cause is named, so nobody has to reverse-engineer it again.
    expect(String(redisCheck(res).error)).toContain("OOM")
  })

  it("keeps degraded on HTTP 200 so orchestrators do not restart-loop it", async () => {
    healthCheck.mockResolvedValue({
      redis: true,
      redisWritable: false,
      redisError: "READONLY You can't write against a read only replica.",
      postgres: true,
      overall: true,
    })

    const res = await callHealth()

    expect(res.statusCode).toBe(200)
    expect(res.body.status).toBe("degraded")
  })

  it("still reports down when Redis is unreachable entirely", async () => {
    healthCheck.mockResolvedValue({
      redis: false,
      redisWritable: false,
      postgres: true,
      overall: true,
    })

    const res = await callHealth()

    expect(res.statusCode).toBe(200)
    expect(res.body.status).toBe("degraded")
    expect(redisCheck(res)).toMatchObject({ status: "down", writable: false })
  })

  it("is unhealthy (503) when PostgreSQL is down, whatever Redis says", async () => {
    healthCheck.mockResolvedValue({
      redis: true,
      redisWritable: true,
      postgres: false,
      overall: false,
    })

    const res = await callHealth()

    expect(res.statusCode).toBe(503)
    expect(res.body.status).toBe("unhealthy")
  })

  // blink-wip#1690 item 3: /api/health is public. Probes need the status
  // code and nothing else; dependency detail (driver error strings, uptime,
  // version, credential presence, pool/voucher stats) is for operators with
  // the token.
  describe("public vs detailed view", () => {
    const degradedRedis = () =>
      healthCheck.mockResolvedValue({
        redis: true,
        redisWritable: false,
        redisError: "READONLY You can't write against a read only replica.",
        postgres: true,
      })

    it("without the token answers only status + timestamp, same status code", async () => {
      degradedRedis()
      const res = await callPublic()
      expect(res.statusCode).toBe(200)
      expect(Object.keys(res.body).sort()).toEqual(["status", "timestamp"])
      expect(res.body.status).toBe("degraded")
      expect(JSON.stringify(res.body)).not.toContain("read only replica")
    })

    it("ignores ?verbose=true without the token", async () => {
      degradedRedis()
      const res = await callPublic({ verbose: "true" })
      expect(Object.keys(res.body).sort()).toEqual(["status", "timestamp"])
    })

    it("rejects a wrong token (public view)", async () => {
      degradedRedis()
      const res = await callHealth({ "x-health-token": "nope" })
      expect(Object.keys(res.body).sort()).toEqual(["status", "timestamp"])
    })

    it("with the token returns the full detail, and ?verbose adds stats", async () => {
      degradedRedis()
      const res = await callHealth(
        { "x-health-token": process.env.HEALTH_TOKEN as string },
        { verbose: "true" },
      )
      expect(res.body).toMatchObject({
        status: "degraded",
        uptime: expect.any(Number),
        version: expect.any(String),
        checks: {
          redis: { status: "degraded", error: expect.stringContaining("read only") },
          sharedPool: { pool: { total: 1, idle: 1, waiting: 0 } },
          vouchers: { stats: { total: 0 } },
          blinkConfig: { apiKey: "set", walletId: "set" },
        },
      })
    })

    it("unhealthy keeps the 503 for the public view", async () => {
      healthCheck.mockResolvedValue({ redis: true, redisWritable: true, postgres: false })
      const res = await callPublic()
      expect(res.statusCode).toBe(503)
      expect(res.body).toEqual({ status: "unhealthy", timestamp: expect.any(String) })
    })

    it("with HEALTH_TOKEN unset, no header can unlock the detail", async () => {
      const saved = process.env.HEALTH_TOKEN
      delete process.env.HEALTH_TOKEN
      try {
        degradedRedis()
        const res = await callHealth({ "x-health-token": "" })
        expect(Object.keys(res.body).sort()).toEqual(["status", "timestamp"])
      } finally {
        process.env.HEALTH_TOKEN = saved
      }
    })
  })
})
