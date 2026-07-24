import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI from "../../../../lib/blink-api"
import * as boltcard from "../../../../lib/boltcard"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../../lib/rate-limit"

/**
 * LNURL-withdraw endpoint for Boltcard payments (card tap)
 *
 * This endpoint is called when a card is tapped and the wallet fetches the LNURL
 *
 * GET /api/boltcard/lnurlw/[cardId]?p=...&c=...
 * - p: Encrypted PICCData (32 hex chars)
 * - c: SunMAC authentication (16 hex chars)
 *
 * Returns LNURL-withdraw response (LUD-03):
 * {
 *   tag: 'withdrawRequest',
 *   callback: 'https://...',
 *   k1: '...',
 *   minWithdrawable: 1000,
 *   maxWithdrawable: 100000000,
 *   defaultDescription: '...'
 * }
 *
 * POST /api/boltcard/lnurlw/[cardId]/callback
 * - k1: Card ID (from GET response)
 * - pr: BOLT11 invoice to pay
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { cardId } = req.query

  if (!cardId) {
    return res.status(400).json({ status: "ERROR", reason: "Missing cardId" })
  }

  if (req.method === "GET") {
    return handleWithdrawGet(req, res, cardId as string)
  } else if (req.method === "POST") {
    return handleWithdrawPost(req, res, cardId as string)
  } else {
    return res.status(405).json({ status: "ERROR", reason: "Method not allowed" })
  }
}

/**
 * Handle GET request - card tap verification and LNURL-withdraw response
 */
async function handleWithdrawGet(
  req: NextApiRequest,
  res: NextApiResponse,
  cardId: string,
) {
  try {
    const { p: piccData, c: sunMac } = req.query as { p?: string; c?: string }

    // Check if this is a browser request - redirect to cardholder balance page
    // Browsers send Accept headers like "text/html,application/xhtml+xml,..."
    // Wallets send Accept headers like "application/json" or "*/*"
    const acceptHeader = req.headers["accept"] || ""
    const isBrowser =
      acceptHeader.includes("text/html") &&
      !acceptHeader.includes("application/json") &&
      piccData &&
      sunMac

    if (isBrowser) {
      console.log(
        `[LNURLW] Browser detected, redirecting to balance page for card: ${cardId}`,
      )
      return res.redirect(302, `/boltcard-balance/${cardId}?p=${piccData}&c=${sunMac}`)
    }

    // Enhanced logging for debugging card tap issues
    console.log(`[LNURLW] Card tap request for: ${cardId}`)
    console.log(`[LNURLW] Full URL: ${req.url}`)
    console.log(
      `[LNURLW] Query params: p=${piccData ? (piccData as string).substring(0, 16) + "..." : "MISSING"} (${(piccData as string)?.length || 0} chars), c=${sunMac || "MISSING"} (${(sunMac as string)?.length || 0} chars)`,
    )

    // If no p/c params, this might be a balance check or info request
    if (!piccData || !sunMac) {
      // Return basic card info (without sensitive data)
      const card = await boltcard.store.getCard(cardId)

      if (!card) {
        return res.status(404).json({ status: "ERROR", reason: "Card not found" })
      }

      // Check if this is a balance request
      if (req.query.balance !== undefined) {
        return res.status(200).json({
          balance: card.balance,
          currency: card.walletCurrency,
          unit: card.walletCurrency === "USD" ? "cents" : "sats",
        })
      }

      // Detailed error for missing params (helps debug card programming issues)
      const missingParams: string[] = []
      if (!piccData) missingParams.push("p (PICCData)")
      if (!sunMac) missingParams.push("c (SunMAC/CMAC)")

      console.log(`[LNURLW] ERROR: Missing params: ${missingParams.join(", ")}`)
      console.log(
        `[LNURLW] This usually means the card SUN feature is not configured correctly.`,
      )
      console.log(
        `[LNURLW] The NFC Programmer app should configure SDM/SUN to include both PICCData and CMAC.`,
      )

      return res.status(400).json({
        status: "ERROR",
        reason: `Missing authentication parameters: ${missingParams.join(", ")}. The card may not be programmed correctly - SUN/SDM feature needs to include both PICCData and CMAC.`,
      })
    }

    // Validate parameter formats with helpful error messages
    if (!/^[0-9a-fA-F]{32}$/.test(piccData as string)) {
      console.log(
        `[LNURLW] ERROR: Invalid PICCData format. Expected 32 hex chars, got ${(piccData as string).length}: ${(piccData as string).substring(0, 50)}...`,
      )
      return res.status(400).json({
        status: "ERROR",
        reason: `Invalid PICCData format: expected 32 hex characters, got ${(piccData as string).length}. This may indicate incorrect SUN/SDM configuration on the card.`,
      })
    }

    if (!/^[0-9a-fA-F]{16}$/.test(sunMac as string)) {
      console.log(
        `[LNURLW] ERROR: Invalid SunMAC format. Expected 16 hex chars, got ${(sunMac as string).length}: ${sunMac}`,
      )
      return res.status(400).json({
        status: "ERROR",
        reason: `Invalid SunMAC format: expected 16 hex characters, got ${(sunMac as string).length}`,
      })
    }

    // Build callback URL
    const serverUrl = getServerUrl(req)
    const callbackUrl = `${serverUrl}/api/boltcard/lnurlw/${cardId}/callback`

    // Process the withdraw request
    const response = await boltcard.lnurlw.handleWithdrawRequest(
      cardId,
      piccData,
      sunMac,
      callbackUrl,
    )

    // Return LNURL-withdraw response
    return res.status(response.status === "ERROR" ? 400 : 200).json(response)
  } catch (error: unknown) {
    console.error("❌ LNURL-withdraw GET error:", error)
    return res.status(500).json({
      status: "ERROR",
      reason: "Internal server error",
    })
  }
}

