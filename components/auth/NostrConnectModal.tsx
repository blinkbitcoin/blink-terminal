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
 * TRANSPORT (issue #70): the NIP-46 relay subscription lives on the SERVER. This
 * component asks the server to start a session, shows the URI it returns, and
 * polls for the outcome. It holds no WebSocket and no signer state, so
 * backgrounding the tab to reach Amber is harmless — which is why the bfcache
 * detection, pending-session persistence, resume decisions and reconnect paths
 * that used to live here are gone rather than hardened further. They existed
 * only to keep a browser-held socket alive across backgrounding, and Android
 * discards that socket no matter how carefully we track the lifecycle.
 *
 * By the time the server returns the URI it is already subscribed to kind-24133
 * on at least one relay, so the signer's one-shot connect ack cannot arrive
 * before anyone is listening.
 */

import { QRCodeSVG } from "qrcode.react"
import { useState, useEffect, useCallback, useRef } from "react"

import {
  cancelSession,
  createSession,
  pollSession,
} from "../../lib/nostr/NostrConnectClient"
import { logAuth, logAuthError } from "../../lib/version"

import ProgressStepper from "./ProgressStepper"

// Detect iOS
const isIOS =
  typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent)
const isAndroid = typeof navigator !== "undefined" && /Android/.test(navigator.userAgent)

// Helper to get the progress stages
const getStages = () => [
  {
    id: "waiting",
    label: "Waiting for connection",
  },
  {
    id: "connected",
    label: "Connected to signer",
  },
  { id: "signing", label: "Signing authentication" },
  { id: "syncing", label: "Loading your data" },
]

/** Connection stage state machine */
type ConnectionStage =
  | "creating"
  | "idle"
  | "waiting"
  | "connected"
  | "signing"
  | "syncing"
  | "complete"
  | "error"

/** How long the whole finalization (consume + local commit) may take. */
const SIGN_IN_TIMEOUT_MS = 30000
/** After this long without an approval, nudge the user towards their signer. */
const SLOW_WARNING_MS = 15000

/** Sign-in progress callback */
interface SignInProgressOptions {
  /** The server-held session to finalize. */
  sessionId: string
  onProgress: (stage: string, message?: string) => void
  timeout: number
  /**
   * Ownership check handed to the auth operation so it can abandon before publishing durable
   * state (profile activation, server sync, provider auth state) once this attempt has been
   * retired — suppressing only this component's continuation is not enough (PR #66 review).
   */
  isCurrent: () => boolean
  /** Cancels the transaction's in-flight work when the attempt is retired. */
  signal: AbortSignal
}

/** Sign-in result from useNostrAuth */
interface SignInResult {
  success: boolean
  error?: string
  errorType?: string
}

