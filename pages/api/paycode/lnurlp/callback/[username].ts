/**
 * LNURL-pay callback endpoint - proxies to Blink's callback
 *
 * GET /api/paycode/lnurlp/callback/[username]?amount=X (in millisatoshis)
 *
 * Following LUD-06 spec: https://github.com/lnurl/luds/blob/luds/06.md
 *
 * RESERVED FOR FUTURE USE: paired with /api/paycode/lnurlp/[username]. Retained
 * for possible reintroduction of fixed-amount paycodes after the Paycodes menu
 * and print page were unified into the variable-amount-only PrintPaycodeView.
 */

import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_PUBLIC } from "../../../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Add CORS headers for LNURL compatibility
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  res.setHeader("Content-Type", "application/json")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  if (req.method !== "GET") {
    return res.status(200).json({
      status: "ERROR",
      reason: "Method not allowed",
    })
  }

  try {
    const { username, amount, comment, nostr } = req.query as {
      username: string
      amount: string
      comment?: string
      nostr?: string
    }

    if (!username) {
      return res.status(200).json({
        status: "ERROR",
        reason: "Username required",
      })
    }

    if (!amount) {
      return res.status(200).json({
        status: "ERROR",
        reason: "Amount required",
      })
    }

    console.log("[paycode/callback] Request:", {
      username,
      amount,
      comment: !!comment,
      nostr: !!nostr,
    })

    // Build Blink callback URL with all parameters
    let blinkCallbackUrl = `https://pay.blink.sv/lnurlp/${username}/callback?amount=${amount}`

    if (comment) {
      blinkCallbackUrl += `&comment=${encodeURIComponent(comment)}`
    }

    if (nostr) {
      blinkCallbackUrl += `&nostr=${encodeURIComponent(nostr)}`
    }

    // Proxy to Blink's callback
    const blinkResponse = await fetch(blinkCallbackUrl)
    const blinkData = await blinkResponse.json()

    console.log("[paycode/callback] Blink response:", {
      status: blinkData.status,
      hasPr: !!blinkData.pr,
    })

    // Format response to match LNbits format
    // LNbits doesn't include 'status' or 'verify' fields
    const response: {
      pr: string
      routes: unknown[]
      successAction?: unknown
    } = {
      pr: blinkData.pr,
      routes: blinkData.routes || [],
    }

    // Only include successAction if present
    if (blinkData.successAction) {
      response.successAction = blinkData.successAction
    }

    return res.status(200).json(response)
  } catch (error: unknown) {
    console.error("[paycode/callback] Error:", error)
    return res.status(200).json({
      status: "ERROR",
      reason: "Internal server error",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_PUBLIC)
