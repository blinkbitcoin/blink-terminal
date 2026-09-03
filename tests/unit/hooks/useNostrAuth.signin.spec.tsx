/**
 * signInWithNostrConnect ownership (PR #66 review, HIGH).
 *
 * The modal retiring its auth token only suppresses the MODAL's continuation. This operation
 * publishes durable state of its own after awaiting the network — the server-account sync and
 * the provider's authenticated state — so a request that was cancelled or superseded (e.g. by a
 * bfcache discard) could still authenticate the app through a transport that is already gone.
 *
 * These tests drive the real provider and assert that a superseded sign-in publishes NOTHING,
 * while an owned one still completes normally.
 *
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, act } from "@testing-library/react"

// ---- Boundary mocks. The provider touches storage, relays and the network on mount; none of
// that is under test here, so each is stubbed at its module edge.

jest.mock("../../../lib/nostr/NostrAuthService", () => ({
  __esModule: true,
  default: {
    // Mount path: no pending flows, no stored auth → the provider settles to "logged out".
    hasPendingChallengeFlow: jest.fn(() => false),
    hasPendingExternalSignerFlow: jest.fn(() => false),
    getStoredAuthData: jest.fn(() => ({ publicKey: null, method: null })),
    isExtensionAvailable: jest.fn(() => false),
    isMobileDevice: jest.fn(() => false),
    getAvailableMethods: jest.fn(() => []),
    // Sign-in path.
    signInWithNostrConnect: jest.fn(() => ({ success: true })),
    nip98Login: jest.fn(async () => ({ success: true })),
    // Durable local-auth mutations, asserted directly by the rollback tests.
    storeAuthData: jest.fn(),
    clearAuthData: jest.fn(),
  },
}))

// Stateful for the active-profile pointer: getActiveProfileId must reflect setActiveProfile and
// deleteProfile, otherwise rollback's "is my profile still the active one?" check cannot be
// exercised and the mock would hide the behavior under test.
// Stateful and keyed by pubkey, so the tests can exercise distinct users, the difference
// between a profile this attempt CREATED and one that already existed, and the active-profile
// pointer transitions that rollback branches on. A double that always returns the same id and
// always reports an existing profile cannot express any of that, and would let these tests pass
// without proving the invariant (PR #66 review).
jest.mock("../../../lib/storage/ProfileStorage", () => {
  let activeId: string | null = null
  const profiles = new Map<
    string,
    {
      id: string
      publicKey: string
      blinkAccounts: []
      lastLogin?: number
      signInMethod?: string
    }
  >()
  let seq = 0
  return {
    __esModule: true,
    default: {
      // --- test helpers ---
      __setActiveId: (id: string | null): void => {
        activeId = id
      },
      __seedProfile: (publicKey: string, id: string, extra?: Record<string, unknown>) => {
        const p = { id, publicKey, blinkAccounts: [] as [], ...extra }
        profiles.set(publicKey, p)
        return p
      },
      __getProfile: (publicKey: string) => profiles.get(publicKey) ?? null,
      __reset: (): void => {
        activeId = null
        profiles.clear()
        seq = 0
      },
      // --- production surface ---
      createProfile: jest.fn((publicKey: string, signInMethod: string) => {
        const existing = profiles.get(publicKey)
        if (existing) {
          // Mirrors the real one: mutates the existing record instead of creating.
          existing.lastLogin = 999
          existing.signInMethod = signInMethod
          return existing
        }
        const created = {
          id: `created-${++seq}`,
          publicKey,
          blinkAccounts: [] as [],
          lastLogin: 999,
          signInMethod,
        }
        profiles.set(publicKey, created)
        activeId = created.id // the real one activates a newly created profile
        return created
      }),
      setActiveProfile: jest.fn((id: string) => {
        activeId = id
      }),
      clearActiveProfile: jest.fn(() => {
        activeId = null
      }),
      getActiveProfileId: jest.fn(() => activeId),
      deleteProfile: jest.fn((id: string) => {
        for (const [key, value] of profiles) {
          if (value.id === id) profiles.delete(key)
        }
        if (activeId === id) activeId = null
      }),
      getProfileById: jest.fn((id: string) => {
        for (const value of profiles.values()) if (value.id === id) return value
        return null
      }),
      // Copies, like the real one: profiles come from JSON.parse, so callers never receive a
      // live reference into storage. Sharing references here would hide aliasing bugs.
      getProfileByPublicKey: jest.fn((publicKey: string) => {
        const p = profiles.get(publicKey)
        return p ? { ...p } : null
      }),
      loadProfile: jest.fn((publicKey: string) => profiles.get(publicKey) ?? null),
      updateProfile: jest.fn((profile: { publicKey: string }) => {
        profiles.set(profile.publicKey, profile as never)
      }),
    },
  }
})

jest.mock("../../../lib/nostr/NostrProfileService", () => ({
  __esModule: true,
  default: { fetchProfile: jest.fn(async () => null) },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports -- required after the mocks above
const { NostrAuthProvider, useNostrAuth } =
  require("../../../lib/hooks/useNostrAuth") as typeof import("../../../lib/hooks/useNostrAuth")

const authService = (
  jest.requireMock("../../../lib/nostr/NostrAuthService") as {
    default: Record<string, jest.Mock>
  }
).default

const profileService = (
  jest.requireMock("../../../lib/nostr/NostrProfileService") as {
    default: { fetchProfile: jest.Mock }
  }
).default

const profileStorage = (
  jest.requireMock("../../../lib/storage/ProfileStorage") as {
    default: Record<string, jest.Mock>
  }
).default

const PUBKEY = "a".repeat(64)

/** Exposes the provider's auth state and the sign-in action to the test. */
let signIn: ReturnType<typeof useNostrAuth>["signInWithNostrConnect"]
const Probe = (): React.JSX.Element => {
  const auth = useNostrAuth()
  signIn = auth.signInWithNostrConnect
  return (
    <>
      <div data-testid="authed">{String(auth.isAuthenticated)}</div>
      <div data-testid="profile">
        {(auth.nostrProfile as { display_name?: string } | null)?.display_name ?? "none"}
      </div>
    </>
  )
}

