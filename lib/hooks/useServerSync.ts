import { useEffect, useRef, useCallback } from "react"

import { initTransactionLabels } from "../../components/TransactionDetail"
import { getApiUrl } from "../config/api"

import {
  hasStoredDisplayCurrency,
  type NumberFormat,
  type NumpadLayout,
  type DisplayCurrency,
} from "./useDisplaySettings"
import type { SoundTheme } from "./useSoundSettings"
import type {
  VoucherWallet,
  VoucherCurrencyMode,
  VoucherExpiry,
} from "./useVoucherWalletState"

// Voucher Wallet storage key (user-scoped for security)
const VOUCHER_WALLET_OLD_KEY = "blinkpos-voucher-wallet" // Old global key (for cleanup)
const VOUCHER_WALLET_PREFIX = "blinkpos-voucher-wallet"

/**
 * Preferences object synced to the server.
 */
interface ServerPreferences {
  soundEnabled: boolean
  soundTheme: string
  tipsEnabled: boolean
  tipPresets: number[]
  displayCurrency: string
  numberFormat: string
  numpadLayout: string
  voucherCurrencyMode: string
  voucherExpiry: string
  [key: string]: unknown
}

/**
 * Parameters for the useServerSync hook.
 */
interface UseServerSyncParams {
  publicKey: string | null
  soundEnabled: boolean
  setSoundEnabled: (value: boolean) => void
  soundTheme: SoundTheme | string
  setSoundTheme: (value: SoundTheme) => void
  tipsEnabled: boolean
  setTipsEnabled: (value: boolean) => void
  tipPresets: number[]
  setTipPresets: (value: number[]) => void
  displayCurrency: string
  setDisplayCurrency: (value: DisplayCurrency) => void
  numberFormat: NumberFormat | string
  setNumberFormat: (value: NumberFormat) => void
  numpadLayout: NumpadLayout | string
  setNumpadLayout: (value: NumpadLayout) => void
  voucherCurrencyMode: VoucherCurrencyMode | string
  setVoucherCurrencyMode: (value: VoucherCurrencyMode) => void
  voucherExpiry: VoucherExpiry | string
  setVoucherExpiry: (value: VoucherExpiry) => void
  voucherWallet: VoucherWallet | null
  setVoucherWallet: (value: VoucherWallet | null) => void
  setVoucherWalletBalance: (value: number | null) => void
  setVoucherWalletUsdBalance: (value: number | null) => void
}

/**
 * Return type for the useServerSync hook.
 */
interface UseServerSyncReturn {
  syncVoucherWalletToServer: (walletData: VoucherWallet | null) => Promise<void>
  getVoucherWalletKey: (userPubkey: string | null) => string | null
}

/**
 * Get user-scoped storage key for voucher wallet
 * @param {string} userPubkey - User's public key
 * @returns {string|null} Storage key or null if no user
 */
export const getVoucherWalletKey = (userPubkey: string | null): string | null =>
  userPubkey ? `${VOUCHER_WALLET_PREFIX}_${userPubkey}` : null

/**
 * Clean up old global voucher wallet storage key
 * This prevents cross-user data leakage from old versions
 */
const cleanupOldGlobalVoucherWalletStorage = (): void => {
  try {
    if (localStorage.getItem(VOUCHER_WALLET_OLD_KEY)) {
      console.log("[Dashboard] Removing old global voucher wallet storage (security fix)")
      localStorage.removeItem(VOUCHER_WALLET_OLD_KEY)
    }
  } catch (err: unknown) {
    console.error("[Dashboard] Failed to cleanup old voucher wallet storage:", err)
  }
}

/**
 * Hook for syncing preferences and voucher wallet data to/from the server.
 *
 * Extracted from Dashboard.js — contains:
 * - syncPreferencesToServer (debounced 2s)
 * - syncVoucherWalletToServer
 * - Fetch preferences from server on login
 * - Sync preferences on change
 * - Voucher wallet server sync and migration
 * - User change detection (clear voucher wallet)
 * - Cleanup timer on unmount
 *
 * @param {Object} params - All required state and setters
 * @returns {Object} { syncVoucherWalletToServer, getVoucherWalletKey }
 */
