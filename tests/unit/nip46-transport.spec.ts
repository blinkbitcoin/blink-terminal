/**
 * @jest-environment node
 *
 * Nip46Transport — the ordering invariant behind issue #70.
 *
 * The signer's connect ack is published exactly once. If the nostrconnect://
 * URI reaches the browser before we are listening, the ack is lost and sign-in
 * fails in a way no retry can recover. So `open()` must not resolve until at
 * least one relay is connected, its handler is attached, AND its REQ has been
 * written to the socket. These tests pin that ordering with a fake pool.
 */

const encodedPrefix = "enc:"

jest.mock("nostr-tools", () => {
  const textOf = (payload: string): string => payload.slice(encodedPrefix.length)
  return {
    generateSecretKey: (): Uint8Array => new Uint8Array(32).fill(7),
    getPublicKey: (sk: Uint8Array): string =>
      Buffer.from(sk).toString("hex").slice(0, 64),
    finalizeEvent: (template: Record<string, unknown>, sk: Uint8Array) => ({
      ...template,
      id: "event-id",
      pubkey: Buffer.from(sk).toString("hex").slice(0, 64),
      sig: "sig",
    }),
    nip44: {
      getConversationKey: (_sk: Uint8Array, pubkey: string): Uint8Array =>
        new Uint8Array(Buffer.from(pubkey.slice(0, 32), "hex")),
      encrypt: (plaintext: string): string => `${encodedPrefix}${plaintext}`,
      decrypt: (payload: string): string => {
        if (!payload.startsWith(encodedPrefix)) throw new Error("undecryptable")
        return textOf(payload)
      },
    },
  }
})

import {
  Nip46Transport,
  type PoolLike,
  type RelayLike,
  type RelaySubscriptionLike,
} from "../../lib/nip46-server/transport"

const SIGNER = "b".repeat(64)

type EventHandler = (event: Record<string, unknown>) => void

/** Records every observable action in order, across all relays. */
let trace: string[] = []

class FakeRelay implements RelayLike {
  readonly url: string
  onevent: EventHandler | null = null
  sent: string[] = []
  published: Record<string, unknown>[] = []
  closed = false
  subClosed = false
  /** When set, send() waits on this before resolving. */
  sendGate: Promise<void> | null = null
  publishResult: "ok" | "fail" = "ok"

  constructor(url: string) {
    this.url = url
  }

  prepareSubscription(
    _filters: Record<string, unknown>[],
    params: { onevent?: EventHandler; onclose?: (reason: string) => void },
  ): RelaySubscriptionLike {
    trace.push(`prepare:${this.url}`)
    this.onevent = params.onevent ?? null
    return {
      id: `sub:${this.url}`,
      close: () => {
        this.subClosed = true
      },
    }
  }

  async send(message: string): Promise<void> {
    if (this.sendGate) await this.sendGate
    trace.push(`send:${this.url}`)
    this.sent.push(message)
  }

  async publish(event: Record<string, unknown>): Promise<string> {
    this.published.push(event)
    if (this.publishResult === "fail") throw new Error("publish failed")
    return "ok"
  }

  close(): void {
    this.closed = true
  }

  /** Simulate the signer answering on this relay. */
  emit(payload: Record<string, unknown>, author: string = SIGNER): void {
    this.onevent?.({
      id: "incoming",
      pubkey: author,
      kind: 24133,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: `${encodedPrefix}${JSON.stringify(payload)}`,
      sig: "sig",
    })
  }
}

class FakePool implements PoolLike {
  readonly relays = new Map<string, FakeRelay>()
  destroyed = false
  /** Per-URL connect behaviour. */
  failing = new Set<string>()
  gates = new Map<string, Promise<void>>()

  async ensureRelay(url: string): Promise<RelayLike> {
    const gate = this.gates.get(url)
    if (gate) await gate
    if (this.failing.has(url)) {
      trace.push(`connect-fail:${url}`)
      throw new Error(`cannot connect to ${url}`)
    }
    trace.push(`connect:${url}`)
    const relay = this.relays.get(url) ?? new FakeRelay(url)
    this.relays.set(url, relay)
    return relay
  }

  destroy(): void {
    this.destroyed = true
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  trace = []
})

