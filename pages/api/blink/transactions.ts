import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import BlinkAPI from "../../../lib/blink-api"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"
import StorageManager from "../../../lib/storage"

/**
 * Transactions API - Supports both legacy and Nostr authentication
 *
 * Authentication methods:
 * 1. Legacy: auth-token cookie (JWT session)
 * 2. Nostr: X-API-KEY header (passed directly from client)
 *
 * Environment:
 * - Pass environment query parameter ('staging' or 'production')
 * - Defaults to 'production' if not specified
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    let apiKey: string | null = null

    // Method 1: Check for API key in header (Nostr auth)
    const headerApiKey = req.headers["x-api-key"]
    if (headerApiKey) {
      apiKey = headerApiKey as string
    } else {
      // Method 2: Legacy cookie-based auth
      const token = req.cookies["auth-token"]
      const session = AuthManager.verifySession(token)

      if (!session) {
        return res
          .status(401)
          .json({ error: "Unauthorized - no valid session or API key" })
      }

      // Get user's API key from server storage
      const userData = await StorageManager.loadUserData(session.username)
      if (!userData?.apiKey) {
        return res.status(400).json({ error: "No API key found" })
      }
      apiKey = userData.apiKey
    }

    if (!apiKey) {
      return res.status(401).json({ error: "No API key available" })
    }

    // Parse query parameters
    const {
      first = 100,
      after,
      environment = "production",
    } = req.query as {
      first?: string | number
      after?: string
      environment?: EnvironmentName
    }

    // Get environment-specific API URL
    const validEnvironment = environment === "staging" ? "staging" : "production"
    const apiUrl = getApiUrlForEnvironment(validEnvironment)

    // Create Blink API instance with environment-specific URL
    const blink = new BlinkAPI(apiKey, apiUrl)

    // Get transactions
    const transactionData = await blink.getTransactions(parseInt(first as string), after)

    // Debug: Log first transaction's raw createdAt format
    if (transactionData.edges.length > 0) {
      const firstTx = transactionData.edges[0].node
      console.log(
        "[transactions] First tx createdAt:",
        firstTx.createdAt,
        "type:",
        typeof firstTx.createdAt,
      )
    }

    // Format transactions for display (preserving all raw data for CSV export)
    const formattedTransactions = transactionData.edges.map(
      (edge: { node: Record<string, unknown>; cursor: string }) => {
        const tx = edge.node as Record<string, unknown> & {
          settlementAmount: number
          direction: string
          settlementCurrency: string
        }
        return {
          // Display fields (for UI)
          id: tx.id,
          direction: tx.direction,
          status: tx.status,
          amount: BlinkAPI.getTransactionAmount(tx),
          currency: tx.settlementCurrency,
          date: BlinkAPI.formatDate(tx.createdAt as string),
          memo: tx.memo || "-",
          cursor: edge.cursor,
          // Raw fields (for CSV export) - pass through all data
          walletId: tx.walletId,
          settlementAmount: tx.settlementAmount,
          settlementFee: tx.settlementFee,
          settlementCurrency: tx.settlementCurrency,
          settlementDisplayAmount: tx.settlementDisplayAmount,
          settlementDisplayCurrency: tx.settlementDisplayCurrency,
          settlementDisplayFee: tx.settlementDisplayFee,
          createdAt: tx.createdAt,
          initiationVia: tx.initiationVia,
          settlementVia: tx.settlementVia,
        }
      },
    )

    res.status(200).json({
      success: true,
      transactions: formattedTransactions,
      pageInfo: transactionData.pageInfo,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Transactions API error:", error)
    res.status(500).json({
      error: "Failed to fetch transactions",
      details: message,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "blink/transactions")
