/**
 * LNURL-pay Metadata Endpoint
 *
 * Provides LNURL-pay metadata for any Blink username.
 * Enables Lightning Address support: username@terminal.blinkbtc.com
 *
 * GET /api/lnurlp/[username]
 * Returns LNURL-pay metadata according to LUD-06
 */

import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI from "../../../../lib/blink-api"
import { withRateLimit, RATE_LIMIT_PUBLIC } from "../../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ status: "ERROR", reason: "Method not allowed" })
  }

  const { username } = req.query as { username: string }

  if (!username) {
    return res.status(400).json({ status: "ERROR", reason: "Username is required" })
  }

  // Basic username validation
  const usernameRegex = /^[a-zA-Z0-9_]{3,30}$/
  if (!usernameRegex.test(username)) {
    return res.status(400).json({ status: "ERROR", reason: "Invalid username format" })
  }

  try {
    // Verify user exists by querying Blink API
    let walletInfo: { id: string } | undefined
    try {
      walletInfo = await BlinkAPI.getWalletByUsername(username)
    } catch (_err) {
      console.log(`[LNURL] User not found: ${username}`)
      return res.status(404).json({
        status: "ERROR",
        reason: `Couldn't find user '${username}'.`,
      })
    }

    if (!walletInfo?.id) {
      return res.status(404).json({
        status: "ERROR",
        reason: `Couldn't find user '${username}'.`,
      })
    }

    // Build callback URL
    const protocol = req.headers["x-forwarded-proto"] || "https"
    const host = req.headers["x-forwarded-host"] || req.headers.host
    const callback = `${protocol}://${host}/api/lnurlp/${username}/callback`

    // Build metadata
    const metadata = JSON.stringify([
      ["text/plain", `Payment to ${username}`],
      ["text/identifier", `${username}@${host}`],
    ])

    // LNURL-pay response (LUD-06)
    return res.status(200).json({
      callback,
      minSendable: 1000, // 1 sat in millisats
      maxSendable: 100000000000, // 1 BTC in millisats
      metadata,
      commentAllowed: 255, // Allow payment comments up to 255 chars
      tag: "payRequest",
    })
  } catch (error: unknown) {
    console.error("[LNURL] Error:", error)
    return res.status(500).json({
      status: "ERROR",
      reason: "Internal server error",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_PUBLIC, "lnurlp/[username]")
