import { useEffect } from "react"

import { isBitcoinCurrency } from "../currency-utils"

import type { CombinedUser } from "./useCombinedAuth"
import type { ExchangeRateData } from "./useExchangeRate"
import type { TipProfile } from "./useTipSettings"
import type { VoucherWallet } from "./useVoucherWalletState"

// ─── Types ────────────────────────────────────────────────────────

/** @deprecated Use ExchangeRateData from useExchangeRate instead */
export type ExchangeRate = ExchangeRateData

/** @deprecated Use TipProfile from useTipSettings instead */
export type ActiveTipProfile = TipProfile

/** @deprecated Use CombinedUser from useCombinedAuth instead */
export type ExchangeRateUser = CombinedUser

export interface UseExchangeRateFetcherParams {
  displayCurrency: string
  apiKey: string | null
  setExchangeRate: (rate: ExchangeRateData) => void
  setLoadingRate: (loading: boolean) => void
  voucherWallet: VoucherWallet | null
  setUsdExchangeRate: (rate: number | null) => void
  activeTipProfile: TipProfile | null
  setTipPresets: (presets: number[]) => void
  resetTipRecipient: () => void
  user: CombinedUser | null
}

// ─── Hook ─────────────────────────────────────────────────────────

/**
 * Hook for fetching exchange rates and syncing tip profile presets.
 *
 * Extracted from Dashboard.js — contains:
 * - Fetch exchange rate when display currency changes (for ItemCart sats display)
 * - Fetch USD exchange rate for voucher creation (5-min interval)
 * - Sync tipPresets when activeTipProfile changes
 * - Clear tip recipient when user changes
 *
 * @param {Object} params
 * @param {string} params.displayCurrency - Current display currency code
 * @param {string|null} params.apiKey - User's API key
 * @param {Function} params.setExchangeRate - Setter for exchange rate
 * @param {Function} params.setLoadingRate - Setter for loading state
 * @param {Object|null} params.voucherWallet - Voucher wallet config
 * @param {Function} params.setUsdExchangeRate - Setter for USD exchange rate
 * @param {Object|null} params.activeTipProfile - Active tip profile
 * @param {Function} params.setTipPresets - Setter for tip presets
 * @param {Function} params.resetTipRecipient - Reset tip recipient and validation
 * @param {Object|null} params.user - Current user object
 */
export function useExchangeRateFetcher({
  displayCurrency,
  apiKey,
  setExchangeRate,
  setLoadingRate,
  voucherWallet,
  setUsdExchangeRate,
  activeTipProfile,
  setTipPresets,
  resetTipRecipient,
  user,
}: UseExchangeRateFetcherParams): void {
  // Fetch exchange rate when currency changes (for sats equivalent display in ItemCart)
  useEffect(() => {
    // Ignore responses that land after the currency changed again — a slow
    // response for a previous currency must not overwrite the current rate.
    let cancelled = false

    const fetchExchangeRate = async (): Promise<void> => {
      if (isBitcoinCurrency(displayCurrency)) {
        setExchangeRate({ satPriceInCurrency: 1, currency: "BTC" })
        return
      }

      setLoadingRate(true)
      try {
        const response = await fetch("/api/rates/exchange-rate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey: apiKey,
            currency: displayCurrency,
            // Use BlinkPOS credentials if no API key available
            useBlinkpos: !apiKey,
          }),
        })

        const data = await response.json()
        if (cancelled) return

        if (data.success) {
          setExchangeRate({
            satPriceInCurrency: data.satPriceInCurrency,
            currency: data.currency,
          })
          console.log(`Exchange rate for ${displayCurrency}:`, data.satPriceInCurrency)
        } else {
          console.error("Failed to fetch exchange rate:", data.error)
        }
      } catch (error: unknown) {
        if (!cancelled) console.error("Exchange rate error:", error)
      } finally {
        if (!cancelled) setLoadingRate(false)
      }
    }

    fetchExchangeRate()

    return () => {
      cancelled = true
    }
  }, [displayCurrency, apiKey])

  // Fetch USD exchange rate for voucher creation (needed for USD/Stablesats vouchers)
  useEffect(() => {
    const fetchUsdExchangeRate = async (): Promise<void> => {
      // Only fetch if voucher wallet is connected
      if (!voucherWallet?.apiKey) {
        setUsdExchangeRate(null)
        return
      }

      try {
        const response = await fetch("/api/rates/exchange-rate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey: voucherWallet.apiKey,
            currency: "USD",
            // Use BlinkPOS credentials if no API key available
            useBlinkpos: !voucherWallet.apiKey,
          }),
        })

        const data = await response.json()

        if (data.success) {
          setUsdExchangeRate(data.satPriceInCurrency)
          console.log("[VoucherWallet] USD exchange rate:", data.satPriceInCurrency)
        } else {
          console.error("[VoucherWallet] Failed to fetch USD exchange rate:", data.error)
          setUsdExchangeRate(null)
        }
      } catch (error: unknown) {
        console.error("[VoucherWallet] USD exchange rate error:", error)
        setUsdExchangeRate(null)
      }
    }

    fetchUsdExchangeRate()

    // Refresh USD rate every 5 minutes while voucher wallet is connected
    // (skipping ticks while the tab is hidden)
    const refreshWhileVisible = (): void => {
      const hidden =
        typeof document !== "undefined" && document.visibilityState === "hidden"
      if (hidden) return
      fetchUsdExchangeRate()
    }
    const intervalId: NodeJS.Timeout | null = voucherWallet?.apiKey
      ? setInterval(refreshWhileVisible, 5 * 60 * 1000)
      : null

    return () => {
      if (intervalId) clearInterval(intervalId)
    }
  }, [voucherWallet?.apiKey])

  // Sync tipPresets when profile changes
  useEffect(() => {
    if (activeTipProfile) {
      // Update tipPresets to match the profile's tip options
      setTipPresets(activeTipProfile.tipOptions)
    }
  }, [activeTipProfile])

  // Clear tip recipient when user changes (no persistence across sessions)
  useEffect(() => {
    resetTipRecipient()
    // Also clear any existing localStorage value
    if (typeof window !== "undefined") {
      localStorage.removeItem("blinkpos-tip-recipient")
    }
  }, [user?.username])
}

export default useExchangeRateFetcher
