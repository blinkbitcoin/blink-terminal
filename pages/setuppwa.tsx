import Head from "next/head"

import SetupPWAForm from "../components/SetupPWAForm"
import { useTheme, THEMES } from "../lib/hooks/useTheme"

/**
 * PWA Setup Page - Entry point for Public POS
 *
 * URL: /setuppwa (matching pay.blink.sv/setuppwa)
 *
 * Features:
 * - Dark/light theme toggle (click top-left Blink icon)
 * - Enter Blink username to access Public POS
 * - PWA install prompts (Android/iOS)
 * - Recent usernames list with choice (no auto-redirect)
 *
 * User Journey:
 * - New users and returning users see this page
 * - PWA users also see this page to choose from recent usernames
 * - Users can sign in for full features via /signin link
 */
export default function SetupPWA() {
  const { theme } = useTheme()

  // Determine if dark mode
  const isDark = theme === THEMES.DARK || theme === THEMES.BLINK_CLASSIC_DARK

  return (
    <>
      <Head>
        <title>Blink Cash Register</title>
        <meta name="description" content="Set up your Blink Bitcoin Point of Sale" />
        <meta name="theme-color" content={isDark ? "#000000" : "#ffffff"} />
        <link rel="icon" href="/icons/icon-ios-192x192.png" />
        <link rel="apple-touch-icon" href="/icons/icon-ios-192x192.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content={isDark ? "black" : "default"}
        />
        <meta name="apple-mobile-web-app-title" content="Blink POS" />
      </Head>

      <SetupPWAForm />
    </>
  )
}
