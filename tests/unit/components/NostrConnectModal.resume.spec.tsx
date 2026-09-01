/**
 * NostrConnectModal — same-device mobile NIP-46 resume regressions (PR #61 review blockers).
 *
 * Blocker 1: the direct nostrconnect:// / Amber deeplink flow is LEGACY-service-only
 * (NostrConnectService.waitForConnection). The foreground resume must inspect THAT service,
 * not getService()/NDK — under USE_NDK=true (production) the wrong service made the resume
 * reset a valid Amber connection to idle.
 *
 * Blocker 2: a foreground return while the authentication is already in flight must NOT start
 * a second NIP-98 request (duplicate signer prompts / racing login). The guard lives at the
 * handleConnectionSuccess boundary (authInFlightRef), protecting every caller.
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

// --- mock the two NIP-46 services; the resume must consult the LEGACY one ---
// jest.mock factories run when the component (imported at the top) is required, before any
// const in this file initializes. So the mock surfaces are created inside the factories and
// read back in tests via jest.requireMock — the one reliable way to reach them.
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
   * Blocker 1: with NDK enabled (production), the resume must consult the LEGACY service.
   * A valid Amber connection on the legacy service must NOT be reset to idle just because
   * the NDK service knows nothing about it.
   */
  it("consults the legacy service (not NDK) for the resume decision under USE_NDK", async () => {
    // Production flag: the modal's getService() would return NDK — the resume must NOT.
    process.env.NEXT_PUBLIC_USE_NDK_NIP46 = "true"
    // A live Amber connection lives on the legacy service; NDK knows nothing.
    legacy().isConnected.mockReturnValue(true)
    legacy().hasStoredSession.mockReturnValue(true)

    const signIn = jest.fn(async () => ({ success: true }))
    renderModal(signIn)

    // Get a connection into flight (legacy waitForConnection resolves with a pubkey).
    legacy().waitForConnection.mockResolvedValueOnce({
      success: true,
      publicKey: "a".repeat(64),
    })
    await act(async () => {
      fireClick(openInAmberButton())
      await flush()
    })

    // The resume decision must read the legacy service, not NDK.
    await foreground()
    await act(async () => flush())

    expect(legacy().isConnected).toHaveBeenCalled()
    // NDK's resume/session surface must never be consulted for the deeplink flow.
    expect(ndk().restoreSession).not.toHaveBeenCalled()
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

    legacy().waitForConnection.mockResolvedValue({
      success: true,
      publicKey: "a".repeat(64),
    })
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
