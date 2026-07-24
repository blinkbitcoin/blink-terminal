import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI from "../../../../lib/blink-api"
import * as boltcard from "../../../../lib/boltcard"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../../lib/rate-limit"

/**
 * LNURL-pay endpoint for Boltcard top-up
 *
 * GET /api/boltcard/lnurlp/[cardId]
 * Returns LNURL-pay metadata (LUD-06)
 *
 * GET /api/boltcard/lnurlp/[cardId]?amount=...
 * Returns invoice for the specified amount (callback)
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cardId = req.query.cardId as string | undefined

  if (!cardId) {
    return res.status(400).json({ status: "ERROR", reason: "Missing cardId" })
  }

  if (req.method !== "GET") {
    return res.status(405).json({ status: "ERROR", reason: "Method not allowed" })
  }

  // Check if this is a callback request (has amount parameter)
  const amount = req.query.amount as string | undefined

  if (amount) {
    return handlePayCallback(req, res, cardId, amount)
  } else {
    return handlePayRequest(req, res, cardId)
  }
}

/**
 * Handle initial LNURL-pay request - return metadata
 */
async function handlePayRequest(
  req: NextApiRequest,
  res: NextApiResponse,
  cardId: string,
) {
  try {
    const serverUrl = getServerUrl(req)
    const response = await boltcard.lnurlp.handleTopUpRequest(cardId, serverUrl)

    if (response.status === "ERROR") {
      return res.status(400).json(response)
    }

    return res.status(200).json(response)
  } catch (error: unknown) {
    console.error("❌ LNURL-pay request error:", error)
    return res.status(500).json({
      status: "ERROR",
      reason: "Internal server error",
    })
  }
}

/**
 * Handle LNURL-pay callback - create invoice
 */
async function handlePayCallback(
  req: NextApiRequest,
  res: NextApiResponse,
  cardId: string,
  amountMsats: string,
) {
  try {
    const comment = (req.query.comment as string) || ""
    const amount = parseInt(amountMsats)

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        status: "ERROR",
        reason: "Invalid amount",
      })
    }

    // Create invoice function - ALWAYS creates BTC invoice for exact sat amount
    // For USD cards, we query the account's BTC wallet and convert sats→cents when crediting
    const createInvoice = async (
      amountSats: number,
      memo: string,
      walletId: string,
      apiKey: string,
      environment: EnvironmentName,
      walletCurrency: string,
    ) => {
      try {
        const apiUrl = getApiUrlForEnvironment(environment)
        const blinkAPI = new BlinkAPI(apiKey, apiUrl)

        let btcWalletId = walletId

        // For USD cards, we need to find the account's BTC wallet
        // because lnInvoiceCreate requires a BTC wallet and we need exact sat amounts
        // for LUD-06 compliance (wallet verifies invoice amount matches request)
        if (walletCurrency === "USD") {
          console.log(`[LNURLP] USD card detected, querying account for BTC wallet...`)
          const wallets = await blinkAPI.getWalletInfo()
          const btcWallet = wallets.find(
            (w: { walletCurrency: string; id: string }) => w.walletCurrency === "BTC",
          )

          if (!btcWallet) {
            console.error(`[LNURLP] No BTC wallet found for USD card account`)
            return { error: "No BTC wallet found for this account" }
          }

          btcWalletId = btcWallet.id
          console.log(`[LNURLP] Found BTC wallet: ${btcWalletId} for USD card top-up`)
        }

        // Always create BTC invoice for exact sat amount (LUD-06 compliance)
        const invoice = await blinkAPI.createLnInvoice(btcWalletId, amountSats, memo)

        if (!invoice) {
          return { error: "Failed to create invoice" }
        }

        return {
          invoice: invoice.paymentRequest,
          paymentHash: invoice.paymentHash,
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error"
        console.error("❌ Invoice creation error:", error)
        return { error: message }
      }
    }

    // Process the callback
    const response = await boltcard.lnurlp.handleTopUpCallback(
      cardId,
      amount,
      comment,
      createInvoice,
    )

    if (response.status === "ERROR") {
      return res.status(400).json(response)
    }

    return res.status(200).json(response)
  } catch (error: unknown) {
    console.error("❌ LNURL-pay callback error:", error)
    return res.status(500).json({
      status: "ERROR",
      reason: "Internal server error",
    })
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

export default withRateLimit(handler, RATE_LIMIT_WRITE, "boltcard/lnurlp/[cardId]")
