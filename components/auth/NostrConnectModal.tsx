/**
 * NostrConnectModal - NIP-46 Remote Signer Connection Modal
 *
 * Connection methods (client-initiated nostrconnect:// only):
 * - QR Code scanning (nostrconnect://) - desktop signers + mobile signers on another device
 * - Direct app open - for Amber (Android)
 *
 * The signer-initiated bunker:// paste flow (nsec.app) was removed: nsec.app is
 * discontinued and the flow had no users. Its NDK variant went with it.
 *
 * Features:
 * - Desktop: Shows QR code as primary method, auto-starts waiting for connection
 * - Mobile: Toggle between QR display and direct app buttons
 * - Progress stepper UI showing connection → signing → syncing → complete
 */

import { QRCodeSVG } from "qrcode.react"
import { useState, useEffect, useCallback, useRef } from "react"

import { decideNip46Resume } from "../../lib/nostr/nip46-resume"
import NostrConnectService from "../../lib/nostr/NostrConnectService"
import { logAuth, logAuthError, logAuthWarn } from "../../lib/version"

import ProgressStepper from "./ProgressStepper"

// Detect iOS
const isIOS =
  typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent)
const isAndroid = typeof navigator !== "undefined" && /Android/.test(navigator.userAgent)

// Helper to get the progress stages
const getStages = () => [
  {
    id: "connected",
    label: "Connected to signer",
  },
  { id: "signing", label: "Signing authentication" },
  { id: "syncing", label: "Loading your data" },
]

/** Connection stage state machine */
type ConnectionStage =
  | "idle"
  | "waiting"
  | "connected"
  | "signing"
  | "syncing"
  | "complete"
  | "error"

/** Sign-in progress callback */
interface SignInProgressOptions {
  onProgress: (stage: string, message?: string) => void
  timeout: number
}

/** Sign-in result from useNostrAuth */
interface SignInResult {
  success: boolean
  error?: string
  errorType?: string
}

interface NostrConnectModalProps {
  /** nostrconnect:// URI */
  uri: string
  /** Called when sign-in is fully complete */
  onSuccess?: (pubkey: string) => void
  /** Called when user cancels */
  onCancel?: () => void
  /** The sign-in function from useNostrAuth */
  signInWithNostrConnect: (
    pubkey: string,
    options: SignInProgressOptions,
  ) => Promise<SignInResult>
}

