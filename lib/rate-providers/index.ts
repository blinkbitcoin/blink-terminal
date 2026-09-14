/**
 * Rate Provider Registry
 *
 * Central registry for exchange rate providers.
 * Supports multiple providers (Blink official, Citrusrate street rates, Citrusrate official, etc.)
 */

import {
  CITRUSRATE_EXCLUSIVE_CURRENCIES,
  CITRUSRATE_ALT_CURRENCIES,
  CITRUSRATE_EXCLUSIVE_IDS,
  isCitrusrateExclusiveCurrency,
  isCitrusrateAltCurrency,
  getCitrusrateBaseCurrency,
  type CitrusrateExclusiveCurrency,
  type CitrusrateAltCurrency,
} from "./citrusrate-currencies"

export interface RateProvider {
  id: string
  name: string
  description: string
  isDefault?: boolean
  currencies?: string[]
  rateType?: string
}

export interface StreetRateCurrency {
  id: string
  baseId: string
  displayId: string
  symbol: string
  name: string
  flag: string
  fractionDigits: number
  rateProvider: string
}

/**
 * Provider configurations
 * Each provider specifies which currencies it handles and how to fetch rates
 */
export const RATE_PROVIDERS: Record<string, RateProvider> = {
  blink: {
    id: "blink",
    name: "Blink (Official)",
    description: "Official exchange rates from Blink API",
    // Handles all currencies by default
    isDefault: true,
  },
  citrusrate_street: {
    id: "citrusrate_street",
    name: "Citrusrate (Street)",
    description: "Black market / street exchange rates from Citrusrate",
    // Currency mapping is driven by STREET_RATE_CURRENCIES below
    rateType: "blackmarket",
  },
  citrusrate_official: {
    id: "citrusrate_official",
    name: "Citrusrate (Official)",
    description:
      "Official aggregated exchange rates from Citrusrate (African currencies)",
    // Handles Citrusrate-exclusive currencies and _CITRUS alternative currencies
    rateType: "official",
  },
}

/**
 * Street rate currency configurations
 * Maps virtual currency IDs (e.g., MZN_STREET) to their base currencies and metadata.
 * Covers all 13 currencies supported by Citrusrate's black-market endpoint
 * (GET /v1/btc/blackmarket?currency=X) — verified live Sept 2026.
 * NOTE: keep in sync with STREET_RATE_CURRENCIES in lib/currency-utils.ts
 */
export const STREET_RATE_CURRENCIES: StreetRateCurrency[] = [
  {
    id: "EGP_STREET",
    baseId: "EGP",
    displayId: "EGP (street)",
    symbol: "E£",
    name: "Egyptian Pound (street rate)",
    flag: "🇪🇬",
    fractionDigits: 2,
    rateProvider: "citrusrate_street",
  },
  {
    id: "ETB_STREET",
    baseId: "ETB",
    displayId: "ETB (street)",
    symbol: "Br",
    name: "Ethiopian Birr (street rate)",
    flag: "🇪🇹",
    fractionDigits: 2,
    rateProvider: "citrusrate_street",
  },
  {
    id: "GHS_STREET",
    baseId: "GHS",
    displayId: "GHS (street)",
    symbol: "₵",
    name: "Ghanaian Cedi (street rate)",
    flag: "🇬🇭",
    fractionDigits: 2,
    rateProvider: "citrusrate_street",
  },
  {
    id: "MWK_STREET",
    baseId: "MWK",
    displayId: "MWK (street)",
    symbol: "MK",
    name: "Malawian Kwacha (street rate)",
    flag: "🇲🇼",
    fractionDigits: 2,
    rateProvider: "citrusrate_street",
  },
  {
    id: "MZN_STREET",
    baseId: "MZN",
    displayId: "MZN (street)",
    symbol: "MT",
    name: "Mozambican Metical (street rate)",
    flag: "🇲🇿",
    fractionDigits: 2,
    rateProvider: "citrusrate_street",
  },
  {
    id: "NAD_STREET",
    baseId: "NAD",
    displayId: "NAD (street)",
    symbol: "$",
    name: "Namibian Dollar (street rate)",
    flag: "🇳🇦",
    fractionDigits: 2,
    rateProvider: "citrusrate_street",
  },
  {
    id: "RWF_STREET",
    baseId: "RWF",
    displayId: "RWF (street)",
    symbol: "RF",
    name: "Rwandan Franc (street rate)",
    flag: "🇷🇼",
    fractionDigits: 0,
    rateProvider: "citrusrate_street",
  },
  {
    id: "TZS_STREET",
    baseId: "TZS",
    displayId: "TZS (street)",
    symbol: "TSh",
    name: "Tanzanian Shilling (street rate)",
    flag: "🇹🇿",
    fractionDigits: 2,
    rateProvider: "citrusrate_street",
  },
  {
    id: "UGX_STREET",
    baseId: "UGX",
    displayId: "UGX (street)",
    symbol: "USh",
    name: "Ugandan Shilling (street rate)",
    flag: "🇺🇬",
    fractionDigits: 0,
    rateProvider: "citrusrate_street",
  },
  {
    id: "XAF_STREET",
    baseId: "XAF",
    displayId: "XAF (street)",
    symbol: "FCFA",
    name: "CFA Franc BEAC (street rate)",
    flag: "🇨🇲",
    fractionDigits: 0,
    rateProvider: "citrusrate_street",
  },
  {
    id: "XOF_STREET",
    baseId: "XOF",
    displayId: "XOF (street)",
    symbol: "CFA",
    name: "CFA Franc BCEAO (street rate)",
    flag: "🇸🇳",
    fractionDigits: 0,
    rateProvider: "citrusrate_street",
  },
  {
    id: "ZAR_STREET",
    baseId: "ZAR",
    displayId: "ZAR (street)",
    symbol: "R",
    name: "South African Rand (street rate)",
    flag: "🇿🇦",
    fractionDigits: 2,
    rateProvider: "citrusrate_street",
  },
  {
    id: "ZMW_STREET",
    baseId: "ZMW",
    displayId: "ZMW (street)",
    symbol: "ZK",
    name: "Zambian Kwacha (street rate)",
    flag: "🇿🇲",
    fractionDigits: 2,
    rateProvider: "citrusrate_street",
  },
]

