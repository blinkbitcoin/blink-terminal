/**
 * Cardholder Balance Page - Public balance check for card holders
 *
 * URL: /card/{cardId}?p={piccData}&c={sunMac}
 *
 * This page is accessed when:
 * 1. User taps their Boltcard and opens the URL in a browser
 * 2. Browser is redirected here from /api/boltcard/lnurlw/{cardId}
 *
 * No login required - card tap authenticates the user.
 */

import Head from "next/head"
import { useRouter } from "next/router"
import { useState, useEffect } from "react"

import CardholderBalance, {
  type CardholderBalanceData,
} from "../../components/boltcard/CardholderBalance"

export default function CardholderPage() {
  const router = useRouter()
  const { cardId, p: piccData, c: sunMac } = router.query

  const [data, setData] = useState<CardholderBalanceData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Fetch balance when params are available
  useEffect(() => {
    if (!cardId || !piccData || !sunMac) {
      // Wait for router to be ready
      if (router.isReady && (!piccData || !sunMac)) {
        setError(
          "Missing authentication parameters. Please tap your card to check balance.",
        )
        setLoading(false)
      }
      return
    }

    const fetchBalance = async () => {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch(
          `/api/boltcard/balance/${cardId}?p=${piccData}&c=${sunMac}`,
        )

        const result = await response.json()

        if (!response.ok) {
          throw new Error(result.reason || "Failed to load balance")
        }

        setData(result)
      } catch (err: unknown) {
        console.error("Failed to fetch balance:", err)
        setError(err instanceof Error ? err.message : "Failed to load card balance")
      } finally {
        setLoading(false)
      }
    }

    fetchBalance()
  }, [cardId, piccData, sunMac, router.isReady])

  // Page title based on state
  const pageTitle = data?.card?.name ? `${data.card.name} - Balance` : "Boltcard Balance"

  return (
    <>
      <Head>
        <title>{pageTitle}</title>
        <meta name="theme-color" content="#000000" />
        <meta name="description" content="Check your Boltcard balance" />
        {/* Prevent caching for security */}
        <meta httpEquiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
        <meta httpEquiv="Pragma" content="no-cache" />
        <meta httpEquiv="Expires" content="0" />
        {/* Prevent indexing */}
        <meta name="robots" content="noindex, nofollow" />
      </Head>

      <CardholderBalance data={data} error={error} loading={loading} />
    </>
  )
}
