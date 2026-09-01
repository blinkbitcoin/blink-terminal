/**
 * NostrConnectModal — NDK-mode regression for the foreground resume (PR #61 blocker 1).
 *
 * USE_NDK is a MODULE-LEVEL const (evaluated from NEXT_PUBLIC_USE_NDK_NIP46 at import), so
 * this test lives in its own file where the env var is set BEFORE the component is required —
 * a per-test assignment after import would never flip it, which is exactly what made the
 * round-1 version of this test vacuous.
 *
 * The direct nostrconnect:// / Amber deeplink flow is LEGACY-service-only
 * (NostrConnectService.waitForConnection). Even with production NDK mode active, the resume
 * decision must read the LEGACY service — a valid Amber connection must never be reset
 * because the NDK service knows nothing about it.
 *
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import React from "react"

// Production posture: NDK active. MUST run before the component module is loaded.
// The prior value is restored in afterAll so this file does not leak its env override.
const ORIGINAL_NDK_FLAG = process.env.NEXT_PUBLIC_USE_NDK_NIP46
process.env.NEXT_PUBLIC_USE_NDK_NIP46 = "true"

// Force the Android branch BEFORE importing the component (isAndroid is module-level).
const ORIGINAL_UA = window.navigator.userAgent
Object.defineProperty(window.navigator, "userAgent", {
  value: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36",
  configurable: true,
})

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

jest.mock("qrcode.react", () => ({ QRCodeSVG: () => null }))
jest.mock("../../../components/auth/ProgressStepper", () => () => null)

// eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require so the env var + UA overrides above take effect before module load
const NostrConnectModal = require("../../../components/auth/NostrConnectModal")
  .default as typeof import("../../../components/auth/NostrConnectModal").default

const flush = () => new Promise<void>((r) => setTimeout(r, 0))
const flushThroughConnectDelay = () => new Promise<void>((r) => setTimeout(r, 350))

const foreground = async () => {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("focus"))
    await flush()
  })
}

const PUBKEY = "a".repeat(64)

const openInAmberButton = () =>
  screen
    .getAllByRole("button")
    .find((b) => /Open in Amber/i.test(b.textContent ?? "")) as HTMLElement

const fireClick = (el: HTMLElement) => {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
}

describe("NostrConnectModal — foreground resume under production NDK mode", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // A live Amber connection lives on the LEGACY service; NDK knows nothing about it.
    legacy().isConnected.mockReturnValue(true)
    legacy().hasStoredSession.mockReturnValue(true)
    legacy().waitForConnection.mockResolvedValue({ success: true, publicKey: PUBKEY })
    ndk().isConnected.mockReturnValue(false)
    ndk().hasStoredSession.mockReturnValue(false)
    ndk().restoreSession.mockResolvedValue({ success: false })
  })

  afterAll(() => {
    // Undo the module-scope overrides so no global state leaks beyond this file.
    Object.defineProperty(window.navigator, "userAgent", {
      value: ORIGINAL_UA,
      configurable: true,
    })
    if (ORIGINAL_NDK_FLAG === undefined) {
      delete process.env.NEXT_PUBLIC_USE_NDK_NIP46
    } else {
      process.env.NEXT_PUBLIC_USE_NDK_NIP46 = ORIGINAL_NDK_FLAG
    }
  })

  it("consults the LEGACY service for the resume decision — NDK is never asked to restore", async () => {
    const signIn = jest.fn(async () => ({ success: true }))
    render(
      <NostrConnectModal
        uri="nostrconnect://clientpubkey?relay=wss%3A%2F%2Fr.example&secret=s&name=Blink%20POS"
        signInWithNostrConnect={signIn}
      />,
    )

    await act(async () => {
      fireClick(openInAmberButton())
      await flushThroughConnectDelay()
    })
    // The deeplink flow connected via the legacy service even under NDK mode.
    expect(signIn).toHaveBeenCalledTimes(1)

    await foreground()
    await act(async () => flush())

    // The resume read the legacy service's liveness…
    expect(legacy().isConnected).toHaveBeenCalled()
    // …and never consulted NDK — whose empty state would have wrongly triggered a restore/reset.
    expect(ndk().restoreSession).not.toHaveBeenCalled()
    // The valid Amber connection was NOT reset: no return to the idle options view.
    expect(
      screen
        .queryAllByRole("button")
        .some((b) => /Open in Amber/i.test(b.textContent ?? "")),
    ).toBe(false)
  })
})
