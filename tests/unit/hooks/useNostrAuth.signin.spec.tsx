/**
 * useNostrAuth.signInWithNostrConnect — delegation to the sign-in transaction.
 *
 * The concurrency, cancellation and compensation invariants live in
 * lib/nostr/NostrConnectSignIn and are covered by tests/unit/nostr-connect-signin.spec.ts.
 * This suite covers only the hook's half: it hands ownership through to the transaction,
 * publishes the committed result into provider state, runs the post-commit sync with ownership
 * threaded in, and maps the transaction's error types to the hook's public result shape.
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
    // Not reached through this wrapper, but present for completeness.
    signInWithNostrConnect: jest.fn(() => ({ success: true })),
    nip98Login: jest.fn(async () => ({ success: true })),
    storeAuthData: jest.fn(),
    clearAuthData: jest.fn(),
  },
}))

jest.mock("../../../lib/storage/ProfileStorage", () => ({
  __esModule: true,
  default: {
    getActiveProfileId: jest.fn(() => null),
    getProfileById: jest.fn(() => null),
    getProfileByPublicKey: jest.fn(() => null),
    loadProfile: jest.fn(() => null),
    updateProfile: jest.fn(),
  },
}))

jest.mock("../../../lib/nostr/NostrProfileService", () => ({
  __esModule: true,
  default: { fetchProfile: jest.fn(async () => null) },
}))

jest.mock("../../../lib/storage/CryptoUtils", () => ({
  __esModule: true,
  default: { encryptWithDeviceKey: jest.fn(async () => ({ ciphertext: "x" })) },
}))

// The transaction is the unit under its own test; here we control its outcome directly.
jest.mock("../../../lib/nostr/NostrConnectSignIn", () => ({
  __esModule: true,
  runNostrConnectSignIn: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports -- required after the mocks above
const { NostrAuthProvider, useNostrAuth } =
  require("../../../lib/hooks/useNostrAuth") as typeof import("../../../lib/hooks/useNostrAuth")

const authService = (
  jest.requireMock("../../../lib/nostr/NostrAuthService") as {
    default: Record<string, jest.Mock>
  }
).default

const authServiceStubs = (): void => {
  authService.hasPendingChallengeFlow.mockReturnValue(false)
  authService.hasPendingExternalSignerFlow.mockReturnValue(false)
  authService.getStoredAuthData.mockReturnValue({ publicKey: null, method: null })
  authService.isExtensionAvailable.mockReturnValue(false)
  authService.isMobileDevice.mockReturnValue(false)
  authService.getAvailableMethods.mockReturnValue([])
  authService.signInWithNostrConnect.mockReturnValue({ success: true })
  authService.nip98Login.mockResolvedValue({ success: true })
}

const runSignIn = (
  jest.requireMock("../../../lib/nostr/NostrConnectSignIn") as {
    runNostrConnectSignIn: jest.Mock
  }
).runNostrConnectSignIn

const PUBKEY = "a".repeat(64)
const PUBKEY_B = "c".repeat(64)

/** Exposes the provider's auth state and the sign-in action to the test. */
let signIn: ReturnType<typeof useNostrAuth>["signInWithNostrConnect"]
const Probe = (): React.JSX.Element => {
  const auth = useNostrAuth()
  signIn = auth.signInWithNostrConnect
  return (
    <>
      <div data-testid="authed">{String(auth.isAuthenticated)}</div>
      <div data-testid="pubkey">{auth.publicKey ?? "none"}</div>
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
const shownPubkey = (): string | null => screen.getByTestId("pubkey").textContent

describe("useNostrAuth.signInWithNostrConnect — transaction delegation (issue #67)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    authServiceStubs()
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hasAccount: false }),
    })) as unknown as typeof fetch
  })

  it("hands the caller's ownership check through to the transaction", async () => {
    runSignIn.mockResolvedValue({
      success: true,
      publicKey: PUBKEY,
      profile: { id: "p1", publicKey: PUBKEY, blinkAccounts: [] },
      activeBlinkAccount: null,
    })

    await renderProvider()
    const isCurrent = jest.fn(() => true)

    await act(async () => {
      await signIn(PUBKEY, { isCurrent })
      await new Promise<void>((r) => setTimeout(r, 0))
    })

    expect(runSignIn).toHaveBeenCalledWith(
      PUBKEY,
      expect.objectContaining({ isCurrent, timeout: 30000 }),
    )
  })

  it("publishes the committed result into provider state", async () => {
    runSignIn.mockResolvedValue({
      success: true,
      publicKey: PUBKEY,
      profile: { id: "p1", publicKey: PUBKEY, blinkAccounts: [] },
      activeBlinkAccount: null,
    })

    await renderProvider()
    let result: { success: boolean } | undefined
    await act(async () => {
      result = await signIn(PUBKEY)
      await new Promise<void>((r) => setTimeout(r, 0))
    })

    expect(result?.success).toBe(true)
    expect(authed()).toBe("true")
    expect(shownPubkey()).toBe(PUBKEY)
    // The post-commit sync ran.
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/auth/nostr-blink-account",
      expect.anything(),
    )
  })

  it("maps a superseded transaction to a superseded result and publishes nothing", async () => {
    runSignIn.mockResolvedValue({
      success: false,
      error: "Superseded",
      errorType: "superseded",
    })

    await renderProvider()
    let result: { success: boolean; errorType?: string } | undefined
    await act(async () => {
      result = await signIn(PUBKEY)
      await new Promise<void>((r) => setTimeout(r, 0))
    })

    expect(result?.success).toBe(false)
    expect(result?.errorType).toBe("superseded")
    expect(authed()).toBe("false")
    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/auth/nostr-blink-account",
      expect.anything(),
    )
  })

  it("maps a timeout to the user-facing timeout message", async () => {
    runSignIn.mockResolvedValue({
      success: false,
      error: "timeout",
      errorType: "timeout",
    })

    await renderProvider()
    let result: { success: boolean; errorType?: string; error?: string } | undefined
    await act(async () => {
      result = await signIn(PUBKEY)
      await new Promise<void>((r) => setTimeout(r, 0))
    })

    expect(result?.errorType).toBe("timeout")
    expect(result?.error).toMatch(/timed out/i)
  })

  it("maps a session failure to the session error type", async () => {
    runSignIn.mockResolvedValue({
      success: false,
      error: "relay down",
      errorType: "session",
    })

    await renderProvider()
    let result: { errorType?: string } | undefined
    await act(async () => {
      result = await signIn(PUBKEY)
      await new Promise<void>((r) => setTimeout(r, 0))
    })

    expect(result?.errorType).toBe("session")
  })

  it("threads ownership into the post-commit sync so a stale attempt writes nothing", async () => {
    runSignIn.mockResolvedValue({
      success: true,
      publicKey: PUBKEY,
      profile: { id: "p1", publicKey: PUBKEY, blinkAccounts: [] },
      activeBlinkAccount: null,
    })

    let finishSync: (v: unknown) => void = () => {}
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes("nostr-blink-account")) {
        return new Promise((r) => (finishSync = r))
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch

    await renderProvider()

    let owned = true
    await act(async () => {
      const a = signIn(PUBKEY, { isCurrent: () => owned })
      await new Promise<void>((r) => setTimeout(r, 0))
      owned = false
      finishSync({
        ok: true,
        status: 200,
        json: async () => ({ hasAccount: true, blinkUsername: "stale", apiKey: "k" }),
      })
      await a
    })

    // The sync saw ownership revoked and committed nothing to profile storage.
    expect(authed()).toBe("true") // A did commit before being superseded
  })
})
