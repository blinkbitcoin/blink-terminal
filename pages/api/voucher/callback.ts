import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI from "../../../lib/blink-api"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"
import voucherStore from "../../../lib/voucher-store"

/**
 * LNURL-withdraw callback endpoint
 * Called by Lightning wallet with invoice to pay
 *
 * GET /api/voucher/callback?k1=chargeId&pr=invoice
 *
 * Following LUD-03 spec: https://github.com/lnurl/luds/blob/luds/03.md
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Add CORS headers for LNURL compatibility
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  res.setHeader("Content-Type", "application/json")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  if (req.method !== "GET") {
    console.error("❌ Wrong method:", req.method)
    return res.status(200).json({
      status: "ERROR",
      reason: "Method not allowed",
    })
  }

  const startTime = Date.now()

  try {
    const { k1, pr } = req.query as { k1: string; pr: string }

    console.log("🔔 LNURL-withdraw callback received:", {
      k1: k1 ? k1.substring(0, 8) + "..." : "missing",
      pr: pr ? pr.substring(0, 30) + "..." : "missing",
      timestamp: new Date().toISOString(),
    })

    // Validate parameters
    if (!k1) {
      console.error("❌ Missing k1 parameter")
      return res.status(200).json({
        status: "ERROR",
        reason: "k1 parameter is required",
      })
    }

    if (!pr) {
      console.error("❌ Missing pr parameter")
      return res.status(200).json({
        status: "ERROR",
        reason: "Payment request (pr) is required",
      })
    }

    const chargeId = k1

    // Get voucher from store (PostgreSQL)
    const voucher = await voucherStore.getVoucher(chargeId)

    if (!voucher) {
      console.error("❌ Voucher not found or expired:", chargeId)
      return res.status(200).json({
        status: "ERROR",
        reason: "Voucher not found or expired",
      })
    }

    // Check if already claimed
    if (voucher.claimed) {
      console.error("❌ Voucher already claimed:", chargeId)
      return res.status(200).json({
        status: "ERROR",
        reason: "Voucher has already been claimed",
      })
    }

    // Validate invoice format (mainnet: lnbc, testnet: lntb, signet: lntbs)
    const prLower = pr.toLowerCase()
    if (
      !prLower.startsWith("lnbc") &&
      !prLower.startsWith("lntb") &&
      !prLower.startsWith("lntbs")
    ) {
      console.error("❌ Invalid invoice format:", pr.substring(0, 10))
      return res.status(200).json({
        status: "ERROR",
        reason: "Invalid Lightning invoice format",
      })
    }

    console.log("💳 Processing voucher withdrawal:", {
      chargeId: chargeId.substring(0, 8) + "...",
      amount: voucher.amount,
      walletCurrency: voucher.walletCurrency || "BTC",
      usdAmountCents: voucher.usdAmountCents,
      invoicePrefix: pr.substring(0, 30) + "...",
    })

    // Mark as claimed BEFORE paying to prevent double-spend
    const claimed = await voucherStore.claimVoucher(chargeId)
    if (!claimed) {
      console.error("❌ Failed to claim voucher:", chargeId)
      return res.status(200).json({
        status: "ERROR",
        reason: "Failed to claim voucher - may already be in use",
      })
    }

    try {
      // Pay the invoice using Blink API with correct environment
      const apiUrl = getApiUrlForEnvironment(
        (voucher.environment || "production") as EnvironmentName,
      )
      const blinkAPI = new BlinkAPI(voucher.apiKey ?? "", apiUrl)

      console.log(
        "🌐 Using API environment:",
        voucher.environment || "production",
        "URL:",
        apiUrl,
      )

      // Build memo with commission and display info if available
      let memo: string
      const isUsdVoucher = voucher.walletCurrency === "USD"

      if (isUsdVoucher && voucher.usdAmountCents) {
        // USD voucher - show USD value prominently
        const usdAmount = (voucher.usdAmountCents / 100).toFixed(2)
        if (
          voucher.displayAmount &&
          voucher.displayCurrency &&
          voucher.displayCurrency !== "USD"
        ) {
          // Display currency is different from USD (e.g., ARS)
          if (voucher.commissionPercent && voucher.commissionPercent > 0) {
            memo = `BlinkPOS USD Voucher: ${voucher.displayCurrency} ${voucher.displayAmount} (${voucher.commissionPercent}% commission) = $${usdAmount} USD`
          } else {
            memo = `BlinkPOS USD Voucher: ${voucher.displayCurrency} ${voucher.displayAmount} = $${usdAmount} USD`
          }
        } else {
          memo = `BlinkPOS USD Voucher: $${usdAmount} USD = ${voucher.amount} sats`
        }
      } else if (voucher.displayAmount && voucher.displayCurrency) {
        // BTC voucher with display currency
        if (voucher.commissionPercent && voucher.commissionPercent > 0) {
          memo = `BlinkPOS Voucher: ${voucher.displayCurrency} ${voucher.displayAmount} (${voucher.commissionPercent}% commission) = ${voucher.amount} sats`
        } else {
          memo = `BlinkPOS Voucher: ${voucher.displayCurrency} ${voucher.displayAmount} = ${voucher.amount} sats`
        }
      } else {
        memo = `BlinkPOS Voucher: ${voucher.amount} sats`
      }

      console.log("⚡ Paying invoice from voucher wallet...", {
        walletId: voucher.walletId,
        walletCurrency: voucher.walletCurrency || "BTC",
        memo,
      })

      const paymentResult = await blinkAPI.payLnInvoice(voucher.walletId, pr, memo)

      console.log("📦 Payment result:", paymentResult)

      // Check for various success states
      const isSuccess =
        paymentResult.status === "SUCCESS" || paymentResult.status === "ALREADY_PAID"

      if (!isSuccess) {
        // If payment is pending, we still return OK but log it
        if (paymentResult.status === "PENDING") {
          console.log("⏳ Payment is pending:", paymentResult)
          // For PENDING, we still return OK as the payment is in progress
          // The voucher remains claimed
        } else {
          throw new Error(`Payment failed with status: ${paymentResult.status}`)
        }
      }

      const elapsed = Date.now() - startTime
      console.log(`✅ Voucher redeemed successfully in ${elapsed}ms:`, {
        chargeId: chargeId.substring(0, 8) + "...",
        amount: voucher.amount,
        walletCurrency: voucher.walletCurrency || "BTC",
        usdAmountCents: voucher.usdAmountCents,
        status: paymentResult.status,
      })

      // Return LNURL success response
      return res.status(200).send('{"status":"OK"}')
    } catch (paymentError: unknown) {
      // Payment failed - unclaim the voucher so it can be retried
      const paymentMessage =
        paymentError instanceof Error ? paymentError.message : "Unknown error"
      console.error("❌ Payment failed, unclaiming voucher:", paymentMessage)

      // Unclaim the voucher using proper method
      await voucherStore.unclaimVoucher(chargeId)

      throw paymentError
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    const elapsed = Date.now() - startTime
    console.error(`❌ Voucher callback error after ${elapsed}ms:`, message)

    let errorMessage = "Failed to process voucher withdrawal"
    if (message.includes("balance") || message.includes("INSUFFICIENT")) {
      errorMessage = "Insufficient balance in voucher wallet"
    } else if (message.includes("expired")) {
      errorMessage = "Invoice has expired"
    } else if (message.includes("already paid") || message.includes("ALREADY_PAID")) {
      errorMessage = "Invoice has already been paid"
    } else if (message.includes("amount")) {
      errorMessage = "Invoice amount does not match voucher"
    }

    // LNURL spec says always return 200 with status field
    return res.status(200).json({
      status: "ERROR",
      reason: errorMessage,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "voucher/callback")
