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
import voucherStore, {
  type BackingInputs,
  isLockTimeout,
} from "../../../lib/voucher-store"

/**
 * Tolerance for rate drift between the client's quote and the server-side
 * check. Attacks are orders of magnitude off (1 BTC vs 1 cent), so 2% is far
 * tighter than needed while robust to normal price movement. An additional
 * ±1 cent allowance covers the client's round() quantization in both flow
 * directions (blink-wip#1665 re-review).
 */
const USD_PAIR_TOLERANCE = 0.02
const USD_PAIR_QUANTIZATION_CENTS = 1

/**
 * The backing inputs are fetched from Blink while the per-wallet lock is held
 * (see BACKING INVARIANT in voucher-store.ts), so the whole fetch runs under
 * ONE deadline and the requests are aborted (not just abandoned) when it
 * passes: fail closed (503) rather than hold the wallet lock and a pool
 * connection. The deadline must stay well below the store's lock_timeout
 * (15 s), or a concurrent settlement (markVoucherPaid) waiting for the same
 * lock could time out behind a slow but still-valid create.
 */
const BACKING_DEADLINE_MS = 8_000

/** A refusal decided inside the locked backing fetch; mapped to a response. */
class BackingRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? "backing refused"))
  }
}

/**
 * Run `work` under one deadline: the AbortSignal passed in is aborted when
 * the deadline passes, so in-flight upstream requests are cancelled, and the
 * returned promise rejects with "<label> timed out".
 */
const withDeadline = <T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`${label} timed out`))
    }, ms)
    work(controller.signal).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })

/**
 * USD cents per sat at the server-side rate, fetched with the caller's own
 * API key (same auth context as the ownership check). null = the rate could
 * not be verified; callers must fail closed.
 */
async function getUsdCentsPerSat(
  apiKey: string,
  environment: EnvironmentName,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const rate = await new BlinkAPI(
      apiKey,
      getApiUrlForEnvironment(environment),
    ).getExchangeRate("USD", signal)
    const centsPerSat = rate.satPriceInCurrency
    if (
      typeof centsPerSat !== "number" ||
      !Number.isFinite(centsPerSat) ||
      centsPerSat <= 0
    ) {
      return null
    }
    return centsPerSat
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

    // Backing check (blink-wip#1665): the wallet must fund this voucher on
    // top of its existing unsettled liabilities. The balance (and, for USD,
    // the rate) is fetched INSIDE the store's per-wallet lock, right before
    // the liability sum: read before the lock, a settlement (CLAIMED -> PAID)
    // could debit the wallet and leave the aggregate between the balance
    // read and the sum, and a stale balance would back a new voucher.
    const usdCents = actualWalletCurrency === "USD" ? parseInt(String(usdAmount)) : 0
    const backing = async (): Promise<BackingInputs> => {
      // Balance and (for USD) rate are independent: fetch them concurrently
      // under the single deadline so the locked critical section is bounded
      // by one round trip, not two.
      const [live, centsPerSat] = await withDeadline(
        (signal) =>
          Promise.all([
            getOwnedWallets(apiKey, environment, signal),
            actualWalletCurrency === "USD"
              ? getUsdCentsPerSat(apiKey, environment, signal)
              : Promise.resolve(null),
          ]),
        BACKING_DEADLINE_MS,
        "Blink backing fetch",
      )
      if (!live.ok) {
        throw new BackingRefusal(
          live.reason === "invalid" ? 403 : OWNERSHIP_UNAVAILABLE.status,
          live.reason === "invalid"
            ? { error: "API key is not valid for this wallet" }
            : OWNERSHIP_UNAVAILABLE.body,
        )
      }
      const wallet = live.wallets.get(walletId)
      if (!wallet || wallet.walletCurrency !== actualWalletCurrency) {
        throw new BackingRefusal(403, { error: "API key is not valid for this wallet" })
      }

      if (actualWalletCurrency !== "USD") {
        if (amountNum > wallet.balance) {
          throw new BackingRefusal(400, {
            error: "Amount is more than the wallet balance",
          })
        }
        return { maxLiabilityMinor: wallet.balance, liabilityMinor: amountNum }
      }

      if (centsPerSat === null) {
        throw new BackingRefusal(503, {
          error: "Could not verify the exchange rate right now, please retry",
        })
      }

      // Cross-check the USD/sats pair in CENT space: the client derives one
      // denomination from the other with round(), so allow ±1 cent
      // quantization plus 2% rate drift.
      const impliedCents = amountNum * centsPerSat
      const toleranceCents = USD_PAIR_QUANTIZATION_CENTS + USD_PAIR_TOLERANCE * usdCents
      if (Math.abs(impliedCents - usdCents) > toleranceCents) {
        throw new BackingRefusal(400, {
          error: "amount does not match usdAmount at the current exchange rate",
        })
      }

      // Conservative backing: the sats actually paid at redemption must be
      // fundable even at the tolerant edge of the pair check.
      const liabilityMinor = Math.max(usdCents, Math.ceil(impliedCents))
      if (liabilityMinor > wallet.balance) {
        throw new BackingRefusal(400, { error: "Amount is more than the wallet balance" })
      }
      return {
        maxLiabilityMinor: wallet.balance,
        liabilityMinor,
        usdCentsPerSat: centsPerSat,
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
      usdAmount: actualWalletCurrency === "USD" ? usdCents : undefined,
      backing,
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
    if (error instanceof BackingRefusal) {
      return res.status(error.status).json(error.body)
    }

    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Voucher creation error:", error)

    // Backing fetch deadline, or the wallet lock wait (SQLSTATE 55P03) when
    // same-wallet creates queue up: both are safe rollbacks, retryable.
    if (message.endsWith("timed out") || isLockTimeout(error)) {
      return res.status(OWNERSHIP_UNAVAILABLE.status).json(OWNERSHIP_UNAVAILABLE.body)
    }

    // Check for wallet limit / backing errors
    if (
      message.includes("Maximum unclaimed vouchers") ||
      message.includes("exceeds the wallet balance")
    ) {
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
