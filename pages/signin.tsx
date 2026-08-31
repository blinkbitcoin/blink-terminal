import Head from "next/head"
import Link from "next/link"
import { useRouter } from "next/router"
import { useEffect } from "react"

import NostrLoginForm from "../components/auth/NostrLoginForm"
import { safeInternalRedirect } from "../lib/auth/safe-redirect"
import { useCombinedAuth } from "../lib/hooks/useCombinedAuth"

/**
 * Sign In Page - Dedicated Nostr authentication
 *
 * URL: /signin
 *
 * Features:
 * - Renders NostrLoginForm for Nostr authentication
 * - Redirects authenticated users to /
 * - Shows "Back to Public POS" link for users who changed their mind
 * - Accepts optional ?redirect= query param for post-auth navigation
 */
export default function SignIn() {
  const router = useRouter()
  const { loading, isAuthenticated } = useCombinedAuth()
  const { redirect } = router.query

  // Redirect authenticated users away from sign-in page. The ?redirect= target
  // is validated to a safe same-origin path (and never back to /signin) to
  // avoid open redirects and redirect loops — see lib/auth/safe-redirect.
  useEffect(() => {
    if (!loading && isAuthenticated) {
      router.replace(safeInternalRedirect(redirect))
    }
  }, [loading, isAuthenticated, redirect, router])

  // Show loading while checking auth or redirecting
  if (loading || isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-black">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-amber-500 border-t-transparent"></div>
      </div>
    )
  }

  return (
    <>
      <Head>
        <title>Sign In | Blink Bitcoin Terminal</title>
        <meta name="description" content="Sign in to Blink Bitcoin Terminal with Nostr" />
        <meta name="theme-color" content="#000000" />
        <link rel="icon" href="/icons/icon-ios-192x192.png" />
        <link rel="apple-touch-icon" href="/icons/icon-ios-192x192.png" />
        {/* Viewport is set globally in _app.tsx (includes viewport-fit=cover for
            iOS safe-area). Do not duplicate it here — a partial override would
            regress notch handling. */}
      </Head>

      {/* Remote logging (mobile, dev-only) is initialized globally in _app.tsx;
          no per-page logger script is needed here. */}

      <div className="min-h-screen bg-gray-50 dark:bg-black">
        {/* Nostr Login Form */}
        <NostrLoginForm />

        {/* Back to Public POS Link */}
        <div className="fixed bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-gray-50 dark:from-black to-transparent">
          <div className="max-w-md mx-auto text-center">
            <Link
              href="/setuppwa"
              className="inline-flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-amber-500 transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M10 19l-7-7m0 0l7-7m-7 7h18"
                />
              </svg>
              Back to Public POS
            </Link>
          </div>
        </div>
      </div>
    </>
  )
}
