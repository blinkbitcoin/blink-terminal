import type { NextApiRequest, NextApiResponse } from "next"

/**
 * Boltcard Balance API - Public cardholder balance check
 *
 * This endpoint allows cardholders to check their card balance WITHOUT logging in.
 * They authenticate by tapping their physical card (p/c parameters from SUN feature).
 *
 * GET /api/boltcard/balance/{cardId}?p={piccData}&c={sunMac}
 *
 * Returns:
 * {
 *   "card": {
 *     "name": "My Card",
 *     "balance": 6200,
 *     "currency": "BTC",
 *     "displayBalance": "6,200 sats",
 *     "dailyLimit": 50000,
 *     "dailyRemaining": 43800,
 *     "status": "ACTIVE"
 *   },
 *   "transactions": [
 *     { "type": "WITHDRAW", "amount": 500, "description": "...", "createdAt": 1234567890 },
 *     ...
 *   ],
 *   "topUp": {
 *     "lnurl": "LNURL1...",
 *     "url": "https://..."
 *   },
 *   "pendingTopUps": {
 *     "processed": 1,
 *     "total": 1
 *   }
 * }
 *
 * Security:
 * - Card tap required (p/c params verified via SunMAC)
 * - Counter replay protection (each tap increments counter)
 * - No sensitive data exposed (no keys, no owner info)
 *
 * Top-up Processing:
 * - When balance is checked, we also check for any pending top-ups
 * - If pending top-ups exist, we query Blink API to see if they've been paid
 * - Paid top-ups are automatically credited to the card balance
 */

import * as boltcard from "../../../../lib/boltcard"
import { withRateLimit, RATE_LIMIT_READ } from "../../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cardId = req.query.cardId as string | undefined

  if (!cardId) {
    return res.status(400).json({ status: "ERROR", reason: "Missing cardId" })
  }

  if (req.method !== "GET") {
    return res.status(405).json({ status: "ERROR", reason: "Method not allowed" })
  }

  return handleBalanceGet(req, res, cardId)
}

/**
 * Handle GET request - card tap verification and balance response
 */
