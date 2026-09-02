/**
 * NostrConnectService — overlapping-attempt ownership (PR #61 round-4 HIGH blocker).
 *
 * Exercises the REAL service class with only the nostr-tools transport boundary mocked
 * (BunkerSigner.fromURI/fromBunker return controllable deferred signers). The modal-side
 * generation guard cannot see these races — the service singleton itself must refuse to
 * publish or clear shared state for a superseded attempt.
 *
 * Scenarios (the exact hazards from the review):
 *  - stale A SUCCESS after B started: A's candidate is closed, B's signer/session untouched
 *  - stale A FAILURE after B succeeded: B stays connected, signer not cleared
 *  - disconnect() while A pending: A's late settle is inert
 *  - stale restore superseded by a newer attempt: publishes nothing
 *
 * @jest-environment jsdom
 */

// Deferred signer factory: each BunkerSigner.fromURI/fromBunker call returns a controllable
// candidate whose getPublicKey/close are tracked per attempt.
interface FakeSigner {
  bp: { pubkey: string; relays: string[]; secret?: string }
  getPublicKey: jest.Mock
  ping: jest.Mock
  signEvent: jest.Mock
  connect: jest.Mock
  close: jest.Mock
}

const makeFakeSigner = (pubkey: string): FakeSigner => ({
  bp: { pubkey, relays: ["wss://r.example"] },
  getPublicKey: jest.fn(async () => "user-" + pubkey),
  ping: jest.fn(async () => undefined),
  signEvent: jest.fn(),
  connect: jest.fn(async () => undefined),
  close: jest.fn(async () => undefined),
})

// Each fromURI/fromBunker call hands the NEXT factory in this queue. Tests enqueue one per
// attempt they expect the service to create.
const signerQueue: Array<() => FakeSigner | Promise<FakeSigner>> = []

jest.mock("nostr-tools/nip46", () => ({
  __esModule: true,
  BunkerSigner: {
    fromURI: jest.fn(() => {
      const next = signerQueue.shift()
      if (!next) return Promise.reject(new Error("no fake signer queued"))
      return Promise.resolve(next())
    }),
    fromBunker: jest.fn(() => {
      const next = signerQueue.shift()
      if (!next) return Promise.reject(new Error("no fake signer queued"))
      return next()
    }),
  },
  // createNostrConnectURI builds a real URI from the passed params so the perms assertion
  // below reflects what the service actually advertises (perms land in the query string).
  createNostrConnectURI: jest.fn(
    (params: {
      clientPubkey: string
      relays: string[]
      secret: string
      perms?: string[]
    }) =>
      `nostrconnect://${params.clientPubkey}` +
      `?secret=${params.secret}` +
      params.relays.map((r) => `&relay=${encodeURIComponent(r)}`).join("") +
      (params.perms ? `&perms=${encodeURIComponent(params.perms.join(","))}` : ""),
  ),
}))

// Each `new SimplePool()` yields a distinct, identifiable instance so tests can assert WHICH
// pool the singleton holds and whether a given pool was closed.
jest.mock("nostr-tools/pool", () => {
  let seq = 0
  return {
    __esModule: true,
    SimplePool: jest.fn(() => ({ id: ++seq, close: jest.fn() })),
  }
})

