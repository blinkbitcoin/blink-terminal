import { useRouter } from "next/router"
import { useEffect } from "react"

import { useCombinedAuth } from "../lib/hooks/useCombinedAuth"

/**
 * Sign In Page - Dedicated Nostr authentication
 *
 * URL: /signin
 *
 * The sign-in entry point is temporarily disabled: all visitors are redirected
 * away (authenticated users to their destination, everyone else to /setuppwa),
 * so the login form is not rendered. Restore the original redirect logic and the
 * links in SetupPWAForm / PublicPOS overlays to re-enable sign-in.
 */
export default function SignIn() {
  const router = useRouter()
  const { loading, isAuthenticated } = useCombinedAuth()
  const { redirect } = router.query

  // Redirect all visitors away from the sign-in page while it is disabled.
  // Authenticated users go to their destination; everyone else to Public POS.
  useEffect(() => {
    if (loading) return
    if (isAuthenticated) {
      const destination = redirect && typeof redirect === "string" ? redirect : "/"
      router.replace(destination)
    } else {
      router.replace("/setuppwa")
    }
  }, [loading, isAuthenticated, redirect, router])

  // Always show a spinner: the page only ever redirects while sign-in is disabled.
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-black">
      <div className="animate-spin rounded-full h-12 w-12 border-4 border-amber-500 border-t-transparent"></div>
    </div>
  )
}
