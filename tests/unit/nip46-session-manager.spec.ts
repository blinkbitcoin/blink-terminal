/**
 * @jest-environment node
 *
 * Nip46SessionManager — the worker that drives connect ack -> get_public_key ->
 * sign_event, plus the resource caps and the pod-restart story.
 *
 * The transport is stubbed: transport.spec.ts already pins the relay ordering,
 * so here we care about what the manager does with the RPC results.
 */

const verifySignedEvent = jest.fn()

jest.mock("../../lib/nostr/Nip98Verifier", () => ({
  __esModule: true,
  default: {
    verifySignedEvent: (...args: unknown[]) => verifySignedEvent(...args),
  },
}))

jest.mock("../../lib/shutdown", () => ({
  onShutdown: jest.fn(),
}))

const transports: FakeTransport[] = []

interface TransportConfig {
  openError?: Error
  ackError?: Error
  responses?: Record<string, string | Error>
  /** When set, sign_event waits on this before answering. */
  signGate?: Promise<void>
  /** When set, open() waits on this — the barrier for concurrent-create tests. */
  openGate?: Promise<void>
}

/**
 * Configuration for the NEXT transport the manager constructs. The worker is
 * detached and starts running inside create(), so anything a test wants it to
 * see has to be in place beforehand.
 */
let nextTransportConfig: TransportConfig = {}

class FakeTransport {
  readonly clientPubkey = "c".repeat(64)
  readonly readyRelays = ["wss://a"]
  pinnedSignerPubkey: string | null = null
  closed = false
  openError: Error | null = null
  ackError: Error | null = null
  responses: Record<string, string | Error>
  signGate: Promise<void> | null
  openGate: Promise<void> | null
  requested: { method: string; params: string[] }[] = []

  constructor() {
    const config = nextTransportConfig
    this.openError = config.openError ?? null
    this.ackError = config.ackError ?? null
    this.responses = config.responses ?? { ...HAPPY_PATH_RESPONSES }
    this.signGate = config.signGate ?? null
    this.openGate = config.openGate ?? null
    transports.push(this)
  }

  async open(): Promise<{ readyRelays: string[] }> {
    if (this.openGate) await this.openGate
    if (this.openError) throw this.openError
    return { readyRelays: this.readyRelays }
  }

  async waitForConnectAck(): Promise<{ signerPubkey: string }> {
    if (this.ackError) throw this.ackError
    this.pinnedSignerPubkey = SIGNER
    return { signerPubkey: SIGNER }
  }

  async request(method: string, params: string[]): Promise<string> {
    this.requested.push({ method, params })
    if (method === "sign_event" && this.signGate) await this.signGate
    const response = this.responses[method]
    if (response instanceof Error) throw response
    if (response === undefined) throw new Error(`${method} timed out`)
    return response
  }

  close(): void {
    this.closed = true
  }
}

jest.mock("../../lib/nip46-server/transport", () => ({
  Nip46Transport: jest.fn(() => new FakeTransport()),
}))

const HAPPY_PATH_RESPONSES: Record<string, string | Error> = {
  get_public_key: "a".repeat(64),
  sign_event: JSON.stringify({ kind: 27235, pubkey: "a".repeat(64) }),
}

import {
  buildConsumeUrl,
  buildNostrConnectUri,
  Nip46CapacityError,
  Nip46RelayUnavailableError,
  Nip46SessionManager,
} from "../../lib/nip46-server/sessionManager"
import {
  __resetSessionStoreForTests,
  getSession,
  sha256Hex,
} from "../../lib/nip46-server/sessionStore"

const SIGNER = "b".repeat(64)
const USER = "a".repeat(64)
const ORIGIN = "https://pos.example"

function latest(): FakeTransport {
  return transports[transports.length - 1]
}

/** Let the detached worker run to completion. */
async function settleWorker(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  }
}

/**
 * Keep the next session parked at sign_event so it stays live/pending for the
 * duration of the test (caps, supersession, restart and shutdown all need a
 * session that has not finished yet).
 */
function stayPending(): void {
  nextTransportConfig = { signGate: new Promise<void>(() => undefined) }
}

let manager: Nip46SessionManager

