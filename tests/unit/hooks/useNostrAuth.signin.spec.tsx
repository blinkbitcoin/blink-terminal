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
jest.mock("../../../lib/storage/ProfileStorage", () => {
  let activeId: string | null = null
  return {
    __esModule: true,
    default: {
      __setActiveId: (id: string | null): void => {
        activeId = id
      },
      createProfile: jest.fn((publicKey: string) => {
        activeId = "profile-1" // the real one activates a newly created profile
        return { id: "profile-1", publicKey, blinkAccounts: [] }
      }),
      setActiveProfile: jest.fn((id: string) => {
        activeId = id
      }),
      getActiveProfileId: jest.fn(() => activeId),
      deleteProfile: jest.fn((id: string) => {
        if (activeId === id) activeId = null
      }),
      getProfileById: jest.fn(() => ({ id: "profile-1", blinkAccounts: [] })),
      getProfileByPublicKey: jest.fn(() => ({ id: "profile-1", blinkAccounts: [] })),
      loadProfile: jest.fn(() => ({ id: "profile-1", blinkAccounts: [] })),
      updateProfile: jest.fn(),
    },
  }
})

jest.mock("../../../lib/nostr/NostrProfileService", () => ({
  __esModule: true,
  default: { fetchProfile: jest.fn(async () => null) },
}))

jest.mock("../../../lib/storage/CryptoUtils", () => ({
  __esModule: true,
  default: { encryptWithDeviceKey: jest.fn(async () => ({ ciphertext: "x" })) },
}))

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
    profileStorage.__setActiveId(null)
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
    expect(profileStorage.getActiveProfileId()).toBe("profile-1")
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
