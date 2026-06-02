/**
 * Currency utilities for dynamic currency handling
 * Supports all Blink-supported currencies automatically
 * Also supports Citrusrate exclusive and alternative currencies
 */

import {
  CITRUSRATE_EXCLUSIVE_CURRENCIES,
  isCitrusrateExclusiveCurrency as isExclusive,
} from "./citrusrate-currencies-client"
import {
  formatNumber,
  formatBitcoinAmount,
  DEFAULT_BITCOIN_FORMAT,
  DEFAULT_AMOUNT_DISPLAY,
  NumberFormatPreference,
  BitcoinFormatPreference,
  AmountDisplayPreference,
} from "./number-format"

// =============================================================================
// Types
// =============================================================================

export interface CurrencyMetadata {
  id: string
  symbol?: string
  name?: string
  flag?: string
  fractionDigits?: number
  displayId?: string
  rateProvider?: string
  baseId?: string
  isStreetRate?: boolean
  country?: string
}

export interface CurrencyOption {
  value: string
  label: string
  currency: CurrencyMetadata
}

export interface AmountParts {
  symbol: string
  value: string
  isBip177: boolean
}

// =============================================================================
// Constants
// =============================================================================

// Satoshi currency metadata (traditional sats display: "10,000 sats")
export const SAT_CURRENCY: CurrencyMetadata = {
  id: "BTC",
  symbol: "sats",
  name: "Bitcoin (sats)",
  flag: "₿",
  fractionDigits: 0,
}

// BIP-177 Bitcoin currency metadata (new display: "₿10,000")
export const BTC_BIP177_CURRENCY: CurrencyMetadata = {
  id: "BTC-BIP177",
  displayId: "BTC", // Show as "BTC" in dropdown, but use id for logic
  symbol: "₿",
  name: "Bitcoin (BIP-177)",
  flag: "₿",
  fractionDigits: 0,
}

/**
 * Street rate currencies (alternative exchange rates from Citrusrate)
 * These appear in the currency list alongside their official counterparts
 */
export const STREET_RATE_CURRENCIES: CurrencyMetadata[] = [
  {
    id: "MZN_STREET",
    baseId: "MZN", // The official currency this is based on
    displayId: "MZN (street)",
    symbol: "MT",
    name: "Mozambican Metical (street rate)",
    flag: "🇲🇿",
    fractionDigits: 2,
    rateProvider: "citrusrate_street",
    isStreetRate: true,
  },
  // Easy to add more street rate currencies:
  // {
  //   id: 'NGN_STREET',
  //   baseId: 'NGN',
  //   displayId: 'NGN (street)',
  //   symbol: '₦',
  //   name: 'Nigerian Naira (street rate)',
  //   flag: '🇳🇬',
  //   fractionDigits: 2,
  //   rateProvider: 'citrusrate_street',
  //   isStreetRate: true
  // },
]

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if a currency ID is a street rate currency
 * @param currencyId
 * @returns boolean
 */
export const isStreetRateCurrency = (currencyId: string): boolean => {
  return !!currencyId && currencyId.endsWith("_STREET")
}

/**
 * Check if a currency ID is a Citrusrate alternative currency
 * @param currencyId
 * @returns boolean
 */
export const isCitrusrateAltCurrency = (currencyId: string): boolean => {
  return !!currencyId && currencyId.endsWith("_CITRUS")
}

/**
 * Check if currency uses Citrusrate rates (street, alt, or exclusive)
 * Used for displaying "(Citrusrate)" attribution
 * @param currencyId
 * @returns boolean
 */
export const isCitrusrateCurrency = (currencyId: string): boolean => {
  return (
    isStreetRateCurrency(currencyId) ||
    isCitrusrateAltCurrency(currencyId) ||
    isExclusive(currencyId)
  )
}

/**
 * Get the base currency for a special currency (street rate or citrus alt)
 * @param currencyId - e.g., 'MZN_STREET' or 'NGN_CITRUS'
 * @returns Base currency ID, e.g., 'MZN' or 'NGN'
 */
export const getBaseCurrencyId = (currencyId: string): string => {
  if (isStreetRateCurrency(currencyId)) {
    return currencyId.replace("_STREET", "")
  }
  if (isCitrusrateAltCurrency(currencyId)) {
    return currencyId.replace("_CITRUS", "")
  }
  return currencyId
}

/**
 * Get street rate currency config by ID
 * @param currencyId
 * @returns CurrencyMetadata or null
 */
export const getStreetRateCurrency = (currencyId: string): CurrencyMetadata | null => {
  return STREET_RATE_CURRENCIES.find((c) => c.id === currencyId) || null
}