export function useServerSync({
  publicKey,
  soundEnabled,
  setSoundEnabled,
  soundTheme,
  setSoundTheme,
  tipsEnabled,
  setTipsEnabled,
  tipPresets,
  setTipPresets,
  displayCurrency,
  setDisplayCurrency,
  numberFormat,
  setNumberFormat,
  numpadLayout,
  setNumpadLayout,
  voucherCurrencyMode,
  setVoucherCurrencyMode,
  voucherExpiry,
  setVoucherExpiry,
  voucherWallet,
  setVoucherWallet,
  setVoucherWalletBalance,
  setVoucherWalletUsdBalance,
}: UseServerSyncParams): UseServerSyncReturn {
  const serverSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSyncedPrefsRef = useRef<string | null>(null)

  // Sync preferences to server (debounced)
  const syncPreferencesToServer = useCallback(
    async (prefs: ServerPreferences) => {
      if (!publicKey) return

      // Clear existing timer
      if (serverSyncTimerRef.current) {
        clearTimeout(serverSyncTimerRef.current)
      }

      // Debounce the sync (2 seconds)
      serverSyncTimerRef.current = setTimeout(async () => {
        try {
          console.log("[Dashboard] Syncing preferences to server...")

          const response = await fetch("/api/user/sync", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include", // Include session cookie for auth
            body: JSON.stringify({
              pubkey: publicKey,
              field: "preferences",
              data: prefs,
            }),
          })

          if (response.ok) {
            console.log("[Dashboard] ✓ Preferences synced to server")
            lastSyncedPrefsRef.current = JSON.stringify(prefs)
          }
        } catch (err: unknown) {
          console.error("[Dashboard] Server sync error:", err)
        }
      }, 2000)
    },
    [publicKey],
  )

  // Sync voucher wallet to server
  const syncVoucherWalletToServer = useCallback(
    async (walletData: VoucherWallet | null) => {
      if (!publicKey) return

      try {
        console.log("[Dashboard] Syncing voucher wallet to server...")
        const response = await fetch("/api/user/sync", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include", // Include session cookie for auth
          body: JSON.stringify({
            pubkey: publicKey,
            field: "voucherWallet",
            data: walletData,
          }),
        })

        if (response.ok) {
          console.log("[Dashboard] ✓ Voucher wallet synced to server")
        }
      } catch (err: unknown) {
        console.error("[Dashboard] Failed to sync voucher wallet:", err)
      }
    },
    [publicKey],
  )

  // Fetch preferences from server on login
  useEffect(() => {
    if (!publicKey) return

    const fetchServerPreferences = async () => {
      try {
        console.log("[Dashboard] Fetching preferences from server...")
        const response = await fetch(`/api/user/sync?pubkey=${publicKey}`, {
          credentials: "include", // Include session cookie for auth
        })

        if (!response.ok) return

        const data = await response.json()
        const serverPrefs = data.preferences as ServerPreferences | undefined

        if (serverPrefs) {
          console.log("[Dashboard] Loaded preferences from server")

          // Apply server preferences to local state
          if (serverPrefs.soundEnabled !== undefined) {
            setSoundEnabled(serverPrefs.soundEnabled)
            localStorage.setItem("soundEnabled", JSON.stringify(serverPrefs.soundEnabled))
          }
          if (serverPrefs.soundTheme) {
            setSoundTheme(serverPrefs.soundTheme as SoundTheme)
            localStorage.setItem("soundTheme", serverPrefs.soundTheme)
          }
          if (serverPrefs.tipsEnabled !== undefined) {
            setTipsEnabled(serverPrefs.tipsEnabled)
            localStorage.setItem(
              "blinkpos-tips-enabled",
              serverPrefs.tipsEnabled.toString(),
            )
          }
          if (serverPrefs.tipPresets) {
            setTipPresets(serverPrefs.tipPresets)
            localStorage.setItem(
              "blinkpos-tip-presets",
              JSON.stringify(serverPrefs.tipPresets),
            )
          }
          // Seed display currency from server prefs on first run only. A
          // persisted device choice is authoritative and must survive login
          // (persist last selected currency per device). Outbound sync below
          // still propagates local changes to the server.
          if (serverPrefs.displayCurrency && !hasStoredDisplayCurrency()) {
            setDisplayCurrency(serverPrefs.displayCurrency as DisplayCurrency)
          }
          if (serverPrefs.numberFormat) {
            setNumberFormat(serverPrefs.numberFormat as NumberFormat)
            localStorage.setItem("blinkpos-number-format", serverPrefs.numberFormat)
          }
          if (serverPrefs.numpadLayout) {
            setNumpadLayout(serverPrefs.numpadLayout as NumpadLayout)
            localStorage.setItem("blinkpos-numpad-layout", serverPrefs.numpadLayout)
          }
          if (serverPrefs.voucherCurrencyMode) {
            setVoucherCurrencyMode(serverPrefs.voucherCurrencyMode as VoucherCurrencyMode)
            localStorage.setItem(
              "blinkpos-voucher-currency-mode",
              serverPrefs.voucherCurrencyMode,
            )
          }
          // Handle voucherExpiry with migration from old default '7d' to new default '24h'
          if (serverPrefs.voucherExpiry) {
            // Migration: if server has '7d' or legacy values, migrate to '24h'
            const migratedExpiry =
              serverPrefs.voucherExpiry === "7d" ||
              serverPrefs.voucherExpiry === "15m" ||
              serverPrefs.voucherExpiry === "1h"
                ? "24h"
                : serverPrefs.voucherExpiry
            setVoucherExpiry(migratedExpiry as VoucherExpiry)
            localStorage.setItem("blinkpos-voucher-expiry", migratedExpiry)
          }

          lastSyncedPrefsRef.current = JSON.stringify(serverPrefs)
        } else {
          // No server preferences - sync current local to server
          const currentPrefs: ServerPreferences = {
            soundEnabled,
            soundTheme,
            tipsEnabled,
            tipPresets,
            displayCurrency,
            numberFormat,
            numpadLayout,
            voucherCurrencyMode,
            voucherExpiry,
          }
          syncPreferencesToServer(currentPrefs)
        }

        // Initialize transaction labels from server
        await initTransactionLabels()
        console.log("[Dashboard] Transaction labels synced from server")

        // Clean up old global voucher wallet key (security fix for cross-profile leakage)
        cleanupOldGlobalVoucherWalletStorage()

        // Sync voucher wallet from server (using user-scoped localStorage key)
        const voucherWalletStorageKey = getVoucherWalletKey(publicKey)
        console.log(
          "[Dashboard] voucherWallet from server:",
          data.voucherWallet
            ? {
                label: data.voucherWallet.label,
                hasApiKey: !!data.voucherWallet.apiKey,
                apiKeyLength: data.voucherWallet.apiKey?.length || 0,
                apiKeyType: typeof data.voucherWallet.apiKey,
              }
            : "null/undefined",
        )

        if (data.voucherWallet && data.voucherWallet.apiKey) {
          console.log(
            "[Dashboard] Loaded voucher wallet from server:",
            data.voucherWallet.label,
          )
          setVoucherWallet(data.voucherWallet)
          if (voucherWalletStorageKey) {
            localStorage.setItem(
              voucherWalletStorageKey,
              JSON.stringify(data.voucherWallet),
            )
          }
        } else if (!data.voucherWallet) {
          // Check if we have local voucher wallet (user-scoped) to sync to server
          if (voucherWalletStorageKey) {
            const localVoucherWallet = localStorage.getItem(voucherWalletStorageKey)
            if (localVoucherWallet) {
              const parsed = JSON.parse(localVoucherWallet) as VoucherWallet
              console.log("[Dashboard] Syncing local voucher wallet to server")
              syncVoucherWalletToServer(parsed)
              setVoucherWallet(parsed)
            }
          }
        }
      } catch (err: unknown) {
        console.error("[Dashboard] Failed to fetch server preferences:", err)
      }
    }

    fetchServerPreferences()
  }, [publicKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Track previous user to detect user changes
  const prevUserRef = useRef<string | null>(publicKey)

  // Clear voucher wallet state when user changes (logout/switch user)
  // This prevents cross-user data leakage
  useEffect(() => {
    const prevUser = prevUserRef.current

    // User has changed (including logout where publicKey becomes null/undefined)
    if (prevUser !== publicKey) {
      console.log("[Dashboard] User changed, clearing voucher wallet state")
      setVoucherWallet(null)
      setVoucherWalletBalance(null)
      setVoucherWalletUsdBalance(null)
      prevUserRef.current = publicKey
    }
  }, [publicKey])

  // Migration: Fetch missing username for voucher wallet (for wallets created before username was added)
  useEffect(() => {
    const migrateVoucherWalletUsername = async () => {
      if (!voucherWallet || !voucherWallet.apiKey || voucherWallet.username) {
        return // No wallet, no API key, or already has username
      }

      console.log("[Dashboard] Migrating voucher wallet: fetching username...")

      try {
        const response = await fetch(getApiUrl(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": voucherWallet.apiKey,
          },
          body: JSON.stringify({
            query: "{ me { username } }",
          }),
        })

        if (!response.ok) {
          console.warn(
            "[Dashboard] Failed to fetch username for voucher wallet migration",
          )
          return
        }

        const data = await response.json()
        const username = data.data?.me?.username as string | undefined

        if (username) {
          console.log("[Dashboard] ✓ Voucher wallet username fetched:", username)

          // Update wallet data with username
          const updatedWallet: VoucherWallet = { ...voucherWallet, username }
          setVoucherWallet(updatedWallet)

          // Save to localStorage (user-scoped)
          if (typeof window !== "undefined" && publicKey) {
            const storageKey = getVoucherWalletKey(publicKey)
            if (storageKey) {
              localStorage.setItem(storageKey, JSON.stringify(updatedWallet))
            }
          }

          // Sync to server
          syncVoucherWalletToServer(updatedWallet)
        }
      } catch (err: unknown) {
        console.error("[Dashboard] Failed to migrate voucher wallet username:", err)
      }
    }

    migrateVoucherWalletUsername()
  }, [voucherWallet?.apiKey]) // Only run when voucherWallet.apiKey changes (initial load)

  // Sync preferences to server when they change
  useEffect(() => {
    if (!publicKey) return

    const currentPrefs: ServerPreferences = {
      soundEnabled,
      soundTheme,
      tipsEnabled,
      tipPresets,
      displayCurrency,
      numberFormat,
      numpadLayout,
      voucherCurrencyMode,
      voucherExpiry,
    }

    const currentPrefsStr = JSON.stringify(currentPrefs)

    // Only sync if preferences actually changed (avoid initial sync loop)
    if (lastSyncedPrefsRef.current && lastSyncedPrefsRef.current !== currentPrefsStr) {
      syncPreferencesToServer(currentPrefs)
    }
  }, [
    publicKey,
    soundEnabled,
    soundTheme,
    tipsEnabled,
    tipPresets,
    displayCurrency,
    numberFormat,
    numpadLayout,
    voucherCurrencyMode,
    voucherExpiry,
    syncPreferencesToServer,
  ])

  // Cleanup server sync timer on unmount
  useEffect(() => {
    return () => {
      if (serverSyncTimerRef.current) {
        clearTimeout(serverSyncTimerRef.current)
      }
    }
  }, [])

  return {
    syncVoucherWalletToServer,
    getVoucherWalletKey,
  }
}

export default useServerSync
