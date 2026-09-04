/**
 * @jest-environment node
 *
 * NIP-46 session store against a REAL Redis.
 *
 * The in-memory tests cannot catch the bug this file exists for. The previous
 * implementation used WATCH/MULTI on the shared singleton connection, which is
 * not a compare-and-swap — WATCH state is connection-scoped, so two overlapping
 * consumes on one client both read `approved`, the first EXEC clears the watch,
 * and the second EXEC then runs unguarded. Both succeed, and one signer approval
 * mints two login sessions (PR #71 review). Under the single-threaded in-memory
 * map that interleaving simply cannot occur, so it passed there.
 *
 * These cases fire genuinely concurrent operations through the real client and
 * assert exactly-once semantics.
 *
 * Requires Redis. Skipped unless NIP46_REDIS_TEST=1 (set in CI, where the Unit
 * Tests job runs a redis service). Locally:
 *   docker compose up -d redis
 *   NIP46_REDIS_TEST=1 npx jest tests/unit/nip46-session-store.redis.spec.ts
 */

const REDIS_ENABLED = process.env.NIP46_REDIS_TEST === "1"

// Must be set before the store module is imported: it reads these at connect time.
if (REDIS_ENABLED) {
  process.env.ENABLE_HYBRID_STORAGE = "true"
  process.env.REDIS_HOST = process.env.REDIS_HOST || "localhost"
  process.env.REDIS_PORT = process.env.REDIS_PORT || "6379"
}

import {
  __closeSessionStoreRedisForTests,
  consumeSession,
  createSession,
  generateBindingSecret,
  generateSessionId,
  getSession,
  markApproved,
  markFailed,
  sha256Hex,
} from "../../lib/nip46-server/sessionStore"

const describeRedis = REDIS_ENABLED ? describe : describe.skip

const PUBKEY = "a".repeat(64)

async function seedApproved(): Promise<{ id: string; secret: string }> {
  const id = generateSessionId()
  const secret = generateBindingSecret()
  await createSession({
    id,
    bindingHash: sha256Hex(secret),
    expectedUrl: `https://pos.example/api/nostr-connect/sessions/${id}/consume`,
    challenge: "challenge-value",
  })
  const approved = await markApproved(id, PUBKEY)
  expect(approved).toBe(true)
  return { id, secret }
}

describeRedis("NIP-46 session store (real Redis)", () => {
  afterAll(async () => {
    await __closeSessionStoreRedisForTests()
  })

  it("is actually talking to Redis, not the in-memory fallback", async () => {
    const id = generateSessionId()
    await createSession({
      id,
      bindingHash: sha256Hex("s"),
      expectedUrl: "https://pos.example/x",
      challenge: "c",
    })

    // Reading through a separate client proves the record left this process.
    const { createClient } = await import("redis")
    const probe = createClient({
      socket: {
        host: process.env.REDIS_HOST,
        port: parseInt(process.env.REDIS_PORT || "6379", 10),
      },
    })
    await probe.connect()
    const raw = await probe.get(`blink-terminal:nip46:${id}`)
    await probe.quit()

    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string).status).toBe("pending")
  })

  /**
   * THE regression test for the review finding: N concurrent consumes of one
   * approval must produce exactly one login.
   */
  it("consumes an approval exactly once under 10 concurrent consumes", async () => {
    const { id, secret } = await seedApproved()

    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeSession(id, secret)),
    )

    const succeeded = results.filter((r) => r.ok)
    expect(succeeded).toHaveLength(1)
    expect(succeeded[0].pubkey).toBe(PUBKEY)
    expect(results.filter((r) => !r.ok)).toHaveLength(9)
    expect((await getSession(id))?.status).toBe("consumed")
  })

  it("holds across many independent sessions consumed concurrently", async () => {
    const seeded = await Promise.all(Array.from({ length: 8 }, () => seedApproved()))

    // Two consumes per session, all in flight together.
    const results = await Promise.all(
      seeded.flatMap(({ id, secret }) => [
        consumeSession(id, secret),
        consumeSession(id, secret),
      ]),
    )

    expect(results.filter((r) => r.ok)).toHaveLength(seeded.length)
  })

  it("does not let a late worker resurrect a cancelled session", async () => {
    const id = generateSessionId()
    const secret = generateBindingSecret()
    await createSession({
      id,
      bindingHash: sha256Hex(secret),
      expectedUrl: "https://pos.example/x",
      challenge: "c",
    })

    expect(await markFailed(id, "cancelled")).toBe(true)
    // The worker finishes signing just after the user cancelled.
    expect(await markApproved(id, PUBKEY)).toBe(false)

    const record = await getSession(id)
    expect(record?.status).toBe("failed")
    expect(record?.error).toBe("cancelled")
    expect((await consumeSession(id, secret)).ok).toBe(false)
  })

  it("keeps a consumed session terminal", async () => {
    const { id, secret } = await seedApproved()
    expect((await consumeSession(id, secret)).ok).toBe(true)

    expect(await markFailed(id, "server_restarted")).toBe(false)
    expect(await markApproved(id, PUBKEY)).toBe(false)
    expect((await getSession(id))?.status).toBe("consumed")
  })

  it("never lets a cancel be undone by a concurrent approval", async () => {
    const id = generateSessionId()
    const secret = generateBindingSecret()
    await createSession({
      id,
      bindingHash: sha256Hex(secret),
      expectedUrl: "https://pos.example/x",
      challenge: "c",
    })

    const [approved, failed] = await Promise.all([
      markApproved(id, PUBKEY),
      markFailed(id, "cancelled"),
    ])

    // Note both CAN succeed, and that is intended: cancelling a session that
    // was just approved but not yet consumed is the cancel-while-signing path.
    // What must never happen is the reverse — a cancelled session becoming
    // approved again.
    expect(approved || failed).toBe(true)

    const record = await getSession(id)
    expect(["approved", "failed"]).toContain(record?.status)

    if (record?.status === "failed") {
      expect(await markApproved(id, PUBKEY)).toBe(false)
      expect((await getSession(id))?.status).toBe("failed")
      expect((await consumeSession(id, secret)).ok).toBe(false)
    }
  })

  it("requires the browser binding even when the session is approved", async () => {
    const { id, secret } = await seedApproved()

    expect((await consumeSession(id, undefined)).ok).toBe(false)
    expect((await consumeSession(id, generateBindingSecret())).ok).toBe(false)
    // A rejected attempt must not have burned the approval.
    expect((await consumeSession(id, secret)).ok).toBe(true)
  })

  it("treats an expired session as gone", async () => {
    const id = generateSessionId()
    const secret = generateBindingSecret()
    await createSession({
      id,
      bindingHash: sha256Hex(secret),
      expectedUrl: "https://pos.example/x",
      challenge: "c",
      ttlSeconds: -1,
    })

    expect(await getSession(id)).toBeNull()
    expect((await consumeSession(id, secret)).ok).toBe(false)
  })
})
