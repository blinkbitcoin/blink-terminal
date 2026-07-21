/**
 * LNURL-pay Callback Endpoint
 *
 * Creates invoices for LNURL-pay requests.
 * Called by wallets when paying to username@terminal.blinkbtc.com
 *
 * GET /api/lnurlp/[username]/callback?amount=<millisats>&comment=<optional>
 * Returns a Lightning invoice according to LUD-06
 */

import crypto from "crypto"

import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI from "../../../../lib/blink-api"
import { withRateLimit, RATE_LIMIT_PUBLIC } from "../../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ status: "ERROR", reason: "Method not allowed" })
  }

  const { username, amount, comment } = req.query as {
    username: string
    amount: string
    comment?: string
  }

  if (!username) {
    return res.status(400).json({ status: "ERROR", reason: "Username is required" })
  }

  if (!amount) {
    return res.status(400).json({ status: "ERROR", reason: "Amount is required" })
  }

  // Parse amount (in millisats)
  const amountMsats = parseInt(amount, 10)
  if (isNaN(amountMsats) || amountMsats < 1000) {
    return res.status(400).json({ status: "ERROR", reason: "Invalid amount" })
  }

  // Convert to sats (must be whole sats)
  const amountSats = Math.round(amountMsats / 1000)
  if ((amountSats * 1000).toString() !== amount) {
    return res.status(400).json({
      status: "ERROR",
      reason: "Millisatoshi amounts are not supported, please send a value in full sats.",
    })
  }

  // Enforce limits
  if (amountSats < 1) {
    return res.status(400).json({ status: "ERROR", reason: "Minimum amount is 1 sat" })
  }
  if (amountSats > 100000000) {
    // 1 BTC
    return res.status(400).json({ status: "ERROR", reason: "Maximum amount is 1 BTC" })
  }

  try {
    // Get user's BTC wallet (LNURL always uses BTC)
    let walletInfo: { id: string } | undefined
    try {
      walletInfo = await BlinkAPI.getBtcWalletByUsername(username)
    } catch (_err) {
      console.log(`[LNURL Callback] User not found: ${username}`)
      return res.status(404).json({
        status: "ERROR",
        reason: `Couldn't find user '${username}'.`,
      })
    }

    if (!walletInfo?.id) {
      return res.status(404).json({
        status: "ERROR",
        reason: `Couldn't find wallet for user '${username}'.`,
      })
    }

    // Build metadata for description hash (LUD-06 requirement)
    const host = req.headers["x-forwarded-host"] || req.headers.host
    const metadata = JSON.stringify([
      ["text/plain", `Payment to ${username}`],
      ["text/identifier", `${username}@${host}`],
    ])

    // Create description hash
    const _descriptionHash = crypto.createHash("sha256").update(metadata).digest("hex")

    // Create invoice with description hash
    // Note: Blink's createInvoiceOnBehalfOfRecipient uses memo, not descriptionHash
    // For proper LNURL compliance, we'd need the descriptionHash variant
    // For now, we use regular memo
    const invoiceMemo = comment
      ? `Payment to ${username}: ${comment.substring(0, 200)}`
      : `Payment to ${username}`

    let invoice: { paymentRequest: string; paymentHash?: string } | undefined
    try {
      invoice = await BlinkAPI.createInvoiceOnBehalfOfRecipient(
        walletInfo.id,
        amountSats,
        invoiceMemo,
        15, // 15 minutes expiry
      )
    } catch (invoiceError: unknown) {
      const invoiceMessage =
        invoiceError instanceof Error ? invoiceError.message : "Unknown error"
      console.error("[LNURL Callback] Invoice creation failed:", invoiceMessage)
      return res.status(500).json({
        status: "ERROR",
        reason: "Failed to create invoice",
      })
    }

    if (!invoice?.paymentRequest) {
      return res.status(500).json({
        status: "ERROR",
        reason: "Invoice creation returned empty result",
      })
    }

    console.log(`[LNURL Callback] Invoice created for ${username}:`, {
      sats: amountSats,
      paymentHash: invoice.paymentHash?.substring(0, 16) + "...",
    })

    // Build verify URL (optional, for payment confirmation)
    const protocol = req.headers["x-forwarded-proto"] || "https"
    const verifyUrl = `${protocol}://${host}/${username}?verify=${invoice.paymentHash}`

    // Return LNURL-pay callback response (LUD-06)
    return res.status(200).json({
      pr: invoice.paymentRequest,
      routes: [],
      verify: verifyUrl,
    })
  } catch (error: unknown) {
    console.error("[LNURL Callback] Error:", error)
    return res.status(500).json({
      status: "ERROR",
      reason: "Internal server error",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_PUBLIC)
