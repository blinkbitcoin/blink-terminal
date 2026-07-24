import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_WRITE } from "../../../../../lib/rate-limit"
import voucherStore from "../../../../../lib/voucher-store"

/**
 * LNURL-withdraw endpoint for vouchers
 * Returns LnurlWithdrawResponse when scanned by a Lightning wallet
 *
 * GET /api/voucher/lnurl/[chargeId]/[amount]
 *
 * Following LUD-03 spec: https://github.com/lnurl/luds/blob/luds/03.md
 * Always returns HTTP 200 with status in JSON body
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
    return res.status(200).json({
      status: "ERROR",
      reason: "Method not allowed",
    })
  }

  try {
    const { chargeId, amount } = req.query as { chargeId: string; amount: string }

    console.log("🔔 LNURL-withdraw request received:", {
      chargeId: chargeId ? chargeId.substring(0, 8) + "..." : "missing",
      amount: amount || "missing",
      timestamp: new Date().toISOString(),
    })

    // Validate parameters
    if (!chargeId || !amount) {
      console.error("❌ Missing chargeId or amount")
      return res.status(200).json({
        status: "ERROR",
        reason: "Missing chargeId or amount",
      })
    }

    const amountNum = parseInt(amount)
    if (isNaN(amountNum) || amountNum <= 0) {
      console.error("❌ Invalid amount:", amount)
      return res.status(200).json({
        status: "ERROR",
        reason: "Invalid amount",
      })
    }

    // Get voucher from store (PostgreSQL)
    const voucher = await voucherStore.getVoucher(chargeId)

    if (!voucher) {
      console.error("❌ Voucher not found or expired:", chargeId)
      return res.status(200).json({
        status: "ERROR",
        reason: "Voucher not found or expired",
      })
    }

    // Verify amount matches voucher
    if (voucher.amount !== amountNum) {
      console.error("❌ Amount mismatch:", {
        requested: amountNum,
        voucher: voucher.amount,
      })
      return res.status(200).json({
        status: "ERROR",
        reason: `Amount mismatch. Expected ${voucher.amount} sats`,
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

    // Build callback URL (full URL required by LNURL spec)
    const protocol = req.headers["x-forwarded-proto"] || "http"
    const host = req.headers["x-forwarded-host"] || req.headers.host
    const callbackUrl = `${protocol}://${host}/api/voucher/callback`

    console.log("📋 LNURL-withdraw serving voucher:", {
      chargeId: chargeId.substring(0, 8) + "...",
      amount: amountNum,
      voucherAmount: voucher.amount,
      callback: callbackUrl,
    })

    // Return LNURL-withdraw response
    // Following LUD-03 spec: https://github.com/lnurl/luds/blob/luds/03.md
    const response = {
      tag: "withdrawRequest",
      callback: callbackUrl,
      k1: chargeId,
      minWithdrawable: amountNum * 1000, // Convert sats to millisats
      maxWithdrawable: amountNum * 1000, // Convert sats to millisats
      defaultDescription: `BlinkPOS Voucher: ${amountNum} sats`,
    }

    console.log("✅ Returning LNURL-withdraw response")
    return res.status(200).json(response)
  } catch (error: unknown) {
    console.error("❌ LNURL-withdraw error:", error)

    // LNURL spec: always return 200 with status in body
    return res.status(200).json({
      status: "ERROR",
      reason: "Internal server error",
    })
  }
}

export default withRateLimit(
  handler,
  RATE_LIMIT_WRITE,
  "voucher/lnurl/[chargeId]/[amount]",
)
