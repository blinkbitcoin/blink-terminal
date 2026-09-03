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
    clearAuthData: jest.fn(),
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
    authService.signInWithNostrConnect.mockReset()
    authService.signInWithNostrConnect.mockReturnValue({ success: true })
    profileStorage.setActiveProfile.mockReset()
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
    // A genuine deadline reports "timeout", not "superseded" — this is the production path the
    // hook's friendly "timed out" message is keyed on (PR #66 review). Previously every abort
    // reported "superseded", so a normal Amber-approval timeout was shown as a replacement.
    expect(result.errorType).toBe("timeout")
    expect(result.error).toMatch(/timed out/i)
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

  it("rejects an invalid key before touching storage, and discards the session", async () => {
    const result = await runNostrConnectSignIn("not-a-pubkey", ok())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/invalid/i)
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    )
    // Validated BEFORE any write: no profile was created for the bad key.
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

  /**
   * HIGH (PR #66 review): cancelling a QUEUED waiter must not break mutex exclusion. With A
   * holding, B queued behind A, and C queued behind B, cancelling B must not release C — C is
   * chained to B's slot, and B's slot must forward A's release, not resolve on B's cancel. The
   * reviewer ran this probe against the previous head and saw nip98Login called twice while A
   * was still unresolved.
   */
  it("A holds, B is cancelled while queued, C must still wait for A (transitive chain)", async () => {
    let finishA: (v: { success: boolean }) => void = () => {}
    authService.nip98Login
      .mockImplementationOnce(() => new Promise((r) => (finishA = r)))
      .mockImplementation(async () => ({ success: true }))

    const bAbort = new AbortController()
    const a = runNostrConnectSignIn(PUBKEY, ok())
    const b = runNostrConnectSignIn(PUBKEY_B, { timeout: 1000, signal: bAbort.signal })
    const c = runNostrConnectSignIn(PUBKEY, ok())
    await new Promise((r) => setTimeout(r, 0))

    // B is cancelled while queued behind A.
    bAbort.abort()
    const bResult = await b
    expect(bResult.errorType).toBe("superseded")
    await new Promise((r) => setTimeout(r, 0))

    // The invariant: while A is STILL unresolved, C has not entered. Only A's login has run.
    expect(authService.nip98Login).toHaveBeenCalledTimes(1)

    finishA({ success: true })
    await Promise.all([a, c])
    // Now C ran, exactly once, after A.
    expect(authService.nip98Login).toHaveBeenCalledTimes(2)
  })

  /**
   * HIGH (PR #66 review): supersession must ABORT the holder, not merely be polled. A hung A
   * would otherwise keep the mutex until its own long deadline while B spends its budget
   * queued. An external signal cancels A immediately and B proceeds with a usable budget.
   */
  it("an external abort cancels the holder immediately and the replacement proceeds", async () => {
    let aSignal: AbortSignal | null = null
    authService.nip98Login
      .mockImplementationOnce(
        (opts: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            aSignal = opts.signal ?? null
            opts.signal?.addEventListener("abort", () =>
              resolve({ success: false, error: "Aborted", errorType: "superseded" }),
            )
          }),
      )
      .mockImplementation(async () => ({ success: true }))

    const aAbort = new AbortController()
    const started = Date.now()
    // A has a LONG deadline; without external cancellation B would wait it out.
    const a = runNostrConnectSignIn(PUBKEY, { timeout: 60_000, signal: aAbort.signal })
    const b = runNostrConnectSignIn(PUBKEY_B, { timeout: 5000 })
    await new Promise((r) => setTimeout(r, 0))

    aAbort.abort() // the modal retires A
    const [aResult, bResult] = await Promise.all([a, b])

    expect((aSignal as AbortSignal | null)?.aborted).toBe(true)
    expect(aResult.errorType).toBe("superseded")
    expect(bResult.success).toBe(true)
    // B did not have to wait A's 60s deadline.
    expect(Date.now() - started).toBeLessThan(3000)
  })

  /**
   * HIGH (PR #66 review): a compensating logout that never settles must not hold the mutex and
   * wedge the successor — and the successor must not log in while that logout could still be
   * mutating the shared cookie. The logout is bounded; the successor is chained to its release.
   */
  it("a never-settling logout is cut off, and the successor logs in only after it", async () => {
    const order: string[] = []
    let finishLogin: (v: { success: boolean }) => void = () => {}
    authService.nip98Login
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            order.push("A:login")
            finishLogin = r
          }),
      )
      .mockImplementation(async () => {
        order.push("B:login")
        return { success: true }
      })
    // The logout hangs until aborted by the transaction's ceiling/signal.
    global.fetch = jest.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      if (String(url).includes("logout")) {
        order.push("A:logout:start")
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            order.push("A:logout:cut")
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          })
        })
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch

    let aOwned = true
    const a = runNostrConnectSignIn(PUBKEY, { timeout: 200, isCurrent: () => aOwned })
    const b = runNostrConnectSignIn(PUBKEY_B, { timeout: 5000 })
    await new Promise((r) => setTimeout(r, 0))

    // A establishes its session, then is superseded → it must discard (the hanging logout).
    aOwned = false
    finishLogin({ success: true })
    const [aResult, bResult] = await Promise.all([a, b])

    expect(aResult.errorType).toBe("superseded")
    expect(bResult.success).toBe(true)
    // B's login happened only AFTER A's logout was cut off — never while it was live.
    expect(order).toEqual(["A:login", "A:logout:start", "A:logout:cut", "B:login"])
  })

  /**
   * HIGH (PR #66 review): the local commit must fail CLOSED. Auth data is the only key
   * startup's isAuthenticated() reads, so it is written LAST; if any later write throws, it is
   * cleared and the session discarded, so a half-commit can never be consumed as a login.
   */
  it("fails closed when the active-profile write throws after profile creation", async () => {
    profileStorage.setActiveProfile.mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    const result = await runNostrConnectSignIn(PUBKEY, ok())

    expect(result.success).toBe(false)
    // Auth was never written (it comes last), and is cleared defensively regardless.
    expect(authService.signInWithNostrConnect).not.toHaveBeenCalled()
    expect(authService.clearAuthData).toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("fails closed when the auth write itself throws mid-way", async () => {
    // storeAuthData writes two keys; a throw on the second leaves a half-pair without this.
    authService.signInWithNostrConnect.mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    const result = await runNostrConnectSignIn(PUBKEY, ok())

    expect(result.success).toBe(false)
    expect(authService.clearAuthData).toHaveBeenCalled() // the half-pair is removed
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
    expect(aResult.errorType).toBe("timeout")
    expect(bResult.success).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
