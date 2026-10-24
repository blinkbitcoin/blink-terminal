/**
 * Session Check API
 *
 * Simple endpoint to check if a valid session exists.
 * Returns session information if authenticated.
 */

import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import { withRateLimit, RATE_LIMIT_AUTH } from "../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const token = req.cookies?.["auth-token"]

    if (!token) {
      return res.status(200).json({ authenticated: false })
    }

    const session = AuthManager.verifySession(token)

    if (!session) {
      return res.status(200).json({ authenticated: false })
    }

    // Extract pubkey if it's a Nostr session
    let pubkey: string | null = null
    if (session.username?.startsWith("nostr:")) {
      pubkey = session.username.replace("nostr:", "")
    }

    return res.status(200).json({
      authenticated: true,
      username: session.username,
      pubkey,
      isNostrSession: !!pubkey,
    })
  } catch (error: unknown) {
    console.error("[auth/session] Error:", error)
    return res.status(200).json({ authenticated: false })
  }
}

export default withRateLimit(handler, RATE_LIMIT_AUTH, "auth/session")
