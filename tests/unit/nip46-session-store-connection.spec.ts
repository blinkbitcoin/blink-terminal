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
  createSession,
  generateBindingSecret,
  generateSessionId,
  getSession,
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
  it("initial connect failure raises a storage error and writes nothing to memory", async () => {
    redisCommands.connect.mockRejectedValue(new Error("ECONNREFUSED"))

    const id = generateSessionId()
    await expect(createSession(seedInput(id))).rejects.toBeInstanceOf(Nip46StorageError)

    // Nothing was written behind Redis's back: once Redis is up and empty, the id is gone.
    redisCommands.connect.mockImplementation(async () => undefined)
    expect(await memoryHas(id)).toBe(false)
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

  it("does not build a second client per failed attempt", async () => {
    redisCommands.connect
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockImplementation(async () => undefined)

    const id = generateSessionId()
    await expect(createSession(seedInput(id))).rejects.toBeInstanceOf(Nip46StorageError)
    // The failed initial connect leaves no client to reconnect, so the next attempt creates
    // one — exactly one — and after THAT succeeds, further calls reuse it.
    redisCommands.set.mockResolvedValue("OK")
    await createSession(seedInput(generateSessionId()))
    await createSession(seedInput(generateSessionId()))

    // One client for the failed attempt, one for the successful one; the third call reused it.
    expect(createClientMock).toHaveBeenCalledTimes(2)
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
