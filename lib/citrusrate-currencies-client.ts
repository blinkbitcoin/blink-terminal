/**
 * Citrusrate Currency Definitions (Client-side ES Module)
 *
 * This file mirrors lib/rate-providers/citrusrate-currencies.ts but uses ES module
 * exports for use in React components and hooks. Keep the two in sync.
 *
 * Contains metadata for the currencies served by the Citrusrate V1 API
 * (verified against GET /v1/btc/all — 38 official rates as of Sept 2026).
 */

// =============================================================================
// Types
// =============================================================================

export interface CitrusrateExclusiveCurrency {
  id: string
  name: string
  flag: string
  symbol: string
  fractionDigits: number
  rateProvider: string
}

export interface CitrusrateAltCurrency {
  id: string
  baseId: string
  name: string
  flag: string
  symbol: string
  fractionDigits: number
  rateProvider: string
}

// =============================================================================
// Data
// =============================================================================

/**
 * 21 currencies available ONLY through Citrusrate (not in Blink API)
 * (20 African + VUV/Vanuatu). Removed: MRO, SLL, STD, ZWD — deprecated ISO
 * codes no longer returned by the live Citrusrate API.
 * These are added directly to the currency list
 */
export const CITRUSRATE_EXCLUSIVE_CURRENCIES: CitrusrateExclusiveCurrency[] = [
  {
    id: "AOA",
    name: "Angolan Kwanza (Citrusrate)",
    flag: "🇦🇴",
    symbol: "Kz",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "BIF",
    name: "Burundian Franc (Citrusrate)",
    flag: "🇧🇮",
    symbol: "FBu",
    fractionDigits: 0,
    rateProvider: "citrusrate_official",
  },
  {
    id: "BWP",
    name: "Botswana Pula (Citrusrate)",
    flag: "🇧🇼",
    symbol: "P",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "CDF",
    name: "Congolese Franc (Citrusrate)",
    flag: "🇨🇩",
    symbol: "FC",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "CVE",
    name: "Cape Verdean Escudo (Citrusrate)",
    flag: "🇨🇻",
    symbol: "$",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "DJF",
    name: "Djiboutian Franc (Citrusrate)",
    flag: "🇩🇯",
    symbol: "Fdj",
    fractionDigits: 0,
    rateProvider: "citrusrate_official",
  },
  {
    id: "DZD",
    name: "Algerian Dinar (Citrusrate)",
    flag: "🇩🇿",
    symbol: "د.ج",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "ERN",
    name: "Eritrean Nakfa (Citrusrate)",
    flag: "🇪🇷",
    symbol: "Nfk",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "GMD",
    name: "Gambian Dalasi (Citrusrate)",
    flag: "🇬🇲",
    symbol: "D",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "GNF",
    name: "Guinean Franc (Citrusrate)",
    flag: "🇬🇳",
    symbol: "FG",
    fractionDigits: 0,
    rateProvider: "citrusrate_official",
  },
  {
    id: "KMF",
    name: "Comorian Franc (Citrusrate)",
    flag: "🇰🇲",
    symbol: "CF",
    fractionDigits: 0,
    rateProvider: "citrusrate_official",
  },
  {
    id: "LSL",
    name: "Lesotho Loti (Citrusrate)",
    flag: "🇱🇸",
    symbol: "L",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "LYD",
    name: "Libyan Dinar (Citrusrate)",
    flag: "🇱🇾",
    symbol: "ل.د",
    fractionDigits: 3,
    rateProvider: "citrusrate_official",
  },
  {
    id: "MGA",
    name: "Malagasy Ariary (Citrusrate)",
    flag: "🇲🇬",
    symbol: "Ar",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "RWF",
    name: "Rwandan Franc (Citrusrate)",
    flag: "🇷🇼",
    symbol: "RF",
    fractionDigits: 0,
    rateProvider: "citrusrate_official",
  },
  {
    id: "SCR",
    name: "Seychellois Rupee (Citrusrate)",
    flag: "🇸🇨",
    symbol: "SR",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "SDG",
    name: "Sudanese Pound (Citrusrate)",
    flag: "🇸🇩",
    symbol: "ج.س",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "SOS",
    name: "Somali Shilling (Citrusrate)",
    flag: "🇸🇴",
    symbol: "S",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "SZL",
    name: "Swazi Lilangeni (Citrusrate)",
    flag: "🇸🇿",
    symbol: "E",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "TND",
    name: "Tunisian Dinar (Citrusrate)",
    flag: "🇹🇳",
    symbol: "د.ت",
    fractionDigits: 3,
    rateProvider: "citrusrate_official",
  },
  {
    id: "VUV",
    name: "Vanuatu Vatu (Citrusrate)",
    flag: "🇻🇺",
    symbol: "VT",
    fractionDigits: 0,
    rateProvider: "citrusrate_official",
  },
]

/**
 * 17 Citrusrate alternative currencies for those that overlap with Blink API
 * These provide an alternative rate source (Citrusrate aggregated African rates)
 */