beforeEach(() => {
  transports.length = 0
  nextTransportConfig = {}
  __resetSessionStoreForTests()
  verifySignedEvent.mockReset()
  verifySignedEvent.mockResolvedValue({ valid: true, pubkey: USER })
  manager = new Nip46SessionManager()
  delete process.env.NIP46_MAX_SESSIONS
  delete process.env.NIP46_MAX_SESSIONS_PER_IP
})

afterEach(() => {
  manager.__resetForTests()
})

describe("create", () => {
  it("returns a URI only after the transport is open, and keeps the session live", async () => {
    stayPending()
    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })

    expect(created.uri).toContain(`nostrconnect://${latest().clientPubkey}`)
    expect(created.readyRelays).toEqual(["wss://a"])
    expect(manager.isLive(created.sessionId)).toBe(true)

    const record = await getSession(created.sessionId)
    expect(record?.status).toBe("pending")
    expect(record?.bindingHash).toBe(sha256Hex(created.bindingSecret))
    expect(record?.expectedUrl).toBe(buildConsumeUrl(ORIGIN, created.sessionId))
  })

  it("fails closed when no relay can be reached, and persists nothing", async () => {
    nextTransportConfig = { openError: new Error("all relays failed to connect") }

    await expect(
      manager.create({ ip: "1.2.3.4", origin: ORIGIN }),
    ).rejects.toBeInstanceOf(Nip46RelayUnavailableError)
    expect(latest().closed).toBe(true)
    expect(manager.liveCount).toBe(0)
  })

  it("caps concurrent sessions per IP", async () => {
    process.env.NIP46_MAX_SESSIONS_PER_IP = "2"

    stayPending()
    await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    stayPending()
    await manager.create({ ip: "1.2.3.4", origin: ORIGIN })

    stayPending()
    await expect(
      manager.create({ ip: "1.2.3.4", origin: ORIGIN }),
    ).rejects.toBeInstanceOf(Nip46CapacityError)
    // A different client is unaffected.
    stayPending()
    await expect(manager.create({ ip: "5.6.7.8", origin: ORIGIN })).resolves.toBeDefined()
  })

  it("caps concurrent sessions globally", async () => {
    process.env.NIP46_MAX_SESSIONS = "1"

    stayPending()
    await manager.create({ ip: "1.1.1.1", origin: ORIGIN })
    stayPending()
    await expect(
      manager.create({ ip: "2.2.2.2", origin: ORIGIN }),
    ).rejects.toBeInstanceOf(Nip46CapacityError)
  })

  /**
   * Caps must bind on CONCURRENT creates, not just sequential ones.
   *
   * Relay setup takes up to RELAY_READY_TIMEOUT_MS, and the session only became
   * visible in `live` afterwards. Every create in a burst therefore saw the same
   * count and none of them blocked, so a burst could open unbounded relay
   * sockets and blow through both caps (PR #71 review). These hold every create
   * inside open() on one barrier, so they are all in flight simultaneously.
   */
  describe("concurrent creates", () => {
    /** Release-on-demand barrier that all in-flight transports wait on. */
    function barrier(): { release: () => void } {
      let release!: () => void
      nextTransportConfig = {
        openGate: new Promise<void>((resolve) => {
          release = resolve
        }),
      }
      return { release }
    }

    it("enforces the per-IP cap against a simultaneous burst", async () => {
      process.env.NIP46_MAX_SESSIONS_PER_IP = "2"
      const gate = barrier()

      // All three enter create() before any of them finishes opening.
      const attempts = [
        manager.create({ ip: "1.2.3.4", origin: ORIGIN }),
        manager.create({ ip: "1.2.3.4", origin: ORIGIN }),
        manager.create({ ip: "1.2.3.4", origin: ORIGIN }),
      ]
      const settled = attempts.map((p) => p.catch((error: unknown) => error))

      // The third is rejected synchronously, before any relay work happens.
      expect(transports).toHaveLength(2)

      gate.release()
      const results = await Promise.all(settled)

      const rejected = results.filter((r) => r instanceof Nip46CapacityError)
      expect(rejected).toHaveLength(1)
      expect(results.filter((r) => !(r instanceof Error))).toHaveLength(2)
      expect(manager.liveCount).toBe(2)
      expect(manager.__reservedCount).toBe(0)
    })

    it("enforces the global cap against a simultaneous burst from many IPs", async () => {
      process.env.NIP46_MAX_SESSIONS = "3"
      const gate = barrier()

      const attempts = Array.from({ length: 6 }, (_unused, i) =>
        manager.create({ ip: `10.0.0.${i}`, origin: ORIGIN }),
      )
      const settled = attempts.map((p) => p.catch((error: unknown) => error))

      expect(transports).toHaveLength(3)

      gate.release()
      const results = await Promise.all(settled)

      expect(results.filter((r) => r instanceof Nip46CapacityError)).toHaveLength(3)
      expect(manager.liveCount).toBe(3)
      expect(manager.__reservedCount).toBe(0)
    })

    it("releases the reservation when relay setup fails, freeing the slot", async () => {
      process.env.NIP46_MAX_SESSIONS_PER_IP = "1"
      nextTransportConfig = { openError: new Error("all relays failed to connect") }

      await expect(
        manager.create({ ip: "1.2.3.4", origin: ORIGIN }),
      ).rejects.toBeInstanceOf(Nip46RelayUnavailableError)

      expect(manager.__reservedCount).toBe(0)
      expect(manager.liveCount).toBe(0)

      // The failed attempt must not have permanently consumed the client's slot.
      stayPending()
      await expect(
        manager.create({ ip: "1.2.3.4", origin: ORIGIN }),
      ).resolves.toBeDefined()
    })

    it("frees a slot again once a session finishes", async () => {
      process.env.NIP46_MAX_SESSIONS_PER_IP = "1"

      const first = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
      await settleWorker()
      // The happy path completes and tears down, releasing the slot.
      expect(manager.isLive(first.sessionId)).toBe(false)

      await expect(
        manager.create({ ip: "1.2.3.4", origin: ORIGIN }),
      ).resolves.toBeDefined()
    })
  })

  it("supersedes the caller's previous session instead of stacking sockets", async () => {
    stayPending()
    const first = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    const firstTransport = latest()

    stayPending()
    const second = await manager.create({
      ip: "1.2.3.4",
      origin: ORIGIN,
      previousBindingHash: sha256Hex(first.bindingSecret),
    })

    expect(firstTransport.closed).toBe(true)
    expect(manager.isLive(first.sessionId)).toBe(false)
    expect(manager.isLive(second.sessionId)).toBe(true)
    expect((await getSession(first.sessionId))?.status).toBe("failed")
  })
})

