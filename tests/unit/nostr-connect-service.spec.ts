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
  parseBunkerInput: jest.fn(),
}))

jest.mock("nostr-tools/pool", () => ({
  __esModule: true,
  SimplePool: jest.fn(() => ({ close: jest.fn() })),
}))

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
   * Round-5 verified follow-up: a stale connectWithBunkerURL continuation settling after a
   * newer waitForConnection winner must neither overwrite nor clear it.
   */
  it("a stale bunker continuation cannot overwrite or clear a newer winner", async () => {
    const nip46 = jest.requireMock("nostr-tools/nip46") as {
      parseBunkerInput: jest.Mock
    }
    nip46.parseBunkerInput.mockResolvedValue({
      pubkey: "bunkerSigner",
      relays: ["wss://r.example"],
      secret: "s3cret",
    })

    // Bunker attempt A: its connect() hangs until released.
    let releaseConnect: () => void = () => {}
    const bunkerSigner = makeFakeSigner("bunkerSigner")
    bunkerSigner.connect = jest.fn(() => new Promise<void>((r) => (releaseConnect = r)))
    signerQueue.push(() => bunkerSigner)

    const bunkerAttempt = NostrConnectService.connectWithBunkerURL("bunker://x")
    await flush()

    // Newer waitForConnection B wins while the bunker connect is pending.
    const signerB = makeFakeSigner("signerB")
    signerQueue.push(() => signerB)
    await NostrConnectService.waitForConnection(URI)
    expect(NostrConnectService.signer).toBe(signerB)

    // The bunker attempt now completes its network phase — but it is superseded: it must
    // close its candidate and leave B untouched.
    releaseConnect()
    const bunkerResult = await bunkerAttempt
    await flush()

    expect(bunkerResult.success).toBe(false)
    expect(bunkerResult.error).toMatch(/superseded/i)
    expect(bunkerSigner.close).toHaveBeenCalled()
    expect(NostrConnectService.signer).toBe(signerB)
    expect(NostrConnectService.connectionState).toBe("connected")
    expect(NostrConnectService.userPublicKey).toBe("user-signerB")
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