interface NostrConnectModalProps {
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

/**
 * Human-readable copy for the machine-readable failure reasons the server
 * reports. Anything unmapped falls back to a generic retry message.
 */
function describeFailure(reason: string | undefined): string {
  switch (reason) {
    case "relays_unavailable":
      return "Could not reach any Nostr relay. Check your connection and try again."
    case "storage_unavailable":
      return "Sign-in is temporarily unavailable. Please try again in a moment."
    case "capacity":
      return "Too many sign-in attempts in progress. Please wait a moment and try again."
    case "connect_timeout":
      return "The signer never connected. Open your signer app and approve the connection."
    case "signing_timeout":
      return "Signing timed out. Make sure your signer is open and approve the request."
    case "signer_rejected":
      return "The signer rejected the request."
    case "verification_failed":
      return "The signature could not be verified. Please try again."
    case "server_restarted":
      return "The sign-in session was interrupted. Please try again."
    case "cancelled":
      return "Sign-in was cancelled."
    default:
      return "Sign-in did not complete. Please try again."
  }
}

export default function NostrConnectModal({
  onSuccess,
  onCancel,
  signInWithNostrConnect,
}: NostrConnectModalProps) {
  // UI state
  const [showMobileQR, setShowMobileQR] = useState<boolean>(false)
  const [copied, setCopied] = useState<boolean>(false)

  // Session + connection state
  const [uri, setUri] = useState<string>("")
  const [stage, setStage] = useState<ConnectionStage>("creating")
  const [errorMessage, setErrorMessage] = useState<string>("")
  const [showSlowWarning, setShowSlowWarning] = useState<boolean>(false)

  /**
   * Attempt identity. Every async continuation checks its generation before
   * touching state, so a retry (or an unmount) can never be finished by the run
   * it replaced. This is the only concurrency machinery still needed here: with
   * the transport server-side there is no socket to re-own, only a stale
   * continuation to ignore.
   */
  const generationRef = useRef<number>(0)
  const sessionIdRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearSlowTimer = useCallback((): void => {
    if (!slowTimerRef.current) return
    clearTimeout(slowTimerRef.current)
    slowTimerRef.current = null
  }, [])

  /**
   * Retire the current attempt: stop polling, and release the server's relay
   * sockets instead of leaving them pinned until the session TTL expires.
   */
  const retireAttempt = useCallback(
    (options: { cancelServerSession: boolean }): void => {
      generationRef.current += 1
      clearSlowTimer()
      abortRef.current?.abort()
      abortRef.current = null

      const sessionId = sessionIdRef.current
      sessionIdRef.current = null
      if (sessionId && options.cancelServerSession) {
        cancelSession(sessionId)
      }
    },
    [clearSlowTimer],
  )

  /** Finalize an approved session and commit the sign-in. */
  const completeSignIn = useCallback(
    async (sessionId: string, pubkey: string, generation: number): Promise<void> => {
      const isCurrent = (): boolean => generationRef.current === generation

      setStage("connected")
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (!isCurrent()) return

      setStage("signing")
      clearSlowTimer()
      slowTimerRef.current = setTimeout(() => {
        if (isCurrent()) setShowSlowWarning(true)
      }, SLOW_WARNING_MS)

      const controller = new AbortController()
      abortRef.current = controller

      try {
        const result = await signInWithNostrConnect(pubkey, {
          sessionId,
          timeout: SIGN_IN_TIMEOUT_MS,
          isCurrent,
          signal: controller.signal,
          onProgress: (progressStage: string) => {
            if (!isCurrent()) return
            if (progressStage === "syncing") setStage("syncing")
          },
        })

        if (!isCurrent()) return
        clearSlowTimer()

        if (!result.success) {
          // A superseded attempt has already been replaced by a newer one, which
          // owns the UI from here.
          if (result.errorType === "superseded") return
          setErrorMessage(result.error || describeFailure(undefined))
          setStage("error")
          return
        }

        // The session is consumed; there is nothing left to cancel server-side.
        sessionIdRef.current = null
        setStage("complete")
        setTimeout(() => {
          if (isCurrent()) onSuccess?.(pubkey)
        }, 600)
      } catch (error: unknown) {
        if (!isCurrent()) return
        logAuthError("NostrConnectModal", "Sign-in failed:", error)
        clearSlowTimer()
        setErrorMessage(
          error instanceof Error ? error.message : describeFailure(undefined),
        )
        setStage("error")
      }
    },
    [clearSlowTimer, onSuccess, signInWithNostrConnect],
  )

  /**
   * Start a session and wait for the signer.
   *
   * The server subscribes before it answers, so the URI we render is already
   * being listened for; polling can safely start after the URI is on screen.
   */
  const startSession = useCallback(async (): Promise<void> => {
    retireAttempt({ cancelServerSession: true })
    const generation = generationRef.current
    const isCurrent = (): boolean => generationRef.current === generation

    setShowSlowWarning(false)
    setErrorMessage("")
    setCopied(false)
    setUri("")
    setStage("creating")

    const controller = new AbortController()
    abortRef.current = controller

    const created = await createSession(controller.signal)
    if (!isCurrent()) return

    if (!created.success || !created.sessionId || !created.uri) {
      if (created.reason === "aborted") return
      setErrorMessage(created.error || describeFailure(created.reason))
      setStage("error")
      return
    }

    sessionIdRef.current = created.sessionId
    setUri(created.uri)
    // Desktop leads with the QR and its own waiting view; mobile keeps the
    // options list visible while we poll in the background.
    setStage(isIOS || isAndroid ? "idle" : "waiting")

    logAuth("NostrConnectModal", "Session created, polling for approval")

    const outcome = await pollSession(created.sessionId, {
      signal: controller.signal,
    })
    if (!isCurrent()) return

    if (outcome.status === "approved" && outcome.pubkey) {
      await completeSignIn(created.sessionId, outcome.pubkey, generation)
      return
    }

    if (outcome.error === "aborted") return
    setErrorMessage(describeFailure(outcome.error))
    setStage("error")
  }, [completeSignIn, retireAttempt])

  // Start a session as soon as the modal opens, and release it on unmount.
  useEffect(() => {
    startSession()
    return () => {
      retireAttempt({ cancelServerSession: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCopyLink = useCallback((): void => {
    if (!uri) return
    navigator.clipboard
      .writeText(uri)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 3000)
      })
      .catch((error: unknown) => {
        logAuthError("NostrConnectModal", "Failed to copy URI:", error)
      })
  }, [uri])

  const handleOpenInSigner = useCallback((): void => {
    if (!uri) return
    // Opening the signer backgrounds this tab. That is fine now: the relay
    // subscription is server-side, and polling resumes when we come back.
    window.location.href = uri
  }, [uri])

  const handleRetry = useCallback((): void => {
    startSession()
  }, [startSession])

  const handleCancel = useCallback((): void => {
    retireAttempt({ cancelServerSession: true })
    onCancel?.()
  }, [onCancel, retireAttempt])

  /**
   * Return to the options list without throwing away the session — the server
   * is still listening, so the user can open their signer again.
   */
  const handleBackToOptions = useCallback((): void => {
    if (stage === "complete" || stage === "signing" || stage === "syncing") return
    setStage("idle")
    setShowSlowWarning(false)
  }, [stage])

  // Determine what to render based on stage
  const isInConnectionFlow = [
    "waiting",
    "connected",
    "signing",
    "syncing",
    "complete",
  ].includes(stage)
  const isInErrorState = stage === "error"
  const isCreating = stage === "creating"

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
                : isCreating
                  ? "🔗 Preparing..."
                  : isInConnectionFlow
                    ? "🔗 Connecting..."
                    : "🔗 Connect with Nostr Signer"}
          </h3>
          {!isInConnectionFlow && !isInErrorState && !isCreating && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              NIP-46 Nostr Connect
            </p>
          )}
        </div>

        {/* Content - scrollable */}
        <div className="px-6 py-5 overflow-y-auto flex-1 min-h-0">
          {/* Waiting for the server to connect to a relay. Deliberately blocking:
              the URI must not appear before a relay subscription exists. */}
          {isCreating && (
            <div className="py-10 flex flex-col items-center gap-3">
              <svg
                className="w-8 h-8 animate-spin text-purple-600 dark:text-purple-400"
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
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Connecting to Nostr relays...
              </p>
            </div>
          )}

          {/* v58: Desktop waiting view - QR code */}
          {stage === "waiting" && !isIOS && !isAndroid && (
            <div className="py-2">
              {/* QR Code - Primary for desktop */}
              <div className="flex flex-col items-center mb-4">
                <div
                  data-testid="nostr-connect-qr"
                  className="p-4 bg-white rounded-xl shadow-sm border border-gray-200"
                >
                  <QRCodeSVG value={uri} size={200} level="M" includeMargin={false} />
                </div>
                <p className="mt-3 text-sm text-gray-600 dark:text-gray-400 text-center">
                  Scan with your mobile signer app
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-500 text-center">
                  (Amber or any NIP-46 signer)
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
                    <div
                      data-testid="nostr-connect-qr"
                      className="p-4 bg-white rounded-xl shadow-sm border border-gray-200"
                    >
                      <QRCodeSVG value={uri} size={200} level="M" includeMargin={false} />
                    </div>
                    <p className="mt-3 text-sm text-gray-600 dark:text-gray-400 text-center">
                      Scan with your mobile signer app
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-500 text-center">
                      (Amber or any NIP-46 signer)
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
                  {/* Copy Link Button - Primary action for client-initiated flow */}
                  <button
                    onClick={handleCopyLink}
                    className={`w-full py-3 px-4 text-base font-semibold rounded-xl transition-all flex items-center justify-center gap-2 ${
                      copied
                        ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-2 border-green-500"
                        : "bg-gradient-to-r from-purple-600 to-violet-700 hover:from-purple-700 hover:to-violet-800 text-white shadow-md hover:shadow-lg"
                    }`}
                  >
                    {copied ? (
                      <>
                        <span>✓</span>
                        <span>Copied! Paste in your signer</span>
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

                  {/* Instructions - client-initiated flow */}
                  <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      How to connect:
                    </p>
                    <ol className="text-sm text-gray-600 dark:text-gray-400 space-y-1.5 list-decimal list-inside">
                      <li>
                        Tap <strong>&quot;Copy Connection Link&quot;</strong> above
                      </li>
                      <li>Open your Nostr signer and paste the connection link</li>
                      <li>Approve the connection request</li>
                    </ol>
                  </div>

                  {/* v55: Show QR Code toggle for mobile */}
                  <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
                    <button
                      onClick={() => setShowMobileQR(!showMobileQR)}
                      className="w-full text-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors flex items-center justify-center gap-1"
                    >
                      <span>{showMobileQR ? "▼" : "▶"}</span>
                      <span>Show QR code (scan from another device)</span>
                    </button>

                    {showMobileQR && (
                      <div className="mt-4 flex flex-col items-center">
                        <div
                          data-testid="nostr-connect-qr"
                          className="p-4 bg-white rounded-xl shadow-sm border border-gray-200"
                        >
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
                      onClick={() => setShowMobileQR(!showMobileQR)}
                      className="w-full text-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors flex items-center justify-center gap-1"
                    >
                      <span>{showMobileQR ? "▼" : "▶"}</span>
                      <span>Show QR code (scan from another device)</span>
                    </button>

                    {showMobileQR && (
                      <div className="mt-4 flex flex-col items-center">
                        <div
                          data-testid="nostr-connect-qr"
                          className="p-4 bg-white rounded-xl shadow-sm border border-gray-200"
                        >
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
        {(stage === "idle" || isCreating) && (
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