export const CITRUSRATE_ALT_CURRENCIES: CitrusrateAltCurrency[] = [
  {
    id: "EGP_CITRUS",
    baseId: "EGP",
    name: "Egyptian Pound (Citrusrate)",
    flag: "🇪🇬",
    symbol: "E£",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "ETB_CITRUS",
    baseId: "ETB",
    name: "Ethiopian Birr (Citrusrate)",
    flag: "🇪🇹",
    symbol: "Br",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "GHS_CITRUS",
    baseId: "GHS",
    name: "Ghanaian Cedi (Citrusrate)",
    flag: "🇬🇭",
    symbol: "₵",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "KES_CITRUS",
    baseId: "KES",
    name: "Kenyan Shilling (Citrusrate)",
    flag: "🇰🇪",
    symbol: "KSh",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "LRD_CITRUS",
    baseId: "LRD",
    name: "Liberian Dollar (Citrusrate)",
    flag: "🇱🇷",
    symbol: "$",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "MAD_CITRUS",
    baseId: "MAD",
    name: "Moroccan Dirham (Citrusrate)",
    flag: "🇲🇦",
    symbol: "د.م.",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "MUR_CITRUS",
    baseId: "MUR",
    name: "Mauritian Rupee (Citrusrate)",
    flag: "🇲🇺",
    symbol: "Rs",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "MWK_CITRUS",
    baseId: "MWK",
    name: "Malawian Kwacha (Citrusrate)",
    flag: "🇲🇼",
    symbol: "MK",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "MZN_CITRUS",
    baseId: "MZN",
    name: "Mozambican Metical (Citrusrate)",
    flag: "🇲🇿",
    symbol: "MT",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "NAD_CITRUS",
    baseId: "NAD",
    name: "Namibian Dollar (Citrusrate)",
    flag: "🇳🇦",
    symbol: "$",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "NGN_CITRUS",
    baseId: "NGN",
    name: "Nigerian Naira (Citrusrate)",
    flag: "🇳🇬",
    symbol: "₦",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "TZS_CITRUS",
    baseId: "TZS",
    name: "Tanzanian Shilling (Citrusrate)",
    flag: "🇹🇿",
    symbol: "TSh",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "UGX_CITRUS",
    baseId: "UGX",
    name: "Ugandan Shilling (Citrusrate)",
    flag: "🇺🇬",
    symbol: "USh",
    fractionDigits: 0,
    rateProvider: "citrusrate_official",
  },
  {
    id: "XAF_CITRUS",
    baseId: "XAF",
    name: "CFA Franc BEAC (Citrusrate)",
    flag: "🇨🇲",
    symbol: "FCFA",
    fractionDigits: 0,
    rateProvider: "citrusrate_official",
  },
  {
    id: "XOF_CITRUS",
    baseId: "XOF",
    name: "CFA Franc BCEAO (Citrusrate)",
    flag: "🇸🇳",
    symbol: "CFA",
    fractionDigits: 0,
    rateProvider: "citrusrate_official",
  },
  {
    id: "ZAR_CITRUS",
    baseId: "ZAR",
    name: "South African Rand (Citrusrate)",
    flag: "🇿🇦",
    symbol: "R",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
  {
    id: "ZMW_CITRUS",
    baseId: "ZMW",
    name: "Zambian Kwacha (Citrusrate)",
    flag: "🇿🇲",
    symbol: "ZK",
    fractionDigits: 2,
    rateProvider: "citrusrate_official",
  },
]

// =============================================================================
// Lookup Helpers
// =============================================================================

/**
 * Set of Citrusrate-exclusive currency IDs for quick lookup
 */
export const CITRUSRATE_EXCLUSIVE_IDS: Set<string> = new Set(
  CITRUSRATE_EXCLUSIVE_CURRENCIES.map((c: CitrusrateExclusiveCurrency) => c.id),
)

/**
 * Check if a currency ID is a Citrusrate-exclusive currency
 */
export const isCitrusrateExclusiveCurrency = (currencyId: string): boolean =>
  CITRUSRATE_EXCLUSIVE_IDS.has(currencyId)

/**
 * Check if a currency ID is a Citrusrate alternative currency
 */
export const isCitrusrateAltCurrency = (currencyId: string): boolean =>
  !!(currencyId && currencyId.endsWith("_CITRUS"))

/**
 * Get the base currency ID from a Citrusrate alt currency
 */
export const getCitrusrateBaseCurrency = (currencyId: string): string => {
  if (isCitrusrateAltCurrency(currencyId)) {
    return currencyId.replace("_CITRUS", "")
  }
  return currencyId
}

/**
 * Get Citrusrate exclusive currency by ID
 */
export const getCitrusrateExclusiveCurrency = (
  currencyId: string,
): CitrusrateExclusiveCurrency | null =>
  CITRUSRATE_EXCLUSIVE_CURRENCIES.find(
    (c: CitrusrateExclusiveCurrency) => c.id === currencyId,
  ) || null

/**
 * Get Citrusrate alternative currency by ID
 */
export const getCitrusrateAltCurrency = (
  currencyId: string,
): CitrusrateAltCurrency | null =>
  CITRUSRATE_ALT_CURRENCIES.find((c: CitrusrateAltCurrency) => c.id === currencyId) ||
  null
