/**
 * Lightning Address Endpoint
 *
 * This endpoint handles Lightning Address requests for username@terminal.blinkbtc.com
 * According to LUD-16, wallets query: GET /.well-known/lnurlp/<username>
 *
 * This proxies to our main LNURL-pay endpoint at /api/lnurlp/[username]
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
    // Verify user exists
    let walletInfo: { id: string } | undefined
    try {
      walletInfo = await BlinkAPI.getWalletByUsername(username)
    } catch (err) {
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

    // Build callback URL (use our main lnurlp callback)
    const protocol = req.headers["x-forwarded-proto"] || "https"
    const host = req.headers["x-forwarded-host"] || req.headers.host
    const callback = `${protocol}://${host}/api/lnurlp/${username}/callback`

    // Build metadata
    const metadata = JSON.stringify([
      ["text/plain", `Payment to ${username}`],
      ["text/identifier", `${username}@${host}`],
    ])

    // Return LNURL-pay metadata (LUD-06 + LUD-16)
    return res.status(200).json({
      callback,
      minSendable: 1000, // 1 sat in millisats
      maxSendable: 100000000000, // 1 BTC in millisats
      metadata,
      commentAllowed: 255,
      tag: "payRequest",
    })
  } catch (error: unknown) {
    console.error("[Lightning Address] Error:", error)
    return res.status(500).json({
      status: "ERROR",
      reason: "Internal server error",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_PUBLIC)