/**
 * Handle POST request - invoice submission and payment
 */
async function handleWithdrawPost(
  req: NextApiRequest,
  res: NextApiResponse,
  cardId: string,
) {
  try {
    // LNURL-withdraw callback parameters
    const k1 = req.body.k1 || req.query.k1
    const pr = req.body.pr || req.query.pr

    if (!pr) {
      return res.status(400).json({
        status: "ERROR",
        reason: "Missing invoice (pr parameter)",
      })
    }

    // k1 should match cardId for security
    if (k1 && k1 !== cardId) {
      console.warn(`[LNURLW] k1 mismatch: ${k1} !== ${cardId}`)
      return res.status(400).json({
        status: "ERROR",
        reason: "Invalid k1 parameter",
      })
    }

    // Create invoice payment function
    const payInvoice = async (
      amountSats: number,
      invoice: string,
      apiKey: string,
      environment: EnvironmentName,
    ) => {
      try {
        const apiUrl = getApiUrlForEnvironment(environment)
        const blinkAPI = new BlinkAPI(apiKey, apiUrl)

        // Get wallet info to find the right wallet
        const wallets = await blinkAPI.getWalletInfo()
        const btcWallet = wallets.find(
          (w: { walletCurrency: string; id: string }) => w.walletCurrency === "BTC",
        )

        if (!btcWallet) {
          return { success: false, error: "No BTC wallet found" }
        }

        // Pay the invoice
        const result = await blinkAPI.payLnInvoice(
          btcWallet.id,
          invoice,
          "Boltcard payment",
        )

        if (result.status === "SUCCESS") {
          const hash = await extractPaymentHash(invoice)
          return {
            success: true,
            paymentHash: hash || undefined,
          }
        } else {
          return {
            success: false,
            error: result.errors?.[0]?.message || `Payment status: ${result.status}`,
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error"
        console.error("❌ Payment error:", error)
        return {
          success: false,
          error: message,
        }
      }
    }

    // Process the callback
    const response = await boltcard.lnurlw.handleWithdrawCallback(cardId, pr, payInvoice)

    return res.status(response.status === "OK" ? 200 : 400).json(response)
  } catch (error: unknown) {
    console.error("❌ LNURL-withdraw POST error:", error)
    return res.status(500).json({
      status: "ERROR",
      reason: "Internal server error",
    })
  }
}

/**
 * Extract payment hash from BOLT11 invoice
 */
async function extractPaymentHash(invoice: string): Promise<string | null> {
  try {
    // The payment hash is in the tagged data section
    // For simplicity, we'll use the bolt11 library if available
    const bolt11 = await import("bolt11")
    const decode = bolt11.default?.decode ?? bolt11.decode
    const decoded = decode(invoice)
    const tag = decoded.tags.find(
      (t: { tagName: string }) => t.tagName === "payment_hash",
    )
    return tag ? String(tag.data) : null
  } catch (_error: unknown) {
    // Return null if we can't extract it
    return null
  }
}

/**
 * Get the server URL from the request
 */
function getServerUrl(req: NextApiRequest) {
  const forwardedProto = req.headers["x-forwarded-proto"]
  const forwardedHost = req.headers["x-forwarded-host"]

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`
  }

  const host = req.headers.host
  const protocol = host?.includes("localhost") ? "http" : "https"

  return `${protocol}://${host}`
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "boltcard/lnurlw/[cardId]")
