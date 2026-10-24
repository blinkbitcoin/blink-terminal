import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI, { BlinkAuthError, PaymentRejectedError } from "../../../lib/blink-api"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import { shortId } from "../../../lib/log-redact"
import { verifyForwardInvoice } from "../../../lib/payout-guard"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"
import { buildVoucherMemo } from "../../../lib/voucher-memo"
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
    const k1 = typeof req.query.k1 === "string" ? req.query.k1 : undefined
    const pr = typeof req.query.pr === "string" ? req.query.pr : undefined

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
      console.error("❌ Voucher not found or expired:", shortId(chargeId))
      return res.status(200).json({
        status: "ERROR",
        reason: "Voucher not found or expired",
      })
    }

    // Check if already claimed
    if (voucher.claimed) {
      console.error("❌ Voucher already claimed:", shortId(chargeId))
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

    // The invoice must be for exactly the voucher's face value (sats fixed at
    // issuance, also for USD vouchers), carry an amount, and not be expired.
    // Checked BEFORE claiming so a rejected invoice never touches the voucher.
    const invoiceCheck = verifyForwardInvoice({
      invoice: pr,
      expectedSats: voucher.amount,
    })
    if (!invoiceCheck.ok) {
      console.error("❌ Invoice rejected for voucher:", {
        chargeId: chargeId.substring(0, 8) + "...",
        reason: invoiceCheck.error,
      })
      return res.status(200).json({
        status: "ERROR",
        reason: invoiceCheck.error.includes("expired")
          ? "Invoice has expired"
          : invoiceCheck.error.includes("no amount")
            ? "Invoice must specify an amount"
            : invoiceCheck.error.includes("decode")
              ? "Invalid Lightning invoice"
              : `Invoice amount does not match voucher (${voucher.amount} sats)`,
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
      console.error("❌ Failed to claim voucher:", shortId(chargeId))
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

      // Exact memo is also the reconciliation key for legacy claims
      const memo = buildVoucherMemo(voucher)

      console.log("⚡ Paying invoice from voucher wallet...", {
        walletId: voucher.walletId,
        walletCurrency: voucher.walletCurrency || "BTC",
        memo,
      })

      const paymentResult = await blinkAPI.payLnInvoice(voucher.walletId, pr, memo)

      console.log("📦 Payment result:", paymentResult)

      // Only SUCCESS proves this wallet was debited. ALREADY_PAID never leaves
      // a net debit in Blink: an already-paid Blink invoice is rejected at
      // validation, the intraledger path checks isLnTxRecorded before
      // debiting, and on the external path LND's "already paid" is settled
      // and reversed (recordLnSendRevert). So it is "nothing sent", handled
      // like FAILURE below (released, still counted as ACTIVE) — never PAID,
      // which would consume the voucher and drop its liability unpaid.
      const isSuccess = paymentResult.status === "SUCCESS"

      if (isSuccess) {
        // Settlement confirmed: the wallet has been debited, so the voucher
        // must leave the liability aggregate (PAID exits the
        // ACTIVE/CLAIMED set). If this write fails the voucher stays CLAIMED
        // — a conservative over-count, never a double-pay risk — so log
        // loudly for ops but still answer OK.
        const marked = await voucherStore.markVoucherPaid(chargeId)
        if (!marked) {
          console.error(
            "❌ Voucher settled but could not be marked PAID (stays CLAIMED):",
            chargeId.substring(0, 8) + "...",
          )
        }
      }

      if (!isSuccess) {
        // If payment is pending, we still return OK but log it
        if (paymentResult.status === "PENDING") {
          console.log("⏳ Payment is pending:", paymentResult)
          // For PENDING, we still return OK as the payment is in progress
          // The voucher remains claimed
        } else if (
          paymentResult.status === "FAILURE" ||
          paymentResult.status === "ALREADY_PAID"
        ) {
          // Definite outcome with no net debit: nothing was sent.
          throw new PaymentRejectedError(
            `Payment failed with status: ${paymentResult.status}`,
          )
        } else {
          // Unknown status: outcome uncertain, keep the voucher claimed.
          throw new Error(`Payment returned unexpected status: ${paymentResult.status}`)
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
      const paymentMessage =
        paymentError instanceof Error ? paymentError.message : "Unknown error"

      if (
        paymentError instanceof PaymentRejectedError ||
        paymentError instanceof BlinkAuthError
      ) {
        // The API rejected the payment, or refused the voucher's stored key
        // (revoked / rotated) before executing anything: nothing was sent.
        // Release the voucher so it can be retried or cancelled/reissued by
        // the owner. Safe: the invoice amount is pinned to face value.
        console.error("❌ Payment not executed, unclaiming voucher:", paymentMessage)
        await voucherStore.unclaimVoucher(chargeId)
      } else {
        // Transport error / unknown outcome: the payment may have gone out.
        // Keep the voucher claimed to rule out a double payout.
        console.error(
          "❌ Payment outcome unknown, voucher stays claimed:",
          paymentMessage,
        )
      }

      throw paymentError
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    const elapsed = Date.now() - startTime
    console.error(`❌ Voucher callback error after ${elapsed}ms:`, message)

    let errorMessage = "Failed to process voucher withdrawal"
    if (error instanceof BlinkAuthError) {
      errorMessage = "This voucher's wallet is no longer available - contact the issuer"
    } else if (message.includes("balance") || message.includes("INSUFFICIENT")) {
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