/**
 * Format currency amount using dynamic currency metadata
 * @param value - The amount to format
 * @param currency - Currency metadata object from Blink API
 * @param numberFormat - Number format preference ('auto', 'comma-period', etc.)
 * @param bitcoinFormat - Bitcoin format preference ('sats', 'bip177', 'sat')
 * @returns Formatted currency string
 */
export const formatCurrencyAmount = (
  value: number | string,
  currency: CurrencyMetadata,
  numberFormat: NumberFormatPreference = "auto",
  bitcoinFormat: BitcoinFormatPreference = DEFAULT_BITCOIN_FORMAT,
): string => {
  const numValue: number = parseFloat(value as string) || 0

  // Special handling for Bitcoin currencies - use configurable format
  if (currency.id === "BTC" || currency.id === "BTC-BIP177") {
    return formatBitcoinAmount(numValue, bitcoinFormat, numberFormat)
  }

  // Use currency metadata for formatting
  const symbol: string = currency.symbol || currency.id
  // Use nullish coalescing - fractionDigits of 0 is valid (e.g., JPY, XOF, HUF)
  const decimals: number = currency.fractionDigits ?? 2
  const formattedAmount: string = formatNumber(numValue, numberFormat, decimals)

  // For currencies with standard symbols, format as: symbol + amount
  // For currencies with text symbols, format as: symbol + space + amount
  const needsSpace: boolean =
    symbol.length > 1 &&
    ![
      "$",
      "£",
      "€",
      "¥",
      "₹",
      "₽",
      "₦",
      "₱",
      "₴",
      "₸",
      "₺",
      "₩",
      "₪",
      "฿",
      "₫",
      "₡",
      "₵",
      "₲",
      "₪",
      "ƒ",
    ].includes(symbol)

  return needsSpace ? `${symbol} ${formattedAmount}` : `${symbol}${formattedAmount}`
}

/**
 * Get currency object by ID from currency list
 * @param currencyId - Currency ID (e.g., 'USD', 'EUR', 'BTC', 'BTC-BIP177', 'MZN_STREET', 'KES_CITRUS')
 * @param currencyList - Array of currency metadata from Blink API
 * @returns Currency object or null if not found
 */
export const getCurrencyById = (
  currencyId: string,
  currencyList: CurrencyMetadata[],
): CurrencyMetadata | null => {
  if (!currencyId || !currencyList) return null

  // Check for BTC/sats (traditional format)
  if (currencyId === "BTC") {
    return SAT_CURRENCY
  }

  // Check for BTC-BIP177 (new format)
  if (currencyId === "BTC-BIP177") {
    return BTC_BIP177_CURRENCY
  }

  // Check for street rate currencies (MZN_STREET)
  // These have their own symbol definitions
  const streetCurrency: CurrencyMetadata | null = getStreetRateCurrency(currencyId)
  if (streetCurrency) {
    return streetCurrency
  }

  // For Citrusrate alt currencies (KES_CITRUS, GHS_CITRUS, etc.),
  // look up the BASE currency from Blink list so formatting matches exactly
  if (isCitrusrateAltCurrency(currencyId)) {
    const baseId: string = getBaseCurrencyId(currencyId) // KES_CITRUS -> KES
    const baseCurrency: CurrencyMetadata | undefined = currencyList.find(
      (c) => c.id === baseId,
    )
    if (baseCurrency) {
      // Return the base currency metadata so formatting is identical
      // The caller uses currencyId for rate lookups, but formatting uses base currency
      return baseCurrency
    }
  }

  // For Citrusrate-exclusive currencies (BWP, AOA, etc.),
  // look up from the CITRUSRATE_EXCLUSIVE_CURRENCIES array
  if (isExclusive(currencyId)) {
    return CITRUSRATE_EXCLUSIVE_CURRENCIES.find((c) => c.id === currencyId) || null
  }

  return currencyList.find((c) => c.id === currencyId) || null
}

/**
 * Format currency for display with proper symbol and decimals
 * @param value - Amount to format
 * @param currencyId - Currency ID
 * @param currencyList - Array of currency metadata
 * @param numberFormat - Number format preference ('auto', 'comma-period', etc.)
 * @param bitcoinFormat - Bitcoin format preference ('sats', 'bip177', 'sat')
 * @returns Formatted string or fallback format
 */
export const formatDisplayAmount = (
  value: number | string,
  currencyId: string,
  currencyList: CurrencyMetadata[],
  numberFormat: NumberFormatPreference = "auto",
  bitcoinFormat: BitcoinFormatPreference = DEFAULT_BITCOIN_FORMAT,
): string => {
  const currency: CurrencyMetadata | null = getCurrencyById(currencyId, currencyList)

  if (!currency) {
    // Fallback formatting if currency not found
    const numValue: number = parseFloat(value as string) || 0
    return `${formatNumber(numValue, numberFormat, 2)} ${currencyId}`
  }

  return formatCurrencyAmount(value, currency, numberFormat, bitcoinFormat)
}

