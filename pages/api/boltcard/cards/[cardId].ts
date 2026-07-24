import type { NextApiRequest, NextApiResponse } from "next"

import * as boltcard from "../../../../lib/boltcard"
import { withRateLimit, RATE_LIMIT_READ } from "../../../../lib/rate-limit"

/**
 * API endpoint for individual Boltcard management
 *
 * GET /api/boltcard/cards/[cardId]
 * - Get card details
 *
 * PUT /api/boltcard/cards/[cardId]
 * - Update card settings (name, limits)
 *
 * DELETE /api/boltcard/cards/[cardId]
 * - Wipe/disable card
 *
 * POST /api/boltcard/cards/[cardId]
 * - Actions: activate, disable, enable, topup
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cardId = req.query.cardId as string | undefined

  if (!cardId) {
    return res.status(400).json({ error: "Missing cardId" })
  }

  switch (req.method) {
    case "GET":
      return handleGet(req, res, cardId)
    case "PUT":
      return handleUpdate(req, res, cardId)
    case "DELETE":
      return handleDelete(req, res, cardId)
    case "POST":
      return handleAction(req, res, cardId)
    default:
      return res.status(405).json({ error: "Method not allowed" })
  }
}

/**
 * GET - Get card details
 */
async function handleGet(req: NextApiRequest, res: NextApiResponse, cardId: string) {
  try {
    const card = await boltcard.store.getCard(cardId)

    if (!card) {
      return res.status(404).json({ error: "Card not found" })
    }

    // Get recent transactions
    const transactions = await boltcard.store.getCardTransactions(cardId, 10)

    // Generate top-up QR if requested
    let topUpQR = null
    if (req.query.includeTopUpQR === "true") {
      const serverUrl = getServerUrl(req)
      topUpQR = boltcard.lnurlp.generateTopUpQR(serverUrl, cardId)
    }

    // Build card response
    // Use cardIdHash by default for privacy, only include cardUid if explicitly requested
    const includeUid = req.query.includeUid === "true"

    const cardResponse: Record<string, unknown> = {
      id: card.id,
      cardIdHash: card.cardIdHash, // Privacy-preserving identifier
      name: card.name,
      walletCurrency: card.walletCurrency,
      balance: card.balance,
      maxTxAmount: card.maxTxAmount,
      dailyLimit: card.dailyLimit,
      dailySpent: card.dailySpent,
      dailyResetAt: card.dailyResetAt,
      status: card.status,
      version: card.version,
      createdAt: card.createdAt,
      activatedAt: card.activatedAt,
      lastUsedAt: card.lastUsedAt,
      environment: card.environment,
    }

    // Only include raw UID if explicitly requested (e.g., for debugging/admin)
    if (includeUid) {
      cardResponse.cardUid = card.cardUid
    }

    res.status(200).json({
      success: true,
      card: cardResponse,
      transactions,
      topUpQR,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Get card error:", error)
    res.status(500).json({
      error: "Failed to get card",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

/**
 * PUT - Update card settings
 */
async function handleUpdate(req: NextApiRequest, res: NextApiResponse, cardId: string) {
  try {
    const { name, maxTxAmount, dailyLimit } = req.body as {
      name?: string
      maxTxAmount?: string
      dailyLimit?: string
    }

    // Check card exists
    const card = await boltcard.store.getCard(cardId)
    if (!card) {
      return res.status(404).json({ error: "Card not found" })
    }

    // Build updates object
    const updates: Record<string, string | number | null> = {}
    if (name !== undefined) updates.name = name
    if (maxTxAmount !== undefined)
      updates.maxTxAmount = maxTxAmount ? parseInt(maxTxAmount) : null
    if (dailyLimit !== undefined)
      updates.dailyLimit = dailyLimit ? parseInt(dailyLimit) : null

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid updates provided" })
    }

    const success = await boltcard.store.updateCard(cardId, updates)

    if (!success) {
      return res.status(500).json({ error: "Failed to update card" })
    }

    // Get updated card
    const updatedCard = await boltcard.store.getCard(cardId)

    if (!updatedCard) {
      return res.status(404).json({ error: "Card not found after update" })
    }

    console.log("✅ Card updated:", { cardId, updates })

    res.status(200).json({
      success: true,
      card: {
        id: updatedCard.id,
        name: updatedCard.name,
        maxTxAmount: updatedCard.maxTxAmount,
        dailyLimit: updatedCard.dailyLimit,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Update card error:", error)
    res.status(500).json({
      error: "Failed to update card",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

/**
 * DELETE - Wipe card
 */
async function handleDelete(req: NextApiRequest, res: NextApiResponse, cardId: string) {
  try {
    const card = await boltcard.store.getCard(cardId)
    if (!card) {
      return res.status(404).json({ error: "Card not found" })
    }

    const success = await boltcard.store.wipeCard(cardId)

    if (!success) {
      return res.status(500).json({ error: "Failed to wipe card" })
    }

    console.log("✅ Card wiped:", cardId)

    res.status(200).json({
      success: true,
      message: "Card wiped successfully",
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Wipe card error:", error)
    res.status(500).json({
      error: "Failed to wipe card",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

/**
 * POST - Card actions (activate, disable, enable, adjust balance)
 */
async function handleAction(req: NextApiRequest, res: NextApiResponse, cardId: string) {
  try {
    const { action, amount, description } = req.body as {
      action?: string
      amount?: string
      description?: string
    }

    if (!action) {
      return res.status(400).json({ error: "Missing action parameter" })
    }

    const card = await boltcard.store.getCard(cardId)
    if (!card) {
      return res.status(404).json({ error: "Card not found" })
    }

    let success = false
    let message = ""

    switch (action) {
      case "activate":
        success = await boltcard.store.activateCard(cardId)
        message = success ? "Card activated" : "Failed to activate card"
        break

      case "disable":
        success = await boltcard.store.disableCard(cardId)
        message = success ? "Card disabled" : "Failed to disable card"
        break

      case "enable":
        success = await boltcard.store.enableCard(cardId)
        message = success ? "Card enabled" : "Failed to enable card"
        break

      case "adjust": {
        // Manual balance adjustment (admin function)
        if (amount === undefined) {
          return res.status(400).json({ error: "Missing amount for balance adjustment" })
        }
        const adjustAmount = parseInt(amount)
        const newBalance = card.balance + adjustAmount

        if (newBalance < 0) {
          return res
            .status(400)
            .json({ error: "Adjustment would result in negative balance" })
        }

        success = await boltcard.store.updateCardBalance(cardId, newBalance)
        if (success) {
          await boltcard.store.recordTransaction(cardId, {
            type: boltcard.TxType.ADJUST,
            amount: adjustAmount,
            balanceAfter: newBalance,
            description: description || "Manual balance adjustment",
          })
        }
        message = success
          ? `Balance adjusted by ${adjustAmount}`
          : "Failed to adjust balance"
        break
      }

      case "resetDaily":
        success = await boltcard.store.resetDailySpent(cardId)
        message = success ? "Daily spending reset" : "Failed to reset daily spending"
        break

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` })
    }

    if (!success) {
      return res.status(500).json({ error: message })
    }

    // Get updated card
    const updatedCard = await boltcard.store.getCard(cardId)

    if (!updatedCard) {
      return res.status(404).json({ error: "Card not found after action" })
    }

    console.log("✅ Card action:", { cardId, action, success })

    res.status(200).json({
      success: true,
      message,
      card: {
        id: updatedCard.id,
        status: updatedCard.status,
        balance: updatedCard.balance,
        dailySpent: updatedCard.dailySpent,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Card action error:", error)
    res.status(500).json({
      error: "Failed to perform action",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
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

export default withRateLimit(handler, RATE_LIMIT_READ, "boltcard/cards/[cardId]")
