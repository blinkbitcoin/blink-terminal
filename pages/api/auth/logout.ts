import type { NextApiRequest, NextApiResponse } from "next"

import { buildClearSessionCookie } from "../../../lib/auth/cookies"
import { withRateLimit, RATE_LIMIT_AUTH } from "../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  // Clear authentication cookie (centralized attributes)
  res.setHeader("Set-Cookie", buildClearSessionCookie())

  res.status(200).json({
    success: true,
    message: "Logged out successfully",
  })
}

export default withRateLimit(handler, RATE_LIMIT_AUTH)
