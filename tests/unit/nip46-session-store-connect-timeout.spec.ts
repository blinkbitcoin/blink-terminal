/**
 * @jest-environment node
 *
 * Session store behaviour when the INITIAL Redis connection never settles.
 *
 * redis@4.7.0's default reconnect strategy retries an unreachable connection forever, so
 * `client.connect()` never rejects: measured against an unused port, after 7s and 20 connection
 * errors the promise was still pending with isOpen=true/isReady=false (PR #71 post-merge review).
 * The store now bounds the connect with a timeout plus a giving-up reconnect strategy, so the
 * POST gets its retryable 503 instead of hanging with session capacity and a relay socket held.
 *
 * The mock below is deliberately faithful to that measured behaviour: connect() returns a
 * promise that NEVER settles. A mock that forced an immediate rejection would certify a path
 * production never takes — the third time in this project a mock concealing the real API's
 * semantics has hidden the bug under test (after the pool close([])/destroy() one and the
 * shared-reference profile store).
 */

process.env.ENABLE_HYBRID_STORAGE = "true"

const redisCommands = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  eval: jest.fn(),
  // Faithful to redis@4.7.0 with a down server and the DEFAULT strategy: never settles.
  connect: jest.fn(() => new Promise<void>(() => {})),
  on: jest.fn(),
  quit: jest.fn(async () => undefined),
}

let capturedConfig: {
  socket?: { connectTimeout?: number; reconnectStrategy?: (retries: number) => unknown }
  disableOfflineQueue?: boolean
} = {}

const createClientMock = jest.fn((config: typeof capturedConfig) => {
  capturedConfig = config
  return redisCommands
})
jest.mock("redis", () => ({
  createClient: (config: typeof capturedConfig) => createClientMock(config),
}))

import { Nip46StorageError } from "../../lib/nip46-server/errors"
import {
  __closeSessionStoreRedisForTests,
  __resetSessionStoreForTests,
  createSession,
  generateBindingSecret,
  generateSessionId,
  sha256Hex,
} from "../../lib/nip46-server/sessionStore"

function seedInput(id: string) {
  return {
    id,
    bindingHash: sha256Hex(generateBindingSecret()),
    expectedUrl: `https://pos.example/api/nostr-connect/sessions/${id}/consume`,
    challenge: "challenge-value",
  }
}

beforeEach(async () => {
  await __closeSessionStoreRedisForTests()
  __resetSessionStoreForTests()
  jest.clearAllMocks()
  capturedConfig = {}
})

describe("initial Redis connect that never settles", () => {
  it("fails closed (retryable) when the bounded connect gives up", async () => {
    // The real client rejects once connectTimeout and the giving-up reconnectStrategy have
    // elapsed — which is what makes this reachable at all. The mocked connect stands in for that
    // rejection (the config test below is what proves the bounding is actually configured; a
    // never-settling mock cannot be rescued by configuration alone, only by the real client
    // honouring it, which CI's Redis job exercises against a live server).
    redisCommands.connect.mockRejectedValueOnce(new Error("Redis unreachable"))

    const id = generateSessionId()
    await expect(createSession(seedInput(id))).rejects.toBeInstanceOf(Nip46StorageError)
  })

  it("configures a bounded connectTimeout, a giving-up reconnectStrategy, and no offline queue", () => {
    // The configuration is the fix, so pin it. Trigger a client build.
    createSession(seedInput(generateSessionId())).catch(() => undefined)

    const socket = capturedConfig.socket
    expect(socket?.connectTimeout).toBeGreaterThan(0)
    expect(socket?.connectTimeout).toBeLessThanOrEqual(2000)
    expect(capturedConfig.disableOfflineQueue).toBe(true)

    const strategy = socket?.reconnectStrategy
    expect(typeof strategy).toBe("function")
    // Early attempts get a bounded backoff...
    expect(strategy?.(1)).not.toBeInstanceOf(Error)
    expect(strategy?.(2)).not.toBeInstanceOf(Error)
    // ...but it gives up rather than retrying forever.
    expect(strategy?.(100)).toBeInstanceOf(Error)
  })
})
