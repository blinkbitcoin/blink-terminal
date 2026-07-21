import type { GetServerSideProps } from "next"
import Head from "next/head"

import PublicPOSDashboard from "../../components/PublicPOSDashboard"

/**
 * Public POS Page - Pay any Blink user directly
 *
 * URL: terminal.blinkbtc.com/[blinkusername]
 *
 * Features:
 * - No authentication required
 * - Creates invoices directly to user's Blink wallet
 * - Same design as authenticated POS (dark/light modes, numpad, etc.)
 * - Only Cart and POS views (no transaction history)
 * - Limited menu (Display Currency, Paycodes, Sound Effects)
 *
 * Environment Handling:
 * - SSR only does basic format validation (no API calls)
 * - Client-side validates username against the correct API (production or staging)
 * - This allows staging-only users (like "wurst") to work when staging is enabled
 */

interface PublicPOSPageProps {
  username: string
}

// SSR: Only validate username format, not existence
// Username validation against Blink API happens client-side
// This is necessary because:
// 1. SSR can't access localStorage to know if staging is enabled
// 2. A user might exist on staging but not mainnet (or vice versa)
// 3. Client-side can check the correct environment and show appropriate errors
export const getServerSideProps: GetServerSideProps<PublicPOSPageProps> = async (
  context,
) => {
  const { blinkusername } = context.params as { blinkusername: string }

  // Basic username validation (alphanumeric + underscore, 3-50 chars)
  // Blink allows up to 50 characters for usernames
  const usernameRegex = /^[a-zA-Z0-9_]{3,50}$/
  if (!usernameRegex.test(blinkusername)) {
    return { notFound: true }
  }

  // Pass username to client - validation happens there
  return {
    props: {
      username: blinkusername,
      // walletCurrency will be determined client-side after validation
    },
  }
}

export default function PublicPOS({ username }: PublicPOSPageProps) {
  return (
    <>
      <Head>
        <title>Pay {username} | Blink Bitcoin Terminal</title>
        <meta name="description" content={`Pay ${username} with Bitcoin Lightning`} />
        <meta
          name="theme-color"
          content="#ffffff"
          media="(prefers-color-scheme: light)"
        />
        <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
        <link rel="icon" href="/icons/icon-ios-192x192.png" />
        <link rel="apple-touch-icon" href="/icons/icon-ios-192x192.png" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"
        />
      </Head>

      <PublicPOSDashboard username={username} />
    </>
  )
}
