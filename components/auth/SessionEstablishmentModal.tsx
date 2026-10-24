/**
 * SessionEstablishmentModal - Shows progress while establishing server session
 *
 * This modal is shown after extension sign-in when:
 * - User is locally authenticated (isAuthenticated: true)
 * - But server session is not yet established (hasServerSession: false)
 *
 * It prevents the "partial sign-in" race condition where Dashboard renders
 * and fetches data before the NIP-98 server session cookie is set, causing 401 errors.
 *
 * Features:
 * - 3-step progress indicator (Connected → Signing → Loading data)
 * - Minimum display times per step for good UX (even if auth is fast)
 * - Timeout handling (~10s) with error state
 * - Retry button on failure
 * - Calls onComplete when all steps finish (controls own visibility)
 */

import { useState, useEffect, useRef, useCallback } from "react"

import ProgressStepper from "./ProgressStepper"

// Session establishment timeout (10 seconds)
const SESSION_TIMEOUT = 10000

// Minimum display times for each step (in ms) for good UX
// This ensures users can see each step complete even if the actual process is fast
const MIN_STEP_DISPLAY_TIME: Record<string, number> = {
  connected: 800, // Show "Connected to extension" for at least 800ms
  signing: 1000, // Show "Signing authentication" for at least 1000ms
  syncing: 800, // Show "Loading your data" for at least 800ms
}

type SessionStage = "connected" | "signing" | "syncing" | "complete" | "error"

interface SessionEstablishmentModalProps {
  /** Whether server session is established */
  hasServerSession: boolean
  /** Called when user clicks retry */
  onRetry?: () => void
  /** Called when user cancels (signs out) */
  onCancel?: () => void
  /** Called when all steps complete (modal ready to hide) */
  onComplete?: () => void
  /** Method used to sign in */
  signInMethod?: "extension" | "externalSigner"
}

