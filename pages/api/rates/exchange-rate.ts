/**
 * Unified Exchange Rate API
 *
 * Single endpoint for all exchange rate requests.
 * Routes to appropriate provider (Blink, Citrusrate, etc.) based on currency.
 * Includes Redis caching for performance.
 *
 * POST /api/rates/exchange-rate
 * Body: { currency: "MZN" | "MZN_STREET" | "NGN_CITRUS" | "AOA", apiKey?: string, useBlinkpos?: boolean }
 *
 * Routing:
 * - MZN_STREET -> Citrusrate black market rate
 * - NGN_CITRUS -> Citrusrate official rate (alternative to Blink)
 * - AOA, BIF, etc. -> Citrusrate official rate (Citrusrate-exclusive currencies)
 * - USD, EUR, NGN, etc. -> Blink API rate
 *
 * Response: { success: true, currency: "MZN_STREET", satPriceInCurrency: 0.069..., provider: "citrusrate_street" }
 */

import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI from "../../../lib/blink-api"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"
import { getCachedRate, setCachedRate } from "../../../lib/rate-providers/cache"
import { getCitrusrateAPI } from "../../../lib/rate-providers/citrusrate"
import {
  getProviderForCurrency,
  getBaseCurrency,
} from "../../../lib/rate-providers/index"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { currency, apiKey, useBlinkpos } = req.body as {
      currency: string
      apiKey?: string
      useBlinkpos?: boolean
    }

    if (!currency) {
      return res.status(400).json({ error: "Currency parameter is required" })
    }

    // Handle BTC/SAT specially - always 1 sat = 1 sat
    if (currency === "BTC" || currency === "SAT") {
      return res.status(200).json({
        success: true,
        currency: currency.toUpperCase(),
        satPriceInCurrency: 1,
        provider: "direct",
      })
    }

    // Determine which provider to use
    const provider = getProviderForCurrency(currency)
    const providerId = provider.id

    // Check cache first
    const cachedRate = await getCachedRate(providerId, currency)
    if (cachedRate) {
      return res.status(200).json({
        success: true,
        currency: currency.toUpperCase(),
        satPriceInCurrency: cachedRate.satPriceInCurrency,
        provider: providerId,
        cached: true,
      })
    }

    let rateData: { satPriceInCurrency: number; currency?: string; provider?: string }

    if (providerId === "citrusrate_street") {
      // Use Citrusrate for street/black market rate currencies (e.g., MZN_STREET)
      const citrusrate = getCitrusrateAPI()
      const baseCurrency = getBaseCurrency(currency) // MZN_STREET -> MZN

      try {
        rateData = await citrusrate.getBlackMarketRate(baseCurrency)
        rateData.currency = currency // Keep original currency ID (MZN_STREET)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error"
        console.error("Citrusrate black market API error:", error)
        return res.status(502).json({
          error: `Failed to fetch street rate for ${baseCurrency}: ${message}`,
          success: false,
          provider: "citrusrate_street",
        })
      }
    } else if (providerId === "citrusrate_official") {
      // Use Citrusrate for official rates:
      // - Citrusrate-exclusive currencies (AOA, BIF, BWP, etc.)
      // - Citrusrate alternative currencies (NGN_CITRUS, KES_CITRUS, etc.)
      const citrusrate = getCitrusrateAPI()
      const baseCurrency = getBaseCurrency(currency) // NGN_CITRUS -> NGN, AOA -> AOA

      try {
        rateData = await citrusrate.getOfficialRate(baseCurrency)
        rateData.currency = currency // Keep original currency ID
        rateData.provider = "citrusrate"
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error"
        console.error("Citrusrate official API error:", error)
        return res.status(502).json({
          error: `Failed to fetch Citrusrate rate for ${baseCurrency}: ${message}`,
          success: false,
          provider: "citrusrate_official",
        })
      }
    } else {
      // Use Blink API (default provider)
      // First try to use public unauthenticated endpoint (mainnet)
      // This works for all standard currencies and doesn't require an API key
      try {
        rateData = await BlinkAPI.getExchangeRatePublic(currency)
        rateData.provider = "blink_public"
      } catch (publicError: unknown) {
        const publicMessage =
          publicError instanceof Error ? publicError.message : "Unknown error"
        console.warn("Public exchange rate failed, trying with API key:", publicMessage)

        // Fallback to authenticated endpoint if public fails
        let effectiveApiKey = apiKey

        // For NWC-only users (no user API key), use BlinkPOS credentials
        if (!effectiveApiKey && useBlinkpos) {
          effectiveApiKey = process.env.BLINKPOS_API_KEY
          if (!effectiveApiKey) {
            return res.status(500).json({ error: "BlinkPOS credentials not configured" })
          }
        }

        if (!effectiveApiKey) {
          // If no API key and public endpoint failed, return the public error
          return res.status(502).json({
            error: `Failed to fetch rate for ${currency}: ${publicMessage}`,
            success: false,
            provider: "blink_public",
          })
        }

        try {
          const blinkAPI = new BlinkAPI(effectiveApiKey)
          rateData = await blinkAPI.getExchangeRate(currency)
          rateData.provider = "blink"
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error"
          console.error("Blink API error:", error)
          return res.status(502).json({
            error: `Failed to fetch rate for ${currency}: ${message}`,
            success: false,
            provider: "blink",
          })
        }
      }
    }

    // Cache the rate
    await setCachedRate(providerId, currency, rateData)

    res.status(200).json({
      success: true,
      currency: currency.toUpperCase(),
      satPriceInCurrency: rateData.satPriceInCurrency,
      provider: rateData.provider || providerId,
      cached: false,
    })
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch exchange rate"
    console.error("Exchange rate API error:", error)
    res.status(500).json({
      error: message,
      success: false,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "rates/exchange-rate")
