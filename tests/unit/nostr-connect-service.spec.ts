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

  // The test-env localStorage carries its own setItem/removeItem (not Storage.prototype's), so
  // the overrides must target the instance for the service's `localStorage.*(...)` to hit
  // them. Captured ONCE, before any override, so the passthroughs never recurse.
  const realSetItem = localStorage.setItem
  const realRemoveItem = localStorage.removeItem

  afterEach(() => {
    localStorage.setItem = realSetItem
    localStorage.removeItem = realRemoveItem
    jest.restoreAllMocks()
  })

  const failNextSessionWrite = (): void => {
    localStorage.setItem = (key: string, value: string): void => {
      if (key === SESSION_KEY) throw new Error("QuotaExceededError")
      realSetItem.call(localStorage, key, value)
    }
  }

  const failSessionRemoval = (): void => {
    localStorage.removeItem = (key: string): void => {
      if (key === SESSION_KEY) throw new Error("SecurityError")
      realRemoveItem.call(localStorage, key)
    }
  }

  const seedOldSession = (): void => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "user-OLD",
        signerPubkey: "signerOld",
        relays: ["wss://r.example"],
      }),
    )
  }

  it("a failed write clears the previous session (fallback removal) and keeps the new connection live", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    seedOldSession()
    const signerNew = makeFakeSigner("signerNew")
    signerQueue.push(() => signerNew)
    failNextSessionWrite() // setItem throws; removeItem still works

    const result = await NostrConnectService.waitForConnection(URI)

    // Connection published and NOT torn down by the storage failure.
    expect(result.success).toBe(true)
    expect(result.publicKey).toBe("user-signerNew")
    expect(NostrConnectService.signer).toBe(signerNew)
    expect(NostrConnectService.connectionState).toBe("connected")
    expect(signerNew.close).not.toHaveBeenCalled()
    // The OLD session was invalidated by the fallback removeItem — a reload cannot restore it.
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
    expect(NostrConnectService.hasStoredSession()).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("cleared any previous session"),
      expect.any(Error),
    )
  })

  it("when BOTH the write and the fallback removal fail, the connection stays live and the stale-session risk is warned", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    seedOldSession()
    const signerNew = makeFakeSigner("signerNew")
    signerQueue.push(() => signerNew)
    failNextSessionWrite()
    failSessionRemoval() // both setItem AND removeItem throw

    const result = await NostrConnectService.waitForConnection(URI)

    // The live connection is never sacrificed for a storage failure.
    expect(result.success).toBe(true)
    expect(NostrConnectService.signer).toBe(signerNew)
    expect(NostrConnectService.connectionState).toBe("connected")
    expect(signerNew.close).not.toHaveBeenCalled()
    // Honest worst case: the old session could not be cleared, so it may still be on disk —
    // and the warning says exactly that (no false "reload requires re-auth" promise).
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null")
    expect(stored?.publicKey).toBe("user-OLD")
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("MAY restore a stale session"),
      expect.any(Error),
      expect.any(Error),
    )
  })

  it("a successful session write replaces the previous session", async () => {
    seedOldSession()
    const signerNew = makeFakeSigner("signerNew")
    signerQueue.push(() => signerNew)

    await NostrConnectService.waitForConnection(URI)

    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null")
    expect(stored.publicKey).toBe("user-signerNew")
    expect(stored.signerPubkey).toBe("signerNew")
  })

  it("clearPendingConnection swallows a throwing sessionStorage.removeItem (PR #66)", () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    const spy = jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError")
    })
    try {
      // Must not throw — cleanup/failure paths call this and a throw would skip teardown.
      expect(() => NostrConnectService.clearPendingConnection()).not.toThrow()
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to clear pending connection"),
        expect.any(Error),
      )
    } finally {
      spy.mockRestore()
    }
  })
})

/**
 * hasPendingSessionForCurrentAttempt(uri) — the resume decision uses it to restore ONLY an
 * attempt-owned pending record, never a previous signer's confirmed OR leftover-pending record
 * (PR #66 review). The record's stored `secret` must match the secret parsed from the CURRENT
 * uri (the immutable source of attempt identity — not mutable sessionStorage).
 */
