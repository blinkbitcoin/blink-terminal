/**
 * BlinkAccountSetup - Component to add Blink API key
 *
 * This component is used for connecting a Blink account via API key,
 * providing full features including transaction history.
 */

import { useState } from "react"

import { getApiUrl, isStaging } from "../../lib/config/api"
import { useCombinedAuth } from "../../lib/hooks/useCombinedAuth"
import { useNostrAuth } from "../../lib/hooks/useNostrAuth"
import { useProfile } from "../../lib/hooks/useProfile"
import { useTheme } from "../../lib/hooks/useTheme"

interface BlinkAccountSetupProps {
  onComplete?: (account: BlinkAccount) => void
  onSkip?: () => void
}

/** Locally-created Blink account object returned from addBlinkAccount */
interface BlinkAccount {
  id: string
  label: string
  username?: string
  defaultCurrency?: string
  [key: string]: unknown
}

interface ValidationResult {
  valid: boolean
  error?: string
  username?: string
  defaultCurrency?: string
}

export default function BlinkAccountSetup({
  onComplete,
  onSkip,
}: BlinkAccountSetupProps) {
  const { addBlinkAccount, loading, refreshProfile } = useProfile()
  const { refreshProfile: refreshAuthProfile } = useNostrAuth()
  const { storeBlinkAccountOnServer } = useCombinedAuth()
  const { darkMode } = useTheme()

  const [apiKey, setApiKey] = useState<string>("")
  const [label, setLabel] = useState<string>("My Blink Account")
  const [error, setError] = useState<string | null>(null)
  const [validating, setValidating] = useState<boolean>(false)
  const [pasting, setPasting] = useState<boolean>(false)

  const handlePasteFromClipboard = async () => {
    setPasting(true)
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText()
        if (text.trim()) {
          setApiKey(text.trim())
          setError(null)
        } else {
          setError("Clipboard is empty")
        }
      } else {
        setError("Clipboard access not supported")
      }
    } catch (err: unknown) {
      console.error("Paste error:", err)
      setError("Failed to read from clipboard. Please paste manually.")
    } finally {
      setPasting(false)
    }
  }

  const validateApiKey = async (key: string): Promise<ValidationResult> => {
    try {
      const response = await fetch(getApiUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": key,
        },
        body: JSON.stringify({
          query: "query { me { id username defaultAccount { displayCurrency } } }",
        }),
      })

      // Check HTTP status before parsing JSON
      if (!response.ok) {
        console.error("API request failed with status:", response.status)
        return {
          valid: false,
          error:
            response.status === 401
              ? "Invalid API key"
              : `API request failed (${response.status})`,
        }
      }

      const data = await response.json()

      if (data.errors || !data.data?.me?.id) {
        return { valid: false, error: "Invalid API key" }
      }

      return {
        valid: true,
        username: data.data.me.username,
        defaultCurrency: data.data.me.defaultAccount?.displayCurrency || "BTC",
      }
    } catch (err: unknown) {
      console.error("API validation error:", err)
      return { valid: false, error: "Failed to validate API key" }
    }
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()

    if (!apiKey.trim()) {
      setError("Please enter your Blink API key")
      return
    }

    setValidating(true)
    setError(null)

    // Validate API key with Blink
    const validation = await validateApiKey(apiKey)

    if (!validation.valid) {
      setError(validation.error || "Invalid API key")
      setValidating(false)
      return
    }

    // Add the Blink account to local storage (encrypted)
    const result = await addBlinkAccount({
      label: label.trim() || "My Blink Account",
      apiKey: apiKey.trim(),
      username: validation.username ?? "",
      defaultCurrency: validation.defaultCurrency ?? "BTC",
    })

    // Also store on server for cross-device sync
    if (result.success) {
      try {
        const serverResult = await storeBlinkAccountOnServer(
          apiKey.trim(),
          validation.defaultCurrency ?? "BTC",
          label,
        )

        if (serverResult.success) {
          console.log("[BlinkAccountSetup] ✓ Blink account stored on server")
        }
      } catch (serverError: unknown) {
        console.warn("[BlinkAccountSetup] Server storage error:", serverError)
      }
    }

    setValidating(false)

    if (result.success && result.account) {
      refreshProfile()
      refreshAuthProfile()
      onComplete?.(result.account as unknown as BlinkAccount)
    } else {
      setError(result.error || "Failed to save account")
    }
  }

  return (
    <div
      className={`rounded-2xl p-6 ${darkMode ? "bg-gray-800" : "bg-white"} shadow-xl max-w-md mx-auto`}
    >
      {/* Header */}
      <div className="text-center mb-6">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-gray-500 to-gray-700 mb-4">
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
        <h2 className={`text-xl font-bold ${darkMode ? "text-white" : "text-gray-900"}`}>
          Connect via API Key
        </h2>
        <p className={`mt-2 text-sm ${darkMode ? "text-gray-400" : "text-gray-600"}`}>
          Full features including transaction history
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
        {/* Account Label */}
        <div>
          <label
            className={`block text-sm font-medium mb-2 ${darkMode ? "text-gray-300" : "text-gray-700"}`}
          >
            Wallet Name
          </label>
          <input
            type="text"
            value={label}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setLabel(e.target.value)
            }
            placeholder="My Blink Account"
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            className={`w-full px-4 py-3 rounded-xl border-2 text-sm transition-colors ${
              darkMode
                ? "bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:border-gray-400"
                : "bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-gray-400"
            } focus:outline-none focus:ring-2 focus:ring-gray-400/20`}
          />
        </div>

        {/* API Key */}
        <div>
          <label
            className={`block text-sm font-medium mb-2 ${darkMode ? "text-gray-300" : "text-gray-700"}`}
          >
            Blink API Key
            <span
              className={`font-normal ml-1 ${darkMode ? "text-gray-500" : "text-gray-400"}`}
            >
              (READ + RECEIVE scopes)
            </span>
          </label>
          <div className="relative">
            <input
              type="password"
              value={apiKey}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setApiKey(e.target.value)
              }
              placeholder={isStaging() ? "galoy_staging_..." : "blink_..."}
              required
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              className={`w-full px-4 py-3 pr-12 rounded-xl border-2 text-sm transition-colors ${
                darkMode
                  ? "bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:border-gray-400"
                  : "bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-gray-400"
              } focus:outline-none focus:ring-2 focus:ring-gray-400/20`}
            />
            <button
              type="button"
              onClick={handlePasteFromClipboard}
              disabled={pasting}
              className={`absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg transition-colors ${
                darkMode
                  ? "text-gray-400 hover:text-white hover:bg-gray-600"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-200"
              }`}
              title="Paste from clipboard"
            >
              {pasting ? (
                <svg
                  className="w-5 h-5 animate-spin"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              ) : (
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
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20">
            <p className="text-sm text-red-500">{error}</p>
          </div>
        )}

        {/* Submit Button */}
        <button
          type="submit"
          disabled={loading || validating}
          className={`w-full py-3 px-4 rounded-xl font-medium transition-all ${
            loading || validating
              ? `${darkMode ? "bg-gray-700 text-gray-500" : "bg-gray-200 text-gray-400"} cursor-not-allowed`
              : "bg-gradient-to-r from-gray-600 to-gray-700 hover:from-gray-700 hover:to-gray-800 text-white shadow-lg"
          }`}
        >
          {validating ? (
            <span className="flex items-center justify-center gap-2">
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
              Connecting...
            </span>
          ) : (
            "Connect Account"
          )}
        </button>

        {/* Skip Link */}
        {onSkip && (
          <div className="text-center">
            <button
              type="button"
              onClick={onSkip}
              className={`text-sm ${darkMode ? "text-gray-500 hover:text-gray-400" : "text-gray-400 hover:text-gray-600"}`}
            >
              Skip for now
            </button>
          </div>
        )}
      </form>

      {/* Info Section */}
      <div
        className={`mt-6 pt-6 border-t ${darkMode ? "border-gray-700" : "border-gray-200"}`}
      >
        <h3
          className={`text-sm font-medium mb-2 ${darkMode ? "text-gray-300" : "text-gray-700"}`}
        >
          How to get your API key:
        </h3>
        <ol
          className={`space-y-2 text-sm ${darkMode ? "text-gray-500" : "text-gray-500"}`}
        >
          <li className="flex items-start gap-2">
            <span className="font-medium">1.</span>
            <span>
              Go to{" "}
              <a
                href="https://dashboard.blink.sv"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blink-accent hover:underline"
              >
                dashboard.blink.sv
              </a>
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-medium">2.</span>
            <span>Navigate to API Keys section</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-medium">3.</span>
            <span>Create a key with READ + RECEIVE scopes</span>
          </li>
        </ol>
        <p className={`mt-3 text-xs ${darkMode ? "text-gray-500" : "text-gray-400"}`}>
          🔐 Your API key is encrypted and stored securely on your device
        </p>
      </div>
    </div>
  )
}