/**
 * Get the rate provider for a given currency
 * @param currencyId - Currency ID (e.g., 'MZN', 'MZN_STREET', 'NGN_CITRUS', 'AOA')
 * @returns Provider configuration
 */
export function getProviderForCurrency(currencyId: string): RateProvider {
  // Check if this is a street rate currency (e.g., MZN_STREET)
  const streetCurrency: StreetRateCurrency | undefined = STREET_RATE_CURRENCIES.find(
    (c: StreetRateCurrency) => c.id === currencyId,
  )
  if (streetCurrency) {
    return RATE_PROVIDERS[streetCurrency.rateProvider]
  }

  // Check if this is a Citrusrate alternative currency (e.g., NGN_CITRUS)
  if (isCitrusrateAltCurrency(currencyId)) {
    return RATE_PROVIDERS.citrusrate_official
  }

  // Check if this is a Citrusrate-exclusive currency (e.g., AOA, BIF, BWP)
  if (isCitrusrateExclusiveCurrency(currencyId)) {
    return RATE_PROVIDERS.citrusrate_official
  }

  // Check if any provider explicitly handles this currency
  for (const [_key, provider] of Object.entries(RATE_PROVIDERS)) {
    if (provider.currencies && provider.currencies.includes(currencyId)) {
      return provider
    }
  }

  // Default to Blink provider
  return RATE_PROVIDERS.blink
}

/**
 * Check if a currency ID is a street rate currency
 */
export function isStreetRateCurrency(currencyId: string): boolean {
  return currencyId.endsWith("_STREET")
}

/**
 * Get the base currency for a special currency (street rate or citrus alt)
 * @param currencyId - e.g., 'MZN_STREET' or 'NGN_CITRUS'
 * @returns Base currency ID, e.g., 'MZN' or 'NGN'
 */
export function getBaseCurrency(currencyId: string): string {
  if (isStreetRateCurrency(currencyId)) {
    return currencyId.replace("_STREET", "")
  }
  if (isCitrusrateAltCurrency(currencyId)) {
    return getCitrusrateBaseCurrency(currencyId)
  }
  return currencyId
}

/**
 * Get street rate currency config by ID
 */
export function getStreetRateCurrency(currencyId: string): StreetRateCurrency | null {
  return (
    STREET_RATE_CURRENCIES.find((c: StreetRateCurrency) => c.id === currencyId) || null
  )
}

/**
 * Get all configured street rate currencies
 */
export function getAllStreetRateCurrencies(): StreetRateCurrency[] {
  return STREET_RATE_CURRENCIES
}

/**
 * Get all Citrusrate exclusive currencies (not in Blink)
 */
export function getAllCitrusrateExclusiveCurrencies(): CitrusrateExclusiveCurrency[] {
  return CITRUSRATE_EXCLUSIVE_CURRENCIES
}

/**
 * Get all Citrusrate alternative currencies
 */
export function getAllCitrusrateAltCurrencies(): CitrusrateAltCurrency[] {
  return CITRUSRATE_ALT_CURRENCIES
}

// Re-export from citrusrate-currencies for backward compatibility
export {
  CITRUSRATE_EXCLUSIVE_CURRENCIES,
  CITRUSRATE_ALT_CURRENCIES,
  CITRUSRATE_EXCLUSIVE_IDS,
  isCitrusrateExclusiveCurrency,
  isCitrusrateAltCurrency,
}

export type { CitrusrateExclusiveCurrency, CitrusrateAltCurrency }
