/**
 * Custom LNURL-pay endpoint that supports fixed amounts
 * Proxies to Blink's LNURL-pay but allows setting min=max for fixed amounts
 *
 * GET /api/paycode/lnurlp/[username]?amount=1000 (optional, in sats)
 *
 * Following LUD-06 spec: https://github.com/lnurl/luds/blob/luds/06.md
 *
 * RESERVED FOR FUTURE USE: fixed-amount paycodes were removed from the UI when
 * the Paycodes menu and the `/[username]/print` page were unified into the
 * shared, variable-amount-only PrintPaycodeView. This route (and its callback
 * sibling) is intentionally retained so fixed amounts can be reintroduced
 * without re-implementing the server side.
 * NOTE: the upstream fetch below currently targets pay.blink.sv, which resolves
 * custodial accounts only — reintroducing fixed amounts for self-custodial
 * (Spark) users would require pointing this at the LN-address domain (blink.sv).
 */

import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_PUBLIC } from "../../../../lib/rate-limit"

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
    const { username, amount } = req.query as { username: string; amount?: string }

    if (!username) {
      return res.status(200).json({
        status: "ERROR",
        reason: "Username required",
      })
    }

    console.log("[paycode/lnurlp] Request:", { username, amount })

    // Fetch the original LNURL-pay metadata from Blink
    const blinkResponse = await fetch(
      `https://pay.blink.sv/.well-known/lnurlp/${username}`,
    )

    if (!blinkResponse.ok) {
      console.error("[paycode/lnurlp] Blink error:", blinkResponse.status)
      return res.status(200).json({
        status: "ERROR",
        reason: "User not found",
      })
    }

    const blinkData = await blinkResponse.json()

    // Build our callback URL
    const protocol = req.headers["x-forwarded-proto"] || "https"
    const host = req.headers["x-forwarded-host"] || req.headers.host
    const callbackUrl = `${protocol}://${host}/api/paycode/lnurlp/callback/${username}`

    // If amount is specified, set min=max for fixed amount
    let minSendable = blinkData.minSendable
    let maxSendable = blinkData.maxSendable
    let isFixedAmount = false

    if (amount) {
      const amountSats = parseInt(amount)
      if (!isNaN(amountSats) && amountSats > 0) {
        const amountMsats = amountSats * 1000 // Convert to millisatoshis
        minSendable = amountMsats
        maxSendable = amountMsats
        isFixedAmount = true
        console.log(
          "[paycode/lnurlp] Fixed amount:",
          amountSats,
          "sats =",
          amountMsats,
          "msats",
        )
      }
    }

    // For fixed-amount paycodes, we need to modify the metadata to remove the
    // text/identifier field. This prevents Blink mobile from detecting it as a
    // Blink user and converting to intraledger payment (which loses the fixed amount).
    let metadata = blinkData.metadata
    if (isFixedAmount) {
      try {
        const metadataArray = JSON.parse(blinkData.metadata)
        // Remove text/identifier entries to prevent Blink intraledger detection
        const filteredMetadata = metadataArray.filter(
          (item: [string, string]) => item[0] !== "text/identifier",
        )
        metadata = JSON.stringify(filteredMetadata)
        console.log(
          "[paycode/lnurlp] Modified metadata for fixed amount (removed text/identifier)",
        )
      } catch (e) {
        console.error("[paycode/lnurlp] Failed to parse metadata:", e)
      }
    }

    // Return LNURL-pay response with our callback
    // Match LNbits format: only include optional fields when they have meaningful values
    const response: {
      tag: string
      callback: string
      minSendable: number
      maxSendable: number
      metadata: string
      commentAllowed?: number
      allowsNostr?: boolean
      nostrPubkey?: string
    } = {
      tag: "payRequest", // LNbits puts tag first
      callback: callbackUrl,
      minSendable,
      maxSendable,
      metadata,
    }

    // Only include commentAllowed if > 0 (LNbits omits when 0)
    if (blinkData.commentAllowed && blinkData.commentAllowed > 0) {
      response.commentAllowed = blinkData.commentAllowed
    }

    // Only include nostr fields if enabled (LNbits omits when not applicable)
    if (blinkData.allowsNostr && blinkData.nostrPubkey) {
      response.allowsNostr = true
      response.nostrPubkey = blinkData.nostrPubkey
    }

    console.log("[paycode/lnurlp] Response:", {
      callback: callbackUrl,
      minSendable,
      maxSendable,
    })

    return res.status(200).json(response)
  } catch (error: unknown) {
    console.error("[paycode/lnurlp] Error:", error)
    return res.status(200).json({
      status: "ERROR",
      reason: "Internal server error",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_PUBLIC)
