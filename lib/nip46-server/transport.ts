/**
 * Server-held NIP-46 transport.
 *
 * WHY THIS EXISTS (issue #70)
 * ---------------------------
 * NIP-46 responses are ephemeral: the signer publishes each one exactly once. A
 * missed response is unrecoverable. The browser cannot hold that subscription on
 * a same-device deeplink flow, because Android freezes the tab (and discards the
 * WebSocket) the moment the signer app is opened. So the socket lives here.
 *
 * THE ORDERING INVARIANT
 * ----------------------
 * The nostrconnect:// URI must not reach the browser until we are listening:
 * the connect ack is one-shot too. `open()` therefore resolves only after at
 * least one relay is connected, its event handler is attached, AND its
 * kind-24133 REQ has actually been written to the socket.
 *
 * We deliberately do NOT use `BunkerSigner.fromURI` for this. It calls
 * `pool.subscribe(...)` and returns synchronously; the REQ is written on a later
 * microtask and nothing observable reports when. Human delay usually hides that
 * race but does not order it. Here we drive the two public primitives directly —
 * `prepareSubscription()` (registers the handler) and `await relay.send(REQ)`
 * (writes the frame) — so "ready" is an awaited fact rather than a hope.
 *
 * The private key minted for a session lives only in this object, in memory. It
 * is never persisted (see sessionStore.ts, which holds TTL-bound metadata only).
 */

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  type Event as NostrEvent,
  type EventTemplate,
} from "nostr-tools"

/** NIP-46 "Nostr Connect" event kind. */
export const NOSTR_CONNECT_KIND = 24133

/**
 * Structural subset of nostr-tools' AbstractRelay / SimplePool that we depend
 * on. Declared structurally (rather than importing the classes) so tests can
 * inject a fake pool and assert the connect/subscribe/send ordering without a
 * live socket.
 */
export interface RelaySubscriptionLike {
  readonly id: string
  close(reason?: string): void
}

export interface RelayLike {
  readonly url: string
  prepareSubscription(
    filters: Record<string, unknown>[],
    params: {
      onevent?: (event: NostrEvent) => void
      onclose?: (reason: string) => void
    },
  ): RelaySubscriptionLike
  send(message: string): Promise<void>
  publish(event: NostrEvent): Promise<string>
  close(): void
}

export interface PoolLike {
  ensureRelay(url: string, params?: { connectionTimeout?: number }): Promise<RelayLike>
  destroy(): void
}

export interface Nip46TransportOptions {
  relays: string[]
  /** Injected in tests; defaults to a real SimplePool. */
  pool?: PoolLike
  /** Injected in tests; defaults to a fresh random key. */
  secretKey?: Uint8Array
}

export interface OpenResult {
  /** Relays that are connected AND subscribed. Never empty on success. */
  readyRelays: string[]
}

export interface ConnectAck {
  signerPubkey: string
}

interface PendingRequest {
  resolve: (result: string) => void
  reject: (error: Error) => void
}

interface SettlerOptions {
  timeoutMs: number
  signal?: AbortSignal
  onTimeout: () => void
  onAbort: (error: Error) => void
  /** Runs exactly once, on whichever outcome wins. */
  onSettle: () => void
}

interface Settler {
  settle: (fn: () => void) => void
  /** True when the abort signal was already aborted at construction time. */
  alreadySettled: boolean
}

/**
 * One-shot settlement guard shared by the ack wait and the RPC wait: whichever
 * of {response, timeout, abort} lands first wins, and the timer/listener/map
 * entry are cleaned up exactly once.
 */
function createSettler(options: SettlerOptions): Settler {
  let done = false
  let removeAbortListener: (() => void) | undefined

  const settle = (fn: () => void): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    removeAbortListener?.()
    options.onSettle()
    fn()
  }

  const timer = setTimeout(() => settle(options.onTimeout), options.timeoutMs)
  if (timer.unref) timer.unref()

  if (options.signal) {
    const signal = options.signal
    removeAbortListener = onAbort(signal, () =>
      settle(() => options.onAbort(abortError(signal))),
    )
  }

  return { settle, alreadySettled: done }
}

class Nip46TransportError extends Error {}

function abortError(signal: AbortSignal): Error {
  return new Nip46TransportError(String(signal.reason ?? "aborted"))
}

/**
 * Lazily create a real SimplePool. Imported through nostr-tools' root entry so
 * it type-checks under `moduleResolution: node`.
 */
async function createDefaultPool(): Promise<PoolLike> {
  const { SimplePool } = await import("nostr-tools")
  return new SimplePool() as unknown as PoolLike
}

