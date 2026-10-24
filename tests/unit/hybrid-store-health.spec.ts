/**
 * @jest-environment node
 *
 * HybridStore.healthCheck() must probe Redis with a WRITE, not just a PING.
 *
 * This is the observability half of the staging NIP-46 outage. The Redis
 * instance was reachable and readable but refusing every write (the
 * OOM / MISCONF-cannot-persist / READONLY-replica class). PING succeeded, so
 * /api/health reported `redis: up` for hours while sign-in was completely
 * broken — the one signal that would have named the fault was the one not
 * being collected.
 *
 * The store is exercised directly with injected fakes: its constructor takes no
 * arguments and only reads env, so there is no need to mock the `redis` or `pg`
 * modules to drive healthCheck.
 */

// hybrid-store transitively imports lib/auth, which throws at module load without
// this. `import` is hoisted above plain assignments, so the module is pulled in with
// require() after the env is set — the same approach as tests/unit/shutdown.spec.ts.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-hybrid-health"

const { HybridStore } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../lib/storage/hybrid-store") as typeof import("../../lib/storage/hybrid-store")

const OOM = new Error("OOM command not allowed when used memory > 'maxmemory'.")

interface Internals {
  redis: unknown
  pg: unknown
  isRedisConnected: boolean
  isPostgresConnected: boolean
}

function makeStore(options: {
  ping?: () => Promise<unknown>
  set?: () => Promise<unknown>
  redisConnected?: boolean
  postgresConnected?: boolean
}) {
  const store = new HybridStore()
  const internals = store as unknown as Internals

  internals.isRedisConnected = options.redisConnected ?? true
  internals.redis = {
    ping: options.ping ?? (async () => "PONG"),
    set: options.set ?? (async () => "OK"),
  }

  internals.isPostgresConnected = options.postgresConnected ?? true
  internals.pg = { query: async () => ({ rows: [{ "?column?": 1 }] }) }

  return store
}

describe("HybridStore.healthCheck Redis write probe", () => {
  it("reports writable when Redis accepts the probe", async () => {
    const store = makeStore({})

    const health = await store.healthCheck()

    expect(health.redis).toBe(true)
    expect(health.redisWritable).toBe(true)
    expect(health.redisError).toBeUndefined()
    expect(health.postgres).toBe(true)
    expect(health.overall).toBe(true)
  })

  it("reports NOT writable when a reachable Redis rejects the write", async () => {
    // The staging condition: PING fine, every write refused.
    const store = makeStore({
      set: async () => {
        throw OOM
      },
    })

    const health = await store.healthCheck()

    // Reachable — so the old PING-only check called this healthy.
    expect(health.redis).toBe(true)
    // The signal that was missing.
    expect(health.redisWritable).toBe(false)
    // And the actual cause is surfaced, not just a boolean.
    expect(health.redisError).toContain("OOM")

    // Postgres is unaffected, so the service is degraded rather than down.
    expect(health.postgres).toBe(true)
    expect(health.overall).toBe(true)
  })

  it("writes a namespaced key with a TTL so probes cannot accumulate", async () => {
    const set = jest.fn(async () => "OK")
    const store = makeStore({ set: set as unknown as () => Promise<unknown> })

    await store.healthCheck()

    expect(set).toHaveBeenCalledTimes(1)
    const [key, , options] = (set as jest.Mock).mock.calls[0]
    expect(key).toBe("blink-terminal:health:probe")
    expect(options).toMatchObject({ EX: expect.any(Number) })
    expect(options.EX).toBeGreaterThan(0)
  })

  it("does not attempt a write when the ping itself fails", async () => {
    const set = jest.fn(async () => "OK")
    const store = makeStore({
      ping: async () => {
        throw new Error("Connection is closed")
      },
      set: set as unknown as () => Promise<unknown>,
    })

    const health = await store.healthCheck()

    expect(health.redis).toBe(false)
    expect(health.redisWritable).toBe(false)
    expect(health.redisError).toContain("Connection is closed")
    expect(set).not.toHaveBeenCalled()
  })

  it("leaves both flags false when Redis is not configured at all", async () => {
    const store = makeStore({ redisConnected: false })

    const health = await store.healthCheck()

    expect(health.redis).toBe(false)
    expect(health.redisWritable).toBe(false)
    // Redis is optional: Postgres alone still makes the service usable.
    expect(health.overall).toBe(true)
  })
})
