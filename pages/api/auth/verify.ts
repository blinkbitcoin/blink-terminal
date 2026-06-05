import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"
import StorageManager from "../../../lib/storage"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const token = req.cookies["auth-token"]

    if (!token) {
      return res.status(401).json({ error: "No authentication token" })
    }

    const session = AuthManager.verifySession(token)
    if (!session) {
      return res.status(401).json({ error: "Invalid session" })
    }

    // Load user data
    const userData = await StorageManager.loadUserData(session.username)
    if (!userData) {
      return res.status(404).json({ error: "User not found" })
    }

    // Determine auth method from username format
    const authMethod = session.username.startsWith("nostr:") ? "nostr" : "legacy"

    res.status(200).json({
      success: true,
      user: {
        username: session.username,
        lastLogin: userData.lastLogin,
        authMethod, // Include auth method so client knows how user authenticated
      },
    })
  } catch (error: unknown) {
    console.error("Verify error:", error)
    res.status(500).json({ error: "Verification failed" })
  }
}

// Session-status read polled by the client on mount/navigation — use the READ
// tier (120/min), not AUTH (10/min). AUTH is for credential-submitting routes
// (login, challenge, verify-ownership); throttling a benign poll there could
// lock a legitimate user out of the app on a transient render churn.
export default withRateLimit(handler, RATE_LIMIT_READ)