describe("NostrConnectService — hasPendingSessionForCurrentAttempt", () => {
  const SESSION_KEY = "blinkpos_nip46_session"

  // Build a nostrconnect:// uri carrying the given attempt secret.
  const uriFor = (secret: string): string =>
    `nostrconnect://clientpubkey?relay=wss%3A%2F%2Fr.example&secret=${secret}`

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it("is false when there is no stored session", () => {
    expect(
      NostrConnectService.hasPendingSessionForCurrentAttempt(uriFor("secretB")),
    ).toBe(false)
  })

  it("is false for a CONFIRMED session (no pending flag)", () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "user-A",
        signerPubkey: "signerA",
        relays: [],
        connectedAt: 0, // a legitimate 0 timestamp must round-trip untouched
      }),
    )
    expect(
      NostrConnectService.hasPendingSessionForCurrentAttempt(uriFor("secretB")),
    ).toBe(false)
    expect(NostrConnectService.hasStoredSession()).toBe(true)
  })

  it("is TRUE for a pending record whose secret matches the current uri", () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "",
        signerPubkey: "signerB",
        relays: [],
        connectedAt: Date.now(),
        pending: true,
        secret: "secretB",
      }),
    )
    expect(
      NostrConnectService.hasPendingSessionForCurrentAttempt(uriFor("secretB")),
    ).toBe(true)
  })

  it("is FALSE for a stale pending record from a PREVIOUS attempt (secret mismatch)", () => {
    // Signer A's leftover pending record (secret A) while the current uri carries secret B.
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "",
        signerPubkey: "signerA",
        relays: [],
        connectedAt: Date.now(),
        pending: true,
        secret: "secretA",
      }),
    )
    expect(
      NostrConnectService.hasPendingSessionForCurrentAttempt(uriFor("secretB")),
    ).toBe(false)
  })

  it("is FALSE for a pending record when the uri carries no secret", () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "",
        signerPubkey: "signerA",
        relays: [],
        connectedAt: Date.now(),
        pending: true,
        secret: "secretA",
      }),
    )
    // A uri with no secret param → no attempt identity to own the record.
    expect(
      NostrConnectService.hasPendingSessionForCurrentAttempt(
        "nostrconnect://clientpubkey?relay=wss%3A%2F%2Fr.example",
      ),
    ).toBe(false)
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
    sessionStorage.clear()
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
    // The pending record is stamped with the secret parsed from the URI (secret=s), not from
    // ambient sessionStorage — this is what makes it attempt-owned and survives a reconnect
    // that wipes sessionStorage (PR #66 review).
    expect(stored.secret).toBe("s")
  })

  it("restores a pending session (matching secret) without enforcing a user-pubkey match, then finalizes it", async () => {
    // A pending session left by an interrupted handshake, bound to THIS attempt's secret.
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "",
        signerPubkey: "signerX",
        relays: ["wss://r.example"],
        connectedAt: Date.now(),
        pending: true,
        secret: "secretX",
      }),
    )
    const restored = makeFakeSigner("signerX") // fromBunker candidate
    signerQueue.push(() => restored)

    // The caller passes the current uri's secret — it matches the pending record's, so restore
    // proceeds and finalizes.
    const result = await NostrConnectService.restoreSession({ expectedSecret: "secretX" })

    expect(result.success).toBe(true)
    expect(result.publicKey).toBe("user-signerX")
    expect(NostrConnectService.isConnected()).toBe(true)
    // Session finalized: real pubkey stamped, pending + attempt secret cleared.
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null")
    expect(stored.publicKey).toBe("user-signerX")
    expect(stored.pending).toBe(false)
    expect(stored.secret).toBeUndefined()
    expect(restored.close).not.toHaveBeenCalled()
  })

  it("REFUSES to restore a pending record whose secret does not match the current attempt (stale signer A)", async () => {
    // Signer A's leftover pending record (secret A) while the current attempt is B (secret B).
    // restoreSession must refuse and clear it — never rebuild A's signer — even if the resume
    // decision were bypassed. (PR #66 review — stale-pending wrong-signer restore.)
    jest.spyOn(console, "warn").mockImplementation(() => {})
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "",
        signerPubkey: "signerA",
        relays: ["wss://r.example"],
        connectedAt: Date.now(),
        pending: true,
        secret: "secretA",
      }),
    )
    // No signer queued: if restore wrongly proceeded it would try to build one and we'd catch
    // it via the assertions below.

    // The caller passes the current uri's secret (B), which does NOT match the record's (A).
    const result = await NostrConnectService.restoreSession({ expectedSecret: "secretB" })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/invalid/i)
    expect(NostrConnectService.isConnected()).toBe(false)
    // The stale pending record was cleared so it cannot be adopted on a later attempt.
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
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

  it("survives a throwing clearSession on the mismatch path: still returns, closes the candidate, clears state", async () => {
    // Confirmed session + a mismatching signer + localStorage.removeItem throwing (e.g.
    // SecurityError). clearSession() is now non-throwing, so restoreSession must still RETURN
    // a failure result (not reject), close the mismatched candidate (no socket leak), and
    // clear the singleton state. (PR #66 review.)
    jest.spyOn(console, "warn").mockImplementation(() => {})
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "user-EXPECTED",
        signerPubkey: "signerX",
        relays: ["wss://r.example"],
        connectedAt: Date.now(),
      }),
    )
    const mismatch = makeFakeSigner("signerX") // getPublicKey → "user-signerX" ≠ expected
    signerQueue.push(() => mismatch)

    const realRemove = localStorage.removeItem
    localStorage.removeItem = (key: string): void => {
      if (key === SESSION_KEY) throw new Error("SecurityError")
      realRemove.call(localStorage, key)
    }
    try {
      const result = await NostrConnectService.restoreSession()

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/invalid/i)
      expect(mismatch.close).toHaveBeenCalled() // candidate torn down despite the storage throw
      expect(NostrConnectService.signer).toBeNull()
      expect(NostrConnectService.connectionState).toBe("disconnected")
      expect(NostrConnectService.userPublicKey).toBeNull()
    } finally {
      localStorage.removeItem = realRemove
    }
  })

  /**
   * Finding 2 (PR #66 review — self-inflicted regression). The reconnect path calls
   * disconnect() → clearSession() → clearPendingConnection(), wiping the
   * `blinkpos_nip46_pending` sessionStorage record, then retries the SAME uri. If the pending
   * record's secret were sourced from that wiped sessionStorage, the retry would stamp
   * `secret: undefined` and a second recovery could no longer prove ownership. Sourcing the
   * secret from the immutable uri makes the retry's pending record carry the right secret
   * across the wipe, so restoreSession(expectedSecret) still matches.
   */
  it("re-stamps the attempt secret from the URI after a reconnect wipes sessionStorage, so a second recovery still matches (PR #66)", async () => {
    const uriA = "nostrconnect://clientpubkey?relay=wss%3A%2F%2Fr.example&secret=secretA"

    // First attempt: stalls at getPublicKey after establishing (pending record persisted).
    const first = makeFakeSigner("signerA")
    first.getPublicKey = jest.fn(() => new Promise<string>(() => {})) // never resolves
    signerQueue.push(() => first)
    NostrConnectService.waitForConnection(uriA) // hangs
    await flush()
    expect(JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null").secret).toBe("secretA")

    // reconnect ≈ disconnect() (wipes sessionStorage + the pending record) then retry the uri.
    await NostrConnectService.disconnect()
    expect(sessionStorage.getItem("blinkpos_nip46_pending")).toBeNull()

    // Retry the SAME uri; it also stalls after establishing.
    const second = makeFakeSigner("signerA")
    second.getPublicKey = jest.fn(() => new Promise<string>(() => {})) // never resolves
    signerQueue.push(() => second)
    NostrConnectService.waitForConnection(uriA) // hangs again
    await flush()

    // The retry's pending record is stamped with the URI's secret — NOT undefined — so a
    // second recovery driven by the same uri can still prove ownership.
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null")
    expect(stored.pending).toBe(true)
    expect(stored.secret).toBe("secretA")
    expect(NostrConnectService.hasPendingSessionForCurrentAttempt(uriA)).toBe(true)
  })

  /**
   * Kimi K3 (PR #66 review — overlapping attempts). Attempt A is awaiting its ack when a fresh
   * URI (attempt B) is generated. generateConnectionURI bumps the attempt counter, so A's late
   * fromURI settle fails isCurrentAttempt(): it closes its candidate and neither publishes a
   * signer nor stamps a pending record — so it cannot be mistaken for B or authenticate the
   * wrong signer.
   */
  it("supersedes a still-pending attempt A when a new URI (attempt B) is generated — A's late ack publishes nothing (PR #66)", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    const uriA = "nostrconnect://clientpubkey?relay=wss%3A%2F%2Fr.example&secret=secretA"

    // A's fromURI stays pending until we release it, so we can generate B in between.
    let releaseA: (s: FakeSigner) => void = () => {}
    const aSigner = makeFakeSigner("signerA")
    signerQueue.push(() => new Promise<FakeSigner>((resolve) => (releaseA = resolve)))
    const aResult = NostrConnectService.waitForConnection(uriA)
    await flush()

    // A fresh URI (attempt B) is generated while A is still awaiting its ack.
    NostrConnectService.generateConnectionURI()

    // Now A's ack finally arrives — but A has been superseded.
    releaseA(aSigner)
    const settled = await aResult

    expect(settled.success).toBe(false)
    expect(settled.error).toMatch(/superseded/i)
    expect(aSigner.close).toHaveBeenCalled() // stale candidate torn down
    // A published nothing: no signer on the singleton, no pending record stamped with A's data.
    expect(NostrConnectService.signer).toBeNull()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()

    // ...and now B stalls before its OWN ack. B must not be able to own or restore anything
    // left by A: no attempt-owned pending record exists, and a restore driven by B's secret is
    // refused (the reviewer's exact generate A → wait → generate B → A ack → B stall sequence).
    const uriB = "nostrconnect://clientpubkey?relay=wss%3A%2F%2Fr.example&secret=secretB"
    signerQueue.push(() => new Promise<FakeSigner>(() => {})) // B's fromURI never resolves
    NostrConnectService.waitForConnection(uriB) // hangs pre-ack
    await flush()

    expect(NostrConnectService.hasPendingSessionForCurrentAttempt(uriB)).toBe(false)
    // No signer queued for a restore: if it wrongly proceeded, fromBunker would reject and the
    // assertions below would not hold.
    const bRestore = await NostrConnectService.restoreSession({
      expectedSecret: "secretB",
    })
    expect(bRestore.success).toBe(false)
    expect(NostrConnectService.signer).toBeNull()
    expect(NostrConnectService.isConnected()).toBe(false)
  })

  /**
   * Divergent finding (PR #66 review, GPT-5.6): a stale CONFIRMED record must not replace a
   * live different user. Reachable when storeSession's write AND its fallback removal both
   * failed, leaving user A's confirmed record on disk while user B went live. A bfcache-driven
   * restore would rebuild A, pass A's own publicKey match, and authenticate the WRONG USER.
   */
  it("REFUSES to restore a CONFIRMED record for a different user than the live flow, and clears it (PR #66)", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "user-A", // stale: a PREVIOUS user's confirmed record
        signerPubkey: "signerA",
        relays: ["wss://r.example"],
        connectedAt: Date.now(),
        // no pending flag → confirmed, so the secret guard does not apply
      }),
    )
    // No signer queued: if the restore wrongly proceeded, fromBunker would be called and the
    // assertions below would fail.

    // The live flow established user B and asks to restore — the record is for A.
    const result = await NostrConnectService.restoreSession({
      expectedPublicKey: "user-B",
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/invalid/i)
    expect(NostrConnectService.isConnected()).toBe(false)
    expect(NostrConnectService.signer).toBeNull()
    // Cleared, so a later startup restore (no expectation to check) cannot log in as A.
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it("still restores a CONFIRMED record when it matches the live flow's user", async () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "user-signerX",
        signerPubkey: "signerX",
        relays: ["wss://r.example"],
        connectedAt: Date.now(),
      }),
    )
    signerQueue.push(() => makeFakeSigner("signerX")) // getPublicKey → "user-signerX"

    const result = await NostrConnectService.restoreSession({
      expectedPublicKey: "user-signerX",
    })

    expect(result.success).toBe(true)
    expect(result.publicKey).toBe("user-signerX")
  })

  /**
   * LOW (PR #66 review, Codex GPT-5): the cleanup helpers must be non-throwing even when the
   * Window storage GETTER itself throws (SecurityError in some privacy modes) — not only when
   * removeItem throws. Previously the `typeof sessionStorage` check sat OUTSIDE the try, so a
   * denied getter escaped clearPendingConnection() through clearSession() and skipped the
   * caller's candidate teardown.
   */
  it("survives THROWING storage getters: cleanup stays non-throwing and the candidate is still torn down (PR #66)", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        publicKey: "user-EXPECTED",
        signerPubkey: "signerX",
        relays: ["wss://r.example"],
        connectedAt: Date.now(),
      }),
    )
    const mismatch = makeFakeSigner("signerX") // getPublicKey → "user-signerX" ≠ expected
    signerQueue.push(() => mismatch)

    // Deny the sessionStorage getter outright — evaluating the identifier throws.
    const realSession = Object.getOwnPropertyDescriptor(window, "sessionStorage")
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new Error("SecurityError")
      },
      configurable: true,
    })
    try {
      // The standalone helper must not propagate the getter throw.
      expect(() => NostrConnectService.clearPendingConnection()).not.toThrow()

      // And the restore mismatch path (which calls clearSession → clearPendingConnection)
      // must still RETURN a failure, close the candidate, and clear the singleton state.
      const result = await NostrConnectService.restoreSession()

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/invalid/i)
      expect(mismatch.close).toHaveBeenCalled() // teardown NOT skipped by the getter throw
      expect(NostrConnectService.signer).toBeNull()
      expect(NostrConnectService.connectionState).toBe("disconnected")
      expect(NostrConnectService.userPublicKey).toBeNull()
    } finally {
      if (realSession) Object.defineProperty(window, "sessionStorage", realSession)
    }
  })
})

