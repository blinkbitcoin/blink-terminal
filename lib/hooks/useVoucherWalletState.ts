/**
 * useVoucherWalletState Hook
 *
 * Manages voucher wallet state for the Dashboard component.
 * Handles voucher wallet configuration, balance tracking, and voucher creation settings.
 *
 * This hook extracts voucher wallet-related state from Dashboard.js to reduce complexity.
 */

import { useState, useCallback } from "react"

export type VoucherCurrencyMode = "BTC" | "USD"

// Mirrors the preset IDs in lib/voucher-expiry.ts (EXPIRY_PRESETS).
export type VoucherExpiry =
  | "15m"
  | "1h"
  | "3h"
  | "12h"
  | "24h"
  | "72h"
  | "7d"
  | "30d"
  | "90d"
  | "6mo"
  // Legacy/loose values that may still exist in storage.
  | "48h"
  | "168h"

export interface VoucherWalletScopes {
  receive?: boolean
  send?: boolean
  read?: boolean
  write?: boolean
  [key: string]: boolean | undefined
}

export interface VoucherWallet {
  id: string
  label: string
  apiKey: string
  btcWalletId?: string
  usdWalletId?: string
  [key: string]: unknown
}

export interface VoucherWalletState {
  // Wallet configuration
  voucherWallet: VoucherWallet | null
  voucherWalletApiKey: string
  voucherWalletLabel: string

  // Loading/error states
  voucherWalletLoading: boolean
  voucherWalletError: string | null
  voucherWalletValidating: boolean

  // Wallet details
  voucherWalletScopes: string[] | null
  voucherWalletBtcId: string | null
  voucherWalletUsdId: string | null

  // Balance tracking
  voucherWalletBalance: number | null
  voucherWalletUsdBalance: number | null
  voucherWalletBalanceLoading: boolean
  usdExchangeRate: number | null

  // Voucher creation settings
  voucherCurrencyMode: VoucherCurrencyMode
  voucherExpiry: VoucherExpiry

  // Capacity indicator state (for real-time amount tracking)
  currentAmountInSats: number
  currentAmountInUsdCents: number
  currentVoucherCurrencyMode: VoucherCurrencyMode
}

export interface VoucherWalletActions {
  // Wallet configuration setters
  setVoucherWallet: (wallet: VoucherWallet | null) => void
  setVoucherWalletApiKey: (apiKey: string) => void
  setVoucherWalletLabel: (label: string) => void

  // Loading/error setters
  setVoucherWalletLoading: (loading: boolean) => void
  setVoucherWalletError: (error: string | null) => void
  setVoucherWalletValidating: (validating: boolean) => void

  // Wallet details setters
  setVoucherWalletScopes: (scopes: string[] | null) => void
  setVoucherWalletBtcId: (id: string | null) => void
  setVoucherWalletUsdId: (id: string | null) => void

  // Balance setters
  setVoucherWalletBalance: (balance: number | null) => void
  setVoucherWalletUsdBalance: (balance: number | null) => void
  setVoucherWalletBalanceLoading: (loading: boolean) => void
  setUsdExchangeRate: (rate: number | null) => void

  // Voucher creation settings setters
  setVoucherCurrencyMode: (mode: VoucherCurrencyMode) => void
  setVoucherExpiry: (expiry: VoucherExpiry) => void

  // Capacity indicator setters
  setCurrentAmountInSats: (amount: number) => void
  setCurrentAmountInUsdCents: (amount: number) => void
  setCurrentVoucherCurrencyMode: (mode: VoucherCurrencyMode) => void

  // Utility actions
  resetVoucherWalletForm: () => void
  clearVoucherWallet: () => void
  resetCapacityIndicator: () => void
}

export type UseVoucherWalletStateReturn = VoucherWalletState & VoucherWalletActions

/**
 * Load voucher currency mode from localStorage
 */
function loadVoucherCurrencyMode(): VoucherCurrencyMode {
  if (typeof window !== "undefined") {
    const saved = localStorage.getItem("blinkpos-voucher-currency-mode")
    return saved === "USD" ? "USD" : "BTC"
  }
  return "BTC"
}

/**
 * Load voucher expiry from localStorage
 */
function loadVoucherExpiry(): VoucherExpiry {
  if (typeof window !== "undefined") {
    const saved = localStorage.getItem("blinkpos-voucher-expiry")
    // Migration: legacy default '7d' is migrated to '24h'. (15m/1h are now
    // valid short UI options, so they are preserved.)
    if (!saved || saved === "7d") {
      return "24h"
    }
    return saved as VoucherExpiry
  }
  return "24h"
}

/**
 * Hook for managing voucher wallet state
 *
 * @example
 * ```tsx
 * const {
 *   voucherWallet,
 *   setVoucherWallet,
 *   voucherWalletBalance,
 *   voucherCurrencyMode,
 *   setVoucherCurrencyMode,
 *   resetVoucherWalletForm
 * } = useVoucherWalletState()
 *
 * // Configure voucher wallet
 * setVoucherWallet({ id: '123', label: 'My Voucher Wallet', apiKey: 'key' })
 *
 * // Switch currency mode
 * setVoucherCurrencyMode('USD')
 *
 * // Reset form after disconnecting
 * resetVoucherWalletForm()
 * ```
 */
