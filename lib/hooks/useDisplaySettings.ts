/**
 * useDisplaySettings Hook
 *
 * Manages display and regional settings for the dashboard including:
 * - Display currency (USD/BTC toggle)
 * - Number format (locale settings)
 * - Bitcoin format (sats, BIP-177, etc.)
 * - Numpad layout (calculator vs phone)
 * - Currency filter for search
 *
 * All settings are persisted to localStorage where applicable.
 *
 * @module lib/hooks/useDisplaySettings
 */

import { useState, useCallback, useEffect } from "react"

import {
  FORMAT_LOCALES,
  DEFAULT_AMOUNT_DISPLAY,
  type NumberFormatPreference,
  type BitcoinFormatPreference,
  type NumpadLayoutPreference,
  type AmountDisplayPreference,
} from "../number-format"

// ============================================================================
// Types
// ============================================================================

/** Display currency options */
export type DisplayCurrency = "USD" | "BTC"

/** Number format — re-exported from number-format.ts canonical types */
export type NumberFormat = NumberFormatPreference

/** Bitcoin format — re-exported from number-format.ts canonical types */
export type BitcoinFormat = BitcoinFormatPreference

/** Numpad layout — re-exported from number-format.ts canonical types */
export type NumpadLayout = NumpadLayoutPreference

/** Amount display — re-exported from number-format.ts canonical types */
export type AmountDisplay = AmountDisplayPreference

/** Return type for the useDisplaySettings hook */
export interface UseDisplaySettingsReturn {
  // Display currency state
  displayCurrency: DisplayCurrency
  setDisplayCurrency: (currency: DisplayCurrency) => void
  toggleDisplayCurrency: () => void

  // Number format state
  numberFormat: NumberFormat
  setNumberFormat: (format: NumberFormat) => void

  // Bitcoin format state
  bitcoinFormat: BitcoinFormat
  setBitcoinFormat: (format: BitcoinFormat) => void

  // Numpad layout state
  numpadLayout: NumpadLayout
  setNumpadLayout: (layout: NumpadLayout) => void

  // Amount display state (fiat-primary vs sats-primary)
  amountDisplay: AmountDisplay
  setAmountDisplay: (preference: AmountDisplay) => void

  // Currency filter state (for currency selector search)
  currencyFilter: string
  setCurrencyFilter: (filter: string) => void
  currencyFilterDebounced: string
  setCurrencyFilterDebounced: (filter: string) => void
  clearCurrencyFilter: () => void

  // Utility functions
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string
  formatBitcoin: (sats: number) => string
  getLocaleFromFormat: () => string
}

// ============================================================================
// Constants
// ============================================================================

const STORAGE_KEYS = {
  NUMBER_FORMAT: "blinkpos-number-format",
  BITCOIN_FORMAT: "blinkpos-bitcoin-format",
  NUMPAD_LAYOUT: "blinkpos-numpad-layout",
  AMOUNT_DISPLAY: "blinkpos-amount-display",
} as const

const DEFAULT_NUMBER_FORMAT: NumberFormat = "auto"
const DEFAULT_BITCOIN_FORMAT: BitcoinFormat = "sats"
const DEFAULT_NUMPAD_LAYOUT: NumpadLayout = "calculator"
const DEFAULT_DISPLAY_CURRENCY: DisplayCurrency = "USD"

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safely get value from localStorage
 */
function getFromStorage<T>(key: string, defaultValue: T): T {
  if (typeof window === "undefined") {
    return defaultValue
  }
  try {
    const stored = localStorage.getItem(key)
    return stored !== null ? (stored as unknown as T) : defaultValue
  } catch {
    return defaultValue
  }
}

/**
 * Safely set value to localStorage
 */