describe("worker", () => {
  it("approves the session after a verified kind-27235 signature", async () => {
    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    await settleWorker()

    const record = await getSession(created.sessionId)
    expect(record?.status).toBe("approved")
    expect(record?.pubkey).toBe(USER)

    // The socket is released as soon as its job is done.
    expect(latest().closed).toBe(true)
    expect(manager.isLive(created.sessionId)).toBe(false)
  })

  it("asks the signer to sign the canonical u, method and per-session challenge", async () => {
    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    await settleWorker()

    const signRequest = latest().requested.find((r) => r.method === "sign_event")
    const template = JSON.parse(signRequest?.params[0] ?? "{}") as {
      kind: number
      tags: string[][]
    }
    const tags = Object.fromEntries(template.tags.map(([k, v]) => [k, v]))

    expect(template.kind).toBe(27235)
    expect(tags.u).toBe(buildConsumeUrl(ORIGIN, created.sessionId))
    expect(tags.method).toBe("POST")
    expect(tags.challenge).toEqual(expect.any(String))

    // ...and verifies against exactly those values.
    expect(verifySignedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        url: buildConsumeUrl(ORIGIN, created.sessionId),
        method: "POST",
        challenge: tags.challenge,
        expectedPubkey: USER,
      }),
    )
  })

  it("fails the session when the connect ack never arrives", async () => {
    nextTransportConfig = { ackError: new Error("connect ack timed out") }

    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    await settleWorker()

    const record = await getSession(created.sessionId)
    expect(record?.status).toBe("failed")
    expect(record?.error).toBe("connect_timeout")
  })

  it("fails the session when the signer rejects the sign request", async () => {
    nextTransportConfig = {
      responses: {
        get_public_key: USER,
        sign_event: new Error("user rejected"),
      },
    }

    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    await settleWorker()

    expect((await getSession(created.sessionId))?.error).toBe("signer_rejected")
  })

  it("fails the session when the sign request times out", async () => {
    nextTransportConfig = {
      responses: {
        get_public_key: USER,
        sign_event: new Error("sign_event timed out"),
      },
    }

    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    await settleWorker()

    expect((await getSession(created.sessionId))?.error).toBe("signing_timeout")
  })

  it("fails the session when get_public_key returns junk", async () => {
    nextTransportConfig = { responses: { get_public_key: "not-a-pubkey" } }

    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    await settleWorker()

    expect((await getSession(created.sessionId))?.error).toBe("verification_failed")
  })

  it("fails the session when the signed event does not verify", async () => {
    verifySignedEvent.mockResolvedValue({ valid: false, error: "Challenge mismatch" })

    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    await settleWorker()

    const record = await getSession(created.sessionId)
    expect(record?.status).toBe("failed")
    expect(record?.error).toBe("verification_failed")
  })

  it("does not approve a session that was cancelled while signing", async () => {
    let releaseSigning!: () => void
    nextTransportConfig = {
      signGate: new Promise<void>((resolve) => {
        releaseSigning = resolve
      }),
    }

    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    await settleWorker()

    await manager.cancel(created.sessionId)
    releaseSigning()
    await settleWorker()

    const record = await getSession(created.sessionId)
    expect(record?.status).toBe("failed")
    expect(record?.error).toBe("cancelled")
  })
})

