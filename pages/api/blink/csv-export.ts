import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import BlinkAPI from "../../../lib/blink-api"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"
import StorageManager from "../../../lib/storage"

/**
 * CSV Export API - Supports both legacy and Nostr authentication
 *
 * Authentication methods:
 * 1. Legacy: auth-token cookie (JWT session)
 * 2. Nostr: X-API-KEY header (secure header-based auth)
 *
 * Note: API keys should NEVER be accepted in request body
 * as bodies are commonly logged by proxies, CDNs, and WAFs.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    let apiKey: string | null = null

    // Method 1: Check for API key in header (Nostr auth)
    const headerApiKey = req.headers["x-api-key"]
    if (headerApiKey) {
      apiKey = headerApiKey as string
    }
    // Method 2: Legacy cookie-based auth
    else {
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

    // Get wallet IDs from request body
    const { walletIds } = req.body as { walletIds: string[] }

    if (!walletIds || !Array.isArray(walletIds) || walletIds.length === 0) {
      return res.status(400).json({ error: "walletIds array is required" })
    }

    // Create Blink API instance
    const blink = new BlinkAPI(apiKey)

    // Get CSV data from Blink (base64 encoded)
    const csvBase64 = await blink.getCsvTransactions(walletIds)

    if (!csvBase64) {
      return res.status(404).json({ error: "No CSV data available" })
    }

    // Decode base64 to get the actual CSV content
    const csvContent = Buffer.from(csvBase64, "base64").toString("utf-8")

    res.status(200).json({
      success: true,
      csv: csvContent,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("CSV Export API error:", error)
    res.status(500).json({
      error: "Failed to export CSV",
      details: message,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "blink/csv-export")