export default function SessionEstablishmentModal({
  hasServerSession,
  onRetry,
  onCancel,
  onComplete,
  signInMethod = "extension",
}: SessionEstablishmentModalProps) {
  // Stage: 'connected' | 'signing' | 'syncing' | 'complete' | 'error'
  const [stage, setStage] = useState<SessionStage>("connected")
  const [errorMessage, setErrorMessage] = useState<string>("")
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startTimeRef = useRef<number>(Date.now())
  // Track when each stage started for minimum display time enforcement
  const stageStartTimeRef = useRef<number>(Date.now())
  // Track if session is ready but we're still showing steps
  const sessionReadyRef = useRef<boolean>(false)
  // Track if we've already called onComplete
  const completedRef = useRef<boolean>(false)

  // Define stages based on sign-in method
  const stages = [
    {
      id: "connected",
      label:
        signInMethod === "extension" ? "Connected to extension" : "Connected to signer",
    },
    { id: "signing", label: "Signing authentication" },
    { id: "syncing", label: "Loading your data" },
  ]

  // Helper to advance to next stage with minimum display time enforcement
  const advanceToStage = useCallback((nextStage: SessionStage) => {
    console.log(`[SessionEstablishmentModal] Advancing to stage: ${nextStage}`)
    stageStartTimeRef.current = Date.now()
    setStage(nextStage)
  }, [])

  // Step 1: connected -> signing (after minimum display time)
  useEffect(() => {
    if (stage === "connected") {
      const timer = setTimeout(() => {
        advanceToStage("signing")
      }, MIN_STEP_DISPLAY_TIME.connected)
      return () => clearTimeout(timer)
    }
  }, [stage, advanceToStage])

  // Track when session becomes ready (can happen at any time)
  useEffect(() => {
    if (hasServerSession && !sessionReadyRef.current) {
      console.log("[SessionEstablishmentModal] Session is now ready!")
      sessionReadyRef.current = true
    }
  }, [hasServerSession])

  // Step 2: signing -> syncing (after session ready AND minimum display time)
  useEffect(() => {
    if (stage === "signing") {
      const checkAndAdvance = (): ReturnType<typeof setTimeout> | null => {
        if (sessionReadyRef.current) {
          const elapsed = Date.now() - stageStartTimeRef.current
          const remaining = Math.max(0, MIN_STEP_DISPLAY_TIME.signing - elapsed)

          const timer = setTimeout(() => {
            advanceToStage("syncing")
          }, remaining)

          return timer
        }
        return null
      }

      // Check immediately in case session is already ready
      let timer = checkAndAdvance()

      // If session wasn't ready, set up an interval to check
      let interval: ReturnType<typeof setInterval> | null = null
      if (!timer) {
        interval = setInterval(() => {
          if (sessionReadyRef.current) {
            if (interval) clearInterval(interval)
            timer = checkAndAdvance()
          }
        }, 100)
      }

      return () => {
        if (timer) clearTimeout(timer)
        if (interval) clearInterval(interval)
      }
    }
  }, [stage, advanceToStage])

  // Step 3: syncing -> complete (after minimum display time)
  useEffect(() => {
    if (stage === "syncing") {
      // Clear the main timeout since we're almost done
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }

      const timer = setTimeout(() => {
        console.log("[SessionEstablishmentModal] All steps complete!")
        setStage("complete")
      }, MIN_STEP_DISPLAY_TIME.syncing)

      return () => clearTimeout(timer)
    }
  }, [stage])

  // When complete, call onComplete callback
  useEffect(() => {
    if (stage === "complete" && !completedRef.current) {
      completedRef.current = true
      console.log("[SessionEstablishmentModal] Calling onComplete callback")
      onComplete?.()
    }
  }, [stage, onComplete])

  // Set up timeout for error state
  useEffect(() => {
    startTimeRef.current = Date.now()

    timeoutRef.current = setTimeout(() => {
      if (!sessionReadyRef.current) {
        console.log("[SessionEstablishmentModal] Timeout - session not established")
        setStage("error")
        setErrorMessage(
          "Session establishment timed out. The server may be slow or there was a signing issue.",
        )
      }
    }, SESSION_TIMEOUT)

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, []) // Only run once on mount

  const handleRetry = () => {
    console.log("[SessionEstablishmentModal] Retry clicked")
    setStage("connected")
    setErrorMessage("")
    startTimeRef.current = Date.now()
    stageStartTimeRef.current = Date.now()
    sessionReadyRef.current = false
    completedRef.current = false

    // Reset timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = setTimeout(() => {
      if (!sessionReadyRef.current) {
        setStage("error")
        setErrorMessage(
          "Session establishment timed out. The server may be slow or there was a signing issue.",
        )
      }
    }, SESSION_TIMEOUT)

    onRetry?.()
  }

  const handleCancel = () => {
    console.log("[SessionEstablishmentModal] Cancel clicked")
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    onCancel?.()
  }

  // Don't render if complete
  if (stage === "complete") {
    return null
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl max-w-sm w-full shadow-xl overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 text-center border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {stage === "error" ? "Connection Issue" : "Completing Sign-in..."}
          </h3>
          {stage !== "error" && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Establishing secure session
            </p>
          )}
        </div>

        {/* Content */}
        <div className="px-6 py-5">
          {stage !== "error" ? (
            <>
              <ProgressStepper stages={stages} currentStage={stage} errorStage={null} />

              {/* Helpful tip during signing */}
              {stage === "signing" && !sessionReadyRef.current && (
                <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <p className="text-sm text-blue-700 dark:text-blue-400">
                    {signInMethod === "extension"
                      ? "Your browser extension is signing the authentication request..."
                      : "Your signer app is signing the authentication request..."}
                  </p>
                </div>
              )}
            </>
          ) : (
            /* Error View */
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
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
              </div>

              <p className="text-gray-700 dark:text-gray-300 mb-2">{errorMessage}</p>

              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                This can happen if:
              </p>
              <ul className="text-sm text-gray-500 dark:text-gray-400 text-left list-disc list-inside mb-4 space-y-1">
                <li>The signing request was rejected</li>
                <li>Your extension didn&apos;t respond in time</li>
                <li>There&apos;s a network connectivity issue</li>
              </ul>

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
                  Sign Out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