describe("resolveStatus", () => {
  it("reports a live pending session as pending", async () => {
    stayPending()
    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    const record = await getSession(created.sessionId)

    const status = await manager.resolveStatus(record!)
    expect(status.status).toBe("pending")
  })

  it("reports a pending session with no live worker as server_restarted", async () => {
    stayPending()
    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    const record = await getSession(created.sessionId)

    // Simulate a pod restart: metadata survives in Redis, the worker does not.
    const restarted = new Nip46SessionManager()
    const status = await restarted.resolveStatus(record!)

    expect(status.status).toBe("failed")
    expect(status.error).toBe("server_restarted")
    // Persisted too, so a later poll is consistent.
    expect((await getSession(created.sessionId))?.error).toBe("server_restarted")
  })

  it("exposes the pubkey only once approved", async () => {
    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    await settleWorker()

    const record = await getSession(created.sessionId)
    const status = await manager.resolveStatus(record!)

    expect(status.status).toBe("approved")
    expect(status.pubkey).toBe(USER)
  })
})

describe("consume", () => {
  it("mints exactly one login from an approval and drops the live session", async () => {
    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    await settleWorker()

    const first = await manager.consume(created.sessionId, created.bindingSecret)
    expect(first).toEqual({ ok: true, pubkey: USER })

    const second = await manager.consume(created.sessionId, created.bindingSecret)
    expect(second.ok).toBe(false)
    expect(manager.isLive(created.sessionId)).toBe(false)
  })

  it("refuses a caller without the binding cookie", async () => {
    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    await settleWorker()

    expect((await manager.consume(created.sessionId, undefined)).ok).toBe(false)
    // The real owner can still finish.
    expect((await manager.consume(created.sessionId, created.bindingSecret)).ok).toBe(
      true,
    )
  })
})

describe("shutdown", () => {
  it("marks live pending sessions as server_restarted and releases sockets", async () => {
    stayPending()
    const created = await manager.create({ ip: "1.2.3.4", origin: ORIGIN })
    const transport = latest()

    await manager.shutdown()

    expect(transport.closed).toBe(true)
    expect(manager.liveCount).toBe(0)
    expect((await getSession(created.sessionId))?.error).toBe("server_restarted")
  })
})

describe("buildNostrConnectUri", () => {
  it("advertises the relays, secret and the permissions the flow needs", () => {
    const uri = buildNostrConnectUri({
      clientPubkey: "c".repeat(64),
      relays: ["wss://a", "wss://b"],
      secret: "s3cret",
      appOrigin: ORIGIN,
    })

    expect(uri.startsWith(`nostrconnect://${"c".repeat(64)}?`)).toBe(true)
    const params = new URLSearchParams(uri.split("?")[1])
    expect(params.getAll("relay")).toEqual(["wss://a", "wss://b"])
    expect(params.get("secret")).toBe("s3cret")
    expect(params.get("perms")).toBe("sign_event:27235,get_public_key")
    expect(params.get("url")).toBe(ORIGIN)
  })
})