async function handleBalanceGet(
  req: NextApiRequest,
  res: NextApiResponse,
  cardId: string,
) {
  try {
    const piccData = req.query.p as string | undefined
    const sunMac = req.query.c as string | undefined

    console.log(`[BALANCE] Balance request for card: ${cardId}`)

    // Require p/c params for authentication
    if (!piccData || !sunMac) {
      return res.status(400).json({
        status: "ERROR",
        reason: "Missing authentication parameters. Tap your card to check balance.",
      })
    }

    // Validate parameter formats
    if (!/^[0-9a-fA-F]{32}$/.test(piccData)) {
      return res.status(400).json({
        status: "ERROR",
        reason: `Invalid PICCData format: expected 32 hex characters`,
      })
    }

    if (!/^[0-9a-fA-F]{16}$/.test(sunMac)) {
      return res.status(400).json({
        status: "ERROR",
        reason: `Invalid SunMAC format: expected 16 hex characters`,
      })
    }

    // Get card with keys (need keys for tap verification and API key for top-up check)
    const card = await boltcard.store.getCard(cardId, true)

    if (!card) {
      return res.status(404).json({ status: "ERROR", reason: "Card not found" })
    }

    // Check card status
    if (card.status === "WIPED") {
      return res.status(400).json({ status: "ERROR", reason: "Card has been wiped" })
    }

    // Verify card tap using crypto module
    const tapResult = boltcard.crypto.verifyCardTap(
      piccData,
      sunMac,
      card.k1 as string,
      card.k2 as string,
      card.cardUid,
      card.lastCounter,
    )

    if (!tapResult.valid) {
      console.log(`[BALANCE] Card tap verification failed: ${tapResult.error}`)
      return res.status(400).json({
        status: "ERROR",
        reason: tapResult.error || "Card authentication failed",
      })
    }

    // Update last counter for replay protection
    await boltcard.store.updateLastCounter(cardId, tapResult.counter as number)

    // Check and process any pending top-ups before returning balance
    // This detects paid invoices that weren't processed via webhook
    let pendingTopUpsResult = { processed: 0, total: 0, errors: 0 }
    try {
      pendingTopUpsResult = await boltcard.lnurlp.checkAndProcessPendingTopUps(
        cardId,
        card.apiKey as string,
        card.environment,
        card.walletId,
        card.walletCurrency, // Pass currency so we can query BTC wallet for USD cards
      )

      if (pendingTopUpsResult.processed > 0) {
        console.log(
          `[BALANCE] Processed ${pendingTopUpsResult.processed} pending top-up(s) for card ${cardId}`,
        )
      }
    } catch (topUpError: unknown) {
      const message = topUpError instanceof Error ? topUpError.message : "Unknown error"
      console.error(`[BALANCE] Error checking pending top-ups: ${message}`)
      // Continue with balance check even if top-up processing fails
    }

    // Re-fetch card to get updated balance if any top-ups were processed
    let updatedCard = card
    if (pendingTopUpsResult.processed > 0) {
      updatedCard = (await boltcard.store.getCard(cardId)) || card
    }

    // Get last 5 transactions
    const transactions = await boltcard.store.getCardTransactions(cardId, 5)

    // Generate top-up QR data
    const serverUrl = getServerUrl(req)
    const topUpData = boltcard.lnurlp.generateTopUpQR(serverUrl, cardId)

    // Format balance for display
    const displayBalance = formatBalance(updatedCard.balance, updatedCard.walletCurrency)

    // Calculate daily remaining
    const dailyRemaining = updatedCard.dailyLimit
      ? Math.max(0, updatedCard.dailyLimit - updatedCard.dailySpent)
      : null

    console.log(`[BALANCE] Card ${cardId} balance: ${displayBalance}`)

    // Return balance response (no sensitive data)
    const response: {
      card: {
        name: string
        balance: number
        currency: string
        displayBalance: string
        dailyLimit: number | null
        dailyRemaining: number | null
        dailySpent: number
        status: string
        lastUsedAt: number | null
      }
      transactions: {
        type: string
        amount: number
        description: string | null
        createdAt: number
      }[]
      topUp: { lnurl: string; url: string }
      pendingTopUps?: { processed: number; total: number }
    } = {
      card: {
        name: updatedCard.name || "Boltcard",
        balance: updatedCard.balance,
        currency: updatedCard.walletCurrency,
        displayBalance,
        dailyLimit: updatedCard.dailyLimit,
        dailyRemaining,
        dailySpent: updatedCard.dailySpent,
        status: updatedCard.status,
        lastUsedAt: updatedCard.lastUsedAt,
      },
      transactions: transactions.map(
        (tx: {
          type: string
          amount: number
          description: string | null
          createdAt: number
        }) => ({
          type: tx.type,
          amount: tx.amount,
          description: tx.description,
          createdAt: tx.createdAt,
        }),
      ),
      topUp: {
        lnurl: topUpData.qrData,
        url: topUpData.url,
      },
    }

    // Include pending top-ups info if any were processed
    if (pendingTopUpsResult.processed > 0 || pendingTopUpsResult.total > 0) {
      response.pendingTopUps = {
        processed: pendingTopUpsResult.processed,
        total: pendingTopUpsResult.total,
      }
    }

    return res.status(200).json(response)
  } catch (error: unknown) {
    console.error("[BALANCE] Error:", error)
    return res.status(500).json({
      status: "ERROR",
      reason: "Internal server error",
    })
  }
}

/**
 * Format balance for display based on currency
 * @param {number} balance - Balance in smallest unit (sats or cents)
 * @param {string} currency - 'BTC' or 'USD'
 * @returns {string} Formatted display string
 */
function formatBalance(balance: number, currency: string) {
  if (currency === "USD") {
    // Format as dollars with 2 decimal places
    const dollars = (balance / 100).toFixed(2)
    return `$${dollars}`
  } else {
    // Format as sats with thousands separator
    const formatted = balance.toLocaleString("en-US")
    return `${formatted} sats`
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

export default withRateLimit(handler, RATE_LIMIT_READ, "boltcard/balance/[cardId]")
