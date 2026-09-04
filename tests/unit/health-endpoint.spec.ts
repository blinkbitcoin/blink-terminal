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
  baseLogger: { child: () => ({ error: jest.fn(), info: jest.fn() }) },
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

async function callHealth(): Promise<Res> {
  const res = makeRes()
  await (handler as unknown as (q: unknown, s: Res) => Promise<void>)(
    { query: {}, method: "GET" },
    res,
  )
  return res
}

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
})
