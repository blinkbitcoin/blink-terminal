/**
 * @jest-environment node
 *
 * Session store behaviour when Redis is configured but a command fails.
 *
 * The store uses ONE backend per session, chosen at creation. Two failure
 * classes are handled differently, and the distinction is the whole point:
 *
 *  - The INITIAL write (createSession) failing is PRE-COMMIT: no backend is
 *    chosen yet, so it degrades to the in-process Map and the session stays
 *    usable end-to-end. This is the staging-regression fix — a readable but
 *    write-rejecting Redis (OOM / can't-persist / readonly replica) used to
 *    503 sign-in outright.
 *  - A command failing on an ALREADY-committed Redis session (get / transition
 *    / consume) is POST-COMMIT: degrading it would split a live session across
 *    two stores, so it raises Nip46StorageError → retryable 503, and nothing is
 *    written to the Map behind Redis's back (PR #71 review).
 */

process.env.ENABLE_HYBRID_STORAGE = "true"

const redisCommands = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  eval: jest.fn(),
  connect: jest.fn(async () => undefined),
  on: jest.fn(),
  quit: jest.fn(async () => undefined),
}

jest.mock("redis", () => ({
  createClient: jest.fn(() => redisCommands),
}))

import { Nip46StorageError } from "../../lib/nip46-server/errors"
import {
  __resetSessionStoreForTests,
  consumeSession,
  createSession,
  deleteSession,
  generateBindingSecret,
  generateSessionId,
  getSession,
  markApproved,
  markFailed,
  sha256Hex,
} from "../../lib/nip46-server/sessionStore"

const FAULT = new Error("READONLY You can't write against a read only replica")

function seedInput(id: string) {
  return {
    id,
    bindingHash: sha256Hex(generateBindingSecret()),
    expectedUrl: `https://pos.example/api/nostr-connect/sessions/${id}/consume`,
    challenge: "challenge-value",
  }
}

beforeEach(() => {
  __resetSessionStoreForTests()
  jest.clearAllMocks()
  // The client reports itself connected; individual commands are what fail.
  redisCommands.on.mockImplementation((event: string, handler: () => void) => {
    if (event === "connect") handler()
  })
})

describe("Redis command failures", () => {
  it("createSession degrades to memory when the initial write is rejected", async () => {
    // A reachable Redis that refuses the write (OOM / can't-persist / readonly).
    redisCommands.set.mockRejectedValue(FAULT)

    const id = generateSessionId()
    // Pre-commit: sign-in must NOT 503 here. The record lands in the Map.
    const record = await createSession(seedInput(id))
    expect(record.id).toBe(id)
    expect(record.status).toBe("pending")

    // And it must be usable through the memory backend for the rest of its life,
    // WITHOUT ever touching Redis again — memory is consulted first. If a later
    // read hit Redis it would 404 the session whose relay worker is still live.
    redisCommands.get.mockResolvedValue(null)
    const read = await getSession(id)
    expect(read?.id).toBe(id)
    expect(redisCommands.get).not.toHaveBeenCalled()
  })

  it("a memory-degraded session transitions and consumes through memory", async () => {
    // Every Redis command is broken; a session created under this condition must
    // still go pending -> approved -> consumed entirely in memory.
    redisCommands.set.mockRejectedValue(FAULT)
    redisCommands.eval.mockRejectedValue(FAULT)
    redisCommands.get.mockRejectedValue(FAULT)

    const id = generateSessionId()
    const secret = generateBindingSecret()
    const input = { ...seedInput(id), bindingHash: sha256Hex(secret) }

    await createSession(input)
    expect(await markApproved(id, "a".repeat(64))).toBe(true)

    const result = await consumeSession(id, secret)
    expect(result.ok).toBe(true)
    expect(result.pubkey).toBe("a".repeat(64))
  })

  it("getSession reports a storage error rather than a false 'expired'", async () => {
    redisCommands.get.mockRejectedValue(FAULT)

    await expect(getSession(generateSessionId())).rejects.toBeInstanceOf(
      Nip46StorageError,
    )
  })

  it("markApproved and markFailed report storage errors", async () => {
    redisCommands.eval.mockRejectedValue(FAULT)

    await expect(
      markApproved(generateSessionId(), "a".repeat(64)),
    ).rejects.toBeInstanceOf(Nip46StorageError)
    await expect(markFailed(generateSessionId(), "cancelled")).rejects.toBeInstanceOf(
      Nip46StorageError,
    )
  })

  it("consumeSession reports a storage error and mints nothing", async () => {
    const id = generateSessionId()
    const secret = generateBindingSecret()
    redisCommands.get.mockResolvedValue(
      JSON.stringify({
        id,
        status: "approved",
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        bindingHash: sha256Hex(secret),
        expectedUrl: "https://pos.example/x",
        challenge: "c",
        pubkey: "a".repeat(64),
      }),
    )
    redisCommands.eval.mockRejectedValue(FAULT)

    await expect(consumeSession(id, secret)).rejects.toBeInstanceOf(Nip46StorageError)
  })

  it("tolerates a delete failure, since the TTL cleans up anyway", async () => {
    redisCommands.del.mockRejectedValue(FAULT)

    // Best-effort: no throw, and no compensating write to the Map.
    await expect(deleteSession(generateSessionId())).resolves.toBeUndefined()
  })
})
