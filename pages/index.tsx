import { useRouter } from "next/router"
import { useState, useEffect, useRef } from "react"

import SessionEstablishmentModal from "../components/auth/SessionEstablishmentModal"
import Dashboard from "../components/Dashboard"
import WalletSetup from "../components/wallet/WalletSetup"
import { useCombinedAuth } from "../lib/hooks/useCombinedAuth"

/**
 * Home Page - Smart router based on authentication state
 *
 * Authentication States:
 * 1. Loading: Show spinner while checking auth
 * 2. Not authenticated: Redirect to /setuppwa
 * 3. Nostr auth but no wallet (Blink or NWC): Show WalletSetup
 * 4. Fully authenticated with wallet: Show Dashboard
 *
 * User Journey:
 * - Unauthenticated users (including after logout) are redirected to /setuppwa
 *   (the Public POS entry point) — NOT directly to /signin, by design.
 * - From /setuppwa (and the public /[username] page) users can reach /signin
 *   to sign in for full features.
 * - Authenticated users see Dashboard or WalletSetup
 */
export default function Home() {
  const router = useRouter()
  const {
    loading,
    isAuthenticated,
    authMode,
    needsWalletSetup,
    hasNWC,
    hasBlinkAccount: _hasBlinkAccount,
    user: _user,
    publicKey,
    hasServerSession,
    establishServerSession,
    logout,
    _nostr,
  } = useCombinedAuth()

  // Track wallet setup completion to force re-render
  // This is needed because useNWC state is per-component
  const [walletSetupComplete, setWalletSetupComplete] = useState(false)

  // Track if we're redirecting to prevent flash
  const [redirecting, setRedirecting] = useState(false)

  // Track if session establishment modal is showing (controls own lifecycle)
  // This allows the modal to show all steps even after hasServerSession becomes true
  const [showSessionModal, setShowSessionModal] = useState(false)

  // Track the previous user to detect user changes
  const prevUserRef = useRef<string | null>(publicKey)

  // Reset walletSetupComplete when user changes (including logout/login)
  useEffect(() => {
    if (prevUserRef.current !== publicKey) {
      console.log(
        "[Home] User changed from",
        prevUserRef.current?.slice(0, 8),
        "to",
        publicKey?.slice(0, 8),
        "- resetting walletSetupComplete",
      )
      setWalletSetupComplete(false)
      prevUserRef.current = publicKey
    }
  }, [publicKey])

  // Show session modal when Nostr auth but no server session yet
  // The modal controls its own lifecycle and calls onComplete when done
  useEffect(() => {
    if (authMode === "nostr" && !hasServerSession && !showSessionModal) {
      console.log("[Home] Nostr auth but no server session - showing session modal")
      setShowSessionModal(true)
    }
  }, [authMode, hasServerSession, showSessionModal])

  // Redirect unauthenticated users to /setuppwa
  useEffect(() => {
    if (!loading && !isAuthenticated) {
      console.log("[Home] Not authenticated - redirecting to /setuppwa")
      setRedirecting(true)
      router.replace("/setuppwa")
    }
  }, [loading, isAuthenticated, router])

  console.log(
    "Home render - loading:",
    loading,
    "authenticated:",
    isAuthenticated,
    "authMode:",
    authMode,
    "needsWalletSetup:",
    needsWalletSetup,
    "hasNWC:",
    hasNWC,
    "walletSetupComplete:",
    walletSetupComplete,
    "hasServerSession:",
    hasServerSession,
    "showSessionModal:",
    showSessionModal,
  )

  // Loading state or redirecting
  if (loading || redirecting || !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-black">
        <div className="text-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blink-accent mx-auto"></div>
          <p className="mt-4 text-gray-600 dark:text-gray-400">
            {loading ? "Loading authentication..." : "Redirecting..."}
          </p>
        </div>
      </div>
    )
  }

  // Nostr authenticated but session establishment modal is showing
  // The modal controls its own lifecycle - it will call onComplete when all steps finish
  if (showSessionModal) {
    return (
      <SessionEstablishmentModal
        hasServerSession={hasServerSession}
        signInMethod={(_nostr?.method || "extension") as "extension" | "externalSigner"}
        onComplete={() => {
          console.log("[Home] Session modal complete - hiding modal")
          setShowSessionModal(false)
        }}
        onRetry={() => {
          // Trigger NIP-98 login retry
          console.log("[Home] Retrying session establishment...")
          establishServerSession?.()
        }}
        onCancel={() => {
          // Sign out and redirect to signin
          console.log("[Home] User cancelled - signing out")
          setShowSessionModal(false)
          logout()
        }}
      />
    )
  }

  // Nostr authenticated but needs wallet setup (Blink OR NWC)
  // Check both needsWalletSetup AND !walletSetupComplete to handle state update race condition
  if (needsWalletSetup && !walletSetupComplete) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-black p-4">
        <WalletSetup
          onComplete={(result) => {
            console.log("Wallet added successfully:", result.type)
            // Force re-render to show Dashboard
            setWalletSetupComplete(true)
          }}
          onSkip={() => {
            // Allow skipping - user can add later from settings
            console.log("User skipped wallet setup")
            setWalletSetupComplete(true)
          }}
        />
      </div>
    )
  }

  // Fully authenticated with wallet - show dashboard
  return <Dashboard />
}
