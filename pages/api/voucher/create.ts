import type { NextApiRequest, NextApiResponse } from "next"

import { BlinkAPI } from "../../../lib/blink-api"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"
import {
  getOwnedWallets,
  OWNERSHIP_UNAVAILABLE,
  toEnvironment,
} from "../../../lib/voucher-auth"
import { isValidExpiryId, DEFAULT_EXPIRY_ID } from "../../../lib/voucher-expiry"
import voucherStore from "../../../lib/voucher-store"

/**
 * Tolerance for rate drift and rounding between the client's quote and the
 * server-side check. Attacks are orders of magnitude off (1 BTC vs 1 cent),
 * so 2% is far tighter than needed while robust to normal price movement.
 */
const USD_PAIR_TOLERANCE = 0.02

/**
 * The sats a USD-cent amount is worth at the server-side rate, fetched with
 * the caller's own API key (same auth context as the ownership check).
 * null = the rate could not be verified; callers must fail closed.
 */
async function expectedSatsForUsdCents(
  apiKey: string,
  environment: EnvironmentName,
  usdCents: number,
): Promise<number | null> {
  try {
    const rate = await new BlinkAPI(
      apiKey,
      getApiUrlForEnvironment(environment),
    ).getExchangeRate("USD")
    const centsPerSat = rate.satPriceInCurrency
    if (
      typeof centsPerSat !== "number" ||
      !Number.isFinite(centsPerSat) ||
      centsPerSat <= 0
    ) {
      return null
    }
    return Math.round(usdCents / centsPerSat)
  } catch (_err: unknown) {
    return null
  }
}

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
      environment: requestedEnvironment,
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
      environment?: unknown
      walletCurrency?: string
      usdAmount?: number | string
    }

    const environment: EnvironmentName = toEnvironment(requestedEnvironment)

    // Validate required fields
    if (
      !amount ||
      !apiKey ||
      !walletId ||
      typeof apiKey !== "string" ||
      typeof walletId !== "string"
    ) {
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

    // The API key must currently own the wallet the voucher is drawn from
    // (checked live, no cache). Otherwise anyone could create vouchers against
    // (and exhaust the unclaimed-voucher quota of) a wallet id they don't control.
    const ownership = await getOwnedWallets(apiKey, environment)
    if (!ownership.ok && ownership.reason === "unavailable") {
      return res.status(OWNERSHIP_UNAVAILABLE.status).json(OWNERSHIP_UNAVAILABLE.body)
    }
    const ownedWallet = ownership.ok ? ownership.wallets.get(walletId) : undefined
    if (!ownedWallet) {
      return res.status(403).json({
        error: "API key is not valid for this wallet",
      })
    }
    const actualWalletCurrency = ownedWallet.walletCurrency

    // The stored currency (memo, USD fields, listing) must match the wallet
    // that actually pays out.
    if (actualWalletCurrency !== walletCurrency) {
      return res.status(400).json({
        error: "walletCurrency does not match the wallet",
      })
    }

    // Balance check, matching the GraphQL create-withdraw-link control
    // (blink-wip#1665): the REST path used to publish ACTIVE vouchers the
    // wallet cannot back (redemption then fails against the empty escrow and
    // k1 is never returned). Minor units on both sides: sats for BTC wallets,
    // cents for USD wallets.
    const requiredBalance =
      actualWalletCurrency === "USD" ? parseInt(String(usdAmount)) : amountNum
    if (requiredBalance > ownedWallet.balance) {
      return res.status(400).json({
        error: "Amount is more than the wallet balance",
      })
    }

    // Cross-check the USD/sats pair against a server-side rate (fetched with
    // the caller's key): the client supplies both denominations and nothing
    // else ties them together — a mismatched pair stores an ACTIVE voucher
    // advertising sats the USD amount doesn't back, or vice versa
    // (blink-wip#1665 re-review).
    if (actualWalletCurrency === "USD") {
      const usdCents = parseInt(String(usdAmount))
      const expected = await expectedSatsForUsdCents(apiKey, environment, usdCents)
      if (expected === null) {
        return res.status(503).json({
          error: "Could not verify the exchange rate right now, please retry",
        })
      }
      if (Math.abs(amountNum - expected) / expected > USD_PAIR_TOLERANCE) {
        return res.status(400).json({
          error: "amount does not match usdAmount at the current exchange rate",
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
      walletCurrency: actualWalletCurrency,
      usdAmount: actualWalletCurrency === "USD" ? parseInt(String(usdAmount)) : undefined,
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
