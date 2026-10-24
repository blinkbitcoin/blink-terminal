/**
 * Boltcard Balance Check Page
 *
 * Public page for cardholders to check their Boltcard balance
 * using Web NFC on Android Chrome.
 *
 * URL: /boltcard-check
 *
 * Features:
 * - Web NFC support detection
 * - NFC tap to read card URL
 * - Balance display with transactions
 * - Fallback QR code for unsupported browsers
 *
 * No login required - authentication is via card tap (p/c params)
 */

import Head from "next/head"

import WebNFCBalanceCheck from "../components/boltcard/WebNFCBalanceCheck"

export default function BoltcardCheckPage() {
  return (
    <>
      <Head>
        <title>Check Boltcard Balance</title>
        <meta name="description" content="Tap your Boltcard to check your balance" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"
        />

        {/* PWA / Mobile optimization */}
        <meta name="theme-color" content="#000000" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />

        {/* Open Graph */}
        <meta property="og:title" content="Check Boltcard Balance" />
        <meta
          property="og:description"
          content="Tap your Boltcard to instantly check your balance"
        />
        <meta property="og:type" content="website" />
      </Head>

      <WebNFCBalanceCheck />
    </>
  )
}