function setToStorage(key: string, value: string): void {
  if (typeof window === "undefined") {
    return
  }
  try {
    localStorage.setItem(key, value)
  } catch {
    // Ignore storage errors (e.g., quota exceeded, private browsing)
  }
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Hook for managing display and regional settings
 *
 * @returns Display settings state and actions
 *
 * @example
 * ```tsx
 * const {
 *   displayCurrency,
 *   toggleDisplayCurrency,
 *   numberFormat,
 *   setNumberFormat,
 *   formatNumber,
 *   formatBitcoin
 * } = useDisplaySettings();
 *
 * // Toggle between USD and BTC display
 * <button onClick={toggleDisplayCurrency}>
 *   {displayCurrency}
 * </button>
 *
 * // Format a number according to locale
 * <span>{formatNumber(1234.56)}</span>
 *
 * // Format sats according to bitcoin format setting
 * <span>{formatBitcoin(100000)}</span>
 * ```
 */
export function useDisplaySettings(): UseDisplaySettingsReturn {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [displayCurrency, setDisplayCurrencyState] = useState<DisplayCurrency>(
    DEFAULT_DISPLAY_CURRENCY,
  )

  const [numberFormat, setNumberFormatState] = useState<NumberFormat>(() =>
    getFromStorage(STORAGE_KEYS.NUMBER_FORMAT, DEFAULT_NUMBER_FORMAT),
  )

  const [bitcoinFormat, setBitcoinFormatState] = useState<BitcoinFormat>(() =>
    getFromStorage(STORAGE_KEYS.BITCOIN_FORMAT, DEFAULT_BITCOIN_FORMAT),
  )

  const [numpadLayout, setNumpadLayoutState] = useState<NumpadLayout>(() =>
    getFromStorage(STORAGE_KEYS.NUMPAD_LAYOUT, DEFAULT_NUMPAD_LAYOUT),
  )

  const [amountDisplay, setAmountDisplayState] = useState<AmountDisplay>(() =>
    getFromStorage(STORAGE_KEYS.AMOUNT_DISPLAY, DEFAULT_AMOUNT_DISPLAY),
  )

  const [currencyFilter, setCurrencyFilterState] = useState<string>("")
  const [currencyFilterDebounced, setCurrencyFilterDebouncedState] = useState<string>("")

  // ---------------------------------------------------------------------------
  // Callbacks - Display Currency
  // ---------------------------------------------------------------------------

  const setDisplayCurrency = useCallback((currency: DisplayCurrency) => {
    setDisplayCurrencyState(currency)
  }, [])

  const toggleDisplayCurrency = useCallback(() => {
    setDisplayCurrencyState((prev) => (prev === "USD" ? "BTC" : "USD"))
  }, [])

  // ---------------------------------------------------------------------------
  // Callbacks - Number Format
  // ---------------------------------------------------------------------------

  const setNumberFormat = useCallback((format: NumberFormat) => {
    setNumberFormatState(format)
    setToStorage(STORAGE_KEYS.NUMBER_FORMAT, format)
  }, [])

  // ---------------------------------------------------------------------------
  // Callbacks - Bitcoin Format
  // ---------------------------------------------------------------------------

  const setBitcoinFormat = useCallback((format: BitcoinFormat) => {
    setBitcoinFormatState(format)
    setToStorage(STORAGE_KEYS.BITCOIN_FORMAT, format)
  }, [])

  // ---------------------------------------------------------------------------
  // Callbacks - Numpad Layout
  // ---------------------------------------------------------------------------

  const setNumpadLayout = useCallback((layout: NumpadLayout) => {
    setNumpadLayoutState(layout)
    setToStorage(STORAGE_KEYS.NUMPAD_LAYOUT, layout)
  }, [])

  // ---------------------------------------------------------------------------
  // Callbacks - Amount Display
  // ---------------------------------------------------------------------------

  const setAmountDisplay = useCallback((preference: AmountDisplay) => {
    setAmountDisplayState(preference)
    setToStorage(STORAGE_KEYS.AMOUNT_DISPLAY, preference)
  }, [])

  // ---------------------------------------------------------------------------
  // Callbacks - Currency Filter
  // ---------------------------------------------------------------------------

  const setCurrencyFilter = useCallback((filter: string) => {
    setCurrencyFilterState(filter)
  }, [])

  const setCurrencyFilterDebounced = useCallback((filter: string) => {
    setCurrencyFilterDebouncedState(filter)
  }, [])

  const clearCurrencyFilter = useCallback(() => {
    setCurrencyFilterState("")
    setCurrencyFilterDebouncedState("")
  }, [])

  // ---------------------------------------------------------------------------
  // Utility Functions
  // ---------------------------------------------------------------------------

  const getLocaleFromFormat = useCallback((): string => {
    if (numberFormat === "auto") {
      return typeof navigator !== "undefined" ? navigator.language : "en-US"
    }
    return FORMAT_LOCALES[numberFormat] ?? "en-US"
  }, [numberFormat])

  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions): string => {
      const locale = getLocaleFromFormat()
      try {
        return new Intl.NumberFormat(locale, options).format(value)
      } catch {
        return value.toString()
      }
    },
    [getLocaleFromFormat],
  )

  const formatBitcoin = useCallback(
    (sats: number): string => {
      const locale = getLocaleFromFormat()

      switch (bitcoinFormat) {
        case "bip177": {
          // BIP-177: Use ₿ symbol with appropriate decimal places
          const btc = sats / 100_000_000
          try {
            return `₿${new Intl.NumberFormat(locale, { minimumFractionDigits: 8, maximumFractionDigits: 8 }).format(btc)}`
          } catch {
            return `₿${btc.toFixed(8)}`
          }
        }
        case "sat": {
          // Bitcoin Beach legacy format — uppercase unit
          try {
            return `${new Intl.NumberFormat(locale).format(sats)} SAT`
          } catch {
            return `${sats} SAT`
          }
        }
        case "sats":
        default: {
          try {
            return `${new Intl.NumberFormat(locale).format(sats)} sats`
          } catch {
            return `${sats} sats`
          }
        }
      }
    },
    [bitcoinFormat, getLocaleFromFormat],
  )

  // ---------------------------------------------------------------------------
  // Debounce Effect for Currency Filter
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const timer = setTimeout(() => {
      setCurrencyFilterDebouncedState(currencyFilter)
    }, 300)

    return () => clearTimeout(timer)
  }, [currencyFilter])

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    // Display currency
    displayCurrency,
    setDisplayCurrency,
    toggleDisplayCurrency,

    // Number format
    numberFormat,
    setNumberFormat,

    // Bitcoin format
    bitcoinFormat,
    setBitcoinFormat,

    // Numpad layout
    numpadLayout,
    setNumpadLayout,

    // Amount display
    amountDisplay,
    setAmountDisplay,

    // Currency filter
    currencyFilter,
    setCurrencyFilter,
    currencyFilterDebounced,
    setCurrencyFilterDebounced,
    clearCurrencyFilter,

    // Utility functions
    formatNumber,
    formatBitcoin,
    getLocaleFromFormat,
  }
}

export default useDisplaySettings
