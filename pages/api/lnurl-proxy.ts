import {
  getParams,
  type LNURLWithdrawParams,
  type LNURLResponse,
  type LNURLChannelParams,
  type LNURLAuthParams,
  type LNURLPayParams,
} from "js-lnurl"
import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_PUBLIC } from "../../lib/rate-limit"

type LNURLResult =
  | LNURLResponse
  | LNURLChannelParams
  | LNURLWithdrawParams
  | LNURLAuthParams
  | LNURLPayParams

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { lnurl, paymentRequest } = req.body as {
      lnurl: string
      paymentRequest: string
    }

    if (!lnurl) {
      return res.status(400).json({ error: "Missing lnurl parameter" })
    }

    if (!paymentRequest) {
      return res.status(400).json({ error: "Missing paymentRequest parameter" })
    }

    console.log("Processing LNURL withdraw request for Boltcard...")
    console.log("LNURL:", lnurl)
    console.log("Payment Request (invoice):", paymentRequest.substring(0, 50) + "...")

    // Parse the LNURL to get the withdraw parameters
    let lnurlParams: LNURLResult
    try {
      lnurlParams = await getParams(lnurl)
    } catch (parseError: unknown) {
      const parseMessage =
        parseError instanceof Error ? parseError.message : "Unknown error"
      console.error("Failed to parse LNURL:", parseMessage)
      console.log("Raw LNURL that failed:", lnurl)

      // Check if this looks like a Boltcard URL with missing/invalid params
      if (lnurl.includes("/api/boltcard/lnurlw/")) {
        // Extract more details about what's wrong
        const urlMatch = lnurl.match(/[?&]p=([^&]*)/)
        const cmacMatch = lnurl.match(/[?&]c=([^&]*)/)

        const diagnosis: string[] = []
        if (!urlMatch || !urlMatch[1]) {
          diagnosis.push("missing p (PICCData) parameter")
        } else if (urlMatch[1].length !== 32) {
          diagnosis.push(
            `p parameter has wrong length (${urlMatch[1].length} chars, expected 32)`,
          )
        }
        if (!cmacMatch || !cmacMatch[1]) {
          diagnosis.push("missing c (CMAC) parameter")
        } else if (cmacMatch[1].length !== 16) {
          diagnosis.push(
            `c parameter has wrong length (${cmacMatch[1].length} chars, expected 16)`,
          )
        }

        return res.status(400).json({
          error: "Card authentication failed",
          reason: `Boltcard URL validation failed: ${diagnosis.join(", ")}. The card may need to be reprogrammed with correct SUN/SDM settings.`,
          details: parseMessage,
        })
      }

      return res.status(400).json({
        error: "Failed to parse LNURL",
        reason: parseMessage,
      })
    }

    // Validate that it's a withdraw request (Boltcard)
    if (
      !("tag" in lnurlParams) ||
      (lnurlParams as LNURLWithdrawParams).tag !== "withdrawRequest"
    ) {
      console.log("LNURL params received:", JSON.stringify(lnurlParams, null, 2))
      return res.status(400).json({
        error: "Not a properly configured LNURL withdraw tag",
        reason:
          "This is not a valid Boltcard or LNURL-withdraw compatible card. The card may have authentication issues (missing or invalid p/c parameters).",
        received:
          "tag" in lnurlParams ? (lnurlParams as LNURLWithdrawParams).tag : "no tag",
      })
    }

    const withdrawParams = lnurlParams as LNURLWithdrawParams
    const { callback, k1 } = withdrawParams

    // Build the callback URL with the required parameters
    const urlObject = new URL(callback)
    const searchParams = urlObject.searchParams
    searchParams.set("k1", k1)
    searchParams.set("pr", paymentRequest)

    const url = urlObject.toString()

    console.log("Calling Boltcard callback URL...")

    // Make the request to the Boltcard service
    const result = await fetch(url)
    const data = await result.json()

    console.log("Boltcard callback response:", data)

    if (result.ok) {
      return res.status(200).json(data)
    } else {
      return res.status(400).json(data)
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error processing LNURL request:", error)
    return res.status(500).json({
      error: "Failed to process LNURL request",
      message,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_PUBLIC, "lnurl-proxy")