describe("Nip46Transport.open — readiness invariant", () => {
  it("attaches the event handler BEFORE writing the REQ", async () => {
    const pool = new FakePool()
    const transport = new Nip46Transport({ relays: ["wss://a"], pool })

    await transport.open({ timeoutMs: 1000 })

    expect(trace).toEqual(["connect:wss://a", "prepare:wss://a", "send:wss://a"])
    transport.close()
  })

  it("does NOT resolve until the REQ has actually been written", async () => {
    const pool = new FakePool()
    const relay = new FakeRelay("wss://a")
    const gate = deferred()
    relay.sendGate = gate.promise
    pool.relays.set("wss://a", relay)

    const transport = new Nip46Transport({ relays: ["wss://a"], pool })

    let resolved = false
    const opening = transport.open({ timeoutMs: 1000 }).then(() => {
      resolved = true
    })

    // The relay is connected and the handler is attached, but the REQ frame is
    // still in flight. This is exactly the window in which the browser must NOT
    // yet have the URI.
    await Promise.resolve()
    await Promise.resolve()
    expect(relay.onevent).not.toBeNull()
    expect(resolved).toBe(false)

    gate.resolve()
    await opening
    expect(resolved).toBe(true)
    expect(relay.sent).toHaveLength(1)
    transport.close()
  })

  it("sends a well-formed kind-24133 REQ scoped to the client pubkey", async () => {
    const pool = new FakePool()
    const transport = new Nip46Transport({ relays: ["wss://a"], pool })
    await transport.open({ timeoutMs: 1000 })

    const relay = pool.relays.get("wss://a") as FakeRelay
    const parsed = JSON.parse(relay.sent[0]) as [string, string, Record<string, unknown>]
    expect(parsed[0]).toBe("REQ")
    expect(parsed[1]).toBe("sub:wss://a")
    expect(parsed[2]).toEqual({
      "kinds": [24133],
      "#p": [transport.clientPubkey],
      "limit": 0,
    })
    transport.close()
  })

  it("resolves as soon as ONE relay is ready, without waiting for the rest", async () => {
    const pool = new FakePool()
    const slow = deferred()
    pool.gates.set("wss://slow", slow.promise)
    pool.failing.add("wss://dead")

    const transport = new Nip46Transport({
      relays: ["wss://dead", "wss://slow", "wss://fast"],
      pool,
    })

    const result = await transport.open({ timeoutMs: 1000 })
    expect(result.readyRelays).toEqual(["wss://fast"])

    // The slow relay joins later and subscribes on its own.
    slow.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(transport.readyRelays).toEqual(
      expect.arrayContaining(["wss://fast", "wss://slow"]),
    )
    transport.close()
  })

  it("rejects when every relay fails to connect", async () => {
    const pool = new FakePool()
    pool.failing.add("wss://a")
    pool.failing.add("wss://b")

    const transport = new Nip46Transport({ relays: ["wss://a", "wss://b"], pool })

    await expect(transport.open({ timeoutMs: 1000 })).rejects.toThrow(
      "all relays failed to connect",
    )
  })

  it("rejects when no relay becomes ready within the timeout", async () => {
    const pool = new FakePool()
    const never = deferred()
    pool.gates.set("wss://a", never.promise)

    const transport = new Nip46Transport({ relays: ["wss://a"], pool })

    await expect(transport.open({ timeoutMs: 20 })).rejects.toThrow(
      "no relay became ready in time",
    )
    never.resolve()
  })

  it("rejects when no relays are configured", async () => {
    const transport = new Nip46Transport({ relays: [], pool: new FakePool() })
    await expect(transport.open({ timeoutMs: 20 })).rejects.toThrow(
      "no relays configured",
    )
  })
})

