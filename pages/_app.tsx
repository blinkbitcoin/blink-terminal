import "../styles/globals.css"
import type { AppProps } from "next/app"
import Head from "next/head"
import { useEffect } from "react"

import StagingBanner from "../components/StagingBanner"
import { initRemoteLogger } from "../lib/debug/remoteLogger"
import { AuthProvider } from "../lib/hooks/useAuth"
import { NostrAuthProvider } from "../lib/hooks/useNostrAuth"
import { ProfileProvider } from "../lib/hooks/useProfile"

/**
 * BlinkPOS App - Supports dual authentication methods:
 *
 * 1. Legacy Auth (AuthProvider): API key-based authentication
 *    - Used by existing users who signed up with Blink API key
 *    - Stored server-side with encrypted credentials
 *
 * 2. Nostr Auth (NostrAuthProvider + ProfileProvider): Nostr-based authentication
 *    - Sign in with browser extension (keys.band, Alby) or external signer (Amber)
 *    - Credentials encrypted and stored locally (device-key encryption)
 *    - Supports multiple Blink accounts and NWC connections per profile
 *
 * Provider Hierarchy:
 *   AuthProvider (legacy)
 *     └── NostrAuthProvider (new)
 *           └── ProfileProvider (profile/credential management)
 *                 └── Component
 */
function MyApp({ Component, pageProps }: AppProps) {
  useEffect(() => {
    // Only run on client side to prevent hydration mismatch
    if (typeof window === "undefined") return

    // Initialize remote logging for mobile devices to debug NIP-46 WebSocket issues
    // This sends console logs to /api/debug/remote-log for real-time viewing on desktop
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    const isAndroid = /Android/.test(navigator.userAgent)
    const isMobile = isIOS || isAndroid

    // Enable for mobile devices during debugging (dev only — the endpoint
    // doesn't exist in production and the logger polls every 500ms forever)
    if (isMobile && process.env.NODE_ENV !== "production") {
      try {
        const result = initRemoteLogger()
        console.log("[App] v39: Remote logging enabled, device:", result?.deviceId)
      } catch (_e) {
        // Silent fail if remote logger has issues
      }
    }

    // Global error handler for WebSocket/relay connection errors
    // These are expected when internet drops and shouldn't crash the app
    const handleError = (event: ErrorEvent) => {
      const error = event.error || event
      const errorMessage = error?.message || String(error)

      // Suppress nostr relay connection errors (expected on network loss)
      if (
        errorMessage.includes("relay connection closed") ||
        errorMessage.includes("WebSocket") ||
        errorMessage.includes("Failed to fetch") ||
        errorMessage.includes("NetworkError") ||
        errorMessage.includes("Network request failed")
      ) {
        console.warn("[Network] Connection error (suppressed):", errorMessage)
        event.preventDefault?.()
        return true
      }
    }

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const errorMessage = event.reason?.message || String(event.reason)

      // Suppress nostr relay connection errors
      if (
        errorMessage.includes("relay connection closed") ||
        errorMessage.includes("WebSocket") ||
        errorMessage.includes("Failed to fetch") ||
        errorMessage.includes("NetworkError") ||
        errorMessage.includes("Network request failed")
      ) {
        console.warn("[Network] Promise rejection (suppressed):", errorMessage)
        event.preventDefault()
        return
      }
    }

    window.addEventListener("error", handleError)
    window.addEventListener("unhandledrejection", handleUnhandledRejection)

    // Initialize theme (supports dark, blink-classic-dark, light, blink-classic-light)
    // Migrate from old 'darkMode' boolean to new 'theme' string
    const legacyDarkMode = localStorage.getItem("darkMode")
    let savedTheme = localStorage.getItem("theme")

    // Migrate old 'blink-classic' to 'blink-classic-dark'
    if (savedTheme === "blink-classic") {
      savedTheme = "blink-classic-dark"
      localStorage.setItem("theme", savedTheme)
    }

    const validThemes = ["dark", "blink-classic-dark", "light", "blink-classic-light"]
    let theme: string
    if (savedTheme && validThemes.includes(savedTheme)) {
      theme = savedTheme
    } else if (legacyDarkMode !== null) {
      // Migrate from legacy darkMode
      theme = legacyDarkMode === "true" ? "dark" : "light"
      localStorage.setItem("theme", theme)
      localStorage.removeItem("darkMode")
    } else {
      // Default to dark mode
      theme = "dark"
      localStorage.setItem("theme", theme)
    }

    // Apply theme class
    document.documentElement.classList.remove(
      "dark",
      "light",
      "blink-classic",
      "blink-classic-dark",
      "blink-classic-light",
    )
    document.documentElement.classList.add(theme)
    // Add 'dark' class for Tailwind dark mode on dark themes
    if (theme === "dark" || theme === "blink-classic-dark") {
      document.documentElement.classList.add("dark")
    }

    // Register service worker for PWA functionality (DISABLED IN DEVELOPMENT)
    // Service Workers aggressively cache files which breaks hot reload during development
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          console.log("Service Worker registered successfully:", registration)
        })
        .catch((error) => {
          console.log("Service Worker registration failed:", error)
        })
    } else if ("serviceWorker" in navigator && process.env.NODE_ENV === "development") {
      // Unregister any existing service workers in development
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const registration of registrations) {
          registration.unregister()
          console.log("Development mode: Service Worker unregistered")
        }
      })
    }

    // Force reload for mobile browsers if this is a cached version (preserve PWA cache)
    const lastUpdate = localStorage.getItem("lastUpdate")
    const currentVersion = "2025-11-27-v5-nostr-auth" // Update this when you deploy

    if (lastUpdate !== currentVersion) {
      localStorage.setItem("lastUpdate", currentVersion)
      if (lastUpdate && window.location.reload) {
        // Clear only specific non-PWA caches to preserve install functionality
        if ("caches" in window) {
          caches.keys().then((names) => {
            for (const name of names) {
              // Don't delete the service worker cache (PWA cache)
              if (!name.includes("blink-tracker") && !name.includes("workbox")) {
                caches.delete(name)
              }
            }
          })
        }
        window.location.reload()
      }
    }

    // Cleanup event listeners
    return () => {
      window.removeEventListener("error", handleError)
      window.removeEventListener("unhandledrejection", handleUnhandledRejection)
    }
  }, [])

  return (
    <>
      <Head>
        <meta httpEquiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
        <meta httpEquiv="Pragma" content="no-cache" />
        <meta httpEquiv="Expires" content="0" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
        />
      </Head>
      {/* Staging environment indicator banner */}
      <StagingBanner />
      {/* Legacy auth provider for existing API-key users */}
      <AuthProvider>
        {/* New Nostr auth provider for extension/signer login */}
        <NostrAuthProvider>
          {/* Profile management (Blink accounts, NWC, settings) */}
          <ProfileProvider>
            <Component {...pageProps} />
          </ProfileProvider>
        </NostrAuthProvider>
      </AuthProvider>
    </>
  )
}

export default MyApp