export function useVoucherWalletState(): UseVoucherWalletStateReturn {
  // Wallet configuration
  const [voucherWallet, setVoucherWallet] = useState<VoucherWallet | null>(null)
  const [voucherWalletApiKey, setVoucherWalletApiKey] = useState("")
  const [voucherWalletLabel, setVoucherWalletLabel] = useState("")

  // Loading/error states
  const [voucherWalletLoading, setVoucherWalletLoading] = useState(false)
  const [voucherWalletError, setVoucherWalletError] = useState<string | null>(null)
  const [voucherWalletValidating, setVoucherWalletValidating] = useState(false)

  // Wallet details
  const [voucherWalletScopes, setVoucherWalletScopes] = useState<string[] | null>(null)
  const [voucherWalletBtcId, setVoucherWalletBtcId] = useState<string | null>(null)
  const [voucherWalletUsdId, setVoucherWalletUsdId] = useState<string | null>(null)

  // Balance tracking
  const [voucherWalletBalance, setVoucherWalletBalance] = useState<number | null>(null)
  const [voucherWalletUsdBalance, setVoucherWalletUsdBalance] = useState<number | null>(
    null,
  )
  const [voucherWalletBalanceLoading, setVoucherWalletBalanceLoading] = useState(false)
  const [usdExchangeRate, setUsdExchangeRate] = useState<number | null>(null)

  // Voucher creation settings (loaded from localStorage)
  const [voucherCurrencyMode, setVoucherCurrencyModeState] =
    useState<VoucherCurrencyMode>(loadVoucherCurrencyMode)
  const [voucherExpiry, setVoucherExpiryState] =
    useState<VoucherExpiry>(loadVoucherExpiry)

  // Capacity indicator state
  const [currentAmountInSats, setCurrentAmountInSats] = useState(0)
  const [currentAmountInUsdCents, setCurrentAmountInUsdCents] = useState(0)
  const [currentVoucherCurrencyMode, setCurrentVoucherCurrencyMode] =
    useState<VoucherCurrencyMode>("BTC")

  /**
   * Set voucher currency mode and persist to localStorage
   */
  const setVoucherCurrencyMode = useCallback((mode: VoucherCurrencyMode) => {
    setVoucherCurrencyModeState(mode)
    if (typeof window !== "undefined") {
      localStorage.setItem("blinkpos-voucher-currency-mode", mode)
    }
  }, [])

  /**
   * Set voucher expiry and persist to localStorage
   */
  const setVoucherExpiry = useCallback((expiry: VoucherExpiry) => {
    setVoucherExpiryState(expiry)
    if (typeof window !== "undefined") {
      localStorage.setItem("blinkpos-voucher-expiry", expiry)
    }
  }, [])

  /**
   * Reset the voucher wallet form (for adding new wallet)
   */
  const resetVoucherWalletForm = useCallback(() => {
    setVoucherWalletApiKey("")
    setVoucherWalletLabel("")
    setVoucherWalletLoading(false)
    setVoucherWalletError(null)
    setVoucherWalletValidating(false)
    setVoucherWalletScopes(null)
  }, [])

  /**
   * Clear the voucher wallet completely (disconnect)
   */
  const clearVoucherWallet = useCallback(() => {
    setVoucherWallet(null)
    setVoucherWalletApiKey("")
    setVoucherWalletLabel("")
    setVoucherWalletLoading(false)
    setVoucherWalletError(null)
    setVoucherWalletValidating(false)
    setVoucherWalletScopes(null)
    setVoucherWalletBtcId(null)
    setVoucherWalletUsdId(null)
    setVoucherWalletBalance(null)
    setVoucherWalletUsdBalance(null)
    setVoucherWalletBalanceLoading(false)
  }, [])

  /**
   * Reset capacity indicator state
   */
  const resetCapacityIndicator = useCallback(() => {
    setCurrentAmountInSats(0)
    setCurrentAmountInUsdCents(0)
    setCurrentVoucherCurrencyMode("BTC")
  }, [])

  return {
    // State
    voucherWallet,
    voucherWalletApiKey,
    voucherWalletLabel,
    voucherWalletLoading,
    voucherWalletError,
    voucherWalletValidating,
    voucherWalletScopes,
    voucherWalletBtcId,
    voucherWalletUsdId,
    voucherWalletBalance,
    voucherWalletUsdBalance,
    voucherWalletBalanceLoading,
    usdExchangeRate,
    voucherCurrencyMode,
    voucherExpiry,
    currentAmountInSats,
    currentAmountInUsdCents,
    currentVoucherCurrencyMode,

    // Actions
    setVoucherWallet,
    setVoucherWalletApiKey,
    setVoucherWalletLabel,
    setVoucherWalletLoading,
    setVoucherWalletError,
    setVoucherWalletValidating,
    setVoucherWalletScopes,
    setVoucherWalletBtcId,
    setVoucherWalletUsdId,
    setVoucherWalletBalance,
    setVoucherWalletUsdBalance,
    setVoucherWalletBalanceLoading,
    setUsdExchangeRate,
    setVoucherCurrencyMode,
    setVoucherExpiry,
    setCurrentAmountInSats,
    setCurrentAmountInUsdCents,
    setCurrentVoucherCurrencyMode,
    resetVoucherWalletForm,
    clearVoucherWallet,
    resetCapacityIndicator,
  }
}

export default useVoucherWalletState