describe("Nip46Transport.waitForConnectAck", () => {
  async function openTransport(): Promise<{
    transport: Nip46Transport
    relay: FakeRelay
    pool: FakePool
  }> {
    const pool = new FakePool()
    const transport = new Nip46Transport({ relays: ["wss://a"], pool })
    await transport.open({ timeoutMs: 1000 })
    return { transport, relay: pool.relays.get("wss://a") as FakeRelay, pool }
  }

  it("resolves on the echoed secret and pins the signer", async () => {
    const { transport, relay } = await openTransport()
    const waiting = transport.waitForConnectAck({ secret: "s3cret", timeoutMs: 1000 })

    relay.emit({ id: "1", result: "s3cret" })

    await expect(waiting).resolves.toEqual({ signerPubkey: SIGNER })
    expect(transport.pinnedSignerPubkey).toBe(SIGNER)
    transport.close()
  })

  /**
   * Our client pubkey is public — it is in the `#p` filter of the REQ we send to
   * every relay — so any relay observer can NIP-44-encrypt a reply to it from a
   * key of their own. If a bare `"ack"` pinned the signer, that observer would
   * be handed `get_public_key` and the NIP-98 challenge, and the victim's
   * browser would consume an approval for the ATTACKER's identity. Only the
   * secret, which never leaves the URI, may pin.
   */
  it("ignores a bare 'ack' from a key that does not know the secret", async () => {
    const { transport, relay } = await openTransport()
    const waiting = transport.waitForConnectAck({ secret: "s3cret", timeoutMs: 40 })

    const attacker = "f".repeat(64)
    relay.emit({ id: "1", result: "ack" }, attacker)

    await expect(waiting).rejects.toThrow("connect ack timed out")
    expect(transport.pinnedSignerPubkey).toBeNull()
    transport.close()
  })

  it("still pins the real signer when the secret arrives after an attacker's ack", async () => {
    const { transport, relay } = await openTransport()
    const waiting = transport.waitForConnectAck({ secret: "s3cret", timeoutMs: 1000 })

    // The attacker races first and must lose.
    relay.emit({ id: "1", result: "ack" }, "f".repeat(64))
    relay.emit({ id: "2", result: "s3cret" })

    await expect(waiting).resolves.toEqual({ signerPubkey: SIGNER })
    expect(transport.pinnedSignerPubkey).toBe(SIGNER)
    transport.close()
  })

  /**
   * A nostrconnect:// handshake has no client request to correlate with, so the
   * response id is signer-chosen and optional — nostr-tools' own
   * BunkerSigner.fromURI accepts the ack on `result === secret` alone. Requiring
   * an id dropped acks from conforming signers and timed the session out as
   * connect_timeout, i.e. the exact failure #70 exists to fix (PR #71 review).
   */
  it("accepts a secret-bearing ack that carries no RPC id", async () => {
    const { transport, relay } = await openTransport()
    const waiting = transport.waitForConnectAck({ secret: "s3cret", timeoutMs: 1000 })

    relay.emit({ result: "s3cret" })

    await expect(waiting).resolves.toEqual({ signerPubkey: SIGNER })
    expect(transport.pinnedSignerPubkey).toBe(SIGNER)
    transport.close()
  })

  it("accepts a secret-bearing ack whose id is not a string", async () => {
    const { transport, relay } = await openTransport()
    const waiting = transport.waitForConnectAck({ secret: "s3cret", timeoutMs: 1000 })

    relay.emit({ id: 7, result: "s3cret" })

    await expect(waiting).resolves.toEqual({ signerPubkey: SIGNER })
    transport.close()
  })

  it("still rejects an id-less ack that does not carry the secret", async () => {
    const { transport, relay } = await openTransport()
    const waiting = transport.waitForConnectAck({ secret: "s3cret", timeoutMs: 40 })

    // Dropping the id requirement must not reopen the pinning hole.
    relay.emit({ result: "ack" }, "f".repeat(64))
    relay.emit({ result: "s3cr" }, "f".repeat(64))

    await expect(waiting).rejects.toThrow("connect ack timed out")
    expect(transport.pinnedSignerPubkey).toBeNull()
    transport.close()
  })

  it("ignores a near-miss secret", async () => {
    const { transport, relay } = await openTransport()
    const waiting = transport.waitForConnectAck({ secret: "s3cret", timeoutMs: 40 })

    relay.emit({ id: "1", result: "s3cre" })
    relay.emit({ id: "2", result: "s3cretX" })
    relay.emit({ id: "3", result: "" })

    await expect(waiting).rejects.toThrow("connect ack timed out")
    transport.close()
  })

  it("ignores unrelated relay traffic", async () => {
    const { transport, relay } = await openTransport()
    const waiting = transport.waitForConnectAck({ secret: "s3cret", timeoutMs: 30 })

    relay.emit({ id: "1", result: "something-else" })
    relay.onevent?.({
      id: "x",
      pubkey: SIGNER,
      kind: 24133,
      created_at: 0,
      tags: [],
      content: "not-encrypted-for-us",
      sig: "sig",
    })

    await expect(waiting).rejects.toThrow("connect ack timed out")
    transport.close()
  })

  it("rejects when aborted", async () => {
    const { transport, relay } = await openTransport()
    const controller = new AbortController()
    const waiting = transport.waitForConnectAck({
      secret: "s3cret",
      timeoutMs: 5000,
      signal: controller.signal,
    })

    controller.abort("cancelled by user")
    await expect(waiting).rejects.toThrow("cancelled by user")

    // A late ack must not resolve an aborted wait.
    relay.emit({ id: "1", result: "s3cret" })
    transport.close()
  })
})

