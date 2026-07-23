import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI from "../../../lib/blink-api"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { apiKey, environment = "production" } = req.body as {
      apiKey: string
      environment?: EnvironmentName
    }

    // Validate required fields
    if (!apiKey) {
      return res.status(400).json({
        error: "Missing required field: apiKey",
      })
    }

    // Get environment-specific API URL
    const validEnvironment = environment === "staging" ? "staging" : "production"
    const apiUrl = getApiUrlForEnvironment(validEnvironment)

    const blinkAPI = new BlinkAPI(apiKey, apiUrl)

    try {
      const wallets = await blinkAPI.getWalletInfo()

      res.status(200).json({
        success: true,
        wallets: wallets,
      })
    } catch (blinkError: unknown) {
      const blinkMessage =
        blinkError instanceof Error ? blinkError.message : "Unknown error"
      console.error("Blink API error:", blinkError)

      return res.status(400).json({
        error: "Failed to fetch wallet information",
        details: blinkMessage,
      })
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Wallets API error:", error)
    res.status(500).json({
      error: "Internal server error",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "blink/wallets")
