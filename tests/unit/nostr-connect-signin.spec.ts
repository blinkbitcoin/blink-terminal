/**
 * runNostrConnectSignIn — the atomic sign-in transaction (issue #67, PR #66).
 *
 * Drives the REAL transaction with NostrAuthService and ProfileStorage mocked at their module
 * edges, and fetch mocked at the network edge. These cover the concurrency and cancellation
 * invariants that were previously spread across useNostrAuth: serialization, cancellation,
 * ownership, exception-safe commit, and session compensation.
 *
 * @jest-environment jsdom
 */
import {
  runNostrConnectSignIn,
  __resetSessionMutexForTests,
} from "../../lib/nostr/NostrConnectSignIn"

jest.mock("../../lib/nostr/NostrAuthService", () => ({
  __esModule: true,
  default: {
    nip98Login: jest.fn(async () => ({ success: true })),
    signInWithNostrConnect: jest.fn(() => ({ success: true })),
  },
}))

jest.mock("../../lib/storage/ProfileStorage", () => ({
  __esModule: true,
  default: {
    createProfile: jest.fn((publicKey: string) => ({
      id: "p1",
      publicKey,
      blinkAccounts: [],
    })),
    setActiveProfile: jest.fn(),
  },
}))

const authService = (
  jest.requireMock("../../lib/nostr/NostrAuthService") as {
    default: Record<string, jest.Mock>
  }
).default
const profileStorage = (
  jest.requireMock("../../lib/storage/ProfileStorage") as {
    default: Record<string, jest.Mock>
  }
).default

const PUBKEY = "a".repeat(64)
const PUBKEY_B = "c".repeat(64)

const ok = (timeout = 1000) => ({ timeout })

describe("runNostrConnectSignIn (issue #67)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetSessionMutexForTests()
    // clearAllMocks does NOT reset mockImplementation, so re-establish the defaults that any
    // previous test may have overridden (a throwing createProfile would leak into later tests).
    profileStorage.createProfile.mockImplementation((publicKey: string) => ({
      id: "p1",
      publicKey,
      blinkAccounts: [],
    }))
    authService.nip98Login.mockResolvedValue({ success: true })
    authService.signInWithNostrConnect.mockReturnValue({ success: true })
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch
  })

  it("commits and publishes when it owns the flow", async () => {
    const result = await runNostrConnectSignIn(PUBKEY, ok())
    expect(result.success).toBe(true)
    expect(result.publicKey).toBe(PUBKEY)
    expect(result.profile?.id).toBe("p1")
    expect(authService.signInWithNostrConnect).toHaveBeenCalledWith(PUBKEY)
    expect(profileStorage.setActiveProfile).toHaveBeenCalledWith("p1")
    expect(global.fetch).not.toHaveBeenCalledWith("/api/auth/logout", expect.anything())
  })

  it("registers nothing and discards the session when superseded during signing", async () => {
    let finish: (v: { success: boolean }) => void = () => {}
    authService.nip98Login.mockImplementation(() => new Promise((r) => (finish = r)))

    let owned = true
    const pending = runNostrConnectSignIn(PUBKEY, {
      timeout: 1000,
      isCurrent: () => owned,
    })
    await new Promise((r) => setTimeout(r, 0))
    owned = false
    finish({ success: true })
    const result = await pending

    expect(result.errorType).toBe("superseded")
    expect(authService.signInWithNostrConnect).not.toHaveBeenCalled()
    expect(profileStorage.createProfile).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("cancels the login on timeout so nothing commits late", async () => {
    let observed: AbortSignal | null = null
    authService.nip98Login.mockImplementation(
      (opts: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          observed = opts.signal ?? null
          opts.signal?.addEventListener("abort", () =>
            resolve({ success: false, error: "Aborted", errorType: "superseded" }),
          )
        }),
    )

    const result = await runNostrConnectSignIn(PUBKEY, { timeout: 10 })
    await new Promise((r) => setTimeout(r, 20))
    expect(result.errorType).toBe("superseded")
    expect((observed as AbortSignal | null)?.aborted).toBe(true)
    expect(authService.signInWithNostrConnect).not.toHaveBeenCalled()
  })

  it("serializes N overlapping attempts through the mutex", async () => {
    const order: string[] = []
    // A's login hangs until released, so B and C can only enter if the mutex lets them in — this
    // is what distinguishes real serialization from incidental FIFO ordering.
    let finishA: (v: { success: boolean }) => void = () => {}
    authService.nip98Login
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            order.push("A:login")
            finishA = r
          }),
      )
      .mockImplementation(async () => {
        order.push("later:login")
        return { success: true }
      })

    const a = runNostrConnectSignIn(PUBKEY, ok())
    const b = runNostrConnectSignIn(PUBKEY_B, ok())
    const c = runNostrConnectSignIn(PUBKEY, ok())
    await new Promise((r) => setTimeout(r, 0))

    // While A holds the mutex, B and C have not started their logins.
    expect(order).toEqual(["A:login"])

    finishA({ success: true })
    await Promise.all([a, b, c])

    expect(order).toEqual(["A:login", "later:login", "later:login"])
  })

  it("a waiter superseded while queued leaves the queue and never runs", async () => {
    let finishA: (v: { success: boolean }) => void = () => {}
    authService.nip98Login
      .mockImplementationOnce(() => new Promise((r) => (finishA = r)))
      .mockImplementation(async () => ({ success: true }))

    let aOwned = true
    let bOwned = true
    const a = runNostrConnectSignIn(PUBKEY, { timeout: 1000, isCurrent: () => aOwned })
    const b = runNostrConnectSignIn(PUBKEY_B, { timeout: 1000, isCurrent: () => bOwned })
    await new Promise((r) => setTimeout(r, 0))

    // B is superseded while still queued behind A.
    bOwned = false
    const bResult = await b
    expect(bResult.errorType).toBe("superseded")
    expect(authService.nip98Login).toHaveBeenCalledTimes(1) // B never logged in

    aOwned = false
    finishA({ success: true })
    await a
  })

  it("discards the session when local registration fails", async () => {
    authService.signInWithNostrConnect.mockReturnValue({
      success: false,
      error: "Invalid public key",
    })
    const result = await runNostrConnectSignIn(PUBKEY, ok())
    expect(result.success).toBe(false)
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    )
    expect(profileStorage.createProfile).not.toHaveBeenCalled()
  })

  it("discards the session when a profile write throws", async () => {
    profileStorage.createProfile.mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    const result = await runNostrConnectSignIn(PUBKEY, ok())
    expect(result.success).toBe(false)
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("a failing attempt releases the mutex so the next attempt is not wedged", async () => {
    // First attempt's login hangs then times out; the second must still run. A's own promise is
    // left to settle on its own — the point is that B is not held up by it.
    authService.nip98Login
      .mockImplementationOnce(() => new Promise(() => {})) // never settles
      .mockImplementation(async () => ({ success: true }))

    const a = runNostrConnectSignIn(PUBKEY, { timeout: 10 })
    const started = Date.now()
    const bResult = await runNostrConnectSignIn(PUBKEY_B, { timeout: 200 })
    const aResult = await a // A times out (10ms), releasing the slot for B

    console.log("PROBE a:", JSON.stringify(aResult), "b:", JSON.stringify(bResult))
    expect(aResult.errorType).toBe("superseded")
    expect(bResult.success).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