describe("Nip46Transport.request", () => {
  async function connected(): Promise<{
    transport: Nip46Transport
    relay: FakeRelay
  }> {
    const pool = new FakePool()
    const transport = new Nip46Transport({ relays: ["wss://a"], pool })
    await transport.open({ timeoutMs: 1000 })
    const relay = pool.relays.get("wss://a") as FakeRelay
    const ack = transport.waitForConnectAck({ secret: "s", timeoutMs: 1000 })
    relay.emit({ id: "1", result: "s" })
    await ack
    return { transport, relay }
  }

  it("refuses to send before the signer is connected", async () => {
    const pool = new FakePool()
    const transport = new Nip46Transport({ relays: ["wss://a"], pool })
    await transport.open({ timeoutMs: 1000 })

    await expect(
      transport.request("get_public_key", [], { timeoutMs: 100 }),
    ).rejects.toThrow("signer not connected")
    transport.close()
  })

  it("resolves with the matching response", async () => {
    const { transport, relay } = await connected()
    const pending = transport.request("get_public_key", [], { timeoutMs: 1000 })

    await Promise.resolve()
    const sent = JSON.parse(
      (relay.published[0].content as string).slice(encodedPrefix.length),
    ) as { id: string; method: string }
    expect(sent.method).toBe("get_public_key")

    relay.emit({ id: sent.id, result: "c".repeat(64) })
    await expect(pending).resolves.toBe("c".repeat(64))
    transport.close()
  })

  it("rejects when the signer returns an error", async () => {
    const { transport, relay } = await connected()
    const pending = transport.request("sign_event", ["{}"], { timeoutMs: 1000 })

    await Promise.resolve()
    const sent = JSON.parse(
      (relay.published[0].content as string).slice(encodedPrefix.length),
    ) as { id: string }

    relay.emit({ id: sent.id, error: "user rejected" })
    await expect(pending).rejects.toThrow("user rejected")
    transport.close()
  })

  it("ignores responses from an author other than the pinned signer", async () => {
    const { transport, relay } = await connected()
    const pending = transport.request("get_public_key", [], { timeoutMs: 30 })

    await Promise.resolve()
    const sent = JSON.parse(
      (relay.published[0].content as string).slice(encodedPrefix.length),
    ) as { id: string }

    relay.emit({ id: sent.id, result: "impostor" }, "f".repeat(64))
    await expect(pending).rejects.toThrow("timed out")
    transport.close()
  })

  it("ignores auth_url prompts rather than treating them as a result", async () => {
    const { transport, relay } = await connected()
    const pending = transport.request("sign_event", ["{}"], { timeoutMs: 30 })

    await Promise.resolve()
    const sent = JSON.parse(
      (relay.published[0].content as string).slice(encodedPrefix.length),
    ) as { id: string }

    relay.emit({ id: sent.id, result: "auth_url", error: "https://signer.example" })
    await expect(pending).rejects.toThrow("timed out")
    transport.close()
  })

  it("ignores id-less events once the signer is pinned", async () => {
    const { transport, relay } = await connected()
    const pending = transport.request("get_public_key", [], { timeoutMs: 40 })

    await Promise.resolve()
    // The ack listener is cleared after pinning, so a stray id-less payload has
    // nothing to resolve and must not settle an in-flight request.
    relay.emit({ result: "c".repeat(64) })
    relay.emit({ result: "s" })

    await expect(pending).rejects.toThrow("timed out")
    transport.close()
  })

  it("fails when the request cannot be published to any relay", async () => {
    const { transport, relay } = await connected()
    relay.publishResult = "fail"

    await expect(
      transport.request("get_public_key", [], { timeoutMs: 100 }),
    ).rejects.toThrow("failed to publish request to any relay")
    transport.close()
  })
})

describe("Nip46Transport.close", () => {
  it("closes subscriptions, rejects in-flight requests and destroys an owned pool", async () => {
    const pool = new FakePool()
    const transport = new Nip46Transport({ relays: ["wss://a"], pool })
    await transport.open({ timeoutMs: 1000 })
    const relay = pool.relays.get("wss://a") as FakeRelay

    const ack = transport.waitForConnectAck({ secret: "s", timeoutMs: 1000 })
    relay.emit({ id: "1", result: "s" })
    await ack

    const pending = transport.request("sign_event", ["{}"], { timeoutMs: 5000 })
    await Promise.resolve()

    transport.close()

    await expect(pending).rejects.toThrow("transport closed")
    expect(relay.subClosed).toBe(true)
    // The pool was injected, so the transport must not destroy it.
    expect(pool.destroyed).toBe(false)
    expect(relay.closed).toBe(false)

    // Idempotent.
    expect(() => transport.close()).not.toThrow()
  })
})
