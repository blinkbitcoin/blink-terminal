/**
 * Citrusrate API Client
 *
 * Fetches official and black market / street exchange rates from Citrusrate API.
 * Docs: https://citrusrate.com/llm.txt
 */

import { getCitrusrateFractionDigits } from "./index"

const SATS_PER_BTC: number = 100_000_000

/**
 * Validate a raw upstream rate before it is converted or cached.
 * The API contract says number, but a malformed payload (string, object,
 * null) would otherwise produce NaN, which JSON.stringify serializes as null
 * — and a null satPriceInCurrency would poison the shared cache for up to the
 * full TTL and be returned to checkout math as a successful response.
 */
function toValidBtcRate(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null
  }
  return raw
}

/**
 * Convert a fiat-per-BTC rate to the price of 1 sat in MINOR units.
 *
 * Consumers (POS, Voucher, MultiVoucher) scale entered amounts by
 * 10^fractionDigits before dividing by satPriceInCurrency, so the conversion
 * must use the currency's actual denomination: x100 for 2-decimal currencies
 * (cents), x1 for zero-decimal (VUV, RWF, UGX, XAF, XOF), x1000 for
 * 3-decimal (LYD, TND). A fixed x100 would misprice invoices by 100x/10x.
 */
function toSatPriceInMinorUnits(btcRate: number, fractionDigits: number): number {
  return (btcRate / SATS_PER_BTC) * 10 ** fractionDigits
}

export interface CitrusrateRateData {
  currency: string
  satPriceInCurrency: number
  btcRate: number
  timestamp: string
  source: string
  provider: string
}

export interface CitrusrateAllRatesResponse {
  rates: Record<string, CitrusrateRateData>
  timestamp: string
}

export interface CitrusrateError extends Error {
  status?: number
  retryAfter?: number
}

export class CitrusrateAPI {
  apiKey: string | undefined
  baseUrl: string
  timeout: number

  constructor() {
    this.apiKey = process.env.CITRUSRATE_API_KEY
    this.baseUrl = process.env.CITRUSRATE_BASE_URL || "https://api.citrusrate.com"
    this.timeout = 10000 // 10 second timeout as recommended
  }

