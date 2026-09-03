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

// eslint-disable-next-line @typescript-eslint/no-require-imports -- required after the mocks above
const { NostrAuthProvider, useNostrAuth } =
  require("../../../lib/hooks/useNostrAuth") as typeof import("../../../lib/hooks/useNostrAuth")

const authService = (
  jest.requireMock("../../../lib/nostr/NostrAuthService") as {
    default: Record<string, jest.Mock>
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
  return <div data-testid="authed">{String(auth.isAuthenticated)}</div>
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
  beforeEach(() => {
    jest.clearAllMocks()
    authService.hasPendingChallengeFlow.mockReturnValue(false)
    authService.hasPendingExternalSignerFlow.mockReturnValue(false)
    authService.getStoredAuthData.mockReturnValue({ publicKey: null, method: null })
    authService.isExtensionAvailable.mockReturnValue(false)
    authService.isMobileDevice.mockReturnValue(false)
    authService.getAvailableMethods.mockReturnValue([])
    profileStorage.__reset()
    authService.signInWithNostrConnect.mockReturnValue({ success: true })
    authService.nip98Login.mockResolvedValue({ success: true })
    // Any sync/account fetch the flow makes.
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hasAccount: false }),
    })) as unknown as typeof fetch
  })

  it("rolls back local auth, active profile and the server session when superseded during signing", async () => {
    // The signing round-trip hangs until the test releases it — the bfcache-discard window.
    let finishSigning: (v: { success: boolean }) => void = () => {}
    authService.nip98Login.mockImplementation(
      () => new Promise((r) => (finishSigning = r)),
    )

    await renderProvider()
    expect(authed()).toBe("false")

    // Seed the pre-existing state AFTER mount, so only the sign-in flow observes it: a
    // different user was already signed in with an active profile, and being superseded must
    // leave THEIR state intact rather than the retired attempt's.
    authService.getStoredAuthData.mockReturnValue({
      publicKey: "previous-user",
      method: "extension",
    })
    profileStorage.__setActiveId("previous-profile")
    // Forget anything the provider's own mount did, so the assertions below describe only what
    // the sign-in attempt caused.
    profileStorage.createProfile.mockClear()
    profileStorage.setActiveProfile.mockClear()
    authService.storeAuthData.mockClear()
    authService.clearAuthData.mockClear()
    ;(global.fetch as jest.Mock).mockClear()

    let owned = true
    let result: { success: boolean; errorType?: string } | undefined
    await act(async () => {
      const pending = signIn(PUBKEY, { isCurrent: () => owned })
      await new Promise<void>((r) => setTimeout(r, 0))
      owned = false
      finishSigning({ success: true }) // the session cookie now exists
      result = await pending
    })

    expect(result?.success).toBe(false)
    expect(result?.errorType).toBe("superseded")

    // Provider state never published.
    expect(authed()).toBe("false")

    // The profile mutations are DEFERRED past the ownership check, so the retired user never
    // got a profile created or activated for them — and the active pointer is therefore
    // untouched rather than restored.
    expect(profileStorage.createProfile).not.toHaveBeenCalled()
    expect(profileStorage.getActiveProfileId()).toBe("previous-profile")

    // The server session established by nip98Login was cleared.
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    )
    // Local auth was restored to the PREVIOUS user, not left as the retired one.
    expect(authService.storeAuthData).toHaveBeenCalledWith("previous-user", "extension")
    expect(authService.clearAuthData).not.toHaveBeenCalled()
    // No account sync was attempted for the retired attempt.
    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/auth/nostr-blink-account",
      expect.anything(),
    )
  })

  it("clears local auth on rollback when there was no previous user", async () => {
    authService.getStoredAuthData.mockReturnValue({ publicKey: null, method: null })

    let finishSigning: (v: { success: boolean }) => void = () => {}
    authService.nip98Login.mockImplementation(
      () => new Promise((r) => (finishSigning = r)),
    )

    await renderProvider()

    let owned = true
    await act(async () => {
      const pending = signIn(PUBKEY, { isCurrent: () => owned })
      await new Promise<void>((r) => setTimeout(r, 0))
      owned = false
      finishSigning({ success: true })
      await pending
    })

    // Nothing to restore, so the retired attempt's auth data is cleared outright.
    expect(authService.clearAuthData).toHaveBeenCalled()
    expect(authService.storeAuthData).not.toHaveBeenCalled()
    expect(authed()).toBe("false")
  })

  it("commits nothing when ownership is lost during the account sync", async () => {
    // Signing succeeds; the SYNC request is what hangs, so ownership is lost inside it.
    let finishSync: (v: unknown) => void = () => {}
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes("nostr-blink-account")) {
        return new Promise((r) => (finishSync = r))
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch

    await renderProvider()

    // Seeded after mount (see above).
    authService.getStoredAuthData.mockReturnValue({
      publicKey: "previous-user",
      method: "extension",
    })
    profileStorage.__setActiveId("previous-profile")

    let owned = true
    let result: { success: boolean; errorType?: string } | undefined
    await act(async () => {
      const pending = signIn(PUBKEY, { isCurrent: () => owned })
      await new Promise<void>((r) => setTimeout(r, 0))
      owned = false
      // The sync response arrives with an account to write — but ownership is already gone.
      finishSync({
        ok: true,
        status: 200,
        json: async () => ({
          hasAccount: true,
          blinkUsername: "someone",
          apiKey: "key",
        }),
      })
      result = await pending
    })

    expect(result?.errorType).toBe("superseded")
    // The sync must not have written the account into profile storage.
    expect(profileStorage.updateProfile).not.toHaveBeenCalled()
    expect(authed()).toBe("false")
    // And the attempt was rolled back: the profile it activated is no longer active, the
    // previous one is.
    expect(authService.storeAuthData).toHaveBeenCalledWith("previous-user", "extension")
    expect(profileStorage.getActiveProfileId()).toBe("previous-profile")
  })

  /**
   * HIGH (PR #66 review): rollback operates on SHARED state — auth data, the session cookie and
   * the active profile. A superseded attempt A must never undo a replacement B's work. These
   * cover the overlapping case with B completing first and A settling late.
   */
  it("a superseded attempt does not log out or overwrite a replacement that already completed", async () => {
    // A hangs at signing; B (started later) signs immediately.
    const signingGates: Array<(v: { success: boolean }) => void> = []
    authService.nip98Login.mockImplementation(
      () =>
        new Promise((r) => {
          signingGates.push(r)
        }),
    )

    await renderProvider()
    profileStorage.__setActiveId("previous-profile")
    authService.getStoredAuthData.mockReturnValue({
      publicKey: "previous-user",
      method: "extension",
    })
    ;(global.fetch as jest.Mock).mockClear()
    authService.storeAuthData.mockClear()
    authService.clearAuthData.mockClear()

    let aOwned = true
    let aResult: { errorType?: string } | undefined
    await act(async () => {
      // A starts and reaches its signing await.
      const aPending = signIn(PUBKEY, { isCurrent: () => aOwned })
      await new Promise<void>((r) => setTimeout(r, 0))

      // A is retired, and B starts and COMPLETES fully while A is still hanging.
      aOwned = false
      const bPending = signIn(PUBKEY, { isCurrent: () => true })
      await new Promise<void>((r) => setTimeout(r, 0))
      signingGates[1]({ success: true }) // B's signing succeeds
      await bPending

      // Only now does A settle and try to clean up.
      signingGates[0]({ success: true })
      aResult = await aPending
    })

    expect(aResult?.errorType).toBe("superseded")

    // B is still current everywhere: its session was not logged out...
    expect(global.fetch).not.toHaveBeenCalledWith("/api/auth/logout", expect.anything())
    // ...its local auth was not overwritten with A's snapshot...
    expect(authService.storeAuthData).not.toHaveBeenCalledWith(
      "previous-user",
      "extension",
    )
    expect(authService.clearAuthData).not.toHaveBeenCalled()
    // ...its profile is still the active one, not the pre-A profile...
    expect(profileStorage.getActiveProfileId()).toBe(
      profileStorage.__getProfile(PUBKEY)?.id,
    )
    expect(profileStorage.getActiveProfileId()).not.toBe("previous-profile")
    expect(profileStorage.deleteProfile).not.toHaveBeenCalled()
    // ...and the provider still reports B's authenticated state.
    expect(authed()).toBe("true")
  })

  it("a replacement waits for a superseded attempt's rollback before registering", async () => {
    // A's rollback hangs inside the logout request; B must not start on top of it.
    let finishLogout: (v: unknown) => void = () => {}
    const order: string[] = []
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes("logout")) {
        order.push("logout:start")
        return new Promise((r) => {
          finishLogout = (v) => {
            order.push("logout:done")
            r(v)
          }
        })
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch

    let finishSigningA: (v: { success: boolean }) => void = () => {}
    authService.nip98Login.mockImplementationOnce(
      () => new Promise((r) => (finishSigningA = r)),
    )

    await renderProvider()
    ;(global.fetch as jest.Mock).mockClear()

    let aOwned = true
    await act(async () => {
      const aPending = signIn(PUBKEY, { isCurrent: () => aOwned })
      await new Promise<void>((r) => setTimeout(r, 0))
      aOwned = false
      finishSigningA({ success: true }) // A settles → rollback begins, hangs on logout
      await new Promise<void>((r) => setTimeout(r, 0))

      // B starts while A's cleanup is still in flight.
      authService.nip98Login.mockImplementation(async () => {
        order.push("B:signing")
        return { success: true }
      })
      const bPending = signIn(PUBKEY, { isCurrent: () => true })
      await new Promise<void>((r) => setTimeout(r, 0))

      finishLogout({ ok: true, status: 200, json: async () => ({}) })
      await Promise.all([aPending, bPending])
    })

    // B's work began only after A's cleanup finished — no interleaving.
    expect(order).toEqual(["logout:start", "logout:done", "B:signing"])
    expect(authed()).toBe("true")
  })

  /**
   * HIGH (PR #66 review): the ownership ticket alone left a hole. If A is superseded by B and
   * then B FAILS, A skips cleanup (no longer latest) while B has nothing of its own to undo —
   * so A's server session survives under B's local auth. The baseline is therefore captured
   * once per chain and inherited, and whichever attempt ends the chain unsuccessfully restores
   * the state from before ALL of them.
   */
  const PUBKEY_B = "c".repeat(64)

  it("restores the pre-A baseline when A establishes a session and the replacement B then fails", async () => {
    // A hangs at signing; B (distinct user) fails its NIP-98 login.
    const gates: Array<(v: { success: boolean; error?: string }) => void> = []
    authService.nip98Login.mockImplementation(() => new Promise((r) => gates.push(r)))

    await renderProvider()
    // The true pre-A baseline: a different user was signed in, with their own active profile.
    authService.getStoredAuthData.mockReturnValue({
      publicKey: "baseline-user",
      method: "extension",
    })
    profileStorage.__seedProfile("baseline-user", "baseline-profile")
    profileStorage.__setActiveId("baseline-profile")
    ;(global.fetch as jest.Mock).mockClear()
    authService.storeAuthData.mockClear()

    let aOwned = true
    await act(async () => {
      const aPending = signIn(PUBKEY, { isCurrent: () => aOwned })
      await new Promise<void>((r) => setTimeout(r, 0))

      // A is retired and B starts; A's session is established as it settles.
      aOwned = false
      const bPending = signIn(PUBKEY_B, { isCurrent: () => true })
      await new Promise<void>((r) => setTimeout(r, 0))

      gates[0]({ success: true }) // A's cookie now exists; A defers cleanup to the chain
      await aPending
      gates[1]({ success: false, error: "nope" }) // B fails AFTER registering
      await bPending
    })

    // The chain ended unsuccessfully, so the session A created is gone...
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    )
    // ...and the true pre-A baseline is restored, not B's or A's registration.
    expect(authService.storeAuthData).toHaveBeenLastCalledWith(
      "baseline-user",
      "extension",
    )
    expect(profileStorage.getActiveProfileId()).toBe("baseline-profile")
    expect(authed()).toBe("false")
  })

  it("restores the pre-A baseline when the replacement B times out", async () => {
    const gates: Array<(v: { success: boolean }) => void> = []
    authService.nip98Login.mockImplementation(() => new Promise((r) => gates.push(r)))

    await renderProvider()
    authService.getStoredAuthData.mockReturnValue({
      publicKey: "baseline-user",
      method: "extension",
    })
    profileStorage.__seedProfile("baseline-user", "baseline-profile")
    profileStorage.__setActiveId("baseline-profile")
    ;(global.fetch as jest.Mock).mockClear()
    authService.storeAuthData.mockClear()

    let aOwned = true
    await act(async () => {
      const aPending = signIn(PUBKEY, { isCurrent: () => aOwned })
      await new Promise<void>((r) => setTimeout(r, 0))
      aOwned = false
      // B uses a tiny timeout and never resolves its signing, so it throws TIMEOUT.
      const bPending = signIn(PUBKEY_B, { isCurrent: () => true, timeout: 5 })
      await new Promise<void>((r) => setTimeout(r, 0))
      gates[0]({ success: true })
      await aPending
      await new Promise<void>((r) => setTimeout(r, 20)) // let B's timeout fire
      const bResult = await bPending
      expect(bResult.errorType).toBe("timeout")
    })

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    )
    expect(authService.storeAuthData).toHaveBeenLastCalledWith(
      "baseline-user",
      "extension",
    )
    expect(profileStorage.getActiveProfileId()).toBe("baseline-profile")
  })

  /**
   * MEDIUM (PR #66 review): rollback must restore the COMPLETE prior profile state — deleting a
   * profile this attempt created is a separate obligation from restoring the pointer, and a
   * pre-existing profile must be left intact with its metadata unchanged.
   */
  it("deletes an attempt-created profile AND restores the previous pointer", async () => {
    // Signing succeeds so the profile is created and activated; ownership is then lost during
    // the SYNC, which is the window where a created profile actually exists.
    let finishSync: (v: unknown) => void = () => {}
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes("nostr-blink-account")) {
        return new Promise((r) => (finishSync = r))
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch

    await renderProvider()
    // Another profile is active, and this pubkey has NO profile yet.
    profileStorage.__seedProfile("other-user", "other-profile")
    profileStorage.__setActiveId("other-profile")

    let owned = true
    await act(async () => {
      const pending = signIn(PUBKEY, { isCurrent: () => owned })
      await new Promise<void>((r) => setTimeout(r, 0))
      owned = false
      finishSync({ ok: true, status: 200, json: async () => ({}) })
      await pending
    })

    // The created profile is gone (not merely deactivated) AND the pointer is back.
    expect(profileStorage.__getProfile(PUBKEY)).toBeNull()
    expect(profileStorage.deleteProfile).toHaveBeenCalled()
    expect(profileStorage.getActiveProfileId()).toBe("other-profile")
  })

  it("keeps a pre-existing profile, restores its metadata, and clears a null pointer", async () => {
    // Ownership is lost during the SYNC, so createProfile has already stamped the existing
    // profile — which is exactly the mutation the restore has to undo. Superseding earlier
    // would make this pass trivially.
    let finishSync: (v: unknown) => void = () => {}
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes("nostr-blink-account")) {
        return new Promise((r) => (finishSync = r))
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch

    await renderProvider()
    // This pubkey already has a profile, and NOTHING is active.
    profileStorage.__seedProfile(PUBKEY, "existing-profile", {
      lastLogin: 111,
      signInMethod: "extension",
    })
    profileStorage.__setActiveId(null)

    let owned = true
    await act(async () => {
      const pending = signIn(PUBKEY, { isCurrent: () => owned })
      await new Promise<void>((r) => setTimeout(r, 0))
      owned = false
      finishSync({ ok: true, status: 200, json: async () => ({}) })
      await pending
    })

    // The user's own profile survives, with the metadata createProfile stamped put back...
    const profile = profileStorage.__getProfile(PUBKEY)
    expect(profile?.id).toBe("existing-profile")
    expect(profile?.lastLogin).toBe(111)
    expect(profile?.signInMethod).toBe("extension")
    expect(profileStorage.deleteProfile).not.toHaveBeenCalled()
    // ...and "nothing was active" is restored rather than leaving the retired attempt active.
    expect(profileStorage.getActiveProfileId()).toBeNull()
  })

  it("still completes normally while the attempt is still owned", async () => {
    await renderProvider()

    let result: { success: boolean } | undefined
    await act(async () => {
      result = await signIn(PUBKEY, { isCurrent: () => true })
      await new Promise<void>((r) => setTimeout(r, 0))
    })

    expect(result?.success).toBe(true)
    expect(authed()).toBe("true")
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
