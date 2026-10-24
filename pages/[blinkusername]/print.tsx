import type { GetServerSideProps } from "next"
import Head from "next/head"

import PrintPaycodeView from "../../components/PublicPOS/PrintPaycodeView"

/**
 * Printable Static QR Page - Pay any Blink user via a static LNURL paycode
 *
 * URL: terminal.blinkbtc.com/[blinkusername]/print
 *
 * Printable static-QR page styled to match the Terminal design. Works for both
 * custodial and self-custodial (Spark) usernames — the encoded LNURL resolves
 * server-side to whichever backend owns the identifier. The human-facing web
 * fallback URL points at the Terminal app origin (terminal.blinkbtc.com).
 *
 * Environment Handling (mirrors pages/[blinkusername]/index.tsx):
 * - SSR only does basic format validation (no API calls)
 * - Client-side validates username against the correct API (production/staging)
 */

interface PrintPageProps {
  username: string
}

export const getServerSideProps: GetServerSideProps<PrintPageProps> = async (context) => {
  const { blinkusername } = context.params as { blinkusername: string }

  // Basic username validation (alphanumeric + underscore, 3-50 chars)
  const usernameRegex = /^[a-zA-Z0-9_]{3,50}$/
  if (!usernameRegex.test(blinkusername)) {
    return { notFound: true }
  }

  // Normalize to lowercase: Blink usernames are lowercase and resolution is
  // case-sensitive. The printed QR uppercases its value for compactness, so the
  // web-fallback URL can arrive here as e.g. /ALICE — canonicalize before use.
  return {
    props: {
      username: blinkusername.toLowerCase(),
    },
  }
}

export default function PrintPage({ username }: PrintPageProps) {
  return (
    <>
      <Head>
        <title>Print — Pay {username} | Blink Bitcoin Terminal</title>
        <meta
          name="description"
          content={`Printable static QR code to pay ${username} with Bitcoin Lightning`}
        />
        <meta
          name="theme-color"
          content="#ffffff"
          media="(prefers-color-scheme: light)"
        />
        <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
        <link rel="icon" href="/icons/icon-ios-192x192.png" />
        <link rel="apple-touch-icon" href="/icons/icon-ios-192x192.png" />
      </Head>

      <PrintPaycodeView username={username} />
    </>
  )
}