/**
 * Client-key consistency when storage is unusable (PR #66 review, GPT-5.6 + Kimi K3).
 *
 * The client key IS this client's identity: generateConnectionURI embeds its pubkey in the
 * nostrconnect:// URI and the signer addresses its reply to that pubkey, while
 * waitForConnection's fromURI subscribes and decrypts with whatever key it is handed. A storage
 * fallback that mints a FRESH key per call therefore advertises key A and then listens with key
 * B — the handshake can never complete, and reconnect rotates the key again.
 *
 * The file-level nostr-tools/pure + @noble/hashes mocks return constants, which conceals the
 * mismatch, so this block makes them key-derived: every generateSecretKey() call yields a
 * distinct key and getPublicKey/bytesToHex derive from the key bytes.
 */
describe("NostrConnectService — client-key consistency with unusable storage", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- reach the mocked modules
  const pure = jest.requireMock("nostr-tools/pure") as {
    generateSecretKey: jest.Mock
    getPublicKey: jest.Mock
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- reach the mocked modules
  const hashes = jest.requireMock("@noble/hashes/utils") as {
    bytesToHex: jest.Mock
    hexToBytes: jest.Mock
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- reach the mocked modules
  const nip46 = jest.requireMock("nostr-tools/nip46") as {
    BunkerSigner: { fromURI: jest.Mock }
  }

  const realImpls = {
    generateSecretKey: pure.generateSecretKey.getMockImplementation(),
    getPublicKey: pure.getPublicKey.getMockImplementation(),
    bytesToHex: hashes.bytesToHex.getMockImplementation(),
    hexToBytes: hashes.hexToBytes.getMockImplementation(),
  }

  let keySeq = 0

  beforeEach(() => {
    signerQueue.length = 0
    localStorage.clear()
    sessionStorage.clear()
    NostrConnectService.signer = null
    NostrConnectService.pool = null
    NostrConnectService.connectionState = "disconnected"
    NostrConnectService.userPublicKey = null
    jest.spyOn(console, "warn").mockImplementation(() => {})

    // Distinct key per call; pubkey/hex derived from the key's first byte so a swapped key is
    // immediately visible.
    keySeq = 0
    pure.generateSecretKey.mockImplementation(() => new Uint8Array(32).fill(++keySeq))
    pure.getPublicKey.mockImplementation((k: Uint8Array) => `pub-${k[0]}`)
    hashes.bytesToHex.mockImplementation((b: Uint8Array) => `hex-${b[0]}`)
    hashes.hexToBytes.mockImplementation((h: string) =>
      new Uint8Array(32).fill(Number(String(h).replace("hex-", "")) || 0),
    )
  })

  afterAll(() => {
    // Restore the file-level constant mocks for any later suite.
    pure.generateSecretKey.mockImplementation(realImpls.generateSecretKey!)
    pure.getPublicKey.mockImplementation(realImpls.getPublicKey!)
    hashes.bytesToHex.mockImplementation(realImpls.bytesToHex!)
    hashes.hexToBytes.mockImplementation(realImpls.hexToBytes!)
  })

  /** The key handed to fromURI on the Nth call. */
  const keyPassedToFromURI = (call: number): Uint8Array =>
    nip46.BunkerSigner.fromURI.mock.calls[call][0] as Uint8Array

  /** The client pubkey advertised in a nostrconnect:// uri (its host). */
  const pubkeyInUri = (uri: string): string =>
    new URL(uri).hostname || uri.split("//")[1]!.split("?")[0]!

  const expectUriAndWaiterAgree = (uri: string, call: number): void => {
    const advertised = pubkeyInUri(uri)
    const used = pure.getPublicKey(keyPassedToFromURI(call))
    expect(used).toBe(advertised)
  }

  const denyStorage = (impl: PropertyDescriptor): (() => void) => {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage")
    Object.defineProperty(window, "localStorage", { ...impl, configurable: true })
    return () => {
      if (real) Object.defineProperty(window, "localStorage", real)
    }
  }

  it("uses ONE key for the URI and the waiter when the localStorage GETTER throws", async () => {
    const restore = denyStorage({
      get() {
        throw new Error("SecurityError")
      },
    })
    try {
      const uri: string = NostrConnectService.generateConnectionURI()
      const signer = makeFakeSigner("signerX")
      signer.getPublicKey = jest.fn(() => new Promise<string>(() => {}))
      signerQueue.push(() => signer)
      NostrConnectService.waitForConnection(uri)
      await flush()

      expectUriAndWaiterAgree(uri, 0)
    } finally {
      restore()
    }
  })

  it("uses ONE key for the URI and the waiter when getItem throws", async () => {
    const restore = denyStorage({
      get: () => ({
        getItem: () => {
          throw new Error("SecurityError")
        },
        setItem: () => undefined,
        removeItem: () => undefined,
      }),
    })
    try {
      const uri: string = NostrConnectService.generateConnectionURI()
      const signer = makeFakeSigner("signerX")
      signer.getPublicKey = jest.fn(() => new Promise<string>(() => {}))
      signerQueue.push(() => signer)
      NostrConnectService.waitForConnection(uri)
      await flush()

      expectUriAndWaiterAgree(uri, 0)
    } finally {
      restore()
    }
  })

  it("uses ONE key for the URI and the waiter when setItem fails, and keeps it across a reconnect", async () => {
    const restore = denyStorage({
      get: () => ({
        getItem: () => null, // nothing stored, and the write below will fail
        setItem: () => {
          throw new Error("QuotaExceededError")
        },
        removeItem: () => undefined,
      }),
    })
    try {
      const uri: string = NostrConnectService.generateConnectionURI()
      const first = makeFakeSigner("signerX")
      first.getPublicKey = jest.fn(() => new Promise<string>(() => {}))
      signerQueue.push(() => first)
      NostrConnectService.waitForConnection(uri)
      await flush()

      expectUriAndWaiterAgree(uri, 0)

      // Reconnect: disconnect and retry the SAME uri — the key must not rotate, or the retry
      // would listen with a key the signer is not addressing.
      await NostrConnectService.disconnect()
      const second = makeFakeSigner("signerX")
      second.getPublicKey = jest.fn(() => new Promise<string>(() => {}))
      signerQueue.push(() => second)
      NostrConnectService.waitForConnection(uri)
      await flush()

      expectUriAndWaiterAgree(uri, 1)
      expect(keyPassedToFromURI(1)).toEqual(keyPassedToFromURI(0))
    } finally {
      restore()
    }
  })
})
