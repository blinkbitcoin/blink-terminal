/**
 * NostrLoginForm - Sign-in component with multiple Nostr authentication methods
 *
 * Supports:
 * - Browser extension (keys.band, Alby) - Desktop
 * - External signer (Amber) - Mobile
 * - NIP-46 remote signer (nsec.app, Amber QR) - Cross-platform
 * - In-app key generation with password protection
 */

import { useState, useEffect, useRef, useCallback } from "react"

import {
  getEnvironment,
  setEnvironment,
  isStaging,
  getEnvironmentConfig,
} from "../../lib/config/api"
import { isPasswordAuthEnabled } from "../../lib/config/features"
import { useNostrAuth } from "../../lib/hooks/useNostrAuth"
import { useTheme } from "../../lib/hooks/useTheme"
import NostrAuthService from "../../lib/nostr/NostrAuthService"
import NostrConnectService from "../../lib/nostr/NostrConnectService"
import { AUTH_VERSION_FULL, logAuth, logAuthError } from "../../lib/version"

import NostrConnectModal from "./NostrConnectModal"

/** Auth mode for the form's view state */
type AuthMode = "main" | "create" | "password"

/** Diagnostic results from NIP-44 tests (dynamically imported) */
interface DiagnosticResultsDisplay {
  overall: string
  summary?: string
  error?: string
}