const renderProvider = async (): Promise<void> => {
  await act(async () => {
    render(
      <NostrAuthProvider>
        <Probe />
      </NostrAuthProvider>,
    )
    await new Promise<void>((r) => setTimeout(r, 0))
  })
}

const authed = (): string | null => screen.getByTestId("authed").textContent

describe("useNostrAuth — signInWithNostrConnect ownership (PR #66)", () => {
  const PUBKEY_B = "c".repeat(64)

  beforeEach(() => {
    jest.clearAllMocks()
    authService.hasPendingChallengeFlow.mockReturnValue(false)
    authService.hasPendingExternalSignerFlow.mockReturnValue(false)
    authService.getStoredAuthData.mockReturnValue({ publicKey: null, method: null })
    authService.isExtensionAvailable.mockReturnValue(false)
    authService.isMobileDevice.mockReturnValue(false)
    authService.getAvailableMethods.mockReturnValue([])
    authService.signInWithNostrConnect.mockReturnValue({ success: true })
    authService.nip98Login.mockResolvedValue({ success: true })
    profileService.fetchProfile.mockResolvedValue(null)
    profileStorage.__reset()
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hasAccount: false }),
    })) as unknown as typeof fetch
  })

  /**
   * The flow establishes the session BEFORE it owns the outcome, because signing is what proves
   * the user. Everything local — auth registration, the profile, provider state — is published
   * only after the ownership gate, so a superseded attempt has nothing local to undo and the
   * session is the single resource it must give up.
   */
  it("publishes nothing locally and discards its session when superseded during signing", async () => {
    let finishSigning: (v: { success: boolean }) => void = () => {}
    authService.nip98Login.mockImplementation(
      () => new Promise((r) => (finishSigning = r)),
    )

    await renderProvider()
    // A different user is signed in with their own active profile.
    authService.getStoredAuthData.mockReturnValue({
      publicKey: "previous-user",
      method: "extension",
    })
    profileStorage.__seedProfile("previous-user", "previous-profile")
    profileStorage.__setActiveId("previous-profile")
    ;(global.fetch as jest.Mock).mockClear()

    let owned = true
    let result: { success: boolean; errorType?: string } | undefined
    await act(async () => {
      const pending = signIn(PUBKEY, { isCurrent: () => owned })
      await new Promise<void>((r) => setTimeout(r, 0))
      owned = false
      finishSigning({ success: true }) // the session now exists
      result = await pending
    })

    expect(result?.errorType).toBe("superseded")
    // Nothing local was ever touched, so there is nothing to have restored.
    expect(authService.signInWithNostrConnect).not.toHaveBeenCalled()
    expect(profileStorage.createProfile).not.toHaveBeenCalled()
    expect(profileStorage.setActiveProfile).not.toHaveBeenCalled()
    expect(profileStorage.deleteProfile).not.toHaveBeenCalled()
    expect(authed()).toBe("false")
    // The previous user is untouched, not restored-after-damage.
    expect(profileStorage.getActiveProfileId()).toBe("previous-profile")
    expect(profileStorage.__getProfile("previous-user")?.id).toBe("previous-profile")
    // The one resource it did create is given up.
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    )
    // ...and no account sync ran for it.
    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/auth/nostr-blink-account",
      expect.anything(),
    )
  })

  it("discards its session when local registration fails", async () => {
    authService.signInWithNostrConnect.mockReturnValue({
      success: false,
      error: "Invalid public key",
    })

    await renderProvider()
    ;(global.fetch as jest.Mock).mockClear()

    let result: { success: boolean; error?: string } | undefined
    await act(async () => {
      result = await signIn(PUBKEY)
      await new Promise<void>((r) => setTimeout(r, 0))
    })

    expect(result?.success).toBe(false)
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    )
    expect(profileStorage.createProfile).not.toHaveBeenCalled()
    expect(authed()).toBe("false")
  })

  it("leaves nothing behind when signing fails or times out", async () => {
    authService.nip98Login.mockResolvedValue({ success: false, error: "relay down" })

    await renderProvider()
    let failed: { errorType?: string } | undefined
    await act(async () => {
      failed = await signIn(PUBKEY)
      await new Promise<void>((r) => setTimeout(r, 0))
    })
    expect(failed?.errorType).toBe("session")

    // A timeout is the same: the request never resolves within the budget.
    authService.nip98Login.mockImplementation(() => new Promise(() => {}))
    let timedOut: { errorType?: string } | undefined
    await act(async () => {
      const pending = signIn(PUBKEY, { timeout: 5 })
      await new Promise<void>((r) => setTimeout(r, 20))
      timedOut = await pending
    })
    expect(timedOut?.errorType).toBe("timeout")

    // Neither path registered anything or published state.
    expect(authService.signInWithNostrConnect).not.toHaveBeenCalled()
    expect(profileStorage.createProfile).not.toHaveBeenCalled()
    expect(authed()).toBe("false")
  })

  /**
   * The caller's predicate defaults to true, so it cannot by itself stop two overlapping calls
   * from both believing they own the flow. Effective ownership is that predicate AND the latest
   * provider ticket — asserted here WITHOUT flipping any caller flag.
   */
  it("a stale attempt's late sync cannot overwrite a newer attempt, with no caller flag involved", async () => {
    let finishSync: (v: unknown) => void = () => {}
    let syncCalls = 0
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes("nostr-blink-account")) {
        syncCalls += 1
        if (syncCalls === 1) return new Promise((r) => (finishSync = r))
        return { ok: true, status: 200, json: async () => ({ hasAccount: false }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch

    await renderProvider()

    await act(async () => {
      // A commits, then hangs in its post-commit sync. No isCurrent is passed at all.
      const aPending = signIn(PUBKEY)
      await new Promise<void>((r) => setTimeout(r, 0))

      // B runs to completion for a DIFFERENT user, taking the latest ticket.
      await signIn(PUBKEY_B)

      // A's sync finally returns an account to write — it must be ignored.
      finishSync({
        ok: true,
        status: 200,
        json: async () => ({
          hasAccount: true,
          blinkUsername: "stale",
          apiKey: "key",
        }),
      })
      await aPending
    })

    // B's profile is the active one and A's stale sync wrote nothing.
    expect(profileStorage.getActiveProfileId()).toBe(
      profileStorage.__getProfile(PUBKEY_B)?.id,
    )
    expect(profileStorage.updateProfile).not.toHaveBeenCalled()
  })

  /**
   * Promise.race does not cancel an in-flight NIP-98 login, so session establishment is
   * serialized: a replacement cannot begin until the previous attempt's session request has
   * settled, which is what stops a late response installing a session behind it.
   */
  it("serializes session establishment across attempts", async () => {
    const order: string[] = []
    let finishA: (v: { success: boolean }) => void = () => {}
    authService.nip98Login
      .mockImplementationOnce(() => {
        order.push("A:login:start")
        return new Promise((r) => {
          finishA = (v) => {
            order.push("A:login:done")
            r(v)
          }
        })
      })
      .mockImplementation(async () => {
        order.push("B:login:start")
        return { success: true }
      })

    await renderProvider()

    await act(async () => {
      const aPending = signIn(PUBKEY, { isCurrent: () => false }) // A is already retired
      await new Promise<void>((r) => setTimeout(r, 0))

      const bPending = signIn(PUBKEY_B)
      await new Promise<void>((r) => setTimeout(r, 0))

      finishA({ success: true })
      await Promise.all([aPending, bPending])
    })

    // B's login only started after A's had settled — never interleaved.
    expect(order).toEqual(["A:login:start", "A:login:done", "B:login:start"])
    expect(authed()).toBe("true")
  })

  /**
   * HIGH (PR #66 review): Promise.race abandons the wait but does not cancel the request, so a
   * timed-out attempt must neither wedge later sign-ins nor leave a late-arriving session
   * unmanaged.
   */
  it("a timed-out attempt does not wedge the next sign-in, even if its login never settles", async () => {
    // A's login never settles at all.
    authService.nip98Login
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementation(async () => ({ success: true }))

    await renderProvider()

    let aResult: { errorType?: string } | undefined
    let bResult: { success: boolean } | undefined
    await act(async () => {
      const aPending = signIn(PUBKEY, { timeout: 5 })
      await new Promise<void>((r) => setTimeout(r, 20))
      aResult = await aPending

      // B must not inherit A's never-settling wait.
      const bPending = signIn(PUBKEY_B, { timeout: 50 })
      await new Promise<void>((r) => setTimeout(r, 10))
      bResult = await bPending
    })

    expect(aResult?.errorType).toBe("timeout")
    expect(bResult?.success).toBe(true)
    expect(authed()).toBe("true")
  })

  it("cancels its login on timeout, so it cannot commit a session late", async () => {
    // The attempt gets a real signal and its login hangs until aborted — which is the point: a
    // timed-out request must be cancellable, or it could install a cookie after the caller
    // already saw a failure (PR #66 review).
    let observedSignal: AbortSignal | null = null
    authService.nip98Login.mockImplementationOnce(
      (opts: {
        signal?: AbortSignal
      }): Promise<{ success: boolean; error: string; errorType: string }> =>
        new Promise((resolve) => {
          observedSignal = opts.signal ?? null
          opts.signal?.addEventListener("abort", () =>
            resolve({ success: false, error: "Aborted", errorType: "superseded" }),
          )
        }),
    )

    await renderProvider()
    ;(global.fetch as jest.Mock).mockClear()

    await act(async () => {
      const pending = signIn(PUBKEY, { timeout: 5 })
      await new Promise<void>((r) => setTimeout(r, 20))
      const result = await pending
      expect(result.errorType).toBe("timeout")
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    // The request was aborted, so there is nothing to commit later and nothing to clean up.
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true)
    expect(global.fetch).not.toHaveBeenCalledWith("/api/auth/logout", expect.anything())
    expect(authed()).toBe("false")
    expect(authService.signInWithNostrConnect).not.toHaveBeenCalled()
  })

  it("a replacement cannot begin session establishment until a retired attempt's logout completes", async () => {
    const order: string[] = []
    let finishLogout: (v: unknown) => void = () => {}
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes("logout")) {
        order.push("A:logout:start")
        return new Promise((r) => {
          finishLogout = (v) => {
            order.push("A:logout:done")
            r(v)
          }
        })
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch

    authService.nip98Login
      .mockImplementationOnce(async () => {
        order.push("A:login")
        return { success: true }
      })
      .mockImplementation(async () => {
        order.push("B:login")
        return { success: true }
      })

    await renderProvider()

    await act(async () => {
      // A is already retired, so it will establish a session and then discard it.
      const aPending = signIn(PUBKEY, { isCurrent: () => false })
      await new Promise<void>((r) => setTimeout(r, 0))

      // B starts while A's logout is still in flight.
      const bPending = signIn(PUBKEY_B, { timeout: 200 })
      await new Promise<void>((r) => setTimeout(r, 10))

      finishLogout({ ok: true, status: 200, json: async () => ({}) })
      await Promise.all([aPending, bPending])
    })

    // B's login only began after A's logout had completed — so A cannot delete B's session.
    expect(order).toEqual(["A:login", "A:logout:start", "A:logout:done", "B:login"])
    expect(authed()).toBe("true")
  })

  /**
   * MEDIUM (PR #66 review): losing ownership during the post-commit sync must be reported as
   * superseded rather than success, and must not log out the replacement's session.
   */
  it("reports superseded, not success, when ownership is lost during sync", async () => {
    let finishSync: (v: unknown) => void = () => {}
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes("nostr-blink-account")) {
        return new Promise((r) => (finishSync = r))
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch

    const progress: string[] = []

    await renderProvider()

    let owned = true
    let result: { success: boolean; errorType?: string } | undefined
    await act(async () => {
      const pending = signIn(PUBKEY, {
        isCurrent: () => owned,
        onProgress: (stage: string) => progress.push(stage),
      })
      await new Promise<void>((r) => setTimeout(r, 0))
      owned = false
      finishSync({ ok: true, status: 200, json: async () => ({ hasAccount: false }) })
      result = await pending
    })

    expect(result?.success).toBe(false)
    expect(result?.errorType).toBe("superseded")
    // It must not claim completion to the caller...
    expect(progress).not.toContain("complete")
    // ...and must not log out, since the session now belongs to the replacement.
    expect(global.fetch).not.toHaveBeenCalledWith("/api/auth/logout", expect.anything())
  })

  /**
   * HIGH (PR #66 review): the background profile fetch checked ownership only before STARTING.
   * An attempt that commits while CURRENT starts the fetch, and can be superseded afterwards;
   * its late relay response must not publish stale metadata over the replacement's identity.
   */
  it("does not publish a stale attempt's profile metadata after a replacement commits", async () => {
    let finishAProfile: (v: unknown) => void = () => {}
    profileService.fetchProfile.mockImplementation((pubkey: string) => {
      if (pubkey === PUBKEY) return new Promise((r) => (finishAProfile = r))
      return Promise.resolve(null)
    })

    await renderProvider()

    let owned = true
    await act(async () => {
      // A is CURRENT through its commit, so its background fetch starts and hangs.
      const aPending = signIn(PUBKEY, { isCurrent: () => owned })
      await new Promise<void>((r) => setTimeout(r, 0))
      await aPending // committed; fetch now in flight

      // A is retired only AFTER committing, and B commits for a different user.
      owned = false
      await signIn(PUBKEY_B, { isCurrent: () => true })

      // A's stale relay response arrives.
      finishAProfile({ display_name: "stale-A" })
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    expect(screen.getByTestId("profile").textContent).not.toBe("stale-A")
    expect(authed()).toBe("true") // B is the live one
  })

  /**
   * Coverage gap (PR #66 review): the never-settling test started B only after A had cleared
   * the ref, so it did not exercise the bounded predecessor-wait branch. Here B waits on a
   * section A still holds, and its wait is bounded by its own budget.
   */
  it("bounds the predecessor wait by the waiter's own timeout, not the predecessor's", async () => {
    // A's login never settles, so it holds its critical section until its OWN timeout.
    authService.nip98Login
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementation(async () => ({ success: true }))

    await renderProvider()

    let bResult: { success: boolean } | undefined
    await act(async () => {
      const aPending = signIn(PUBKEY, { timeout: 30 })
      await new Promise<void>((r) => setTimeout(r, 0))

      // B arrives while A still holds the section; it waits only its own budget, then proceeds.
      const started = Date.now()
      const bPending = signIn(PUBKEY_B, { timeout: 30 })
      await aPending
      bResult = await bPending
      expect(Date.now() - started).toBeLessThan(3000)
    })

    expect(bResult?.success).toBe(true)
    expect(authed()).toBe("true")
  })

  it("completes normally and publishes state when it owns the flow", async () => {
    await renderProvider()

    let result: { success: boolean } | undefined
    await act(async () => {
      result = await signIn(PUBKEY, { isCurrent: () => true })
      await new Promise<void>((r) => setTimeout(r, 0))
    })

    expect(result?.success).toBe(true)
    expect(authed()).toBe("true")
    expect(authService.signInWithNostrConnect).toHaveBeenCalledWith(PUBKEY)
    expect(profileStorage.getActiveProfileId()).toBe(
      profileStorage.__getProfile(PUBKEY)?.id,
    )
  })

  it("signs with an explicit method so nothing is registered before the session exists", async () => {
    await renderProvider()
    await act(async () => {
      await signIn(PUBKEY)
      await new Promise<void>((r) => setTimeout(r, 0))
    })

    // The signing dispatch is told the method explicitly rather than reading it back out of
    // storage, which is what lets registration happen after the ownership gate.
    expect(authService.nip98Login).toHaveBeenCalledWith({
      signWithMethod: "nostrConnect",
      signal: expect.any(AbortSignal),
    })
    const loginOrder = authService.nip98Login.mock.invocationCallOrder[0]
    const registerOrder = authService.signInWithNostrConnect.mock.invocationCallOrder[0]
    expect(loginOrder).toBeLessThan(registerOrder)
  })

  it("defaults to owned when the caller passes no ownership check", async () => {
    await renderProvider()

    let result: { success: boolean } | undefined
    await act(async () => {
      result = await signIn(PUBKEY)
      await new Promise<void>((r) => setTimeout(r, 0))
    })

    expect(result?.success).toBe(true)
    expect(authed()).toBe("true")
  })
})
