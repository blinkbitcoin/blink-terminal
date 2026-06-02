/**
 * Number formatting utilities with locale support
 *
 * Provides consistent number formatting across the app with user-configurable
 * locale preferences for thousands separators and decimal points.
 */

// =============================================================================
// Number Format Types
// =============================================================================

export type NumberFormatPreference =
  | "auto"
  | "comma-period"
  | "period-comma"
  | "space-comma"
export type BitcoinFormatPreference = "sats" | "bip177" | "sat"
export type NumpadLayoutPreference = "calculator" | "telephone"
export type AmountDisplayPreference = "fiat-primary" | "sats-primary"

export interface FormatPreview {
  integer: string
  decimal: string
  small: string
}

// =============================================================================
// Number Format Configuration
// =============================================================================

// Locale mapping for explicit format preferences
export const FORMAT_LOCALES: Record<NumberFormatPreference, string | undefined> = {
  "auto": undefined, // Use browser default
  "comma-period": "en-US", // 1,234.56
  "period-comma": "de-DE", // 1.234,56
  "space-comma": "fr-FR", // 1 234,56
}

// Format labels for UI display
export const FORMAT_LABELS: Record<NumberFormatPreference, string> = {
  "auto": "Automatic (use device settings)",
  "comma-period": "1,234.56",
  "period-comma": "1.234,56",
  "space-comma": "1 234,56",
}

// Format descriptions for UI
export const FORMAT_DESCRIPTIONS: Record<NumberFormatPreference, string> = {
  "auto": "Uses your device's regional settings",
  "comma-period": "Comma for thousands, period for decimals (US, UK, Australia)",
  "period-comma": "Period for thousands, comma for decimals (Germany, France, Spain)",
  "space-comma": "Space for thousands, comma for decimals (France, Russia)",
}

// All available format options in display order
export const FORMAT_OPTIONS: NumberFormatPreference[] = [
  "auto",
  "comma-period",
  "period-comma",
  "space-comma",
]

// Default format when 'auto' can't determine browser locale
export const DEFAULT_FALLBACK_FORMAT: NumberFormatPreference = "comma-period"

// =============================================================================
// Bitcoin Format Configuration
// =============================================================================

// Bitcoin format options
export const BITCOIN_FORMAT_OPTIONS: BitcoinFormatPreference[] = ["sats", "bip177", "sat"]

// Bitcoin format labels for UI display
export const BITCOIN_FORMAT_LABELS: Record<BitcoinFormatPreference, string> = {
  sats: "sats",
  bip177: "BIP-177 (₿)",
  sat: "SAT",
}

// Bitcoin format descriptions for UI
export const BITCOIN_FORMAT_DESCRIPTIONS: Record<BitcoinFormatPreference, string> = {
  sats: "Standard satoshi notation - most common in Lightning",
  bip177: "Unicode Bitcoin symbol with sats value",
  sat: "Bitcoin Beach legacy format - uppercase unit",
}

// Default Bitcoin format
export const DEFAULT_BITCOIN_FORMAT: BitcoinFormatPreference = "sats"

// =============================================================================
// Numpad Layout Configuration
// =============================================================================

// Numpad layout options
export const NUMPAD_LAYOUT_OPTIONS: NumpadLayoutPreference[] = ["calculator", "telephone"]

// Numpad layout labels for UI display
export const NUMPAD_LAYOUT_LABELS: Record<NumpadLayoutPreference, string> = {
  calculator: "7-8-9 Top Row (Calculator)",
  telephone: "1-2-3 Top Row (Telephone)",
}

// Numpad layout descriptions for UI
export const NUMPAD_LAYOUT_DESCRIPTIONS: Record<NumpadLayoutPreference, string> = {
  calculator: "Standard calculator layout with 7-8-9 on top",
  telephone: "Phone/ATM style layout with 1-2-3 on top",
}

// Default numpad layout
export const DEFAULT_NUMPAD_LAYOUT: NumpadLayoutPreference = "calculator"