export default function NostrConnectModal({
  uri,
  onSuccess,
  onCancel,
  signInWithNostrConnect,
}: NostrConnectModalProps) {
  // UI state
  const [_showQRCode, _setShowQRCode] = useState<boolean>(false)
  const [showMobileQR, setShowMobileQR] = useState<boolean>(false) // v55: QR toggle for mobile
  const [copied, setCopied] = useState<boolean>(false)

  // Connection state machine
  const [stage, setStage] = useState<ConnectionStage>("idle")
  const [connectedPubkey, setConnectedPubkey] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string>("")
  const [_errorStage, setErrorStage] = useState<string | null>(null)
  const [showSlowWarning, setShowSlowWarning] = useState<boolean>(false)

  // Timer refs (real refs so timers survive re-renders and can be
  // cleared from any code path, including unmount)
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Single-flight guard for the foreground-resume path so a burst of
  // visibilitychange/focus events doesn't fire the NIP-98 sign request twice.
  const resumeInFlightRef = useRef<boolean>(false)
  // Attempt-scoped authentication ownership. Round-3 replaced the Boolean guard with a
  // token; round-4 review found the token had an ABA hole: resetting it to 0 on idle let a
  // later attempt reuse token 1, reviving a superseded token-1 continuation. The counter is
  // now STRICTLY MONOTONIC (never reset), and the active owner is a separate nullable slot —
  // null means idle. No token is ever reused, so a stale continuation can never become
  // current again.
  const authAttemptSeqRef = useRef<number>(0)
  const authActiveTokenRef = useRef<number | null>(null)
  // Whether a fresh waitForConnection() attempt is pending (BunkerSigner.fromURI has not
  // settled). A pending attempt OWNS the flow — the foreground resume must leave it alone.
  const connectInFlightRef = useRef<boolean>(false)
  // Monotonic flow generation: every intentional reset/restart bumps it, and every long
  // async continuation (connect settle, session restore) captures it up front and bails
  // WITHOUT mutating state if it has moved — a superseded waiter must never resurrect the
  // flow after the user (or the resume logic) has moved on.
  const flowGenRef = useRef<number>(0)

  // Clear any pending timers on unmount to avoid leaked intervals
  useEffect(() => {
    return () => {
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current)
        slowTimerRef.current = null
      }
    }
  }, [])

  const startWaitingForConnection = useCallback(async () => {
    logAuth("NostrConnectModal", "Waiting for NIP-46 connection...")

    // A new attempt supersedes any prior one: bump the generation so a still-pending
    // earlier attempt's continuation cannot mutate state when it eventually settles, and
    // mark the attempt in-flight so the foreground resume leaves it alone.
    flowGenRef.current += 1
    const gen = flowGenRef.current
    connectInFlightRef.current = true

    try {
      const result = await NostrConnectService.waitForConnection(uri)

      // The connect attempt has SETTLED (acked or failed): clear the in-flight flag BEFORE
      // entering the sign-in phase — handleConnectionSuccess is a separate phase owned by
      // authAttemptRef, and holding the connect flag across it would freeze the foreground
      // resume (a pending sign is not a pending connect). Only the current generation clears
      // it, so a superseded attempt settling late must not clear a newer attempt's flag.
      if (gen === flowGenRef.current) connectInFlightRef.current = false

      // Superseded attempt: the flow was reset/restarted while this fromURI was pending.
      if (gen !== flowGenRef.current) {
        logAuth("NostrConnectModal", "Connect attempt superseded — dropping its result")
        return
      }

      if (result.success && result.publicKey) {
        logAuth(
          "NostrConnectModal",
          "Connection successful, pubkey:",
          result.publicKey.substring(0, 16) + "...",
        )
        setConnectedPubkey(result.publicKey)
        await handleConnectionSuccess(result.publicKey)
      } else {
        logAuthError("NostrConnectModal", "Connection failed:", result.error)
        setStage("error")
        setErrorMessage(result.error || "Connection failed")
        setErrorStage("connected")
      }
    } catch (error: unknown) {
      if (gen === flowGenRef.current) connectInFlightRef.current = false
      if (gen !== flowGenRef.current) return
      logAuthError("NostrConnectModal", "Exception during connection:", error)
      setStage("error")
      setErrorMessage((error as Error).message || "Connection failed")
      setErrorStage("connected")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri])

  // Reset copied state after 2 seconds
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 2000)
      return () => clearTimeout(timer)
    }
  }, [copied])

  // Start waiting for connection when modal mounts with URI
  // On desktop, auto-start immediately since QR is shown
  useEffect(() => {
    if (uri && stage === "idle" && !isIOS && !isAndroid) {
      // Desktop: Auto-start waiting for connection since QR is shown immediately
      logAuth("NostrConnectModal", "Desktop - auto-starting connection wait for QR scan")
      setStage("waiting")
      startWaitingForConnection()
    }
  }, [uri, stage, startWaitingForConnection])

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(uri)
      setCopied(true)
      logAuth("NostrConnectModal", "Copied URI to clipboard")
    } catch (err: unknown) {
      logAuthError("NostrConnectModal", "Failed to copy:", err)
      window.prompt("Copy this link:", uri)
    }
  }

  const handleOpenInSigner = () => {
    logAuth("NostrConnectModal", "Opening in signer app (nostrconnect://)")
    // Open the nostrconnect:// URI - Amber handles this on Android, desktop signers like Peridot on desktop
    window.location.href = uri

    // If not already waiting (mobile case), start waiting
    if (stage !== "waiting") {
      setStage("waiting")
      startWaitingForConnection()
    }
  }

  const handleConnectionSuccess = async (
    pubkey: string,
    opts?: { supersede?: boolean },
  ) => {
    // Duplicate live invocation (visibility burst, retry while running): no-op. A session
    // restore instead passes supersede — the obsolete attempt's auth is REPLACED, not blocked.
    if (authActiveTokenRef.current !== null && opts?.supersede !== true) {
      logAuth("NostrConnectModal", "Sign-in already in flight — ignoring duplicate entry")
      return
    }
    // Every attempt gets a fresh, never-reused token; a superseding call's token increment is
    // what retires the hung predecessor (its continuation goes inert the next time it checks
    // currency). The counter is never reset, so no stale token can collide with a future one.
    const attempt = ++authAttemptSeqRef.current
    authActiveTokenRef.current = attempt
    const isCurrent = () => attempt === authActiveTokenRef.current
    // Set in the success branch so the finally does not zero the token before the deferred
    // completion timeout runs — that timeout owns the release on success.
    let completedSuccessfully = false

    logAuth("NostrConnectModal", "Handling connection success...")
    setStage("connected")
    setConnectedPubkey(pubkey)

    // Clear any previous slow warning
    setShowSlowWarning(false)

    // Start slow warning timer (15 seconds)
    slowTimerRef.current = setTimeout(() => {
      if (isCurrent()) setShowSlowWarning(true)
    }, 15000)

    try {
      // Small delay to show the "connected" state
      await new Promise<void>((resolve) => setTimeout(resolve, 300))

      // A superseded attempt must not resume mutating UI after its await.
      if (!isCurrent()) return

      setStage("signing")

      // Call the sign-in function with progress callback
      const result = await signInWithNostrConnect(pubkey, {
        onProgress: (progressStage: string, message?: string) => {
          // Stale attempts must not move the stepper mid-flight.
          if (!isCurrent()) return
          logAuth("NostrConnectModal", "Progress:", progressStage, message)
          if (progressStage === "signing") setStage("signing")
          else if (progressStage === "syncing") setStage("syncing")
          else if (progressStage === "complete") setStage("complete")
        },
        timeout: 30000,
      })

      // The request settled after this attempt was superseded — apply nothing. (The hung
      // original settling late must neither complete the login nor flip the UI to error.)
      if (!isCurrent()) return

      // Clear the slow warning timer
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current)
        slowTimerRef.current = null
      }

      if (result.success) {
        completedSuccessfully = true
        setStage("complete")
        // Small delay to show completion before closing; this timeout owns the currency check
        // AND the guard release on success (finally skips it for completed attempts).
        setTimeout(() => {
          if (!isCurrent()) return
          authActiveTokenRef.current = null
          onSuccess?.(pubkey)
        }, 600)
      } else {
        setStage("error")
        setErrorStage(result.errorType === "timeout" ? "signing" : "signing")
        setErrorMessage(result.error || "Authentication failed")
      }
    } catch (error: unknown) {
      if (!isCurrent()) return
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current)
        slowTimerRef.current = null
      }
      setStage("error")
      setErrorStage("signing")
      setErrorMessage((error as Error).message || "An unexpected error occurred")
    } finally {
      // Only the CURRENT attempt may release the guard — a superseded attempt settling must
      // not free the slot its replacement still owns. On success the release is deferred to
      // the completion timeout below (which owns the final isCurrent check + onSuccess).
      if (isCurrent() && !completedSuccessfully) authActiveTokenRef.current = null
    }
  }

  /**
   * Same-device mobile fix: "Open in signer" navigates the browser AWAY to the
   * nostrconnect:// deep link (`handleOpenInSigner`), which launches the signer app and
   * SUSPENDS this tab. The NIP-46 client loop (`BunkerSigner`: connect-ack → get_public_key
   * → sign_event) runs in JS in that suspended tab, so its WebSocket/timer chain stalls and
   * the sign-in challenge is never driven. The flow is designed for the user to return to
   * the browser afterwards (see the Android instructions), but nothing used to resume the
   * relay client on that return — this effect closes that gap.
   *
   * On foreground while a connection flow is in flight, re-drive it from wherever it stopped:
   * still connected → re-run just the NIP-98 sign step; dropped → rebuild the signer from the
   * stored session (fresh-pool restore + ping liveness) and continue; no resumable session →
   * reset to idle so the user can reopen the signer. Single-flight so a focus/visibility burst
   * doesn't double-fire the sign request.
   */
  const resumeOnForeground = useCallback(async () => {
    // The only connection path left is the direct nostrconnect:// deeplink flow, served by
    // NostrConnectService (the bunker flow and its NDK variant were removed).
    const service = NostrConnectService
    const action = decideNip46Resume({
      stage,
      // Round-2 blocker: a pending fresh connect attempt owns the flow — the resume must
      // leave it alone (it resolves or times out by itself, generation-guarded).
      connectInFlight: connectInFlightRef.current,
      connected: service.isConnected(),
      hasPubkey: Boolean(connectedPubkey),
      hasSession: service.hasStoredSession(),
    })
    if (action === null) return
    if (resumeInFlightRef.current) return
    resumeInFlightRef.current = true
    logAuth("NostrConnectModal", `Foreground resume (stage=${stage}, action=${action})`)
    try {
      if (action === "resume-signing" && connectedPubkey) {
        // The BunkerSigner survived backgrounding — re-drive only the NIP-98 step. The
        // authAttemptRef ownership guard inside handleConnectionSuccess makes this a no-op
        // if the ORIGINAL mobile sign-in is still running (review blocker 2).
        logAuth("NostrConnectModal", "Still connected — resuming at signing stage")
        setStage("signing")
        await handleConnectionSuccess(connectedPubkey)
        return
      }
      if (action === "restore-session") {
        // The socket died while suspended: rebuild from the stored session and re-drive.
        // Capture the flow generation now so a superseding reset during the async restore
        // makes its continuation a no-op instead of resurrecting a stale session.
        const gen = flowGenRef.current
        logAuth("NostrConnectModal", "Connection lost — restoring session")
        const restored = await service.restoreSession()
        if (gen !== flowGenRef.current) {
          logAuth("NostrConnectModal", "Restore superseded — dropping its result")
          return
        }
        if (restored.success && restored.publicKey) {
          setConnectedPubkey(restored.publicKey)
          // supersede: the original sign request hung on the dead socket and still owns the
          // auth slot. The restore must REPLACE that obsolete authentication with exactly one
          // request through the restored signer — the hung attempt's late settle (its eventual
          // 30s timeout) then goes inert instead of erroring the UI (round-3 blocker).
          await handleConnectionSuccess(restored.publicKey, { supersede: true })
          return
        }
        logAuthWarn(
          "NostrConnectModal",
          "Session restore failed — resetting to idle:",
          restored.error,
        )
      }
      // action === "restart" (or a failed restore): reset so the user can reopen the signer.
      // Bumping the flow generation first makes any still-pending attempt/restore continuation
      // a no-op, and releasing the auth slot supersedes any hung sign request — its eventual
      // timeout must not flip this fresh idle UI to an error. disconnect() invalidates the
      // SERVICE-side pending attempt too (round-4 review), not just the modal refs.
      flowGenRef.current += 1
      authActiveTokenRef.current = null
      setStage("idle")
      setConnectedPubkey(null)
      service.disconnect().catch(() => undefined)
    } catch (error: unknown) {
      logAuthError("NostrConnectModal", "Foreground resume failed:", error)
      flowGenRef.current += 1
      authActiveTokenRef.current = null
      setStage("idle")
      setConnectedPubkey(null)
      service.disconnect().catch(() => undefined)
    } finally {
      resumeInFlightRef.current = false
    }
    // stage/connectedPubkey are read at fire time; handleConnectionSuccess is stable per
    // render. Deliberately NOT reactive — this runs on visibility/focus events, not on state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, connectedPubkey])

  useEffect(() => {
    // Only the same-device mobile flow backgrounds the driving tab (desktop QR keeps the
    // browser foregrounded), so only register the resume listener there.
    if (!isIOS && !isAndroid) return

    const onVisible = () => {
      if (document.visibilityState === "visible") resumeOnForeground()
    }
    const onFocus = () => resumeOnForeground()

    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onFocus)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onFocus)
    }
  }, [resumeOnForeground])

  const handleRetry = async () => {
    logAuth("NostrConnectModal", "Retrying...")
    setErrorMessage("")
    setShowSlowWarning(false)
    setErrorStage(null)

    // Check if we still have a relay connection
    if (NostrConnectService.isConnected() && connectedPubkey) {
      // Retry just the NIP-98 part
      logAuth("NostrConnectModal", "Still connected, retrying from signing stage")
      setStage("signing")
      await handleConnectionSuccess(connectedPubkey)
    } else {
      // Need to reconnect from scratch
      logAuth("NostrConnectModal", "Not connected, restarting from beginning")
      setStage("idle")
      setConnectedPubkey(null)
    }
  }

  const handleCancel = () => {
    logAuth("NostrConnectModal", "User cancelled")
    // Bump the flow generation: any still-pending connect/restore continuation must become
    // a no-op rather than resurrecting a flow the user just cancelled. Releasing the auth
    // slot likewise retires any hung sign request so its late timeout can't error the UI.
    flowGenRef.current += 1
    authActiveTokenRef.current = null
    // Clean disconnect
    if (slowTimerRef.current) {
      clearTimeout(slowTimerRef.current)
    }
    // Disconnect also invalidates any pending attempt at the service level (round-4 review).
    NostrConnectService.disconnect()
    onCancel?.()
  }

  const handleBackToOptions = () => {
    // Same guard as cancel: leaving the flow supersedes any in-flight attempt or hung sign.
    flowGenRef.current += 1
    authActiveTokenRef.current = null
    setStage("idle")
    setShowSlowWarning(false)
    setErrorMessage("")
    setErrorStage(null)
  }

  // Determine what to render based on stage
  // isInConnectionFlow now includes states where we're waiting for approval
  const isInConnectionFlow = [
    "waiting",
    "connected",
    "signing",
    "syncing",
    "complete",
  ].includes(stage)
  const isInErrorState = stage === "error"

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl max-w-sm w-full shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 text-center border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {stage === "complete"
              ? "✓ Connected!"
              : isInErrorState
                ? "⚠️ Connection Failed"
                : isInConnectionFlow
                  ? "🔗 Connecting..."
                  : "🔗 Connect with Nostr Signer"}
          </h3>
          {!isInConnectionFlow && !isInErrorState && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              NIP-46 Nostr Connect
            </p>
          )}
        </div>

        {/* Content - scrollable */}
        <div className="px-6 py-5 overflow-y-auto flex-1 min-h-0">
          {/* v58: Desktop waiting view - QR code */}
          {stage === "waiting" && !isIOS && !isAndroid && (
            <div className="py-2">
              {/* QR Code - Primary for desktop */}
              <div className="flex flex-col items-center mb-4">
                <div className="p-4 bg-white rounded-xl shadow-sm border border-gray-200">
                  <QRCodeSVG value={uri} size={200} level="M" includeMargin={false} />
                </div>
                <p className="mt-3 text-sm text-gray-600 dark:text-gray-400 text-center">
                  Scan with your mobile signer app
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-500 text-center">
                  (Amber, nsec.app, or any NIP-46 signer)
                </p>
              </div>

              {/* Waiting indicator */}
              <div className="flex items-center justify-center gap-2 text-purple-600 dark:text-purple-400 mb-4">
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <span className="text-sm font-medium">Waiting for connection...</span>
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700"></div>
                <span className="text-xs text-gray-400 dark:text-gray-500">or</span>
                <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700"></div>
              </div>

              {/* Desktop signer button (for Peridot, etc.) */}
              <button
                onClick={handleOpenInSigner}
                className="w-full py-3 px-4 text-base font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-xl transition-all flex items-center justify-center gap-2 mb-3"
              >
                <span>🔗</span>
                <span>Open in Desktop Signer</span>
              </button>

              {/* Copy Link Button */}
              <button
                onClick={handleCopyLink}
                className={`w-full py-3 px-4 text-base font-medium rounded-xl transition-all flex items-center justify-center gap-2 ${
                  copied
                    ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-2 border-green-500"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 border-2 border-transparent"
                }`}
              >
                {copied ? (
                  <>
                    <span>✓</span>
                    <span>Copied! Paste in signer app</span>
                  </>
                ) : (
                  <>
                    <span>📋</span>
                    <span>Copy Link</span>
                  </>
                )}
              </button>

              {/* Cancel button */}
              <button
                onClick={handleCancel}
                className="mt-4 w-full text-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Connection Progress View - for mobile waiting OR any platform after connection established */}
          {isInConnectionFlow && (stage !== "waiting" || isIOS || isAndroid) && (
            <div className="py-2">
              <ProgressStepper
                stages={getStages()}
                currentStage={stage}
                errorStage={null}
              />

              {/* Slow warning */}
              {showSlowWarning && stage === "signing" && (
                <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    ⏳ Taking longer than expected? Make sure Amber is open and tap{" "}
                    <strong>&quot;Approve&quot;</strong> when prompted.
                  </p>
                </div>
              )}

              {/* Success message */}
              {stage === "complete" && (
                <div className="mt-4 text-center">
                  <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                    <svg
                      className="w-8 h-8 text-green-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                  <p className="text-green-600 dark:text-green-400 font-medium">
                    Successfully signed in!
                  </p>
                </div>
              )}

              {/* Back button during waiting/signing */}
              {stage !== "complete" && (
                <button
                  onClick={handleBackToOptions}
                  className="mt-4 w-full text-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  ← Back to options
                </button>
              )}
            </div>
          )}

          {/* Error View */}
          {isInErrorState && (
            <div className="py-4 text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                <svg
                  className="w-8 h-8 text-red-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </div>

              {/* Regular error message */}
              <p className="text-gray-700 dark:text-gray-300 mb-2">{errorMessage}</p>

              <div className="flex gap-3 mt-6">
                <button
                  onClick={handleRetry}
                  className="flex-1 py-3 px-4 text-base font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-xl transition-colors"
                >
                  Try Again
                </button>
                <button
                  onClick={handleCancel}
                  className="flex-1 py-3 px-4 text-base font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-xl transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Main Options View (idle state) */}
          {stage === "idle" && (
            <>
              {/* v58: Desktop experience with two clear options */}
              {!isIOS && !isAndroid && (
                <div className="space-y-4">
                  {/* QR Code - Primary for desktop */}
                  <div className="flex flex-col items-center">
                    <div className="p-4 bg-white rounded-xl shadow-sm border border-gray-200">
                      <QRCodeSVG value={uri} size={200} level="M" includeMargin={false} />
                    </div>
                    <p className="mt-3 text-sm text-gray-600 dark:text-gray-400 text-center">
                      Scan with your mobile signer app
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-500 text-center">
                      (Amber, nsec.app, or any NIP-46 signer)
                    </p>
                  </div>

                  {/* Divider */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700"></div>
                    <span className="text-xs text-gray-400 dark:text-gray-500">or</span>
                    <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700"></div>
                  </div>

                  {/* Desktop signer button (for Peridot, etc.) */}
                  <button
                    onClick={handleOpenInSigner}
                    className="w-full py-3 px-4 text-base font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-xl transition-all flex items-center justify-center gap-2"
                  >
                    <span>🔗</span>
                    <span>Open in Desktop Signer</span>
                  </button>

                  {/* Copy Link Button */}
                  <button
                    onClick={handleCopyLink}
                    className={`w-full py-3 px-4 text-base font-medium rounded-xl transition-all flex items-center justify-center gap-2 ${
                      copied
                        ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-2 border-green-500"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 border-2 border-transparent"
                    }`}
                  >
                    {copied ? (
                      <>
                        <span>✓</span>
                        <span>Copied! Paste in signer app</span>
                      </>
                    ) : (
                      <>
                        <span>📋</span>
                        <span>Copy Link</span>
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* v55: Mobile experience - iOS */}
              {isIOS && (
                <div className="space-y-3">
                  {/* nsec.app recommendation banner */}
                  <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl">
                    <p className="text-sm text-green-700 dark:text-green-400 font-medium">
                      ✅ <strong>Recommended for iOS:</strong> Use nsec.app (web-based
                      signer)
                    </p>
                    <p className="text-xs text-green-600 dark:text-green-500 mt-1">
                      Works reliably in Safari. Native iOS signers have known issues.
                    </p>
                  </div>

                  {/* Copy Link Button - Primary action for client-initiated flow */}
                  <button
                    onClick={() => {
                      handleCopyLink()
                      // Start waiting for connection when link is copied (don't change stage - keep showing UI)
                      if (stage === "idle") {
                        startWaitingForConnection()
                      }
                    }}
                    className={`w-full py-3 px-4 text-base font-semibold rounded-xl transition-all flex items-center justify-center gap-2 ${
                      copied
                        ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-2 border-green-500"
                        : "bg-gradient-to-r from-purple-600 to-violet-700 hover:from-purple-700 hover:to-violet-800 text-white shadow-md hover:shadow-lg"
                    }`}
                  >
                    {copied ? (
                      <>
                        <span>✓</span>
                        <span>Copied! Paste in nsec.app</span>
                      </>
                    ) : (
                      <>
                        <span>📋</span>
                        <span>Copy Connection Link</span>
                      </>
                    )}
                  </button>

                  {/* Waiting indicator - show when link copied or QR shown */}
                  {(copied || showMobileQR) && (
                    <div className="flex items-center justify-center gap-2 text-purple-600 dark:text-purple-400 py-2">
                      <svg
                        className="w-4 h-4 animate-spin"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                      <span className="text-sm font-medium">
                        Waiting for connection...
                      </span>
                    </div>
                  )}

                  {/* Instructions - updated for client-initiated flow */}
                  <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      How to connect:
                    </p>
                    <ol className="text-sm text-gray-600 dark:text-gray-400 space-y-1.5 list-decimal list-inside">
                      <li>
                        Tap <strong>&quot;Copy Connection Link&quot;</strong> above
                      </li>
                      <li>
                        Open{" "}
                        <a
                          href="https://nsec.app"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-purple-600 dark:text-purple-400 underline"
                        >
                          nsec.app
                        </a>{" "}
                        and sign in
                      </li>
                      <li>
                        Tap <strong>&quot;Connect App&quot;</strong> →{" "}
                        <strong>&quot;Paste from clipboard&quot;</strong>
                      </li>
                      <li>Approve the connection request</li>
                    </ol>
                  </div>

                  {/* v55: Show QR Code toggle for mobile */}
                  <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
                    <button
                      onClick={() => {
                        const newShowQR = !showMobileQR
                        setShowMobileQR(newShowQR)
                        // Start waiting for connection when QR is shown (don't change stage - keep showing UI)
                        if (newShowQR && stage === "idle") {
                          startWaitingForConnection()
                        }
                      }}
                      className="w-full text-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors flex items-center justify-center gap-1"
                    >
                      <span>{showMobileQR ? "▼" : "▶"}</span>
                      <span>Show QR code (scan from another device)</span>
                    </button>

                    {showMobileQR && (
                      <div className="mt-4 flex flex-col items-center">
                        <div className="p-4 bg-white rounded-xl shadow-sm border border-gray-200">
                          <QRCodeSVG
                            value={uri}
                            size={200}
                            level="M"
                            includeMargin={false}
                          />
                        </div>
                        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400 text-center">
                          Scan this QR from another device
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* v55: Mobile experience - Android */}
              {isAndroid && (
                <div className="space-y-3">
                  {/* Amber button - uses nostrconnect:// which Amber registers */}
                  <button
                    onClick={handleOpenInSigner}
                    className="w-full py-3 px-4 text-base font-semibold text-white bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 rounded-xl transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-2"
                  >
                    <span>🔶</span>
                    <span>Open in Amber</span>
                  </button>

                  {/* Copy Link Button */}
                  <button
                    onClick={handleCopyLink}
                    className={`w-full py-3 px-4 text-base font-medium rounded-xl transition-all flex items-center justify-center gap-2 ${
                      copied
                        ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-2 border-green-500"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 border-2 border-transparent"
                    }`}
                  >
                    {copied ? (
                      <>
                        <span>✓</span>
                        <span>Copied! Paste in signer app</span>
                      </>
                    ) : (
                      <>
                        <span>📋</span>
                        <span>Copy Link</span>
                      </>
                    )}
                  </button>

                  {/* Instructions */}
                  <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      How to connect:
                    </p>
                    <ol className="text-sm text-gray-600 dark:text-gray-400 space-y-1.5 list-decimal list-inside">
                      <li>
                        Tap <strong>&quot;Open in Amber&quot;</strong>
                      </li>
                      <li>Approve the connection request in your signer</li>
                      <li>Approve the authentication when prompted</li>
                      <li>Return here to complete sign-in</li>
                    </ol>
                  </div>

                  {/* v55: Show QR Code toggle for mobile */}
                  <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
                    <button
                      onClick={() => {
                        const newShowQR = !showMobileQR
                        setShowMobileQR(newShowQR)
                        // Start waiting for connection when QR is shown (don't change stage - keep showing UI)
                        if (newShowQR && stage === "idle") {
                          startWaitingForConnection()
                        }
                      }}
                      className="w-full text-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors flex items-center justify-center gap-1"
                    >
                      <span>{showMobileQR ? "▼" : "▶"}</span>
                      <span>Show QR code (scan from another device)</span>
                    </button>

                    {showMobileQR && (
                      <div className="mt-4 flex flex-col items-center">
                        <div className="p-4 bg-white rounded-xl shadow-sm border border-gray-200">
                          <QRCodeSVG
                            value={uri}
                            size={200}
                            level="M"
                            includeMargin={false}
                          />
                        </div>
                        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400 text-center">
                          Scan this QR from another device
                        </p>
                        {/* Waiting indicator */}
                        <div className="mt-3 flex items-center justify-center gap-2 text-purple-600 dark:text-purple-400">
                          <svg
                            className="w-4 h-4 animate-spin"
                            fill="none"
                            viewBox="0 0 24 24"
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                            />
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                          <span className="text-sm font-medium">
                            Waiting for connection...
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Old separate "Awaiting Approval" view removed - approval is now shown inline in the connection progress view */}
        </div>

        {/* Footer - sticky at bottom, only show cancel button when in idle state */}
        {stage === "idle" && (
          <div className="px-6 pb-6 pt-2 border-t border-gray-100 dark:border-gray-800 flex-shrink-0 bg-white dark:bg-gray-900">
            <button
              onClick={handleCancel}
              className="w-full py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Footer for connection flow - sticky at bottom, subtle cancel */}
        {isInConnectionFlow && stage !== "complete" && (
          <div className="px-6 pb-6 pt-2 border-t border-gray-100 dark:border-gray-800 flex-shrink-0 bg-white dark:bg-gray-900">
            <button
              onClick={handleCancel}
              className="w-full text-center text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-400"
            >
              Cancel sign-in
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