// The service's ESM imports (nostr-tools/pure, @noble/hashes) cannot be parsed by jest —
// mock them at the boundary; the overlap tests never exercise real crypto.
jest.mock("nostr-tools/pure", () => ({
  __esModule: true,
  generateSecretKey: jest.fn(() => new Uint8Array(32).fill(7)),
  getPublicKey: jest.fn(() => "clientpubkey"),
}))
jest.mock("@noble/hashes/utils", () => ({
  __esModule: true,
  bytesToHex: jest.fn(() => "mockhex"),
  hexToBytes: jest.fn(() => new Uint8Array(32)),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports -- required after the module mocks above
const NostrConnectService = require("../../lib/nostr/NostrConnectService")
  .default as typeof import("../../lib/nostr/NostrConnectService").default

const URI = "nostrconnect://clientpubkey?relay=wss%3A%2F%2Fr.example&secret=s"

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe("NostrConnectService — overlapping attempt ownership (round-4)", () => {
  beforeEach(() => {
    signerQueue.length = 0
    localStorage.clear()
    // Reset the singleton's static state so tests don't leak into each other.
    NostrConnectService.signer = null
    NostrConnectService.pool = null
    NostrConnectService.connectionState = "disconnected"
    NostrConnectService.userPublicKey = null
  })

  /**
   * Round-1 perms fix regression: the connection URI must advertise the kind actually signed
   * at login (NIP-98 = 27235), not 22242 — strict signers enforce declared perms.
   */
  it("generateConnectionURI advertises sign_event:27235 (NIP-98) + get_public_key, never 22242", () => {
    const uri: string = NostrConnectService.generateConnectionURI()
    expect(uri).toContain("sign_event%3A27235")
    expect(uri).toContain("get_public_key")
    expect(uri).not.toContain("22242")
  })

  it("stale attempt's late SUCCESS does not overwrite the newer attempt's signer/session", async () => {
    // Attempt A: fromURI resolves only when the test releases it.
    let resolveA: (s: FakeSigner) => void = () => {}
    const signerA = makeFakeSigner("signerA")
    signerQueue.push(() => new Promise<FakeSigner>((r) => (resolveA = r)))
    // Attempt B: resolves immediately with its own signer.
    const signerB = makeFakeSigner("signerB")
    signerQueue.push(() => signerB)

    const attemptA = NostrConnectService.waitForConnection(URI)
    await flush()
    const attemptB = NostrConnectService.waitForConnection(URI)
    // B settles first and wins.
    await attemptB
    expect(NostrConnectService.signer).toBe(signerB)

    // A settles LATE — its success must be inert: candidate closed, B untouched.
    resolveA(signerA)
    const resultA = await attemptA
    await flush()

    expect(resultA.success).toBe(false)
    expect(resultA.error).toMatch(/superseded/i)
    expect(signerA.close).toHaveBeenCalled()
    expect(NostrConnectService.signer).toBe(signerB)
    expect(NostrConnectService.connectionState).toBe("connected")
    expect(NostrConnectService.userPublicKey).toBe("user-signerB")
  })

  it("stale attempt's late FAILURE does not clear the newer live connection", async () => {
    // Attempt A rejects late.
    let rejectA: (e: Error) => void = () => {}
    signerQueue.push(() => new Promise<FakeSigner>((_r, rej) => (rejectA = rej)))
    const signerB = makeFakeSigner("signerB")
    signerQueue.push(() => signerB)

    const attemptA = NostrConnectService.waitForConnection(URI)
    await flush()
    await NostrConnectService.waitForConnection(URI) // B wins
    expect(NostrConnectService.signer).toBe(signerB)

    rejectA(new Error("timed out"))
    await attemptA
    await flush()

    // B's live signer must NOT have been cleared by A's late failure.
    expect(NostrConnectService.signer).toBe(signerB)
    expect(NostrConnectService.connectionState).toBe("connected")
  })

  it("disconnect() invalidates a pending attempt — its late settle is inert", async () => {
    let resolveA: (s: FakeSigner) => void = () => {}
    const signerA = makeFakeSigner("signerA")
    signerQueue.push(() => new Promise<FakeSigner>((r) => (resolveA = r)))

    const attemptA = NostrConnectService.waitForConnection(URI)
    await flush()

    await NostrConnectService.disconnect()
    expect(NostrConnectService.signer).toBeNull()
    expect(NostrConnectService.connectionState).toBe("disconnected")

    // A settles after the disconnect — nothing may be published.
    resolveA(signerA)
    const resultA = await attemptA
    await flush()

    expect(resultA.success).toBe(false)
    expect(signerA.close).toHaveBeenCalled()
    expect(NostrConnectService.signer).toBeNull()
    expect(NostrConnectService.connectionState).toBe("disconnected")
  })

  it("a superseded restore publishes nothing", async () => {
    // Seed a stored session so restoreSession proceeds.
    const session = {
      publicKey: "user-signerOld",
      signerPubkey: "signerOld",
      relays: ["wss://r.example"],
    }
    localStorage.setItem("blinkpos_nip46_session", JSON.stringify(session))

    // Restore's candidate pings only when the test releases it.
    let resolvePing: () => void = () => {}
    const signerOld = makeFakeSigner("signerOld")
    signerOld.ping = jest.fn(() => new Promise<void>((r) => (resolvePing = r)))
    signerQueue.push(() => signerOld)
    // The superseding connect attempt's signer.
    const signerB = makeFakeSigner("signerB")
    signerQueue.push(() => signerB)

    const restore = NostrConnectService.restoreSession()
    await flush()
    // Newer attempt starts while the restore is pending on its ping.
    await NostrConnectService.waitForConnection(URI)
    expect(NostrConnectService.signer).toBe(signerB)

    // The restore's ping now resolves LATE — its continuation must be inert: candidate
    // closed, the newer signer's state untouched.
    resolvePing()
    const restoreResult = await restore
    await flush()

    expect(restoreResult.success).toBe(false)
    expect(restoreResult.error).toMatch(/superseded/i)
    expect(signerOld.close).toHaveBeenCalled()
    expect(NostrConnectService.signer).toBe(signerB)
    expect(NostrConnectService.connectionState).toBe("connected")
    expect(NostrConnectService.userPublicKey).toBe("user-signerB")
  })

  /**
   * Round-5 HIGH: an older disconnect() whose signer.close() is still pending must not erase
   * a newer successful connection. disconnect() now detaches synchronously and closes only
   * the detached resources.
   */
  it("a deferred disconnect close cannot erase a newer successful connection", async () => {
    // Establish connection A.
    const signerA = makeFakeSigner("signerA")
    signerQueue.push(() => signerA)
    await NostrConnectService.waitForConnection(URI)
    expect(NostrConnectService.signer).toBe(signerA)

    // A's close() resolves only when the test releases it.
    let releaseClose: () => void = () => {}
    signerA.close = jest.fn(() => new Promise<void>((r) => (releaseClose = r)))

    // Disconnect (fire-and-forget, exactly like the modal's restart path) — its synchronous
    // detach runs now; its awaited close hangs.
    const disconnectA = NostrConnectService.disconnect()
    await flush()
    expect(NostrConnectService.signer).toBeNull() // detached synchronously

    // Connection B starts and SUCCEEDS while A's close is still pending.
    const signerB = makeFakeSigner("signerB")
    signerQueue.push(() => signerB)
    await NostrConnectService.waitForConnection(URI)
    expect(NostrConnectService.signer).toBe(signerB)
    expect(NostrConnectService.connectionState).toBe("connected")

    // A's close now resolves — it must not touch B's signer, state, or session.
    releaseClose()
    await disconnectA
    await flush()

    expect(NostrConnectService.signer).toBe(signerB)
    expect(NostrConnectService.connectionState).toBe("connected")
    expect(NostrConnectService.userPublicKey).toBe("user-signerB")
    const storedSession = JSON.parse(
      localStorage.getItem("blinkpos_nip46_session") ?? "null",
    )
    expect(storedSession?.publicKey).toBe("user-signerB")
    expect(signerB.close).not.toHaveBeenCalled()
  })

  /**
   * Copilot review: waitForConnection must not publish the signer EARLY (before getPublicKey /
   * stabilization). Otherwise a supersede after that point closes the candidate but leaves
   * `signer` pointing at the closed instance. The singleton is published atomically at the
   * single success point, so it is null until then and never a closed/superseded signer.
   */
  it("never exposes a not-yet-published or superseded signer via the singleton", async () => {
    // Attempt A: fromURI resolves immediately, but getPublicKey hangs until released.
    let releasePubkey: () => void = () => {}
    const signerA = makeFakeSigner("signerA")
    signerA.getPublicKey = jest.fn(
      () =>
        new Promise<string>((r) => {
          releasePubkey = () => r("user-signerA")
        }),
    )
    signerQueue.push(() => signerA)

    const attemptA = NostrConnectService.waitForConnection(URI)
    await flush()
    // A's fromURI has resolved and it is blocked in getPublicKey — the singleton must NOT
    // already hold signerA (no early publish).
    expect(NostrConnectService.signer).toBeNull()

    // B starts and wins while A is still blocked.
    const signerB = makeFakeSigner("signerB")
    signerQueue.push(() => signerB)
    await NostrConnectService.waitForConnection(URI)
    expect(NostrConnectService.signer).toBe(signerB)

    // A now completes getPublicKey — superseded, so it closes and publishes nothing; the
    // singleton must still be B, never the closed signerA.
    releasePubkey()
    const resultA = await attemptA
    await flush()

    expect(resultA.success).toBe(false)
    expect(signerA.close).toHaveBeenCalled()
    expect(NostrConnectService.signer).toBe(signerB)
    expect(NostrConnectService.connectionState).toBe("connected")
  })

  /**
   * Copilot review (round 2): restoreSession used getPool(true), which CLOSED and replaced
   * the shared pool before the restore had confirmed ownership — a restore starting while
   * connection B was live tore down B's relay sockets. The pool is now local and published
   * atomically; a pending/failed/superseded restore never touches the shared pool.
   */
  it("a restore must not clobber a live connection's pool before it owns the singleton", async () => {
    // Establish a live connection via a first successful restore (publishes its own pool).
    localStorage.setItem(
      "blinkpos_nip46_session",
      JSON.stringify({
        publicKey: "user-signerB",
        signerPubkey: "signerB",
        relays: ["wss://r.example"],
      }),
    )
    const signerB = makeFakeSigner("signerB")
    signerQueue.push(() => signerB)
    await NostrConnectService.restoreSession()
    const livePool = NostrConnectService.pool as unknown as {
      id: number
      close: jest.Mock
    }
    expect(livePool).not.toBeNull()
    expect(NostrConnectService.signer).toBe(signerB)

    // A second restore starts (newer stored session) and hangs on its ping.
    localStorage.setItem(
      "blinkpos_nip46_session",
      JSON.stringify({
        publicKey: "user-signerOld",
        signerPubkey: "signerOld",
        relays: ["wss://r.example"],
      }),
    )
    let failPing: (e: Error) => void = () => {}
    const signerOld = makeFakeSigner("signerOld")
    signerOld.ping = jest.fn(() => new Promise<void>((_r, rej) => (failPing = rej)))
    signerQueue.push(() => signerOld)

    const restore = NostrConnectService.restoreSession()
    await flush()

    // While the restore is pending, the live pool must be untouched — NOT closed, NOT
    // replaced (the old getPool(true) did both here).
    expect(NostrConnectService.pool).toBe(livePool)
    expect(livePool.close).not.toHaveBeenCalled()

    // The restore fails: it closes ITS OWN local pool and still leaves the live one alone.
    failPing(new Error("dead"))
    await restore
    await flush()

    expect(NostrConnectService.pool).toBe(livePool)
    expect(livePool.close).not.toHaveBeenCalled()
  })

  it("a failed restore closes its own local pool", async () => {
    localStorage.setItem(
      "blinkpos_nip46_session",
      JSON.stringify({
        publicKey: "user-signerOld",
        signerPubkey: "signerOld",
        relays: ["wss://r.example"],
      }),
    )
    const signerOld = makeFakeSigner("signerOld")
    signerOld.ping = jest.fn(async () => {
      throw new Error("dead socket")
    })
    signerQueue.push(() => signerOld)
    const poolMock = (jest.requireMock("nostr-tools/pool") as { SimplePool: jest.Mock })
      .SimplePool
    const before = poolMock.mock.results.length

    await NostrConnectService.restoreSession()

    // Exactly one pool was created for this restore, and it was closed.
    const createdPools = poolMock.mock.results.slice(before)
    expect(createdPools).toHaveLength(1)
    const localPool = createdPools[0].value as { close: jest.Mock }
    expect(localPool.close).toHaveBeenCalled()
    // Nothing was published.
    expect(NostrConnectService.pool).toBeNull()
  })

  it("a successful restore publishes its pool and closes the previous one (detach-then-replace)", async () => {
    // A prior live pool from a first successful restore.
    localStorage.setItem(
      "blinkpos_nip46_session",
      JSON.stringify({
        publicKey: "user-signerB",
        signerPubkey: "signerB",
        relays: ["wss://r.example"],
      }),
    )
    signerQueue.push(() => makeFakeSigner("signerB"))
    await NostrConnectService.restoreSession()
    const previousPool = NostrConnectService.pool as unknown as { close: jest.Mock }

    // A second restore that succeeds (stored session matches the candidate's pubkey).
    localStorage.setItem(
      "blinkpos_nip46_session",
      JSON.stringify({
        publicKey: "user-signerR",
        signerPubkey: "signerR",
        relays: ["wss://r.example"],
      }),
    )
    const signerR = makeFakeSigner("signerR")
    signerQueue.push(() => signerR)

    const result = await NostrConnectService.restoreSession()

    expect(result.success).toBe(true)
    expect(NostrConnectService.signer).toBe(signerR)
    // The restore's own pool is now the singleton's, and the previous one was closed
    // only AFTER the replacement — never a window with a closed live pool.
    expect(NostrConnectService.pool).not.toBe(previousPool)
    expect(previousPool.close).toHaveBeenCalled()
  })

  /** Round-5 verified follow-up: failure paths must close the candidate (no socket leaks). */
  it("closes the candidate when a CURRENT attempt's getPublicKey fails", async () => {
    const signerA = makeFakeSigner("signerA")
    signerA.getPublicKey = jest.fn(async () => {
      throw new Error("no response")
    })
    signerQueue.push(() => signerA)

    const result = await NostrConnectService.waitForConnection(URI)

    expect(result.success).toBe(false)
    expect(signerA.close).toHaveBeenCalled()
    expect(NostrConnectService.signer).toBeNull()
    expect(NostrConnectService.connectionState).toBe("disconnected")
  })

  it("closes the candidate when a restore's ping fails", async () => {
    localStorage.setItem(
      "blinkpos_nip46_session",
      JSON.stringify({
        publicKey: "user-signerOld",
        signerPubkey: "signerOld",
        relays: ["wss://r.example"],
      }),
    )
    const signerOld = makeFakeSigner("signerOld")
    signerOld.ping = jest.fn(async () => {
      throw new Error("dead socket")
    })
    signerQueue.push(() => signerOld)

    const result = await NostrConnectService.restoreSession()

    expect(result.success).toBe(false)
    expect(signerOld.close).toHaveBeenCalled()
  })

  it("closes the candidate on a restore public-key mismatch", async () => {
    localStorage.setItem(
      "blinkpos_nip46_session",
      JSON.stringify({
        publicKey: "user-EXPECTED",
        signerPubkey: "signerOld",
        relays: ["wss://r.example"],
      }),
    )
    // The candidate answers with a DIFFERENT pubkey than the stored session.
    const signerOld = makeFakeSigner("signerOld")
    signerQueue.push(() => signerOld)

    const result = await NostrConnectService.restoreSession()

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/invalid/i)
    expect(signerOld.close).toHaveBeenCalled()
    expect(NostrConnectService.signer).toBeNull()
  })
})

/**
 * storeSession() failure semantics (PR #61 approval follow-up; stale-session hazard flagged
 * in the PR #63 review). A storage write failure after the in-memory publish must:
 *  - never leave a PREVIOUS session behind for a reload to restore (clear-before-write)
 *  - never propagate into the connect path's catch and tear down the live connection
 */
describe("NostrConnectService — storeSession failure is fail-safe", () => {
  const SESSION_KEY = "blinkpos_nip46_session"

  beforeEach(() => {
    signerQueue.length = 0
    localStorage.clear()
    NostrConnectService.signer = null
    NostrConnectService.pool = null
    NostrConnectService.connectionState = "disconnected"
    NostrConnectService.userPublicKey = null
  })

  // The test-env localStorage carries its own setItem (not Storage.prototype's), so the
  // override must target the instance for the service's `localStorage.setItem(...)` to
  // hit it. Captured ONCE, before any override, so the passthrough never recurses.
  const realSetItem = localStorage.setItem

  afterEach(() => {
    localStorage.setItem = realSetItem
    jest.restoreAllMocks()
  })

  const failNextSessionWrite = (): void => {
    localStorage.setItem = (key: string, value: string): void => {
      if (key === SESSION_KEY) throw new Error("QuotaExceededError")
      realSetItem.call(localStorage, key, value)
    }
  }

  it("a failed session write leaves NO previous session behind and keeps the new connection live", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    // A previous session from an older signer is already persisted.
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "user-OLD",
        signerPubkey: "signerOld",
        relays: ["wss://r.example"],
      }),
    )
    const signerNew = makeFakeSigner("signerNew")
    signerQueue.push(() => signerNew)
    failNextSessionWrite()

    const result = await NostrConnectService.waitForConnection(URI)

    // Connection published and NOT torn down by the storage failure.
    expect(result.success).toBe(true)
    expect(result.publicKey).toBe("user-signerNew")
    expect(NostrConnectService.signer).toBe(signerNew)
    expect(NostrConnectService.connectionState).toBe("connected")
    expect(signerNew.close).not.toHaveBeenCalled()
    // The OLD session is gone — a reload cannot restore it.
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
    expect(NostrConnectService.hasStoredSession()).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Session not persisted"),
      expect.any(Error),
    )
  })

  it("a successful session write replaces the previous session", async () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ publicKey: "user-OLD", signerPubkey: "signerOld", relays: [] }),
    )
    const signerNew = makeFakeSigner("signerNew")
    signerQueue.push(() => signerNew)

    await NostrConnectService.waitForConnection(URI)

    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null")
    expect(stored.publicKey).toBe("user-signerNew")
    expect(stored.signerPubkey).toBe("signerNew")
  })
})