export class Nip46Transport {
  private readonly relayUrls: string[]
  private readonly secretKey: Uint8Array
  readonly clientPubkey: string

  private pool: PoolLike | null = null
  private readonly ownsPool: boolean
  private readonly subscriptions = new Map<
    string,
    { relay: RelayLike; sub: RelaySubscriptionLike }
  >()

  private readonly pending = new Map<string, PendingRequest>()
  private ackListener: ((event: NostrEvent, payload: RpcPayload) => void) | null = null

  /** Pinned once the connect ack identifies the signer. */
  private signerPubkey: string | null = null
  private conversationKey: Uint8Array | null = null
  private serial = 0
  private closed = false

  constructor(options: Nip46TransportOptions) {
    this.relayUrls = [...options.relays]
    this.secretKey = options.secretKey ?? generateSecretKey()
    this.clientPubkey = getPublicKey(this.secretKey)
    this.pool = options.pool ?? null
    this.ownsPool = !options.pool
  }

  /** Relays currently connected and subscribed. */
  get readyRelays(): string[] {
    return [...this.subscriptions.keys()]
  }

  get pinnedSignerPubkey(): string | null {
    return this.signerPubkey
  }

  /**
   * Connect and subscribe. Resolves as soon as the FIRST relay is fully ready
   * (connected + handler attached + REQ written); the remaining relays keep
   * connecting in the background and attach their own subscription when they
   * land. Rejects only if every relay fails or the timeout elapses with none
   * ready — we must never hand out a URI nobody is listening for.
   */
  async open(options: { timeoutMs: number; signal?: AbortSignal }): Promise<OpenResult> {
    if (this.relayUrls.length === 0) {
      throw new Nip46TransportError("no relays configured")
    }
    if (!this.pool) {
      this.pool = await createDefaultPool()
    }

    const attempts = this.relayUrls.map((url) => this.connectAndSubscribe(url))

    // Swallow late rejections so a relay failing after we already succeeded
    // never surfaces as an unhandled rejection.
    attempts.forEach((attempt) => attempt.catch(() => undefined))

    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Nip46TransportError("no relay became ready in time")),
        options.timeoutMs,
      )
      if (timer.unref) timer.unref()
    })

    const raced: Promise<unknown>[] = [Promise.any(attempts), timeout]
    if (options.signal) {
      raced.push(rejectOnAbort(options.signal))
    }

    try {
      await Promise.race(raced)
    } catch (error: unknown) {
      // Promise.any rejects with an AggregateError when every relay failed.
      if (error instanceof AggregateError) {
        throw new Nip46TransportError("all relays failed to connect")
      }
      throw error
    }

    return { readyRelays: this.readyRelays }
  }

  private async connectAndSubscribe(url: string): Promise<void> {
    const pool = this.pool
    if (!pool) throw new Nip46TransportError("transport not opened")

    const relay = await pool.ensureRelay(url)
    if (this.closed) {
      throw new Nip46TransportError("transport closed")
    }

    // prepareSubscription registers the handler; send() writes the REQ frame.
    // Splitting them (instead of relay.subscribe()) is what makes readiness
    // observable — see the header comment.
    const filter = {
      "kinds": [NOSTR_CONNECT_KIND],
      "#p": [this.clientPubkey],
      "limit": 0,
    }
    const sub = relay.prepareSubscription([filter], {
      onevent: (event: NostrEvent) => this.handleEvent(event),
      onclose: () => {
        this.subscriptions.delete(url)
      },
    })

    await relay.send(
      `["REQ",${JSON.stringify(sub.id)},${JSON.stringify([filter]).substring(1)}`,
    )

    if (this.closed) {
      sub.close("transport closed")
      throw new Nip46TransportError("transport closed")
    }

    this.subscriptions.set(url, { relay, sub })
  }

  /**
   * Wait for the signer's connect acknowledgement for `secret`.
   *
   * Per NIP-46 the signer answers a nostrconnect:// handshake with the secret
   * echoed back; some signers answer with "ack" instead, so both are accepted.
   * The acknowledging author is pinned as the signer for the rest of the
   * session and every later response is required to come from it.
   */
  async waitForConnectAck(options: {
    secret: string
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<ConnectAck> {
    if (this.signerPubkey) return { signerPubkey: this.signerPubkey }

    return new Promise<ConnectAck>((resolve, reject) => {
      const settled = createSettler({
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        onTimeout: () => reject(new Nip46TransportError("connect ack timed out")),
        onAbort: (error: Error) => reject(error),
        onSettle: () => {
          this.ackListener = null
        },
      })

      this.ackListener = (event: NostrEvent, payload: RpcPayload): void => {
        if (payload.result !== options.secret && payload.result !== "ack") return
        this.pinSigner(event.pubkey)
        settled.settle(() => resolve({ signerPubkey: event.pubkey }))
      }

      if (settled.alreadySettled) this.ackListener = null
    })
  }

  /** Issue a NIP-46 RPC against the pinned signer. */
  async request(
    method: string,
    params: string[],
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<string> {
    const signerPubkey = this.signerPubkey
    const conversationKey = this.conversationKey
    if (!signerPubkey || !conversationKey) {
      throw new Nip46TransportError("signer not connected")
    }
    if (this.subscriptions.size === 0) {
      throw new Nip46TransportError("no relay connection")
    }

    this.serial += 1
    const id = `${this.clientPubkey.slice(0, 8)}-${this.serial}`

    const template: EventTemplate = {
      kind: NOSTR_CONNECT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", signerPubkey]],
      content: nip44.encrypt(JSON.stringify({ id, method, params }), conversationKey),
    }
    const event = finalizeEvent(template, this.secretKey)

    const response = new Promise<string>((resolve, reject) => {
      const settled = createSettler({
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        onTimeout: () => reject(new Nip46TransportError(`${method} timed out`)),
        onAbort: (error: Error) => reject(error),
        onSettle: () => {
          this.pending.delete(id)
        },
      })

      if (settled.alreadySettled) return

      this.pending.set(id, {
        resolve: (result: string) => settled.settle(() => resolve(result)),
        reject: (error: Error) => settled.settle(() => reject(error)),
      })
    })

    // The caller only adopts `response` a few microtasks from now (we still have
    // to publish). close() can reject it before then, so attach a handler
    // immediately: the real consumer still sees the rejection, but Node does not
    // report it as unhandled in that window.
    response.catch(() => undefined)

    const publishes = [...this.subscriptions.values()].map(({ relay }) =>
      relay.publish(event),
    )
    publishes.forEach((publish) => publish.catch(() => undefined))

    try {
      await Promise.any(publishes)
    } catch {
      throw new Nip46TransportError("failed to publish request to any relay")
    }

    return response
  }

  private pinSigner(pubkey: string): void {
    this.signerPubkey = pubkey
    this.conversationKey = nip44.getConversationKey(this.secretKey, pubkey)
  }

  private handleEvent(event: NostrEvent): void {
    if (this.closed) return
    // Once pinned, only the signer may answer us.
    if (this.signerPubkey && event.pubkey !== this.signerPubkey) return

    const conversationKey =
      this.conversationKey ?? nip44.getConversationKey(this.secretKey, event.pubkey)

    let payload: RpcPayload
    try {
      payload = JSON.parse(nip44.decrypt(event.content, conversationKey)) as RpcPayload
    } catch {
      // Not addressed to us / undecryptable / malformed — ignore. Relays are
      // public; unrelated traffic is expected.
      return
    }
    if (!payload || typeof payload.id !== "string") return

    // auth_url is an out-of-band prompt, not an RPC result. We cannot surface a
    // signer-hosted popup from a headless worker, so ignore it and let the
    // request time out with its own error.
    if (payload.result === "auth_url") return

    const waiter = this.pending.get(payload.id)
    if (waiter) {
      if (payload.error) {
        waiter.reject(new Nip46TransportError(payload.error))
      } else {
        waiter.resolve(payload.result ?? "")
      }
      return
    }

    this.ackListener?.(event, payload)
  }

  /** Close every subscription and socket this transport owns. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true

    for (const { sub, relay } of this.subscriptions.values()) {
      try {
        sub.close("session finished")
      } catch {
        // best effort
      }
      if (!this.ownsPool) continue
      try {
        relay.close()
      } catch {
        // best effort
      }
    }
    this.subscriptions.clear()

    // reject() runs through the settler, which clears the request's timer and
    // removes it from `pending`.
    for (const waiter of [...this.pending.values()]) {
      waiter.reject(new Nip46TransportError("transport closed"))
    }
    this.pending.clear()
    this.ackListener = null

    if (this.ownsPool && this.pool) {
      try {
        this.pool.destroy()
      } catch {
        // best effort
      }
    }
    this.pool = null
  }
}

interface RpcPayload {
  id?: string
  result?: string
  error?: string
}

function onAbort(signal: AbortSignal, handler: () => void): () => void {
  if (signal.aborted) {
    handler()
    return () => undefined
  }
  signal.addEventListener("abort", handler, { once: true })
  return () => signal.removeEventListener("abort", handler)
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    onAbort(signal, () => reject(abortError(signal)))
  })
}

export { Nip46TransportError }
