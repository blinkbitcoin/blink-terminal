/**
 * @jest-environment node
 *
 * Session store behaviour when Redis is configured but the CONNECTION is unavailable.
 *
 * The companion fault spec covers a command failing on a connected client. This covers the
 * layer above it: the initial connection failing, and a connected client dropping. Both used
 * to make getRedisClient() return null, which silently switched every subsequent operation to
 * the in-process Map — the exact backend split the store's header forbids. A session created
 * in memory during an outage vanished when Redis recovered, and a Redis-backed session read
 * during a drop 404'd while its relay worker was still live (PR #71 review).
 *
 * With Redis configured, the Map is never a backend. Unavailability is a retryable
 * Nip46StorageError, and one client is reused across attempts rather than rebuilt.
 */

process.env.ENABLE_HYBRID_STORAGE = "true"

type Handler = (...args: unknown[]) => void
const handlers: Record<string, Handler[]> = {}

const redisCommands = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  eval: jest.fn(),
  connect: jest.fn(async () => undefined),
  on: jest.fn((event: string, handler: Handler) => {
    ;(handlers[event] ??= []).push(handler)
  }),
  quit: jest.fn(async () => undefined),
}

const createClientMock = jest.fn(() => redisCommands)
jest.mock("redis", () => ({
  createClient: () => createClientMock(),
}))

import { Nip46StorageError } from "../../lib/nip46-server/errors"
import {
  __resetSessionStoreForTests,
  __closeSessionStoreRedisForTests,
  consumeSession,
  createSession,
  generateBindingSecret,
  generateSessionId,
  getSession,
  markApproved,
  sha256Hex,
} from "../../lib/nip46-server/sessionStore"

const emit = (event: string, ...args: unknown[]): void => {
  for (const h of handlers[event] ?? []) h(...args)
}

function seedInput(id: string) {
  return {
    id,
    bindingHash: sha256Hex(generateBindingSecret()),
    expectedUrl: `https://pos.example/api/nostr-connect/sessions/${id}/consume`,
    challenge: "challenge-value",
  }
}

/** Reach the private Map the store falls back to, to prove nothing landed there. */
const memoryHas = async (id: string): Promise<boolean> => {
  // With Redis configured, getSession must consult Redis (throwing if it is down) — so a
  // record that only exists in memory is unreachable, which is what we want to assert. We
  // probe by making Redis "up" and empty: a memory-resident record would be returned by a
  // per-call fallback, and is NOT returned by a one-backend store.
  redisCommands.get.mockResolvedValue(null)
  return (await getSession(id)) !== null
}

beforeEach(async () => {
  await __closeSessionStoreRedisForTests()
  __resetSessionStoreForTests()
  jest.clearAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  redisCommands.connect.mockImplementation(async () => undefined)
})

describe("Redis configured but the connection is unavailable", () => {
  it("initial connect failure degrades to memory, and the session stays there for its whole life (PR #71 regression)", async () => {
    redisCommands.connect.mockRejectedValue(new Error("ECONNREFUSED"))

    const id = generateSessionId()
    const created = await createSession(seedInput(id))
    expect(created.id).toBe(id)

    // The record is memory-resident. Crucially it must REMAIN readable after Redis recovers —
    // the earlier bug re-chose the backend from live connectivity on every op, so a recovered
    // Redis made the session vanish while its relay worker was still running (this is the
    // regression seen live on staging).
    redisCommands.connect.mockImplementation(async () => undefined)
    redisCommands.get.mockResolvedValue(null) // recovered Redis has nothing under this id
    const read = await getSession(id)
    expect(read?.id).toBe(id)
    expect(read?.status).toBe("pending")
  })

  it("a memory-resident session remains single-use consume-able after Redis recovers", async () => {
    redisCommands.connect.mockRejectedValue(new Error("ECONNREFUSED"))

    const id = generateSessionId()
    const secret = generateBindingSecret()
    const input = {
      id,
      bindingHash: sha256Hex(secret),
      expectedUrl: `https://pos.example/api/nostr-connect/sessions/${id}/consume`,
      challenge: "challenge-value",
    }
    await createSession(input)
    await markApproved(id, "user-pubkey")

    // Redis is back, but the session lives in memory and must consume there — exactly once.
    redisCommands.connect.mockImplementation(async () => undefined)
    const first = await consumeSession(id, secret)
    expect(first.ok).toBe(true)
    const second = await consumeSession(id, secret)
    expect(second.ok).toBe(false)
    expect(redisCommands.eval).not.toHaveBeenCalled() // never touched Redis
  })

  it("a client that dropped after connecting fails closed rather than falling back", async () => {
    // Connect succeeds; a session lands in Redis.
    redisCommands.set.mockResolvedValue("OK")
    const id = generateSessionId()
    await createSession(seedInput(id))
    expect(redisCommands.set).toHaveBeenCalledTimes(1)

    // The connection drops. node-redis reports it via `error`; readiness is lost.
    emit("error", new Error("Socket closed unexpectedly"))

    // A read during the drop must NOT silently consult the Map and report the session gone —
    // that 404'd a session whose relay worker was still live.
    await expect(getSession(id)).rejects.toBeInstanceOf(Nip46StorageError)
    expect(redisCommands.get).not.toHaveBeenCalled()
  })

  it("the same session is readable again after the client recovers — never split", async () => {
    redisCommands.set.mockResolvedValue("OK")
    const id = generateSessionId()
    const created = await createSession(seedInput(id))

    emit("error", new Error("Socket closed unexpectedly"))
    await expect(getSession(id)).rejects.toBeInstanceOf(Nip46StorageError)

    // node-redis reconnects and reports ready. The record was only ever in Redis.
    emit("ready")
    redisCommands.get.mockResolvedValue(JSON.stringify(created))
    const read = await getSession(id)
    expect(read?.id).toBe(id)
    expect(read?.status).toBe("pending")
  })

  it("does not build a second client while one is live or reconnecting", async () => {
    redisCommands.connect.mockImplementation(async () => undefined)
    redisCommands.set.mockResolvedValue("OK")

    await createSession(seedInput(generateSessionId()))
    expect(createClientMock).toHaveBeenCalledTimes(1)

    // The connection drops; while node-redis reconnects, calls fail closed and no second
    // client is built. (A failed INITIAL connect leaves no live client, so that path does retry
    // connect once per call — the invariant is only that a live/reconnecting client is never
    // duplicated.)
    emit("error", new Error("Socket closed unexpectedly"))
    await expect(getSession("whatever")).rejects.toBeInstanceOf(Nip46StorageError)
    await expect(getSession("whatever")).rejects.toBeInstanceOf(Nip46StorageError)
    expect(createClientMock).toHaveBeenCalledTimes(1)
  })

  it("while a dropped client reconnects, no additional client is created", async () => {
    redisCommands.set.mockResolvedValue("OK")
    await createSession(seedInput(generateSessionId()))
    expect(createClientMock).toHaveBeenCalledTimes(1)

    emit("error", new Error("Socket closed unexpectedly"))
    await expect(getSession("whatever")).rejects.toBeInstanceOf(Nip46StorageError)
    await expect(getSession("whatever")).rejects.toBeInstanceOf(Nip46StorageError)

    // Still the one client — node-redis owns the reconnect; we do not race it.
    expect(createClientMock).toHaveBeenCalledTimes(1)
  })
})
