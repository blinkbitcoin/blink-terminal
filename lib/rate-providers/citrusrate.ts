/**
 * Citrusrate API Client
 *
 * Fetches official and black market / street exchange rates from Citrusrate API.
 * Docs: https://citrusrate.com/llm.txt
 */

const SATS_PER_BTC: number = 100_000_000

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
    const timeoutId: ReturnType<typeof setTimeout> = setTimeout(
      () => controller.abort(),
      this.timeout,
    )

    try {
      const response: Response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "x-api-key": this.apiKey as string,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

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
        throw new Error(
          (data.message as string) || "Citrusrate API returned error status",
        )
      }

      return data.data
    } catch (error: unknown) {
      clearTimeout(timeoutId)

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Citrusrate API request timed out")
      }
      throw error
    }
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

    if (!data.rate) {
      throw new Error(`No black market rate available for ${currency}`)
    }

    // Convert BTC rate to satPriceInCurrency format (price of 1 sat in fiat minor units)
    // Citrusrate returns: rate = price of 1 BTC in fiat (e.g., 6,903,525 MZN)
    // We need: satPriceInCurrency = price of 1 sat in fiat cents/minor units
    // Formula: (btcRate / SATS_PER_BTC) * 100 = price of 1 sat in cents
    const satPriceInCurrency: number = ((data.rate as number) / SATS_PER_BTC) * 100

    return {
      currency: currency.toUpperCase(),
      satPriceInCurrency,
      btcRate: data.rate as number,
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

    if (!data.rate) {
      throw new Error(`No official rate available for ${currency}`)
    }

    const satPriceInCurrency: number = ((data.rate as number) / SATS_PER_BTC) * 100

    return {
      currency: currency.toUpperCase(),
      satPriceInCurrency,
      btcRate: data.rate as number,
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

    // Convert all rates to satPriceInCurrency format
    const convertedRates: Record<string, CitrusrateRateData> = {}
    for (const [currency, btcRate] of Object.entries(
      data.rates as Record<string, number>,
    )) {
      convertedRates[currency] = {
        currency,
        satPriceInCurrency: (btcRate / SATS_PER_BTC) * 100,
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
