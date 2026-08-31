import Link from "next/link"

import { isStaging } from "../../lib/config/api"

/**
 * PublicPOSValidationOverlay - Displays validation error or loading spinner
 *
 * Shows a full-screen overlay when:
 * - Username validation is in progress (loading spinner)
 * - Username validation failed (error with environment info and action buttons)
 */

interface ValidationError {
  environment: "staging" | "production"
  message: string
  suggestion: string
  canSwitchEnv: boolean
}

interface PublicPOSValidationOverlayProps {
  validationError: ValidationError | null
  validating: boolean
  darkMode: boolean
}

export default function PublicPOSValidationOverlay({
  validationError,
  validating,
  darkMode,
}: PublicPOSValidationOverlayProps) {
  if (!validationError && !validating) return null

  return (
    <>
      {/* Username Validation Error */}
      {validationError && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4">
          <div
            className={`max-w-md w-full p-6 rounded-xl ${darkMode ? "bg-gray-900" : "bg-white"} shadow-2xl`}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0">
                <svg
                  className="w-6 h-6 text-red-500"
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
              <div>
                <h2 className="text-xl font-bold text-red-500">User Not Found</h2>
                <p className={`text-xs ${darkMode ? "text-gray-400" : "text-gray-500"}`}>
                  {validationError.environment === "staging"
                    ? "Staging/Signet"
                    : "Production/Mainnet"}
                </p>
              </div>
            </div>

            <p
              className={`text-sm leading-relaxed ${darkMode ? "text-gray-300" : "text-gray-600"}`}
            >
              {validationError.message}
            </p>
            <p className={`text-sm mt-2 ${darkMode ? "text-gray-400" : "text-gray-500"}`}>
              {validationError.suggestion}
            </p>

            <div className="mt-6 flex gap-3">
              {validationError.canSwitchEnv && (
                <Link
                  href="/signin"
                  className="flex-1 px-4 py-2 text-center rounded-lg bg-blink-accent hover:bg-blue-600 text-white text-sm font-medium transition-colors"
                >
                  Switch Environment
                </Link>
              )}
              <Link
                href="/setuppwa"
                className={`flex-1 px-4 py-2 text-center rounded-lg text-sm font-medium transition-colors ${
                  darkMode
                    ? "bg-gray-800 hover:bg-gray-700 text-white"
                    : "bg-gray-200 hover:bg-gray-300 text-gray-900"
                }`}
              >
                Change User
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Validation Loading */}
      {validating && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div
              className={`animate-spin rounded-full h-12 w-12 border-4 ${isStaging() ? "border-orange-500" : "border-blink-accent"} border-t-transparent`}
            ></div>
            <p className="text-white text-sm">Validating user...</p>
          </div>
        </div>
      )}
    </>
  )
}
