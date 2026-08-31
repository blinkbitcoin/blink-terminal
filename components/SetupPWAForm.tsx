/**
 * SetupPWAForm - PWA Setup Form for Public POS
 *
 * Entry point for unauthenticated users to access Public POS.
 * Allows entering a Blink username to receive payments.
 *
 * Features:
 * - Dark/light theme toggle (click top-left Blink icon)
 * - Username validation against Blink GraphQL API
 * - PWA install prompts (Android/iOS)
 * - Recent usernames list
 * - Auto-saves last username for PWA auto-redirect
 */

import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/router"
import { useState, useEffect, useRef, useCallback } from "react"

import { getEnvironment, getAllValidDomains } from "../lib/config/api"
import { useTheme, THEMES } from "../lib/hooks/useTheme"

// Extend Window for MSStream (IE detection)
declare global {
  interface Window {
    MSStream?: unknown
  }
}

// BeforeInstallPromptEvent is not in standard TS lib
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

// localStorage keys
const STORAGE_KEYS = {
  RECENT_USERNAMES: "setuppwa-recent-usernames",
  LAST_USERNAME: "setuppwa-last-username",
} as const

const MAX_RECENT_USERNAMES = 5

type ValidationStatus = "valid" | "invalid" | null

export default function SetupPWAForm() {
  const router = useRouter()
  const { theme, setTheme } = useTheme()

  const [username, setUsername] = useState<string>("")
  const [validating, setValidating] = useState<boolean>(false)
  const [validationStatus, setValidationStatus] = useState<ValidationStatus>(null)
  const [error, setError] = useState<string | null>(null)
  const [recentUsernames, setRecentUsernames] = useState<string[]>([])

  // PWA install state
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(
    null,
  )
  const [isIOS, setIsIOS] = useState<boolean>(false)
  const [isStandalone, setIsStandalone] = useState<boolean>(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Determine if dark mode is active
  const isDark = theme === THEMES.DARK || theme === THEMES.BLINK_CLASSIC_DARK

  // Toggle between light and dark theme
  const toggleTheme = () => {
    setTheme(isDark ? THEMES.LIGHT : THEMES.DARK)
  }

  // Load recent usernames on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.RECENT_USERNAMES)
      if (stored) {
        const parsed: unknown = JSON.parse(stored)
        if (Array.isArray(parsed)) {
          setRecentUsernames((parsed as string[]).slice(0, MAX_RECENT_USERNAMES))
        }
      }
    } catch (err: unknown) {
      console.error("Failed to load recent usernames:", err)
    }
  }, [])

  // Detect iOS and standalone mode
  useEffect(() => {
    const checkIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream
    setIsIOS(checkIOS)

    const checkStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    setIsStandalone(checkStandalone)
  }, [])

  // Listen for beforeinstallprompt (Android/Chrome)
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }

    window.addEventListener("beforeinstallprompt", handler)
    return () => window.removeEventListener("beforeinstallprompt", handler)
  }, [])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /**
   * Normalize a typed identifier to a bare Blink username.
   * Accepts "username" or "username@<blink-domain>". A Blink domain is stripped;
   * a non-Blink domain is rejected (Public POS is Blink-only). Returns
   * { username } on success or { error } when the domain is not a Blink domain.
   */
  const normalizeBlinkUsername = useCallback(
    (raw: string): { username?: string; error?: string } => {
      const value = raw.trim().toLowerCase()
      if (!value.includes("@")) {
        return { username: value }
      }
      const parts = value.split("@")
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return { error: "Invalid username format" }
      }
      const [localpart, domain] = parts
      if (!getAllValidDomains().includes(domain)) {
        return {
          error: "Please enter a Blink username (e.g. yourname or yourname@blink.sv)",
        }
      }
      return { username: localpart }
    },
    [],
  )

  // Validate username against Blink API (debounced)
  // Returns true if the username is valid, false otherwise
  const validateUsername = useCallback(
    async (usernameToValidate: string): Promise<boolean> => {
      if (!usernameToValidate || usernameToValidate.length < 3) {
        setValidationStatus(null)
        setError(null)
        return false
      }

      // Accept bare username or username@<blink-domain>; reject other domains.
      const normalized = normalizeBlinkUsername(usernameToValidate)
      if (normalized.error || !normalized.username) {
        setValidationStatus("invalid")
        setError(normalized.error || "Invalid username")
        return false
      }

      setValidating(true)
      setError(null)

      try {
        // Resolve via custodial-first → LNURL fallback so self-custodial
        // (Spark) usernames — which have no custodial accountDefaultWallet —
        // are recognized as valid when their Lightning address resolves.
        const response = await fetch("/api/blink/resolve-receiver", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: normalized.username,
            environment: getEnvironment(),
          }),
        })

        const data = await response.json()

        if (response.ok && data.exists) {
          setValidationStatus("valid")
          setError(null)
          return true
        } else {
          setValidationStatus("invalid")
          setError("Username not found")
          return false
        }
      } catch (err: unknown) {
        console.error("Validation error:", err)
        setValidationStatus("invalid")
        setError("Failed to validate username")
        return false
      } finally {
        setValidating(false)
      }
    },
    [normalizeBlinkUsername],
  )

  // Handle input change with debounced validation
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.trim().toLowerCase()
    setUsername(value)
    setValidationStatus(null)
    setError(null)

    // Clear existing debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    // Debounce validation (500ms)
    if (value.length >= 3) {
      debounceRef.current = setTimeout(() => {
        validateUsername(value)
      }, 500)
    }
  }

  // Handle username chip click
  const handleChipClick = (chipUsername: string) => {
    setUsername(chipUsername)
    setValidationStatus("valid") // Assume valid since it was used before
    setError(null)
    inputRef.current?.focus()
  }

  // Clear recent usernames
  const handleClearRecent = () => {
    setRecentUsernames([])
    localStorage.removeItem(STORAGE_KEYS.RECENT_USERNAMES)
  }

  // Save username to recent list
  const saveToRecent = (usernameToSave: string) => {
    const filtered = recentUsernames.filter((u) => u !== usernameToSave)
    const updated = [usernameToSave, ...filtered].slice(0, MAX_RECENT_USERNAMES)
    setRecentUsernames(updated)
    localStorage.setItem(STORAGE_KEYS.RECENT_USERNAMES, JSON.stringify(updated))
    localStorage.setItem(STORAGE_KEYS.LAST_USERNAME, usernameToSave)
  }

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()

    const trimmedUsername = username.trim().toLowerCase()

    if (!trimmedUsername) {
      setError("Please enter a Blink username")
      return
    }

    // Normalize to a bare Blink username (strip @blink.sv; reject other domains)
    // so the public route /[blinkusername] receives a valid bare username and
    // does not 404 on an @-containing path.
    const normalized = normalizeBlinkUsername(trimmedUsername)
    if (normalized.error || !normalized.username) {
      setValidationStatus("invalid")
      setError(normalized.error || "Invalid username")
      return
    }
    const bareUsername = normalized.username

    // If not yet validated, validate first
    if (validationStatus !== "valid") {
      const isValid = await validateUsername(bareUsername)
      if (!isValid) {
        return
      }
    }

    // Save to recent usernames (store what the user typed for convenience)
    saveToRecent(trimmedUsername)

    // Theme persists via useTheme hook - no need to force

    // Navigate to Public POS using the bare username
    router.push(`/${bareUsername}`)
  }

  // Handle PWA install
  const handleInstallPWA = async () => {
    if (!deferredPrompt) return

    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice

    if (outcome === "accepted") {
      setDeferredPrompt(null)
    }
  }

  const canSubmit = username.length >= 3 && validationStatus === "valid" && !validating

  return (
    <div
      className={`min-h-screen flex flex-col transition-colors ${isDark ? "bg-black" : "bg-white"}`}
    >
      {/* Fixed header with clickable logo for theme toggle */}
      <div className="px-4 py-4">
        <button
          onClick={toggleTheme}
          className="focus:outline-none focus:ring-2 focus:ring-amber-500/50 rounded-lg p-1 -m-1 transition-transform hover:scale-105 active:scale-95"
          title={isDark ? "Switch to light mode" : "Switch to dark mode"}
        >
          <img
            src={isDark ? "/logos/blink-icon-dark.svg" : "/logos/blink-icon-light.svg"}
            alt="Blink - Click to toggle theme"
            className="h-12 w-12"
          />
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        {/* BlinkPOS Logo */}
        <div className="mb-8">
          <Image
            src={isDark ? "/logos/BlinkPOS-dark.svg" : "/logos/BlinkPOS.svg"}
            alt="Blink POS"
            width={200}
            height={45}
            priority
          />
        </div>

        {/* Subtitle */}
        <p
          className={`text-center mb-8 max-w-sm ${isDark ? "text-gray-400" : "text-gray-600"}`}
        >
          Enter your Blink username to start accepting Bitcoin payments
        </p>

        {/* Form */}
        <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-6">
          {/* Username Input */}
          <div>
            <label
              className={`block text-sm font-medium mb-2 ${isDark ? "text-gray-300" : "text-gray-700"}`}
            >
              Blink Username
            </label>
            <div className="relative">
              <input
                ref={inputRef}
                type="text"
                value={username}
                onChange={handleInputChange}
                placeholder="username"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck="false"
                data-1p-ignore="true"
                data-lpignore="true"
                className={`w-full px-4 py-3 pr-24 rounded-xl border-2 text-base transition-all ${
                  validationStatus === "valid"
                    ? isDark
                      ? "border-green-500 bg-green-900/30"
                      : "border-green-500 bg-green-50"
                    : validationStatus === "invalid"
                      ? isDark
                        ? "border-red-500 bg-red-900/30"
                        : "border-red-500 bg-red-50"
                      : isDark
                        ? "border-gray-700 bg-gray-900 focus:border-amber-500"
                        : "border-gray-200 bg-gray-50 focus:border-amber-500"
                } ${isDark ? "text-white placeholder-gray-500" : "text-gray-900 placeholder-gray-400"} focus:outline-none focus:ring-2 focus:ring-amber-500/20`}
              />

              {/* @blink.sv suffix */}
              <span
                className={`absolute right-4 top-1/2 -translate-y-1/2 text-sm pointer-events-none ${isDark ? "text-gray-500" : "text-gray-400"}`}
              >
                @blink.sv
              </span>

              {/* Validation indicator */}
              {validating && (
                <div className="absolute right-20 top-1/2 -translate-y-1/2">
                  <svg
                    className="w-5 h-5 animate-spin text-amber-500"
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
                </div>
              )}

              {validationStatus === "valid" && !validating && (
                <div className="absolute right-20 top-1/2 -translate-y-1/2">
                  <svg
                    className="w-5 h-5 text-green-500"
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
              )}

              {validationStatus === "invalid" && !validating && (
                <div className="absolute right-20 top-1/2 -translate-y-1/2">
                  <svg
                    className="w-5 h-5 text-red-500"
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
              )}
            </div>

            {/* Error message */}
            {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
          </div>

          {/* Recent Usernames */}
          {recentUsernames.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span
                  className={`text-sm font-medium ${isDark ? "text-gray-300" : "text-gray-700"}`}
                >
                  Recent
                </span>
                <button
                  type="button"
                  onClick={handleClearRecent}
                  className={`text-xs transition-colors ${isDark ? "text-gray-500 hover:text-gray-300" : "text-gray-400 hover:text-gray-600"}`}
                >
                  Clear
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {recentUsernames.map((recentUsername) => (
                  <button
                    key={recentUsername}
                    type="button"
                    onClick={() => handleChipClick(recentUsername)}
                    className={`px-3 py-1.5 rounded-full text-sm transition-all ${
                      username === recentUsername
                        ? isDark
                          ? "bg-amber-900/50 text-amber-400 border-2 border-amber-500"
                          : "bg-amber-100 text-amber-700 border-2 border-amber-300"
                        : isDark
                          ? "bg-gray-800 text-gray-300 border-2 border-transparent hover:bg-gray-700"
                          : "bg-gray-100 text-gray-700 border-2 border-transparent hover:bg-gray-200"
                    }`}
                  >
                    {recentUsername}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={!canSubmit}
            className={`w-full py-4 px-6 rounded-xl font-semibold text-base transition-all ${
              canSubmit
                ? "bg-gradient-to-r from-amber-400 to-orange-500 hover:from-amber-500 hover:to-orange-600 text-black shadow-lg shadow-amber-500/25"
                : isDark
                  ? "bg-gray-800 text-gray-500 cursor-not-allowed"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            Start Accepting Payments
          </button>
        </form>

        {/* PWA Install Section */}
        {!isStandalone && (
          <div className="mt-8 w-full max-w-sm">
            {/* Android/Chrome Install Button */}
            {deferredPrompt && (
              <button
                onClick={handleInstallPWA}
                className={`w-full py-3 px-4 rounded-xl font-medium text-sm transition-colors flex items-center justify-center gap-2 ${
                  isDark
                    ? "bg-gray-800 hover:bg-gray-700 text-gray-300"
                    : "bg-gray-100 hover:bg-gray-200 text-gray-700"
                }`}
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                  />
                </svg>
                Install App
              </button>
            )}

            {/* iOS Install Instructions */}
            {isIOS && !deferredPrompt && (
              <div
                className={`p-4 rounded-xl border ${isDark ? "bg-gray-900 border-gray-700" : "bg-gray-50 border-gray-200"}`}
              >
                <p
                  className={`text-sm text-center ${isDark ? "text-gray-400" : "text-gray-600"}`}
                >
                  <span className="font-medium">Install this app:</span> Tap{" "}
                  <svg
                    className="inline w-4 h-4 text-blue-500"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M16 5l-1.42 1.42-1.59-1.59V16h-1.98V4.83L9.42 6.42 8 5l4-4 4 4zm4 5v11c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V10c0-1.11.89-2 2-2h3v2H6v11h12V10h-3V8h3c1.1 0 2 .89 2 2z" />
                  </svg>{" "}
                  then <span className="font-medium">&quot;Add to Home Screen&quot;</span>
                </p>
              </div>
            )}
          </div>
        )}

        {/* Sign in link */}
        <div className="mt-8">
          <Link
            href="/signin"
            className={`text-sm transition-colors ${isDark ? "text-gray-500 hover:text-gray-300" : "text-gray-500 hover:text-gray-700"}`}
          >
            Sign in for full features
          </Link>
        </div>
      </div>

      {/* Footer */}
      <div className="py-6 text-center">
        <p className={`text-xs ${isDark ? "text-gray-600" : "text-gray-400"}`}>
          Powered by Blink
        </p>
      </div>
    </div>
  )
}
