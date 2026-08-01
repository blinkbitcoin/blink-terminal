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
import type { OrangePillMode } from "../orangepill"

import { type Theme, normalizeEnabledThemes, parseEnabledThemes } from "./useTheme"

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

  // Themes included in the logo-tap cycle (subset of THEME_ORDER, >= 1)
  enabledThemes: Theme[]
  setEnabledThemes: (themes: Theme[]) => void

  // Amount display state (fiat-primary vs sats-primary)
  amountDisplay: AmountDisplay
  setAmountDisplay: (preference: AmountDisplay) => void

  // Orange-pill receipt footer state
  orangePillMode: OrangePillMode
  setOrangePillMode: (mode: OrangePillMode) => void
  orangePillStaticUrl: string
  setOrangePillStaticUrl: (url: string) => void

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
  DISPLAY_CURRENCY: "blinkpos-display-currency",
  NUMBER_FORMAT: "blinkpos-number-format",
  BITCOIN_FORMAT: "blinkpos-bitcoin-format",
  NUMPAD_LAYOUT: "blinkpos-numpad-layout",
  AMOUNT_DISPLAY: "blinkpos-amount-display",
  ENABLED_THEMES: "blinkpos-enabled-themes",
  ORANGE_PILL_MODE: "blinkpos-orangepill-mode",
  ORANGE_PILL_STATIC_URL: "blinkpos-orangepill-static-url",
} as const

const DEFAULT_NUMBER_FORMAT: NumberFormat = "auto"
const DEFAULT_BITCOIN_FORMAT: BitcoinFormat = "sats"
const DEFAULT_NUMPAD_LAYOUT: NumpadLayout = "calculator"
const DEFAULT_DISPLAY_CURRENCY: DisplayCurrency = "USD"

/**
 * Whether this device already has a persisted display-currency choice.
 *
 * Used by login-time effects to decide whether to seed the display currency
 * from the account/server (first run only) or leave the device choice intact.
 */
export function hasStoredDisplayCurrency(): boolean {
  if (typeof window === "undefined") {
    return false
  }
  try {
    return localStorage.getItem(STORAGE_KEYS.DISPLAY_CURRENCY) !== null
  } catch {
    return false
  }
}

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

  const [displayCurrency, setDisplayCurrencyState] = useState<DisplayCurrency>(() => {
    const stored = getFromStorage<string>(
      STORAGE_KEYS.DISPLAY_CURRENCY,
      DEFAULT_DISPLAY_CURRENCY,
    )
    return stored === "USD" || stored === "BTC" ? stored : DEFAULT_DISPLAY_CURRENCY
  })

  const [numberFormat, setNumberFormatState] = useState<NumberFormat>(() =>
    getFromStorage(STORAGE_KEYS.NUMBER_FORMAT, DEFAULT_NUMBER_FORMAT),
  )

  const [bitcoinFormat, setBitcoinFormatState] = useState<BitcoinFormat>(() =>
    getFromStorage(STORAGE_KEYS.BITCOIN_FORMAT, DEFAULT_BITCOIN_FORMAT),
  )

  const [numpadLayout, setNumpadLayoutState] = useState<NumpadLayout>(() =>
    getFromStorage(STORAGE_KEYS.NUMPAD_LAYOUT, DEFAULT_NUMPAD_LAYOUT),
  )

  const [enabledThemes, setEnabledThemesState] = useState<Theme[]>(() =>
    parseEnabledThemes(
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(STORAGE_KEYS.ENABLED_THEMES),
    ),
  )

  const [amountDisplay, setAmountDisplayState] = useState<AmountDisplay>(() =>
    getFromStorage(STORAGE_KEYS.AMOUNT_DISPLAY, DEFAULT_AMOUNT_DISPLAY),
  )

  const [orangePillMode, setOrangePillModeState] = useState<OrangePillMode>(() =>
    getFromStorage<OrangePillMode>(STORAGE_KEYS.ORANGE_PILL_MODE, "off"),
  )

  const [orangePillStaticUrl, setOrangePillStaticUrlState] = useState<string>(() =>
    getFromStorage(STORAGE_KEYS.ORANGE_PILL_STATIC_URL, ""),
  )

  const [currencyFilter, setCurrencyFilterState] = useState<string>("")
  const [currencyFilterDebounced, setCurrencyFilterDebouncedState] = useState<string>("")

  // ---------------------------------------------------------------------------
  // Callbacks - Display Currency
  // ---------------------------------------------------------------------------

  const setDisplayCurrency = useCallback((currency: DisplayCurrency) => {
    setDisplayCurrencyState(currency)
    setToStorage(STORAGE_KEYS.DISPLAY_CURRENCY, currency)
  }, [])

  const toggleDisplayCurrency = useCallback(() => {
    setDisplayCurrencyState((prev) => {
      const next = prev === "USD" ? "BTC" : "USD"
      setToStorage(STORAGE_KEYS.DISPLAY_CURRENCY, next)
      return next
    })
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
  // Callbacks - Enabled Themes (logo-tap cycle set)
  // ---------------------------------------------------------------------------

  const setEnabledThemes = useCallback((themes: Theme[]) => {
    // Keep canonical order and never persist an empty set.
    const next = normalizeEnabledThemes(themes)
    setEnabledThemesState(next)
    setToStorage(STORAGE_KEYS.ENABLED_THEMES, JSON.stringify(next))
  }, [])

  // ---------------------------------------------------------------------------
  // Callbacks - Amount Display
  // ---------------------------------------------------------------------------

  const setAmountDisplay = useCallback((preference: AmountDisplay) => {
    setAmountDisplayState(preference)
    setToStorage(STORAGE_KEYS.AMOUNT_DISPLAY, preference)
  }, [])

  // ---------------------------------------------------------------------------
  // Callbacks - Orange-pill footer
  // ---------------------------------------------------------------------------

  const setOrangePillMode = useCallback((mode: OrangePillMode) => {
    setOrangePillModeState(mode)
    setToStorage(STORAGE_KEYS.ORANGE_PILL_MODE, mode)
  }, [])

  const setOrangePillStaticUrl = useCallback((url: string) => {
    setOrangePillStaticUrlState(url)
    setToStorage(STORAGE_KEYS.ORANGE_PILL_STATIC_URL, url)
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

    // Enabled themes (logo-tap cycle set)
    enabledThemes,
    setEnabledThemes,

    // Amount display
    amountDisplay,
    setAmountDisplay,

    // Orange-pill footer
    orangePillMode,
    setOrangePillMode,
    orangePillStaticUrl,
    setOrangePillStaticUrl,

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
