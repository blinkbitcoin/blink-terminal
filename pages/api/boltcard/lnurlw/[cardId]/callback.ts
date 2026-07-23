import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI from "../../../../../lib/blink-api"
import * as boltcard from "../../../../../lib/boltcard"
import {
  getApiUrlForEnvironment,
  type EnvironmentName,
} from "../../../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../../../lib/rate-limit"

/**
 * LNURL-withdraw callback endpoint
 *
 * POST /api/boltcard/lnurlw/[cardId]/callback
 *
 * Called by wallet to submit an invoice after LNURL-withdraw scan
 *
 * Query/Body parameters:
 * - k1: Card ID (for verification)
 * - pr: BOLT11 invoice to pay
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ status: "ERROR", reason: "Method not allowed" })
  }

  const cardId = req.query.cardId as string | undefined

  if (!cardId) {
    return res.status(400).json({ status: "ERROR", reason: "Missing cardId" })
  }

  try {
    // LNURL-withdraw callback parameters (support both query and body)
    const k1 = (req.body?.k1 || req.query.k1) as string | undefined
    const pr = (req.body?.pr || req.query.pr) as string | undefined

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
    // For BTC cards: Pay from BTC wallet
    // For USD cards: Pay from USD wallet (Blink auto-converts USD→sats)
    const payInvoice = async (
      amountSats: number,
      invoice: string,
      apiKey: string,
      environment: EnvironmentName,
      walletCurrency: string = "BTC",
    ) => {
      try {
        const apiUrl = getApiUrlForEnvironment(environment)
        const blinkAPI = new BlinkAPI(apiKey, apiUrl)

        // Get wallet info to find the right wallet based on card's currency
        const wallets = await blinkAPI.getWalletInfo()
        const targetWallet = wallets.find(
          (w: { walletCurrency: string; id: string }) =>
            w.walletCurrency === walletCurrency,
        )

        if (!targetWallet) {
          console.error(`[LNURLW] No ${walletCurrency} wallet found`)
          return { success: false, error: `No ${walletCurrency} wallet found` }
        }

        console.log(
          `[LNURLW] Paying ${amountSats} sats invoice from ${walletCurrency} wallet (${targetWallet.id})`,
        )

        // Pay the invoice from the card's wallet
        // For USD wallet, Blink automatically converts USD→sats at current exchange rate
        const result = await blinkAPI.payLnInvoice(
          targetWallet.id,
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
    console.error("❌ LNURL-withdraw callback error:", error)
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
    const bolt11 = await import("bolt11")
    const decode = bolt11.default?.decode ?? bolt11.decode
    const decoded = decode(invoice)
    const tag = decoded.tags.find(
      (t: { tagName: string }) => t.tagName === "payment_hash",
    )
    return tag ? String(tag.data) : null
  } catch (_error: unknown) {
    return null
  }
}

export default withRateLimit(
  handler,
  RATE_LIMIT_WRITE,
  "boltcard/lnurlw/[cardId]/callback",
)
