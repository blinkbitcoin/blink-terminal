/**
 * @jest-environment node
 *
 * lib/redis.ts — the shared Redis client lifecycle.
 *
 * These drive the REAL node-redis client against real local listeners, because a mock cannot
 * reproduce the library's connection timing — that is the exact lesson from this project: the
 * earlier mocks forced an immediate rejection while redis@4.7.0's default retries an
 * unreachable initial connect forever. The bot reproduced both with real listeners; so do these.
 *
 * The deadline is shrunk via REDIS_CONNECT_DEADLINE_MS so the real timeouts are exercised
 * quickly.
 */

process.env.ENABLE_HYBRID_STORAGE = "true"
const DEADLINE_MS = 800
process.env.REDIS_CONNECT_DEADLINE_MS = String(DEADLINE_MS)

import net from "net"

import {
  __closeSharedRedisForTests,
  getSharedRedisClient,
  sharedRedisReady,
} from "../../lib/redis"

const OPEN_PORT = 16398

/** Start a TCP server. `silent: true` accepts connections and never answers (no handshake). */
function startListener(
  silent: boolean,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>()
    const srv = net.createServer((sock) => {
      sockets.add(sock)
      sock.on("close", () => sockets.delete(sock))
    })
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port
      resolve({
        port,
        // close() waits for open connections to drain; a still-connecting socket would block it
        // forever, so destroy them first.
        close: () =>
          new Promise((r) => {
            for (const sock of sockets) sock.destroy()
            srv.close(() => r())
          }),
      })
    })
  })
}

afterEach(async () => {
  await __closeSharedRedisForTests()
  delete process.env.REDIS_HOST
  delete process.env.REDIS_PORT
})

describe("getSharedRedisClient — real connection lifecycle (PR #73 review)", () => {
  it("a dead port (connection refused) rejects within the deadline instead of hanging", async () => {
    // Nothing is listening, so every connection is refused. The default strategy would retry
    // forever; the bounded initial connect must reject.
    process.env.REDIS_HOST = "127.0.0.1"
    process.env.REDIS_PORT = String(OPEN_PORT)

    const t0 = Date.now()
    await expect(getSharedRedisClient()).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it("a silent peer (accepts TCP, never answers the handshake) rejects within the deadline", async () => {
    // This is the case socket.connectTimeout misses: TCP succeeds, so the library's timeout is
    // cleared, and connect() would otherwise hang on the Redis handshake forever.
    const listener = await startListener(true)
    process.env.REDIS_HOST = "127.0.0.1"
    process.env.REDIS_PORT = String(listener.port)
    try {
      const t0 = Date.now()
      await expect(getSharedRedisClient()).rejects.toThrow()
      expect(Date.now() - t0).toBeLessThan(5000)
    } finally {
      await listener.close()
    }
  })

  it("a timed-out initial connect leaves no orphan client that could reconnect later", async () => {
    const listener = await startListener(true)
    process.env.REDIS_HOST = "127.0.0.1"
    process.env.REDIS_PORT = String(listener.port)
    try {
      await expect(getSharedRedisClient()).rejects.toThrow()
      // The failed client was disposed; the NEXT call builds a fresh one rather than resurrecting
      // the orphan. Both fail while the peer is silent, and each is bounded.
      await expect(getSharedRedisClient()).rejects.toThrow()
      expect(sharedRedisReady()).toBe(false)
    } finally {
      await listener.close()
    }
  })

  it("consumers in sequence pay ONE connect deadline in total, not one each", async () => {
    // A cold-start request runs two consumers in sequence: the rate limiter, then the session
    // store. Before the shared unavailable memo, the limiter's attempt timed out and was
    // discarded, so the store rebuilt a client and waited the whole deadline over again —
    // roughly 10s per request at the 5s default, with relay and capacity already reserved
    // before the second wait (#75 review).
    const listener = await startListener(true)
    process.env.REDIS_HOST = "127.0.0.1"
    process.env.REDIS_PORT = String(listener.port)
    try {
      const t0 = Date.now()
      await expect(getSharedRedisClient()).rejects.toThrow() // the limiter
      const afterFirst = Date.now()
      await expect(getSharedRedisClient()).rejects.toThrow() // the session store
      const total = Date.now() - t0

      // The second consumer is served from the memo, so it costs ~nothing...
      expect(Date.now() - afterFirst).toBeLessThan(DEADLINE_MS / 2)
      // ...and the request as a whole never pays the deadline twice.
      expect(total).toBeLessThan(DEADLINE_MS * 2)
    } finally {
      await listener.close()
    }
  })

  it("repeated connect timeouts leak no listeners on the emitter that survives them", async () => {
    // The leaking helper waited for `ready` and never removed its listener on the timeout path,
    // warning after ~11 timeouts (#75 review). Nothing waits for `ready` any more, so the leak
    // is gone by construction — this guards the remaining per-attempt listeners (error/ready/end
    // registered in buildClient) against accumulating on anything that outlives an attempt.
    const listener = await startListener(true)
    process.env.REDIS_HOST = "127.0.0.1"
    process.env.REDIS_PORT = String(listener.port)
    const warnings: string[] = []
    const onWarning = (w: Error): void => {
      warnings.push(w.name)
    }
    process.on("warning", onWarning)
    try {
      // Each iteration must reach a real connect, so step past the unavailable memo.
      for (let i = 0; i < 12; i++) {
        await expect(getSharedRedisClient()).rejects.toThrow()
        await __closeSharedRedisForTests()
      }
      await new Promise((r) => setTimeout(r, 50))
      expect(warnings).not.toContain("MaxListenersExceededWarning")
      expect(process.listenerCount("warning")).toBeLessThan(10)
    } finally {
      process.off("warning", onWarning)
      await listener.close()
    }
  })

  it("cleanup completes promptly while the client is mid-reconnect", async () => {
    // quit() waits for a graceful exchange the server will never complete while reconnecting, so
    // teardown hung; disconnect() releases the socket outright (#75 review).
    const listener = await startListener(true)
    process.env.REDIS_HOST = "127.0.0.1"
    process.env.REDIS_PORT = String(listener.port)
    try {
      await expect(getSharedRedisClient()).rejects.toThrow()
      const t0 = Date.now()
      await __closeSharedRedisForTests()
      expect(Date.now() - t0).toBeLessThan(500)
    } finally {
      await listener.close()
    }
  })
})