export default function NostrLoginForm() {
  const { darkMode: _darkMode } = useTheme()
  const {
    loading,
    error,
    hasExtension,
    isMobile,
    availableMethods: _availableMethods,
    signInWithExtension,
    signInWithExternalSigner,
    signInWithNostrConnect,
    checkPendingSignerFlow,
    createAccountWithPassword,
    signInWithPassword,
  } = useNostrAuth()

  const [signingIn, setSigningIn] = useState<boolean>(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [checkingReturn, setCheckingReturn] = useState<boolean>(true)

  // Manual Step 2 state - when Step 1 (pubkey) completes, show manual button for Step 2
  const [awaitingStep2, setAwaitingStep2] = useState<boolean>(false)
  const [step1Pubkey, setStep1Pubkey] = useState<string | null>(null)

  // NIP-46 Nostr Connect state
  // Modal handles the full sign-in flow internally
  const [showNostrConnectModal, setShowNostrConnectModal] = useState<boolean>(false)
  const [nostrConnectURI, setNostrConnectURI] = useState<string>("")

  // Ref to prevent multiple rapid sign-in attempts (refs don't trigger re-renders)
  const signingInRef = useRef<boolean>(false)

  // Debug mode state (tap logo 5 times to activate)
  const [logoTapCount, setLogoTapCount] = useState<number>(0)
  const [showDebugPanel, setShowDebugPanel] = useState<boolean>(false)
  const [debugInfo, setDebugInfo] = useState<string>("")
  const [runningDiagnostics, setRunningDiagnostics] = useState<boolean>(false)
  const [diagnosticResults, setDiagnosticResults] =
    useState<DiagnosticResultsDisplay | null>(null)
  const [diagnosticLogs, setDiagnosticLogs] = useState<string[]>([])

  // In-app key generation state
  const [authMode, setAuthMode] = useState<AuthMode>("main")
  const [password, setPassword] = useState<string>("")
  const [confirmPassword, setConfirmPassword] = useState<string>("")
  const [hasStoredAccount, setHasStoredAccount] = useState<boolean>(false)

  // Detect Android for showing appropriate mobile options
  const isAndroid =
    typeof navigator !== "undefined" && /Android/.test(navigator.userAgent)

  // Check for stored account on mount
  useEffect(() => {
    setHasStoredAccount(NostrAuthService.hasStoredEncryptedNsec())
  }, [])

  // Debug: Handle logo tap for debug mode
  const handleLogoTap = () => {
    const newCount = logoTapCount + 1
    setLogoTapCount(newCount)
    console.log(`[DEBUG] Logo tap ${newCount}/5`)

    if (newCount >= 5) {
      setShowDebugPanel(true)
      setLogoTapCount(0)
      updateDebugInfo()
    }

    // Reset tap count after 2 seconds of inactivity
    setTimeout(() => setLogoTapCount(0), 2000)
  }

  // Debug: Update debug info display
  const updateDebugInfo = () => {
    const info = {
      buildVersion: AUTH_VERSION_FULL,
      url: window.location.href,
      urlParams: window.location.search,
      challengeFlow: localStorage.getItem("blinkpos_challenge_flow"),
      signinFlow: localStorage.getItem("blinkpos_signin_flow"),
      pubkey: localStorage.getItem("blinkpos_pubkey"),
      method: localStorage.getItem("blinkpos_signin_method"),
      isPWA:
        window.matchMedia("(display-mode: standalone)").matches ||
        window.navigator.standalone,
      userAgent: navigator.userAgent.substring(0, 100),
    }
    setDebugInfo(JSON.stringify(info, null, 2))
    logAuth("DEBUG", "Build:", AUTH_VERSION_FULL, "| Current state:", info)
  }

  // Debug: Clear all auth state
  const handleDebugClearAuth = () => {
    console.log("[DEBUG] Clearing all auth state...")
    localStorage.removeItem("blinkpos_challenge_flow")
    localStorage.removeItem("blinkpos_signin_flow")
    localStorage.removeItem("blinkpos_pubkey")
    localStorage.removeItem("blinkpos_signin_method")
    // Clear URL params
    const cleanUrl = new URL(window.location.href)
    cleanUrl.search = ""
    window.history.replaceState({}, "", cleanUrl.toString())
    // Update debug info
    updateDebugInfo()
    setLocalError(null)
    alert("Auth state cleared! You can try signing in again.")
  }

  // Debug: Clear everything including encrypted nsec
  const handleDebugClearAll = () => {
    console.log("[DEBUG] Clearing ALL data including account...")
    localStorage.removeItem("blinkpos_challenge_flow")
    localStorage.removeItem("blinkpos_signin_flow")
    localStorage.removeItem("blinkpos_pubkey")
    localStorage.removeItem("blinkpos_signin_method")
    localStorage.removeItem("blinkpos_encrypted_nsec")
    localStorage.removeItem("blinkpos_profiles")
    // Clear URL params
    const cleanUrl = new URL(window.location.href)
    cleanUrl.search = ""
    window.history.replaceState({}, "", cleanUrl.toString())
    setHasStoredAccount(false)
    updateDebugInfo()
    setLocalError(null)
    alert("All data cleared! Page will reload.")
    window.location.reload()
  }

  // Debug: Run NIP-44 crypto diagnostics
  const handleRunNIP44Diagnostics = async () => {
    setRunningDiagnostics(true)
    setDiagnosticLogs([])
    setDiagnosticResults(null)

    try {
      // Dynamic import to avoid loading diagnostic code in production
      const { runNIP44Diagnostics, sendDiagnosticsToServer } =
        await import("../../lib/debug/nip44DiagnosticTest")

      const logs: string[] = []
      const logCallback = (msg: string) => {
        logs.push(msg)
        setDiagnosticLogs([...logs])
      }

      const results = await runNIP44Diagnostics(logCallback)
      setDiagnosticResults(results)

      // Send to server for remote debugging
      await sendDiagnosticsToServer(results)

      console.log("[DEBUG] NIP-44 Diagnostics complete:", results)
    } catch (err: unknown) {
      console.error("[DEBUG] NIP-44 Diagnostics failed:", err)
      setDiagnosticResults({ overall: "ERROR", error: (err as Error).message })
    } finally {
      setRunningDiagnostics(false)
    }
  }

  // Check for pending signer flow on mount and focus (user returning from Amber)
  useEffect(() => {
    const checkSignerReturn = async () => {
      const result = await checkPendingSignerFlow()

      // Check if Step 1 completed and we need manual Step 2
      if (result.needsManualStep2) {
        logAuth("NostrLoginForm", "Step 1 complete, showing manual Step 2 button")
        logAuth("NostrLoginForm", "pubkey:", result.pubkey?.substring(0, 16) + "...")
        setAwaitingStep2(true)
        setStep1Pubkey(result.pubkey ?? null)
        setCheckingReturn(false)
        setLocalError(null)
        return
      }

      if (result.success) {
        // Sign-in completed successfully
        logAuth("NostrLoginForm", "Signed in via external signer")
        setAwaitingStep2(false)
        setStep1Pubkey(null)
      } else if (result.error && result.pending !== false) {
        // Show error only if there was a pending flow that failed
        setLocalError(result.error ?? null)
        setAwaitingStep2(false)
        setStep1Pubkey(null)
      }
      setCheckingReturn(false)
    }

    // Check immediately on mount (handles redirect return)
    checkSignerReturn()

    // Also check on focus (handles manual app switch)
    const handleFocus = () => {
      checkSignerReturn()
    }

    window.addEventListener("focus", handleFocus)

    // Also listen for visibility change (more reliable on mobile)
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkSignerReturn()
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      window.removeEventListener("focus", handleFocus)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [checkPendingSignerFlow])

  const handleExtensionSignIn = async () => {
    setSigningIn(true)
    setLocalError(null)

    const result = await signInWithExtension()

    if (!result.success) {
      setLocalError(result.error ?? null)
    }

    setSigningIn(false)
  }

  const handleExternalSignerSignIn = async () => {
    console.log(
      "[NostrLoginForm] handleExternalSignerSignIn called, signingInRef:",
      signingInRef.current,
    )

    // CRITICAL: Prevent multiple rapid clicks from overwriting challenge flow
    // This fixes the bug where 12+ rapid clicks would each fetch a new challenge,
    // causing the final return from Amber to have mismatched challenge data
    if (signingInRef.current) {
      console.log("[NostrLoginForm] Sign-in already in progress (ref), ignoring click")
      return
    }

    // Set ref immediately to block any subsequent calls
    signingInRef.current = true
    setSigningIn(true)
    setLocalError(null)

    try {
      console.log("[NostrLoginForm] Calling signInWithExternalSigner...")
      const result = await signInWithExternalSigner()
      console.log("[NostrLoginForm] signInWithExternalSigner result:", result)

      if (result.pending) {
        // User will be redirected to external signer
        // When they return, the page reloads fresh with new state.
        // Keep signingInRef true - it will be reset on page reload
        console.log("[NostrLoginForm] Redirect pending, keeping signingInRef locked")
        setTimeout(() => {
          // Only reset UI state after timeout, but keep ref locked to prevent re-clicks
          setSigningIn(false)
          // Reset ref after longer timeout in case redirect failed
          setTimeout(() => {
            signingInRef.current = false
            console.log("[NostrLoginForm] signingInRef reset after timeout")
          }, 5000)
        }, 3000)
        return
      }

      if (!result.success) {
        console.log("[NostrLoginForm] Sign-in failed:", result.error)
        setLocalError(result.error ?? null)
      }
    } catch (err: unknown) {
      console.error("[NostrLoginForm] Exception in handleExternalSignerSignIn:", err)
      setLocalError((err as Error).message || "Sign-in failed")
    }

    // Reset both ref and state when not pending
    signingInRef.current = false
    setSigningIn(false)
  }

  // Handle user tap on "Continue to Amber" button for Step 2 (sign challenge)
  // This is a user-initiated navigation which is more reliable on Android than automatic redirects
  const handleContinueToAmber = async () => {
    logAuth("NostrLoginForm", "handleContinueToAmber called - user-initiated Step 2")
    setSigningIn(true)
    setLocalError(null)

    try {
      // Call retrySignChallengeRedirect which will navigate to Amber for signing
      const result = await NostrAuthService.retrySignChallengeRedirect()
      logAuth(
        "NostrLoginForm",
        "retrySignChallengeRedirect result:",
        JSON.stringify(result),
      )

      if (result.pending) {
        // Navigation initiated, user will be redirected to Amber
        logAuth("NostrLoginForm", "Redirect to Amber initiated")
        // Keep signing in state until redirect or timeout
        setTimeout(() => {
          setSigningIn(false)
        }, 3000)
        return
      }

      if (!result.success) {
        logAuth("NostrLoginForm", "Step 2 redirect failed:", result.error)
        setLocalError(result.error ?? null)
        // If redirect failed, allow retry
        setAwaitingStep2(true)
      }
    } catch (err: unknown) {
      logAuthError("NostrLoginForm", "Exception in handleContinueToAmber:", err)
      setLocalError((err as Error).message || "Failed to open Amber")
    }

    setSigningIn(false)
  }

  // Handle cancel/restart of the sign-in flow
  const handleCancelStep2 = () => {
    logAuth("NostrLoginForm", "User cancelled Step 2, clearing flow")
    NostrAuthService.clearPendingChallengeFlow()
    setAwaitingStep2(false)
    setStep1Pubkey(null)
    setLocalError(null)
  }

  // NIP-46 Nostr Connect handlers
  const handleNostrConnectSignIn = async () => {
    logAuth("NostrLoginForm", "Starting Nostr Connect flow")
    setLocalError(null)

    try {
      // Generate the nostrconnect:// URI
      const uri = NostrConnectService.generateConnectionURI()
      setNostrConnectURI(uri)
      setShowNostrConnectModal(true)

      logAuth("NostrLoginForm", "Generated URI, showing modal")
    } catch (err: unknown) {
      logAuthError("NostrLoginForm", "Failed to generate connection URI:", err)
      setLocalError("Failed to start Nostr Connect: " + (err as Error).message)
    }
  }

  // Handle successful Nostr Connect sign-in
  // Called by NostrConnectModal after the FULL sign-in flow is complete
  const handleNostrConnectSuccess = useCallback((pubkey: string) => {
    logAuth(
      "NostrLoginForm",
      "Nostr Connect complete, pubkey:",
      pubkey?.substring(0, 16) + "...",
    )
    setShowNostrConnectModal(false)
    setNostrConnectURI("")
    // Navigation will happen automatically via auth state change
  }, [])

  // Handle modal cancel
  const handleNostrConnectClose = () => {
    logAuth("NostrLoginForm", "Closing Nostr Connect modal")
    setShowNostrConnectModal(false)
    setNostrConnectURI("")
  }

  // v29: The modal now handles the full connection flow internally,
  // so we don't need a useEffect here anymore to auto-start the connection.

  // Handle create new account with password
  const handleCreateAccount = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSigningIn(true)
    setLocalError(null)

    try {
      // Validate password
      if (password.length < 8) {
        setLocalError("Password must be at least 8 characters")
        setSigningIn(false)
        return
      }

      if (password !== confirmPassword) {
        setLocalError("Passwords do not match")
        setSigningIn(false)
        return
      }

      // Use the hook method which handles everything including state update
      const result = await createAccountWithPassword(password)

      if (!result.success) {
        setLocalError(result.error ?? null)
        setSigningIn(false)
        return
      }

      // Success! State is already updated by the hook - no reload needed
      console.log("[NostrLoginForm] Account created successfully")
      setSigningIn(false)
    } catch (err: unknown) {
      console.error("Create account failed:", err)
      setLocalError((err as Error).message || "Failed to create account")
      setSigningIn(false)
    }
  }

  // Handle sign in with password (existing account)
  const handlePasswordSignIn = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSigningIn(true)
    setLocalError(null)

    try {
      // Use the hook method which handles everything including state update
      const result = await signInWithPassword(password)

      if (!result.success) {
        setLocalError(result.error ?? null)
        setSigningIn(false)
        return
      }

      // Success! State is already updated by the hook - no reload needed
      console.log("[NostrLoginForm] Signed in with password successfully")
      setSigningIn(false)
    } catch (err: unknown) {
      console.error("Password sign in failed:", err)
      setLocalError((err as Error).message || "Failed to sign in")
      setSigningIn(false)
    }
  }

  // Reset to main view
  const handleBackToMain = () => {
    setAuthMode("main")
    setPassword("")
    setConfirmPassword("")
    setLocalError(null)
  }

  const displayError = localError || error

  if (loading || checkingReturn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-black">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-blink-accent border-t-transparent mx-auto"></div>
          <p className="mt-4 text-gray-600 dark:text-gray-400">
            {checkingReturn ? "Completing sign-in..." : "Checking authentication..."}
          </p>
        </div>
      </div>
    )
  }

  // v24: Manual Step 2 View - Show when pubkey obtained, waiting for user to tap to continue signing
  if (awaitingStep2) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-black">
        <div className="max-w-md w-full space-y-8 p-8">
          {/* Header */}
          <div className="text-center">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 bg-gradient-to-br from-green-400 to-emerald-600 rounded-full flex items-center justify-center">
                <svg
                  className="w-10 h-10 text-white"
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
            </div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              Identity Confirmed!
            </h2>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Step 1 of 2 complete
            </p>
            {step1Pubkey && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-500 font-mono">
                {step1Pubkey.substring(0, 8)}...
                {step1Pubkey.substring(step1Pubkey.length - 8)}
              </p>
            )}
          </div>

          {/* Explanation */}
          <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              <strong>Almost there!</strong> Amber has confirmed your identity. Now tap
              the button below to sign in securely.
            </p>
          </div>

          {/* Continue Button */}
          <button
            onClick={handleContinueToAmber}
            disabled={signingIn}
            className="group relative w-full flex justify-center items-center py-5 px-6 border-2 border-amber-500 text-xl font-bold rounded-xl text-white bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg hover:shadow-xl"
          >
            {signingIn ? (
              <>
                <svg
                  className="animate-spin -ml-1 mr-3 h-6 w-6 text-white"
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
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                Opening Amber...
              </>
            ) : (
              <>
                <svg
                  className="w-7 h-7 mr-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                  />
                </svg>
                Continue to Amber
                <svg
                  className="w-5 h-5 ml-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M14 5l7 7m0 0l-7 7m7-7H3"
                  />
                </svg>
              </>
            )}
          </button>

          {/* Error Display */}
          {displayError && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-600 dark:text-red-400">{displayError}</p>
              <p className="text-xs text-red-500 dark:text-red-400 mt-2">
                Tap the button above to try again
              </p>
            </div>
          )}

          {/* Cancel/Start Over */}
          <button
            onClick={handleCancelStep2}
            disabled={signingIn}
            className="w-full text-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-50"
          >
            Cancel and start over
          </button>

          {/* Help text */}
          <div className="text-center">
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Having trouble? Make sure Amber is installed and try tapping the button
              above.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Create Account View
  if (authMode === "create") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-black">
        <div className="max-w-md w-full space-y-8 p-8">
          {/* Header */}
          <div className="text-center">
            <div className="flex justify-center mb-6">
              <div className="w-16 h-16 bg-gradient-to-br from-emerald-400 to-teal-600 rounded-2xl flex items-center justify-center">
                <svg
                  className="w-8 h-8 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
                  />
                </svg>
              </div>
            </div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              Create New Account
            </h2>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Your private key will be encrypted with this password
            </p>
          </div>

          {/* Create Account Form */}
          <form onSubmit={handleCreateAccount} className="space-y-4">
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setPassword(e.target.value)
                }
                placeholder="Enter a strong password"
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                required
                minLength={8}
                autoFocus
                autoComplete="new-password"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Minimum 8 characters
              </p>
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Confirm Password
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setConfirmPassword(e.target.value)
                }
                placeholder="Confirm your password"
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>

            {/* Error Display */}
            {displayError && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-sm text-red-600 dark:text-red-400">{displayError}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={signingIn || password.length < 8 || password !== confirmPassword}
              className="w-full flex justify-center items-center py-4 px-6 border border-transparent text-lg font-medium rounded-xl text-white bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {signingIn ? (
                <>
                  <svg
                    className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
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
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  Creating Account...
                </>
              ) : (
                "Create Account"
              )}
            </button>
          </form>

          {/* Back Button */}
          <button
            onClick={handleBackToMain}
            className="w-full text-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
          >
            &larr; Back to sign-in options
          </button>

          {/* Warning */}
          <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              &#9888;&#65039; <strong>Important:</strong> Remember your password!
              It&apos;s the only way to access your account. We cannot recover it.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Password Sign-In View (returning users)
  if (authMode === "password") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-black">
        <div className="max-w-md w-full space-y-8 p-8">
          {/* Header */}
          <div className="text-center">
            <div className="flex justify-center mb-6">
              <div className="w-16 h-16 bg-gradient-to-br from-blue-400 to-indigo-600 rounded-2xl flex items-center justify-center">
                <svg
                  className="w-8 h-8 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                  />
                </svg>
              </div>
            </div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              Welcome Back
            </h2>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Enter your password to sign in
            </p>
          </div>

          {/* Password Sign-In Form */}
          <form onSubmit={handlePasswordSignIn} className="space-y-4">
            <div>
              <label
                htmlFor="loginPassword"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Password
              </label>
              <input
                id="loginPassword"
                type="password"
                value={password}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setPassword(e.target.value)
                }
                placeholder="Enter your password"
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
                autoFocus
                autoComplete="current-password"
              />
            </div>

            {/* Error Display */}
            {displayError && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-sm text-red-600 dark:text-red-400">{displayError}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={signingIn || !password}
              className="w-full flex justify-center items-center py-4 px-6 border border-transparent text-lg font-medium rounded-xl text-white bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {signingIn ? (
                <>
                  <svg
                    className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
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
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  Signing In...
                </>
              ) : (
                "Sign In"
              )}
            </button>
          </form>

          {/* Back Button */}
          <button
            onClick={handleBackToMain}
            className="w-full text-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
          >
            &larr; Back to sign-in options
          </button>
        </div>
      </div>
    )
  }

  // Main View (default)

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-black">
      {/* Fixed header with logo like dashboard - TAP 5 TIMES FOR DEBUG */}
      <div className="px-4 py-4" onClick={handleLogoTap} data-testid="app-logo">
        <img
          src="/logos/blink-icon-light.svg"
          alt="Blink"
          className="h-12 w-12 dark:hidden"
        />
        <img
          src="/logos/blink-icon-dark.svg"
          alt="Blink"
          className="h-12 w-12 hidden dark:block"
        />
      </div>

      {/* Debug Panel - shown after 5 logo taps */}
      {showDebugPanel && (
        <div
          className="fixed inset-0 bg-black/80 z-50 p-4 overflow-auto"
          data-testid="debug-panel"
        >
          <div className="bg-gray-900 rounded-xl p-4 max-w-lg mx-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-white">&#128295; Debug Panel</h3>
              <button
                onClick={() => setShowDebugPanel(false)}
                className="text-gray-400 hover:text-white text-2xl"
              >
                &times;
              </button>
            </div>

            {/* Build Version - Prominent display */}
            <div className="mb-4 p-3 bg-blue-900/50 border border-blue-500 rounded-lg">
              <div className="text-xs text-blue-300 uppercase tracking-wide mb-1">
                Build Version
              </div>
              <div className="text-lg font-mono font-bold text-blue-100">
                {AUTH_VERSION_FULL}
              </div>
            </div>

            <div className="space-y-3">
              {/* NIP-44 Diagnostics Button - Primary action for iOS debugging */}
              <button
                onClick={handleRunNIP44Diagnostics}
                disabled={runningDiagnostics}
                className="w-full py-3 px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 text-white rounded-lg font-medium flex items-center justify-center gap-2"
              >
                {runningDiagnostics ? (
                  <>
                    <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    Running NIP-44 Tests...
                  </>
                ) : (
                  <>&#129514; Run NIP-44 Crypto Diagnostics</>
                )}
              </button>

              {/* Diagnostic Results Summary */}
              {diagnosticResults && (
                <div
                  className={`p-3 rounded-lg border ${
                    diagnosticResults.overall === "PASS"
                      ? "bg-green-900/50 border-green-500"
                      : diagnosticResults.overall === "ERROR"
                        ? "bg-red-900/50 border-red-500"
                        : "bg-yellow-900/50 border-yellow-500"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-white">
                      {diagnosticResults.overall === "PASS"
                        ? "&#9989; All Tests Passed"
                        : diagnosticResults.overall === "ERROR"
                          ? "&#10060; Error Running Tests"
                          : "&#9888;&#65039; Some Tests Failed"}
                    </span>
                    <span className="text-sm text-gray-300">
                      {diagnosticResults.summary || diagnosticResults.error}
                    </span>
                  </div>
                </div>
              )}

              {/* Diagnostic Logs */}
              {diagnosticLogs.length > 0 && (
                <div className="mt-2">
                  <h4 className="text-sm font-medium text-gray-400 mb-2">Test Output:</h4>
                  <pre className="bg-black p-3 rounded text-xs text-green-400 overflow-auto max-h-48 whitespace-pre-wrap font-mono">
                    {diagnosticLogs.join("\n")}
                  </pre>
                </div>
              )}

              {/* Environment Toggle Section */}
              <div className="border-t border-gray-700 my-3 pt-3">
                <h4 className="text-sm font-medium text-gray-400 mb-2">
                  API Environment:
                </h4>
                <div className="flex gap-2">
                  <button
                    onClick={() => setEnvironment("production")}
                    data-testid="production-toggle"
                    className={`flex-1 py-2 px-3 rounded-lg font-medium transition-colors ${
                      getEnvironment() === "production"
                        ? "bg-green-600 text-white"
                        : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                    }`}
                  >
                    Production
                  </button>
                  <button
                    onClick={() => setEnvironment("staging")}
                    data-testid="staging-toggle"
                    className={`flex-1 py-2 px-3 rounded-lg font-medium transition-colors ${
                      getEnvironment() === "staging"
                        ? "bg-amber-600 text-white"
                        : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                    }`}
                  >
                    Staging
                  </button>
                </div>
                {isStaging() && (
                  <p className="text-xs text-amber-400 mt-2">
                    Using staging environment (signet) - not real sats!
                  </p>
                )}
                <p className="text-xs text-gray-500 mt-1">
                  API: {getEnvironmentConfig().apiUrl}
                </p>
              </div>

              <div className="border-t border-gray-700 my-3 pt-3">
                <h4 className="text-sm font-medium text-gray-400 mb-2">Other Actions:</h4>
              </div>

              <button
                onClick={handleDebugClearAuth}
                className="w-full py-3 px-4 bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-medium"
              >
                &#128260; Clear Auth State (Keep Account)
              </button>

              <button
                onClick={handleDebugClearAll}
                className="w-full py-3 px-4 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium"
              >
                &#128465;&#65039; Clear ALL Data &amp; Reload
              </button>

              <button
                onClick={updateDebugInfo}
                className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium"
              >
                &#128269; Refresh Debug Info
              </button>

              <div className="mt-4">
                <h4 className="text-sm font-medium text-gray-400 mb-2">Current State:</h4>
                <pre className="bg-black p-3 rounded text-xs text-green-400 overflow-auto max-h-64 whitespace-pre-wrap">
                  {debugInfo || 'Tap "Refresh Debug Info"'}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-center min-h-[calc(100vh-80px)]">
        <div className="max-w-md w-full space-y-8 p-8">
          {/* Logo */}
          <div className="text-center">
            {/* Terminal-style ASCII logo */}
            <div className="mb-8 mt-4 flex justify-center">
              {/* ASCII art text - centered */}
              <pre className="font-mono text-[13px] sm:text-base leading-tight text-purple-600 dark:text-purple-400 text-left">
                {`╔╗ ╦  ╦╔╗╔╦╔═  ╔╗ ╦╔╦╗╔═╗╔═╗╦╔╗╔
╠╩╗║  ║║║║╠╩╗  ╠╩╗║ ║ ║  ║ ║║║║║
╚═╝╩═╝╩╝╚╝╩ ╩  ╚═╝╩ ╩ ╚═╝╚═╝╩╝╚╝
      ╔╦╗╔═╗╦═╗╔╦╗╦╔╗╔╔═╗╦
       ║ ║╣ ╠╦╝║║║║║║║╠═╣║
       ╩ ╚═╝╩╚═╩ ╩╩╝╚╝╩ ╩╩═╝`}
              </pre>
            </div>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Sign in with your Nostr identity
            </p>
          </div>

          {/* Sign-in Methods */}
          <div className="space-y-4">
            {/* Password Sign-In (if account exists) — gated: Nostr-only by default */}
            {isPasswordAuthEnabled() && hasStoredAccount && (
              <>
                <button
                  onClick={() => setAuthMode("password")}
                  disabled={signingIn}
                  className="group relative w-full flex justify-center items-center py-4 px-6 border border-transparent text-lg font-medium rounded-xl text-white bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  <svg
                    className="w-6 h-6 mr-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                    />
                  </svg>
                  Sign in with Password
                </button>

                {/* Divider */}
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-300 dark:border-gray-700"></div>
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-2 bg-gray-50 dark:bg-black text-gray-500">
                      or use another method
                    </span>
                  </div>
                </div>
              </>
            )}

            {/* v56: Nostr Connect - Available for ALL platforms */}
            {/* Desktop: Shows QR code to scan with mobile signer (nsec.app, Amber, etc.) */}
            {/* Mobile: Opens signer app directly via NIP-46 relay connection */}
            <button
              onClick={handleNostrConnectSignIn}
              disabled={signingIn}
              className="group relative w-full flex justify-center items-center py-4 px-6 border border-transparent text-lg font-medium rounded-xl text-white bg-gradient-to-r from-purple-500 to-violet-600 hover:from-purple-600 hover:to-violet-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg"
            >
              <svg
                className="w-6 h-6 mr-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                />
              </svg>
              {isMobile ? "Connect with Nostr Connect" : "Connect with Remote Signer"}
            </button>

            {/* Extension Sign-In (Desktop) */}
            {hasExtension && (
              <button
                onClick={handleExtensionSignIn}
                disabled={signingIn}
                className="group relative w-full flex justify-center items-center py-4 px-6 border border-transparent text-lg font-medium rounded-xl text-white bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {signingIn ? (
                  <>
                    <svg
                      className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
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
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    Connecting...
                  </>
                ) : (
                  <>
                    <svg
                      className="w-6 h-6 mr-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                      />
                    </svg>
                    Sign in with Extension
                  </>
                )}
              </button>
            )}

            {/* Show extension install hint if not available on desktop */}
            {!hasExtension && !isMobile && !hasStoredAccount && (
              <div className="text-center p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
                <p className="text-sm text-blue-700 dark:text-blue-300">
                  &#128161; Use &quot;Connect with Remote Signer&quot; above to scan a QR
                  code with your mobile signer app, or install a browser extension like{" "}
                  <a
                    href="https://keys.band"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline hover:text-blue-800 dark:hover:text-blue-200"
                  >
                    keys.band
                  </a>{" "}
                  or{" "}
                  <a
                    href="https://getalby.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline hover:text-blue-800 dark:hover:text-blue-200"
                  >
                    Alby
                  </a>
                </p>
              </div>
            )}

            {/* v30: NIP-55 Offline signing - collapsible advanced option for Android */}
            {isAndroid && (
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 list-none flex items-center justify-center gap-1 py-2">
                  <svg
                    className="w-4 h-4 transition-transform details-open:rotate-90"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                  <span>Offline signing (NIP-55)</span>
                </summary>
                <div className="mt-2 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 text-center">
                    Use NIP-55 URL scheme signing if you don&apos;t have internet access.
                    Requires Amber signer app.
                  </p>
                  <button
                    onClick={handleExternalSignerSignIn}
                    disabled={signingIn}
                    className="group relative w-full flex justify-center items-center py-3 px-4 border border-amber-400 dark:border-amber-500 text-base font-medium rounded-lg text-amber-600 dark:text-amber-400 bg-transparent hover:bg-amber-50 dark:hover:bg-amber-900/20 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {signingIn ? (
                      <>
                        <svg
                          className="animate-spin -ml-1 mr-2 h-4 w-4"
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
                          ></circle>
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          ></path>
                        </svg>
                        Opening Signer...
                      </>
                    ) : (
                      <>
                        <svg
                          className="w-5 h-5 mr-2"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                          />
                        </svg>
                        Sign in with NIP-55
                      </>
                    )}
                  </button>
                </div>
              </details>
            )}

            {/* Create New Account Button — gated: Nostr-only by default */}
            {isPasswordAuthEnabled() && (
              <button
                onClick={() => setAuthMode("create")}
                disabled={signingIn}
                className="group relative w-full flex justify-center items-center py-4 px-6 border-2 border-emerald-500 text-lg font-medium rounded-xl text-emerald-600 dark:text-emerald-400 bg-transparent hover:bg-emerald-50 dark:hover:bg-emerald-900/20 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg
                  className="w-6 h-6 mr-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
                  />
                </svg>
                Create New Account
              </button>
            )}

            {/* Android hint */}
            {isAndroid && (
              <p className="text-xs text-center text-gray-500 dark:text-gray-400">
                Works with{" "}
                <a
                  href="https://github.com/greenart7c3/Amber"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-600 dark:text-purple-400 underline"
                >
                  Amber
                </a>{" "}
                signer app
              </p>
            )}
          </div>

          {/* v32: Nostr Connect Modal - handles full sign-in flow with progress UI */}
          {showNostrConnectModal && (
            <NostrConnectModal
              uri={nostrConnectURI}
              onSuccess={handleNostrConnectSuccess}
              onCancel={handleNostrConnectClose}
              signInWithNostrConnect={signInWithNostrConnect}
            />
          )}

          {/* Error Display */}
          {displayError && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-600 dark:text-red-400">{displayError}</p>
            </div>
          )}

          {/* Info Section */}
          <div className="mt-8 text-center space-y-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              &#128272; Your credentials are encrypted and stored locally
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              After signing in, you&apos;ll connect your Blink account
            </p>
          </div>

          {/* What is Nostr? */}
          <div className="mt-6 text-center">
            <details className="text-left">
              <summary className="cursor-pointer text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">
                What is Nostr?
              </summary>
              <div className="mt-2 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm text-gray-600 dark:text-gray-300">
                <p>
                  Nostr is a decentralized protocol for identity and communication. Your
                  Nostr identity (public key) acts as your login across many apps.
                </p>
                <p className="mt-2">
                  <strong>Browser extensions</strong> (keys.band, Alby) keep your keys
                  secure on desktop.
                </p>
                <p className="mt-2">
                  <strong>Mobile signers</strong> like Amber (Android) securely manage
                  your Nostr keys on mobile. For iOS, use the Nostash extension for
                  Safari.
                </p>
                {isPasswordAuthEnabled() && (
                  <p className="mt-2">
                    <strong>Create New Account</strong> generates a Nostr identity
                    protected by your password - works everywhere!
                  </p>
                )}
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  )
}
