import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import BlinkAPI from "../../../lib/blink-api"
import { getApiUrlForEnvironment } from "../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"
import StorageManager from "../../../lib/storage"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    // Get user from JWT token
    const token = req.cookies["auth-token"]
    if (!token) {
      return res.status(401).json({ error: "No authentication token" })
    }

    const session = AuthManager.verifySession(token)
    if (!session) {
      return res.status(401).json({ error: "Invalid token" })
    }

    // Get user's API key from server storage
    const userData = await StorageManager.loadUserData(session.username)
    if (!userData?.apiKey) {
      return res.status(400).json({ error: "No API key found" })
    }

    // Get environment from query parameter (client passes it)
    const environment = req.query.environment === "staging" ? "staging" : "production"
    const apiUrl = getApiUrlForEnvironment(environment)

    // Use the API key to fetch user info with environment-specific URL
    const blinkAPI = new BlinkAPI(userData.apiKey, apiUrl)
    const userInfo = await blinkAPI.getMe()

    if (!userInfo) {
      return res.status(400).json({ error: "Failed to fetch user information" })
    }

    res.status(200).json({
      success: true,
      user: userInfo,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Me API error:", error)
    res.status(500).json({
      error: message || "Failed to fetch user information",
      success: false,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "blink/me")