  /**
   * Make authenticated request to Citrusrate API
   * @param endpoint - API endpoint path
   * @param params - Query parameters
   * @returns API response data
   */
  async request(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
    if (!this.apiKey) {
      throw new Error("Citrusrate API key not configured (CITRUSRATE_API_KEY is not set)")
    }

    const url: URL = new URL(`${this.baseUrl}${endpoint}`)
    Object.entries(params).forEach(([key, value]: [string, string]) => {
      url.searchParams.append(key, value)
    })

    const controller: AbortController = new AbortController()

    // The deadline must cover the ENTIRE lifecycle — fetch, status handling,
    // AND body parsing. Aborting on timer expiry alone is not sufficient:
    // once fetch() resolves with headers, response.json() has no deadline of
    // its own, and a stalled/truncated body would hang the caller forever
    // (for the poller: the tick never settles and no further tick is ever
    // scheduled). Racing the deadline rejects the request even when the body
    // stream never completes; the abort still fires for real-network cleanup.
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const deadline: Promise<never> = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort()
        reject(new Error("Citrusrate API request timed out"))
      }, this.timeout)
    })

    try {
      return await Promise.race([this.doRequest(url, controller.signal), deadline])
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Perform the HTTP request and validate the response envelope.
   * Separated from request() so the timeout race wraps body parsing too.
   */
  private async doRequest(url: URL, signal: AbortSignal): Promise<unknown> {
    const response: Response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": this.apiKey as string,
        "Content-Type": "application/json",
      },
      signal,
    })

    if (!response.ok) {
      const errorData: Record<string, unknown> = (await response
        .json()
        .catch(() => ({}))) as Record<string, unknown>

      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter: number = (errorData.retryAfter as number) || 60
        const error = new Error(
          `Rate limited. Retry after ${retryAfter} seconds.`,
        ) as CitrusrateError
        error.status = 429
        error.retryAfter = retryAfter
        throw error
      }

      throw new Error(
        (errorData.message as string) || `Citrusrate API error: ${response.status}`,
      )
    }

    const data: Record<string, unknown> = (await response.json()) as Record<
      string,
      unknown
    >

    if (data.status !== "success") {
      throw new Error((data.message as string) || "Citrusrate API returned error status")
    }

    return data.data
  }

  /**
   * Get black market rate for a specific currency
   * @param currency - 3-letter currency code (e.g., 'MZN')
   * @returns Rate data with satPriceInCurrency
   */
  async getBlackMarketRate(currency: string): Promise<CitrusrateRateData> {
    // GET /v1/btc/blackmarket?currency=MZN
    // Response: { pair: "BTC/MZN", rate: 6903525.51, timestamp: "...", source: "estimated" }

    const data: Record<string, unknown> = (await this.request("/v1/btc/blackmarket", {
      currency: currency.toUpperCase(),
    })) as Record<string, unknown>

    const btcRate: number | null = toValidBtcRate(data.rate)
    if (btcRate === null) {
      throw new Error(`No valid black market rate available for ${currency}`)
    }

    // Convert to satPriceInCurrency (price of 1 sat in fiat MINOR units)
    const satPriceInCurrency: number = toSatPriceInMinorUnits(
      btcRate,
      getCitrusrateFractionDigits(currency),
    )

    return {
      currency: currency.toUpperCase(),
      satPriceInCurrency,
      btcRate,
      timestamp: data.timestamp as string,
      source: (data.source as string) || "citrusrate_blackmarket",
      provider: "citrusrate_street",
    }
  }

  /**
   * Get official rate for a specific currency (not black market)
   * @param currency - 3-letter currency code
   * @returns Rate data
   */
  async getOfficialRate(currency: string): Promise<CitrusrateRateData> {
    // GET /v1/btc?currency=NGN
    const data: Record<string, unknown> = (await this.request("/v1/btc", {
      currency: currency.toUpperCase(),
    })) as Record<string, unknown>

    const btcRate: number | null = toValidBtcRate(data.rate)
    if (btcRate === null) {
      throw new Error(`No valid official rate available for ${currency}`)
    }

    const satPriceInCurrency: number = toSatPriceInMinorUnits(
      btcRate,
      getCitrusrateFractionDigits(currency),
    )

    return {
      currency: currency.toUpperCase(),
      satPriceInCurrency,
      btcRate,
      timestamp: data.timestamp as string,
      source: "citrusrate_official",
      provider: "citrusrate",
    }
  }

  /**
   * Get all official rates (batch)
   * @returns All rates keyed by currency code
   */
  async getAllOfficialRates(): Promise<CitrusrateAllRatesResponse> {
    // GET /v1/btc/all
    const data: Record<string, unknown> = (await this.request("/v1/btc/all")) as Record<
      string,
      unknown
    >

    if (!data.rates) {
      throw new Error("No rates available from Citrusrate")
    }

    // Convert all rates to satPriceInCurrency format.
    // Malformed entries are skipped, not propagated: one bad currency must not
    // poison the 38-currency snapshot the poller bulk-writes to the cache.
    const convertedRates: Record<string, CitrusrateRateData> = {}
    for (const [currency, rawRate] of Object.entries(
      data.rates as Record<string, unknown>,
    )) {
      const btcRate: number | null = toValidBtcRate(rawRate)
      if (btcRate === null) {
        console.warn(`Citrusrate /btc/all: skipping malformed rate for ${currency}`)
        continue
      }
      convertedRates[currency] = {
        currency,
        satPriceInCurrency: toSatPriceInMinorUnits(
          btcRate,
          getCitrusrateFractionDigits(currency),
        ),
        btcRate,
        timestamp: data.timestamp as string,
        source: "citrusrate_official",
        provider: "citrusrate",
      }
    }

    return {
      rates: convertedRates,
      timestamp: data.timestamp as string,
    }
  }
}

// Singleton instance
let citrusrateInstance: CitrusrateAPI | null = null

export function getCitrusrateAPI(): CitrusrateAPI {
  if (!citrusrateInstance) {
    citrusrateInstance = new CitrusrateAPI()
  }
  return citrusrateInstance
}
