/**
 * NostrConnectModal — same-device mobile NIP-46 resume regressions (PR #61 review blockers).
 *
 * Blocker 1 (legacy-vs-NDK service selection) lives in NostrConnectModal.resume-ndk.spec.tsx
 * — the USE_NDK flag is a module-level const, so it must be set before the component's module
 * loads; a dedicated file does that.
 *
 * Blocker 2: a foreground return while the authentication is already in flight must NOT start
 * a second NIP-98 request (duplicate signer prompts / racing login). The guard lives at the
 * handleConnectionSuccess boundary (authInFlightRef), protecting every caller.
 *
 * Round-2 blocker: a foreground return while a fresh waitForConnection() attempt is still
 * PENDING must leave it alone (it owns the flow), and a superseded attempt must never mutate
 * state when it eventually settles (flow generation guard).
 *
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import React from "react"

// Force the Android branch BEFORE importing the component (isAndroid is module-level).
Object.defineProperty(window.navigator, "userAgent", {
  value: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36",
  configurable: true,
})

// jest.mock factories run when the component (required below) is loaded, before any const in
// this file initializes. Mock surfaces are created inside the factories and read back in tests
// via jest.requireMock — the one reliable way to reach them.
jest.mock("../../../lib/nostr/NostrConnectService", () => ({
  __esModule: true,
  default: {
    isConnected: jest.fn(() => false),
    hasStoredSession: jest.fn(() => false),
    restoreSession: jest.fn(async () => ({ success: false })),
    waitForConnection: jest.fn(async () => ({ success: false })),
    disconnect: jest.fn(),
    getConnectionState: jest.fn(() => "disconnected"),
  },
}))
jest.mock("../../../lib/nostr/NostrConnectServiceNDK", () => ({
  __esModule: true,
  default: {
    isConnected: jest.fn(() => false),
    hasStoredSession: jest.fn(() => false),
    restoreSession: jest.fn(async () => ({ success: false })),
    disconnect: jest.fn(),
    getConnectionState: jest.fn(() => "disconnected"),
  },
}))

// Accessors resolved lazily (after the modules are mocked).
const legacy = () =>
  (
    jest.requireMock("../../../lib/nostr/NostrConnectService") as {
      default: Record<string, jest.Mock>
    }
  ).default
const ndk = () =>
  (
    jest.requireMock("../../../lib/nostr/NostrConnectServiceNDK") as {
      default: Record<string, jest.Mock>
    }
  ).default

// Keep the render light — the resume logic is what is under test, not the chrome.
jest.mock("qrcode.react", () => ({ QRCodeSVG: () => null }))
jest.mock("../../../components/auth/ProgressStepper", () => () => null)

// The component computes isAndroid/isIOS from navigator.userAgent at MODULE LOAD. The UA is
// set above (line ~20), so the component must be required lazily — a static import would hoist
// above the override and read the default jsdom UA.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy require so the module-load UA override above takes effect
const NostrConnectModal = require("../../../components/auth/NostrConnectModal")
  .default as typeof import("../../../components/auth/NostrConnectModal").default

const flush = () => new Promise<void>((r) => setTimeout(r, 0))
// handleConnectionSuccess has a 300ms "show connected" delay before the sign step — flush
// past it so the sign request is actually issued.
const flushThroughConnectDelay = () => new Promise<void>((r) => setTimeout(r, 350))

// Drive a foreground transition exactly as a returning mobile browser does.
const foreground = async () => {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("focus"))
    await flush()
  })
}

const PUBKEY = "a".repeat(64)

const renderModal = (signInWithNostrConnect = jest.fn()) =>
  render(
    <NostrConnectModal
      uri="nostrconnect://clientpubkey?relay=wss%3A%2F%2Fr.example&secret=s&name=Blink%20POS"
      signInWithNostrConnect={signInWithNostrConnect}
    />,
  )

describe("NostrConnectModal — same-device NIP-46 resume (review blockers)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    legacy().isConnected.mockReturnValue(false)
    legacy().hasStoredSession.mockReturnValue(false)
    legacy().restoreSession.mockResolvedValue({ success: false })
    legacy().waitForConnection.mockResolvedValue({ success: false })
    ndk().isConnected.mockReturnValue(false)
    ndk().hasStoredSession.mockReturnValue(false)
  })

  /**
   * Blocker 2: while a NIP-98 sign-in is in flight, a foreground return must NOT launch a
   * second sign request.
   */
  it("does not start a second sign-in while one is already in flight", async () => {
    // A sign-in that never resolves on its own — simulates the in-flight challenge.
    let resolveSign: (v: { success: boolean }) => void = () => {}
    const signIn = jest.fn(
      () => new Promise<{ success: boolean }>((r) => (resolveSign = r)),
    )

    legacy().waitForConnection.mockResolvedValue({ success: true, publicKey: PUBKEY })
    legacy().isConnected.mockReturnValue(true)
    legacy().hasStoredSession.mockReturnValue(true)

    renderModal(signIn)

    // Start the flow (connect → success → sign begins, staying in flight).
    await act(async () => {
      fireClick(openInAmberButton())
      await flushThroughConnectDelay()
    })
    expect(signIn).toHaveBeenCalledTimes(1)

    // Foreground return while that sign is still running → no second request.
    await foreground()
    await act(async () => flushThroughConnectDelay())

    expect(signIn).toHaveBeenCalledTimes(1)

    // Clean up the dangling promise.
    await act(async () => {
      resolveSign({ success: true })
      await flush()
    })
  })

  /**
   * Round-2 blocker: a foreground return while the fresh connect attempt is still PENDING
   * must leave it alone — no UI reset, no session restore — and the attempt must complete
   * the flow exactly once when it eventually settles.
   */
  it("leaves a pending waitForConnection attempt alone on foreground, and it completes once", async () => {
    // The connect attempt never settles until the test says so — this is the exact state a
    // backgrounded tab is in while the user approves in the signer app.
    let resolveConnect: (v: { success: boolean; publicKey: string }) => void = () => {}
    legacy().waitForConnection.mockReturnValue(
      new Promise<{ success: boolean; publicKey: string }>((r) => (resolveConnect = r)),
    )
    const signIn = jest.fn(async () => ({ success: true }))
    renderModal(signIn)

    await act(async () => {
      fireClick(openInAmberButton())
      await flush()
    })

    // Foreground return mid-attempt: the pending attempt owns the flow.
    await foreground()
    await act(async () => flush())

    expect(legacy().restoreSession).not.toHaveBeenCalled()
    expect(signIn).not.toHaveBeenCalled()

    // The signer answers: the SAME attempt drives sign-in exactly once.
    await act(async () => {
      resolveConnect({ success: true, publicKey: PUBKEY })
      await flushThroughConnectDelay()
    })

    expect(signIn).toHaveBeenCalledTimes(1)
    expect(signIn).toHaveBeenCalledWith(PUBKEY, expect.anything())
  })

  /**
   * Restore path coverage: an ESTABLISHED connection (pubkey known, sign hung on a dead
   * socket) restores from the stored session on foreground — exactly once — and the
   * auth-in-flight guard prevents a duplicate sign while the original is still running.
   */
  it("restores the dropped session once on foreground (established connection, dead socket)", async () => {
    let resolveSign: (v: { success: boolean }) => void = () => {}
    const signIn = jest.fn(
      () => new Promise<{ success: boolean }>((r) => (resolveSign = r)),
    )
    legacy().waitForConnection.mockResolvedValue({ success: true, publicKey: PUBKEY })
    legacy().hasStoredSession.mockReturnValue(true)
    legacy().restoreSession.mockResolvedValue({ success: true, publicKey: PUBKEY })

    renderModal(signIn)
    await act(async () => {
      fireClick(openInAmberButton())
      await flushThroughConnectDelay()
    })
    expect(signIn).toHaveBeenCalledTimes(1)

    // The socket dies while the sign hangs.
    legacy().isConnected.mockReturnValue(false)

    await foreground()
    await act(async () => flush())

    expect(legacy().restoreSession).toHaveBeenCalledTimes(1)
    // The original sign is still in flight — the restore's handleConnectionSuccess must not
    // start a second one (authInFlightRef guard).
    expect(signIn).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveSign({ success: true })
      await flush()
    })
  })

  /** Restore failure: the modal resets to idle so the user can reopen the signer. */
  it("resets to idle when the stored session fails to restore", async () => {
    let resolveSign: (v: { success: boolean }) => void = () => {}
    const signIn = jest.fn(
      () => new Promise<{ success: boolean }>((r) => (resolveSign = r)),
    )
    legacy().waitForConnection.mockResolvedValue({ success: true, publicKey: PUBKEY })
    legacy().hasStoredSession.mockReturnValue(true)
    legacy().restoreSession.mockResolvedValue({ success: false, error: "dead" })

    renderModal(signIn)
    await act(async () => {
      fireClick(openInAmberButton())
      await flushThroughConnectDelay()
    })

    legacy().isConnected.mockReturnValue(false)

    await foreground()
    await act(async () => flush())

    expect(legacy().restoreSession).toHaveBeenCalledTimes(1)
    expect(signIn).toHaveBeenCalledTimes(1)
    // Back at the idle options view — the entry points are offered again.
    expect(openInAmberButton()).toBeTruthy()

    await act(async () => {
      resolveSign({ success: true })
      await flush()
    })
  })

  /**
   * Legitimate retry: after a sign-in FAILS (guard released in finally), the error Retry
   * button must start a fresh sign — the auth-in-flight guard is not a permanent block.
   */
  it("allows a legitimate retry after the in-flight guard is released", async () => {
    const signIn = jest
      .fn<Promise<{ success: boolean }>, []>()
      .mockRejectedValueOnce(new Error("relay timeout"))
      .mockResolvedValue({ success: true })
    legacy().waitForConnection.mockResolvedValue({ success: true, publicKey: PUBKEY })
    legacy().isConnected.mockReturnValue(true)

    renderModal(signIn)
    await act(async () => {
      fireClick(openInAmberButton())
      await flushThroughConnectDelay()
    })
    expect(signIn).toHaveBeenCalledTimes(1)
    // The failure surfaced the error state with the Retry button.
    const retry = await screen.findByRole("button", { name: /Try Again/i })

    await act(async () => {
      fireClick(retry)
      await flushThroughConnectDelay()
    })

    // The retry ran a second, legitimate sign-in.
    expect(signIn).toHaveBeenCalledTimes(2)
  })

  it("resets to idle (no session, not connected) so the user can reopen the signer", async () => {
    legacy().isConnected.mockReturnValue(false)
    legacy().hasStoredSession.mockReturnValue(false)

    const signIn = jest.fn(async () => ({ success: true }))
    renderModal(signIn)

    await act(async () => {
      fireClick(openInAmberButton())
      await flush()
    })

    await foreground()
    await act(async () => flush())

    // No pubkey was ever obtained, so sign-in must not run; the modal returns to idle.
    expect(signIn).not.toHaveBeenCalled()
    expect(legacy().restoreSession).not.toHaveBeenCalled()
  })
})

// Minimal event helper (jsdom click).
function fireClick(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
}

// The Android "Open in Amber" button (the text also appears verbatim in the instructions
// list, so match the BUTTON by role, not the text alone).
const openInAmberButton = () =>
  screen
    .getAllByRole("button")
    .find((b) => /Open in Amber/i.test(b.textContent ?? "")) as HTMLElement