/**
 * Format a combined amount string showing both the fiat value and the sats value,
 * with the order determined by the amount-display preference.
 *
 * - fiat-primary: "$50.00 (5,000 sats)"
 * - sats-primary: "5,000 sats ($50.00)"
 *
 * When no fiat value is available (e.g. a Bitcoin-denominated payment), only the
 * sats value is returned. When the sats value is missing, only the fiat is returned.
 *
 * @param sats - Amount in satoshis (may be undefined for fiat-only contexts)
 * @param displayAmount - Fiat amount (may be undefined for sats-only contexts)
 * @param displayCurrency - Fiat currency id (e.g. "USD", "KES"); BTC currencies are treated as no-fiat
 * @param amountDisplay - Which value is primary
 * @param numberFormat - Number format preference
 * @param bitcoinFormat - Bitcoin format preference
 * @param currencyList - Currency metadata list (optional; enables symbol-aware fiat formatting)
 * @returns Combined display string
 */
export const formatCombinedAmount = (
  sats: number | undefined,
  displayAmount: number | string | undefined,
  displayCurrency: string | undefined,
  amountDisplay: AmountDisplayPreference = DEFAULT_AMOUNT_DISPLAY,
  numberFormat: NumberFormatPreference = "auto",
  bitcoinFormat: BitcoinFormatPreference = DEFAULT_BITCOIN_FORMAT,
  currencyList: CurrencyMetadata[] = [],
): string => {
  const hasSats = typeof sats === "number" && !Number.isNaN(sats)
  const hasFiat =
    displayAmount !== undefined &&
    displayAmount !== null &&
    displayAmount !== "" &&
    !!displayCurrency &&
    !isBitcoinCurrency(displayCurrency)

  const satsStr = hasSats
    ? formatBitcoinAmount(sats as number, bitcoinFormat, numberFormat)
    : ""
  const fiatStr = hasFiat
    ? formatDisplayAmount(
        displayAmount as number | string,
        displayCurrency as string,
        currencyList,
        numberFormat,
        bitcoinFormat,
      )
    : ""

  // Only one side available
  if (!hasFiat) return satsStr
  if (!hasSats) return fiatStr

  // Both available - order by preference
  if (amountDisplay === "sats-primary") {
    return `${satsStr} (${fiatStr})`
  }
  return `${fiatStr} (${satsStr})`
}

/**
 * Create a currency dropdown option object
 * @param currency - Currency metadata
 * @returns Option object for select dropdown
 */
export const createCurrencyOption = (currency: CurrencyMetadata): CurrencyOption => {
  const flag: string = currency.flag ? `${currency.flag} ` : ""
  return {
    value: currency.id,
    label: `${flag}${currency.id} - ${currency.name}`,
    currency: currency,
  }
}

/**
 * Check if currency is a Bitcoin/satoshi-based currency (BTC or BTC-BIP177)
 * Both use satoshis internally, just displayed differently
 * @param currencyId - Currency ID to check
 * @returns True if currency is Bitcoin-based
 */
export const isBitcoinCurrency = (currencyId: string): boolean => {
  return currencyId === "BTC" || currencyId === "BTC-BIP177"
}

/**
 * Parse formatted amount into symbol and value parts for custom rendering
 * Useful when you need to style the symbol differently (e.g., smaller ₿ symbol)
 * @param formattedAmount - The formatted amount string from formatDisplayAmount
 * @param currencyId - Currency ID to determine parsing logic
 * @param bitcoinFormat - Bitcoin format used ('sats', 'bip177', 'sat')
 * @returns Parts for custom rendering
 */
export const parseAmountParts = (
  formattedAmount: string,
  currencyId: string,
  bitcoinFormat: BitcoinFormatPreference = DEFAULT_BITCOIN_FORMAT,
): AmountParts => {
  // Handle Bitcoin currencies based on format
  if (currencyId === "BTC" || currencyId === "BTC-BIP177") {
    if (bitcoinFormat === "bip177") {
      // BIP-177 format: "₿10,000" - symbol is first character
      return {
        symbol: "₿",
        value: formattedAmount.substring(1),
        isBip177: true,
      }
    }

    // Both 'sats' and 'sat' formats: "10,000 sats" or "10,000 SAT" - no symbol prefix
    return {
      symbol: "",
      value: formattedAmount,
      isBip177: false,
    }
  }

  // For fiat currencies, try to extract symbol
  // Most formats are: "$100.00" or "€100.00" or "CHF 100.00"
  const match: RegExpMatchArray | null = formattedAmount.match(/^([^\d\s]+\s?)(.+)$/)
  if (match) {
    return {
      symbol: match[1],
      value: match[2],
      isBip177: false,
    }
  }

  return {
    symbol: "",
    value: formattedAmount,
    isBip177: false,
  }
}
