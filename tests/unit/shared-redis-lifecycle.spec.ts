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
process.env.REDIS_CONNECT_DEADLINE_MS = "800"

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
})
