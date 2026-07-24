import type { NextApiRequest, NextApiResponse } from "next"

import type { EnvironmentName } from "../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"
import { isValidExpiryId, DEFAULT_EXPIRY_ID } from "../../../lib/voucher-expiry"
import voucherStore from "../../../lib/voucher-store"

/**
 * API endpoint to create a new voucher charge
 *
 * POST /api/voucher/create
 * Body: {
 *   amount: number (sats),
 *   apiKey: string,
 *   walletId: string,
 *   expiryId: string (optional, e.g., '6mo', '24h', '15m'),
 *   commissionPercent: number (optional),
 *   displayAmount: string (optional),
 *   displayCurrency: string (optional),
 *   environment: string (optional, 'production' or 'staging'),
 *   walletCurrency: string (optional, 'BTC' or 'USD', defaults to 'BTC'),
 *   usdAmount: number (optional, USD cents - required if walletCurrency is 'USD')
 * }
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const {
      amount,
      apiKey,
      walletId,
      expiryId,
      commissionPercent,
      displayAmount,
      displayCurrency,
      environment = "production",
      walletCurrency = "BTC",
      usdAmount,
    } = req.body as {
      amount: number | string
      apiKey: string
      walletId: string
      expiryId?: string
      commissionPercent?: number
      displayAmount?: string
      displayCurrency?: string
      environment?: EnvironmentName
      walletCurrency?: string
      usdAmount?: number | string
    }

    // Validate required fields
    if (!amount || !apiKey || !walletId) {
      console.error("❌ Missing required fields for voucher creation")
      return res.status(400).json({
        error: "Missing required fields: amount, apiKey, walletId",
      })
    }

    // Validate amount
    const amountNum = parseInt(String(amount))
    if (isNaN(amountNum) || amountNum <= 0) {
      console.error("❌ Invalid amount for voucher:", amount)
      return res.status(400).json({
        error: "Amount must be a positive number",
      })
    }

    // Validate walletCurrency
    if (walletCurrency !== "BTC" && walletCurrency !== "USD") {
      console.error("❌ Invalid walletCurrency:", walletCurrency)
      return res.status(400).json({
        error: "walletCurrency must be BTC or USD",
      })
    }

    // Validate USD voucher has usdAmount
    if (walletCurrency === "USD") {
      const usdAmountNum = parseInt(String(usdAmount))
      if (isNaN(usdAmountNum) || usdAmountNum <= 0) {
        console.error("❌ USD voucher missing or invalid usdAmount:", usdAmount)
        return res.status(400).json({
          error: "USD vouchers require a positive usdAmount (in cents)",
        })
      }
    }

    // Validate expiryId if provided
    const validExpiryId =
      expiryId && isValidExpiryId(expiryId) ? expiryId : DEFAULT_EXPIRY_ID

    // Create voucher charge with optional commission, expiry, and display info (async)
    const voucher = await voucherStore.createVoucher(amountNum, apiKey, walletId, {
      expiryId: validExpiryId,
      commissionPercent: commissionPercent || 0,
      displayAmount: displayAmount || undefined,
      displayCurrency: displayCurrency || undefined,
      environment: environment,
      walletCurrency: walletCurrency,
      usdAmount: walletCurrency === "USD" ? parseInt(String(usdAmount)) : undefined,
    })

    console.log("✅ Voucher created successfully:", {
      chargeId: voucher.id,
      amount: voucher.amount,
      walletCurrency: voucher.walletCurrency,
      usdAmountCents: voucher.usdAmountCents,
      expiryId: voucher.expiryId,
      expiresAt: new Date(voucher.expiresAt).toISOString(),
      commissionPercent: voucher.commissionPercent,
      displayAmount: voucher.displayAmount,
      displayCurrency: voucher.displayCurrency,
      timestamp: new Date(voucher.createdAt).toISOString(),
    })

    res.status(200).json({
      success: true,
      voucher: {
        id: voucher.id,
        amount: voucher.amount,
        walletCurrency: voucher.walletCurrency,
        usdAmountCents: voucher.usdAmountCents,
        createdAt: voucher.createdAt,
        expiresAt: voucher.expiresAt,
        expiryId: voucher.expiryId,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Voucher creation error:", error)

    // Check for wallet limit error
    if (message.includes("Maximum unclaimed vouchers")) {
      return res.status(400).json({
        error: message,
      })
    }

    res.status(500).json({
      error: "Failed to create voucher",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "voucher/create")
