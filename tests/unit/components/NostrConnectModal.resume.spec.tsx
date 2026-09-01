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
// The original UA is captured and restored in afterAll so this file does not leak its
// global override into whatever runs after it in the same jest worker.
const ORIGINAL_UA = window.navigator.userAgent
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
    disconnect: jest.fn(async () => undefined),
    getConnectionState: jest.fn(() => "disconnected"),
  },
}))

// Accessor resolved lazily (after the module is mocked).
const legacy = () =>
  (
    jest.requireMock("../../../lib/nostr/NostrConnectService") as {
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
  })

  afterAll(() => {
    // Undo the module-scope UA override so no global state leaks beyond this file.
    Object.defineProperty(window.navigator, "userAgent", {
      value: ORIGINAL_UA,
      configurable: true,
    })
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
   * Restore path (round-3 blocker): an ESTABLISHED connection whose socket died mid-sign gets
   * restored on foreground, and the restore SUPERSEDES the hung original authentication — a
   * replacement sign runs through the restored signer and completes the login. The hung
   * original settling late (success OR rejection) must change no state and fire no callbacks.
   */
  it("restores the dropped session and re-drives auth through it; the hung original's late settle is inert", async () => {
    // Call 1 (original, dead socket) hangs until the test settles it late. Call 2 (the
    // replacement through the restored signer) resolves successfully.
    const deferreds: Array<{
      resolve: (v: { success: boolean }) => void
      reject: (e: Error) => void
    }> = []
    const signIn = jest.fn(
      () =>
        new Promise<{ success: boolean }>((resolve, reject) => {
          deferreds.push({ resolve, reject })
        }),
    )
    const onSuccess = jest.fn()
    legacy().waitForConnection.mockResolvedValue({ success: true, publicKey: PUBKEY })
    legacy().hasStoredSession.mockReturnValue(true)
    legacy().restoreSession.mockResolvedValue({ success: true, publicKey: PUBKEY })

    render(
      <NostrConnectModal
        uri="nostrconnect://clientpubkey?relay=wss%3A%2F%2Fr.example&secret=s&name=Blink%20POS"
        signInWithNostrConnect={signIn}
        onSuccess={onSuccess}
      />,
    )

    // Connect, sign begins and hangs (dead socket).
    await act(async () => {
      fireClick(openInAmberButton())
      await flushThroughConnectDelay()
    })
    expect(signIn).toHaveBeenCalledTimes(1)

    // Socket dies; foreground → restore → replacement auth runs.
    legacy().isConnected.mockReturnValue(false)
    await act(async () => {
      await foreground()
      await flushThroughConnectDelay()
    })

    expect(legacy().restoreSession).toHaveBeenCalledTimes(1)
    // The replacement auth started through the restored signer.
    expect(signIn).toHaveBeenCalledTimes(2)

    // The replacement completes → login completes exactly once.
    await act(async () => {
      deferreds[1].resolve({ success: true })
      // Past the 600ms completion timeout that owns onSuccess.
      await new Promise((r) => setTimeout(r, 650))
    })
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledWith(PUBKEY)

    // The hung ORIGINAL now settles late with an error (its 30s timeout). Its continuation
    // must be inert: no second onSuccess, and the completed UI must not flip to error.
    await act(async () => {
      deferreds[0].reject(new Error("TIMEOUT"))
      await flush()
    })
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("button", { name: /Try Again/i })).toBeNull()
  })

  /**
   * ABA regression (round-4 review): auth tokens must NEVER be reused. Sequence: sign A hangs
   * → foreground restart resets the flow (old code zeroed the token) → fresh attempt starts
   * sign B (old code reused token 1 — A's late settle would then read CURRENT and mutate B's
   * flow). The counter is now strictly monotonic, so A can never become current again.
   */
  it("a hung attempt's late settle stays inert across a restart + fresh attempt (no token reuse)", async () => {
    const deferreds: Array<{
      resolve: (v: { success: boolean }) => void
      reject: (e: Error) => void
    }> = []
    const signIn = jest.fn(
      () =>
        new Promise<{ success: boolean }>((resolve, reject) => {
          deferreds.push({ resolve, reject })
        }),
    )
    const onSuccess = jest.fn()
    legacy().waitForConnection.mockResolvedValue({ success: true, publicKey: PUBKEY })

    render(
      <NostrConnectModal
        uri="nostrconnect://clientpubkey?relay=wss%3A%2F%2Fr.example&secret=s&name=Blink%20POS"
        signInWithNostrConnect={signIn}
        onSuccess={onSuccess}
      />,
    )

    // Attempt A: connect → sign hangs.
    await act(async () => {
      fireClick(openInAmberButton())
      await flushThroughConnectDelay()
    })
    expect(signIn).toHaveBeenCalledTimes(1)

    // Foreground with a dead socket and NO stored session → restart to idle. The old code
    // zeroed the auth token here, setting up the ABA reuse.
    legacy().isConnected.mockReturnValue(false)
    legacy().hasStoredSession.mockReturnValue(false)
    await foreground()
    await act(async () => flush())
    expect(openInAmberButton()).toBeTruthy() // back at the idle options view

    // Fresh attempt B (same mounted modal): connect → sign B runs.
    legacy().isConnected.mockReturnValue(true)
    await act(async () => {
      fireClick(openInAmberButton())
      await flushThroughConnectDelay()
    })
    expect(signIn).toHaveBeenCalledTimes(2)

    // A settles LATE with success. Under token reuse A now shares B's token and would fire
    // onSuccess. With monotonic tokens it must be fully inert.
    await act(async () => {
      deferreds[0].resolve({ success: true })
      await new Promise((r) => setTimeout(r, 650))
    })
    expect(onSuccess).not.toHaveBeenCalled()

    // B completes → exactly one success.
    await act(async () => {
      deferreds[1].resolve({ success: true })
      await new Promise((r) => setTimeout(r, 650))
    })
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledWith(PUBKEY)
  })

  /**
   * Restore path, stale LATE SUCCESS variant: the round-3 test covered a late REJECTION of the
   * hung original; this covers the other arm — the hung original settling with SUCCESS after
   * the replacement already completed must likewise change nothing.
   */
  it("a hung original's late SUCCESS after a successful restore+re-auth is inert", async () => {
    const deferreds: Array<{
      resolve: (v: { success: boolean }) => void
      reject: (e: Error) => void
    }> = []
    const signIn = jest.fn(
      () =>
        new Promise<{ success: boolean }>((resolve, reject) => {
          deferreds.push({ resolve, reject })
        }),
    )
    const onSuccess = jest.fn()
    legacy().waitForConnection.mockResolvedValue({ success: true, publicKey: PUBKEY })
    legacy().hasStoredSession.mockReturnValue(true)
    legacy().restoreSession.mockResolvedValue({ success: true, publicKey: PUBKEY })

    render(
      <NostrConnectModal
        uri="nostrconnect://clientpubkey?relay=wss%3A%2F%2Fr.example&secret=s&name=Blink%20POS"
        signInWithNostrConnect={signIn}
        onSuccess={onSuccess}
      />,
    )

    await act(async () => {
      fireClick(openInAmberButton())
      await flushThroughConnectDelay()
    })
    expect(signIn).toHaveBeenCalledTimes(1)

    legacy().isConnected.mockReturnValue(false)
    await act(async () => {
      await foreground()
      await flushThroughConnectDelay()
    })
    expect(legacy().restoreSession).toHaveBeenCalledTimes(1)
    expect(signIn).toHaveBeenCalledTimes(2)

    // Replacement completes.
    await act(async () => {
      deferreds[1].resolve({ success: true })
      await new Promise((r) => setTimeout(r, 650))
    })
    expect(onSuccess).toHaveBeenCalledTimes(1)

    // The hung ORIGINAL settles late with SUCCESS — must not double-fire onSuccess.
    await act(async () => {
      deferreds[0].resolve({ success: true })
      await new Promise((r) => setTimeout(r, 650))
    })
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  /** Restore failure: the modal resets to idle so the user can reopen the signer — and the
   *  hung original sign request's late timeout must not flip that fresh idle UI to error. */
  it("resets to idle when the stored session fails to restore, and the hung original's late timeout stays inert", async () => {
    let rejectSign: (e: Error) => void = () => {}
    const signIn = jest.fn(
      () => new Promise<{ success: boolean }>((_r, reject) => (rejectSign = reject)),
    )
    legacy().waitForConnection.mockResolvedValue({ success: true, publicKey: PUBKEY })
    legacy().hasStoredSession.mockReturnValue(true)
    legacy().restoreSession.mockResolvedValue({ success: false, error: "dead" })

    renderModal(signIn)
    await act(async () => {
      fireClick(openInAmberButton())
      await flushThroughConnectDelay()
    })
    expect(signIn).toHaveBeenCalledTimes(1)

    legacy().isConnected.mockReturnValue(false)

    await foreground()
    await act(async () => flush())

    expect(legacy().restoreSession).toHaveBeenCalledTimes(1)
    // Back at the idle options view — the entry points are offered again.
    expect(openInAmberButton()).toBeTruthy()

    // The hung original now times out late. The reset superseded its auth token, so the
    // rejection must not surface an error over the idle view.
    await act(async () => {
      rejectSign(new Error("TIMEOUT"))
      await flush()
    })
    expect(screen.queryByRole("button", { name: /Try Again/i })).toBeNull()
    expect(openInAmberButton()).toBeTruthy()
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
