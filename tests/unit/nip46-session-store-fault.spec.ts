/**
 * @jest-environment node
 *
 * Session store behaviour when Redis is configured but a command fails.
 *
 * The store must use ONE backend per session. Falling back to the in-process
 * Map per command split a session across two stores: a failed SET wrote the
 * record to memory, and the next GET — against a Redis that had recovered —
 * missed and reported the session as expired. Polling and consume then 404'd a
 * session whose relay worker was still running (PR #71 review).
 *
 * A command failure now raises Nip46StorageError, which the routes turn into a
 * retryable 503, and nothing is written to the Map behind Redis's back.
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
  it("createSession reports a storage error instead of writing to memory", async () => {
    redisCommands.set.mockRejectedValue(FAULT)

    const id = generateSessionId()
    await expect(createSession(seedInput(id))).rejects.toBeInstanceOf(Nip46StorageError)

    // The crucial part: nothing was written behind Redis's back, so a later
    // read cannot disagree with a recovered Redis.
    redisCommands.get.mockResolvedValue(null)
    expect(await getSession(id)).toBeNull()
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