/**
 * Same-device deeplink recovery (verified on-device 2026-09-02): the connect handshake reaches
 * the signer's ack (fromURI resolves), a PENDING session is persisted, then Android suspends
 * the tab's socket before getPublicKey resolves. The connection is recoverable via
 * restoreSession (fromBunker with the known signer pubkey), and a pending session skips the
 * user-pubkey match since none was ever confirmed.
 */
describe("NostrConnectService — pending-session handshake recovery", () => {
  const SESSION_KEY = "blinkpos_nip46_session"

  beforeEach(() => {
    signerQueue.length = 0
    localStorage.clear()
    NostrConnectService.signer = null
    NostrConnectService.pool = null
    NostrConnectService.connectionState = "disconnected"
    NostrConnectService.userPublicKey = null
  })

  it("persists a pending session as soon as the connection is established, before getPublicKey", async () => {
    // getPublicKey never resolves (socket died) — the connect hangs, but the pending session
    // must already be on disk from the moment fromURI resolved.
    const signer = makeFakeSigner("signerX")
    signer.getPublicKey = jest.fn(() => new Promise<string>(() => {})) // never resolves
    signerQueue.push(() => signer)

    NostrConnectService.waitForConnection(URI) // do not await — it hangs at getPublicKey
    await flush()

    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null")
    expect(stored).not.toBeNull()
    expect(stored.pending).toBe(true)
    expect(stored.signerPubkey).toBe("signerX")
    expect(stored.publicKey).toBe("") // user pubkey not known yet
  })

  it("restores a pending session without enforcing a user-pubkey match, then finalizes it", async () => {
    // A pending session left by an interrupted handshake.
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "",
        signerPubkey: "signerX",
        relays: ["wss://r.example"],
        connectedAt: Date.now(),
        pending: true,
      }),
    )
    const restored = makeFakeSigner("signerX") // fromBunker candidate
    signerQueue.push(() => restored)

    const result = await NostrConnectService.restoreSession()

    expect(result.success).toBe(true)
    expect(result.publicKey).toBe("user-signerX")
    expect(NostrConnectService.isConnected()).toBe(true)
    // Session finalized: real pubkey stamped, pending cleared.
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null")
    expect(stored.publicKey).toBe("user-signerX")
    expect(stored.pending).toBe(false)
    expect(restored.close).not.toHaveBeenCalled()
  })

  it("still enforces the pubkey match for a CONFIRMED (non-pending) session", async () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "user-EXPECTED",
        signerPubkey: "signerX",
        relays: ["wss://r.example"],
        connectedAt: Date.now(),
        // no pending flag → confirmed
      }),
    )
    const mismatch = makeFakeSigner("signerX") // getPublicKey → "user-signerX" ≠ expected
    signerQueue.push(() => mismatch)

    const result = await NostrConnectService.restoreSession()

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/invalid/i)
    expect(mismatch.close).toHaveBeenCalled()
  })
})
