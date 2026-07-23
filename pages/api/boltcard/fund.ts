import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI from "../../../lib/blink-api"
import * as boltcard from "../../../lib/boltcard"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"

/**
 * API endpoint for funding a Boltcard from the Sending Wallet
 *
 * POST /api/boltcard/fund
 *
 * This endpoint sets or increments the card's virtual balance. The actual sats/cents
 * stay in the user's Sending Wallet - the card balance is just a spending limit.
 *
 * Body:
 * - cardId: string - The card ID to fund
 * - amount: number - Amount to add (sats for BTC cards, cents for USD cards) - used with mode='increment'
 * - newBalance: number - Target balance to set - used with mode='set'
 * - mode: 'increment' | 'set' - How to apply the amount (default: 'increment')
 * - description: string - Optional description for the transaction
 *
 * Response includes a 'warning' field if card balance exceeds wallet balance (soft limit).
 */

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const {
      cardId,
      amount,
      newBalance: targetBalance,
      mode = "increment",
      description,
    } = req.body as {
      cardId?: string
      amount?: string | number
      newBalance?: string | number
      mode?: string
      description?: string
    }

    // Validate required fields
    if (!cardId) {
      return res.status(400).json({ error: "Missing cardId" })
    }

    // Get the card with API key for Blink API calls
    const card = await boltcard.store.getCard(cardId, true) // includeKeys=true

    if (!card) {
      return res.status(404).json({ error: "Card not found" })
    }

    // Check card status
    if (card.status === "wiped") {
      return res.status(400).json({ error: "Cannot fund a wiped card" })
    }

    const currentBalance = card.balance || 0
    let newBalance: number
    let fundAmount: number
    let txDescription: string

    if (mode === "set") {
      // Set mode: targetBalance is the new total balance
      if (targetBalance === undefined || targetBalance === null) {
        return res.status(400).json({ error: "Missing newBalance for set mode" })
      }

      newBalance = parseInt(targetBalance as string)

      if (isNaN(newBalance) || newBalance < 0) {
        return res.status(400).json({ error: "newBalance must be a non-negative number" })
      }

      fundAmount = newBalance - currentBalance
      txDescription =
        description ||
        (fundAmount >= 0
          ? `Balance set to ${newBalance} (from ${currentBalance})`
          : `Balance reduced to ${newBalance} (from ${currentBalance})`)
    } else {
      // Increment mode (default): amount is added to current balance
      if (amount === undefined || amount === null) {
        return res.status(400).json({ error: "Missing amount" })
      }

      fundAmount = parseInt(amount as string)

      if (isNaN(fundAmount) || fundAmount <= 0) {
        return res.status(400).json({ error: "Amount must be a positive number" })
      }

      newBalance = currentBalance + fundAmount
      txDescription = description || "Funded from Sending Wallet"
    }

    // Fetch real-time wallet balance from Blink API for validation
    let walletBalance: number | null = null
    let warning: string | null = null

    try {
      const apiUrl = getApiUrlForEnvironment(
        (card.environment || "production") as EnvironmentName,
      )
      const blinkAPI = new BlinkAPI(card.apiKey as string, apiUrl)

      const wallets = await blinkAPI.getWalletInfo()
      const targetWallet = wallets.find(
        (w: { walletCurrency: string; balance: number }) =>
          card.walletCurrency === "USD"
            ? w.walletCurrency === "USD"
            : w.walletCurrency === "BTC",
      )

      walletBalance = targetWallet?.balance || 0

      // Check if over-allocated (soft limit - warn but allow)
      if (newBalance > (walletBalance as number)) {
        const unit = card.walletCurrency === "USD" ? "cents" : "sats"
        const formatValue = (val: number) =>
          card.walletCurrency === "USD"
            ? `$${(val / 100).toFixed(2)}`
            : `${val.toLocaleString()} sats`

        warning = `Card balance (${formatValue(newBalance)}) exceeds wallet balance (${formatValue(walletBalance as number)}). Card can only spend available wallet funds.`
        console.log(
          `⚠️ Card ${cardId} over-allocated: card=${newBalance} ${unit}, wallet=${walletBalance} ${unit}`,
        )
      }
    } catch (apiError: unknown) {
      // Log but don't fail - we can still update the balance
      const message = apiError instanceof Error ? apiError.message : "Unknown error"
      console.warn(`⚠️ Could not fetch wallet balance for validation: ${message}`)
    }

    // Update the card balance
    const success = await boltcard.store.updateCardBalance(cardId, newBalance)

    if (!success) {
      return res.status(500).json({ error: "Failed to update card balance" })
    }

    // Record the transaction (only if balance changed)
    if (fundAmount !== 0) {
      await boltcard.store.recordTransaction(cardId, {
        type: fundAmount > 0 ? boltcard.TxType.TOPUP : boltcard.TxType.ADJUST,
        amount: Math.abs(fundAmount),
        balanceAfter: newBalance,
        description: txDescription,
      })
    }

    const unit = card.walletCurrency === "USD" ? "cents" : "sats"
    console.log(`✅ Card balance updated:`, {
      cardId,
      cardName: card.name,
      mode,
      previousBalance: currentBalance,
      newBalance,
      change: fundAmount,
      currency: card.walletCurrency,
      walletBalance,
      overAllocated: walletBalance !== null && newBalance > walletBalance,
    })

    // Get updated card data
    const updatedCard = await boltcard.store.getCard(cardId)

    if (!updatedCard) {
      return res.status(404).json({ error: "Card not found after funding" })
    }

    res.status(200).json({
      success: true,
      message:
        mode === "set"
          ? `Card balance set to ${newBalance} ${unit}`
          : `Card funded with ${fundAmount} ${unit}`,
      warning, // Include soft limit warning if over-allocated
      walletBalance, // Include wallet balance for client reference
      card: {
        id: updatedCard.id,
        name: updatedCard.name,
        balance: updatedCard.balance,
        walletCurrency: updatedCard.walletCurrency,
        status: updatedCard.status,
      },
      transaction:
        fundAmount !== 0
          ? {
              type: fundAmount > 0 ? "topup" : "adjust",
              amount: Math.abs(fundAmount),
              balanceAfter: newBalance,
            }
          : null,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Fund card error:", error)
    res.status(500).json({
      error: "Failed to fund card",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "boltcard/fund")
