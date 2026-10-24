import type { NextApiRequest, NextApiResponse } from "next"

import { getApiUrl } from "../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"

/**
 * API endpoint to fetch the list of supported currencies from Blink
 * This is a public query and doesn't require authentication
 */

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const query = `
      query currencyList {
        currencyList {
          id
          flag
          name
          symbol
          fractionDigits
        }
      }
    `

    const response = await fetch(getApiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    })

    const data = await response.json()

    if (data.errors) {
      console.error("Blink API errors:", data.errors)
      return res.status(500).json({
        error: "Failed to fetch currency list",
        details: data.errors,
      })
    }

    const currencies = data.data?.currencyList || []

    // Cache for 1 hour (currencies don't change often)
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=7200")

    res.status(200).json({
      success: true,
      currencies,
      count: currencies.length,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error fetching currency list:", error)
    res.status(500).json({
      error: "Failed to fetch currency list",
      message,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "blink/currency-list")