// =============================================================================
// Amount Display Configuration
// =============================================================================

// Amount display options (which value is primary when both fiat + sats are shown)
export const AMOUNT_DISPLAY_OPTIONS: AmountDisplayPreference[] = [
  "fiat-primary",
  "sats-primary",
]

// Amount display labels for UI display
export const AMOUNT_DISPLAY_LABELS: Record<AmountDisplayPreference, string> = {
  "fiat-primary": "Local currency first",
  "sats-primary": "Bitcoin first",
}

// Amount display descriptions for UI
export const AMOUNT_DISPLAY_DESCRIPTIONS: Record<AmountDisplayPreference, string> = {
  "fiat-primary": "Show the local currency amount as primary, sats in parentheses",
  "sats-primary": "Show the Bitcoin amount as primary, local currency in parentheses",
}

// Default amount display preference
export const DEFAULT_AMOUNT_DISPLAY: AmountDisplayPreference = "fiat-primary"

/**
 * Format a Bitcoin/sats amount according to the specified format
 * @param sats - Amount in satoshis
 * @param bitcoinFormat - Bitcoin format preference ('sats', 'bip177', 'sat')
 * @param numberFormat - Number format preference ('auto', 'comma-period', etc.)
 * @returns Formatted Bitcoin amount string
 */
export const formatBitcoinAmount = (
  sats: number,
  bitcoinFormat: BitcoinFormatPreference = "sats",
  numberFormat: NumberFormatPreference = "auto",
): string => {
  const formattedNumber: string = formatNumber(sats, numberFormat, 0)

  switch (bitcoinFormat) {
    case "sats":
      return `${formattedNumber} sats`
    case "sat":
      return `${formattedNumber} SAT`
    case "bip177":
    default:
      return `₿${formattedNumber}`
  }
}

/**
 * Get a preview of how Bitcoin amounts will look with a given format
 * @param bitcoinFormat - Bitcoin format preference
 * @param numberFormat - Number format preference
 * @returns Preview string with example amount
 */
export const getBitcoinFormatPreview = (
  bitcoinFormat: BitcoinFormatPreference,
  numberFormat: NumberFormatPreference = "auto",
): string => {
  return formatBitcoinAmount(21000, bitcoinFormat, numberFormat)
}

/**
 * Get the locale string for a given format preference
 * @param format - Format preference ('auto', 'comma-period', etc.)
 * @returns Locale string or undefined for auto
 */
export const getLocaleForFormat = (
  format: NumberFormatPreference,
): string | undefined => {
  return FORMAT_LOCALES[format] || FORMAT_LOCALES[DEFAULT_FALLBACK_FORMAT]
}

/**
 * Format a number with the specified format preference
 * @param value - Number to format
 * @param format - Format preference ('auto', 'comma-period', etc.)
 * @param decimals - Number of decimal places (default: 0)
 * @returns Formatted number string
 */
export const formatNumber = (
  value: number | string,
  format: NumberFormatPreference = "auto",
  decimals: number = 0,
): string => {
  const numValue: number = parseFloat(value as string) || 0

  // For 'auto', use undefined to let browser choose; otherwise use explicit locale
  let locale: string | undefined
  if (format === "auto") {
    locale = undefined // Browser will use system locale
  } else {
    locale = FORMAT_LOCALES[format] || FORMAT_LOCALES[DEFAULT_FALLBACK_FORMAT]
  }

  try {
    return numValue.toLocaleString(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  } catch (err: unknown) {
    // Fallback if locale not supported
    console.warn(`Locale formatting failed for format "${format}":`, err)
    return numValue.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  }
}

/**
 * Get a preview of how numbers will look with a given format
 * @param format - Format preference
 * @returns Preview object with example formatted numbers
 */
export const getFormatPreview = (format: NumberFormatPreference): FormatPreview => {
  return {
    integer: formatNumber(1234567, format, 0),
    decimal: formatNumber(1234567.89, format, 2),
    small: formatNumber(42.5, format, 2),
  }
}
