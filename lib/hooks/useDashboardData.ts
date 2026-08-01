import { useEffect, useRef, useCallback, MutableRefObject } from "react"

import type { TransactionRecord } from "../../components/TransactionDetail"
import { getEnvironment } from "../config/api"
import type { ListTransactionsParams } from "../nwc/NWCClient"

import type { PaymentData } from "./useBlinkWebSocket"
import type { CombinedUser } from "./useCombinedAuth"
import { hasStoredDisplayCurrency, type DisplayCurrency } from "./useDisplaySettings"
import type { LocalNWCConnection, NWCOperationResult } from "./useNWC"
import type { LocalBlinkAccount } from "./useProfile"
import type { VoucherWallet, VoucherCurrencyMode } from "./useVoucherWalletState"
import type { WalletInfo } from "./useWalletState"

// ============================================================================
// Interfaces
// ============================================================================

/** @deprecated Use TransactionRecord from TransactionDetail instead */
export type Transaction = TransactionRecord

/** @deprecated Use CombinedUser from useCombinedAuth instead */
export type User = CombinedUser

/** @deprecated Use WalletInfo from useWalletState instead */
export type Wallet = WalletInfo

// Re-export for backward compatibility
export type { VoucherWallet }

/**
 * Exchange rate data
 */
export interface ExchangeRate {
  satPriceInCurrency: number
  currency: string
}

/**
 * NWC transaction from NIP-47
 */
interface _NWCTransaction {
  payment_hash?: string
  preimage?: string
  type?: string
  amount?: number
  description?: string
  memo?: string
  metadata?: { description?: string; memo?: string }
  invoice_description?: string
  created_at?: number
  settled_at?: number
  [key: string]: unknown
}

/**
 * Params for useDashboardData hook
 */
export interface UseDashboardDataParams {
  // From useCombinedAuth
  user: CombinedUser | null
  getApiKey: () => Promise<string | null>
  hasServerSession: boolean
  activeBlinkAccount: LocalBlinkAccount | null
  blinkAccounts: LocalBlinkAccount[]
  activeNWC: LocalNWCConnection | null
  nwcClientReady: boolean
  nwcListTransactions: (
    params?: ListTransactionsParams,
  ) => Promise<NWCOperationResult & { transactions?: Record<string, unknown>[] }>
  nwcHasCapability: (capability: string) => boolean
  activeNpubCashWallet: LocalBlinkAccount | null
  // From useViewNavigation
  currentView: string
  // From useDisplaySettings
  setDisplayCurrency: (currency: DisplayCurrency) => void
  // From useUIVisibility
  showVoucherWalletSettings: boolean
  showBoltcards: boolean
  // From useWalletState
  apiKey: string | null
  setApiKey: (key: string | null) => void
  setWallets: (wallets: WalletInfo[]) => void
  // From useTransactionState
  setTransactions: (transactions: TransactionRecord[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string) => void
  setHasMoreTransactions: (hasMore: boolean) => void
  setPastTransactionsLoaded: (loaded: boolean) => void
  setFilteredTransactions: (transactions: TransactionRecord[]) => void
  setDateFilterActive: (active: boolean) => void
  // From useVoucherWalletState
  voucherWallet: VoucherWallet | null
  setVoucherWalletBalance: (balance: number | null) => void
  setVoucherWalletUsdBalance: (balance: number | null) => void
  setVoucherWalletBalanceLoading: (loading: boolean) => void
  setVoucherWalletBtcId: (id: string | null) => void
  setVoucherWalletUsdId: (id: string | null) => void
  setCurrentAmountInSats: (amount: number) => void
  setCurrentAmountInUsdCents: (amount: number) => void
  setCurrentVoucherCurrencyMode: (mode: VoucherCurrencyMode) => void
  // From useBlinkWebSocket
  lastPayment: PaymentData | null
  // Refs (created in Dashboard, passed in)
  posPaymentReceivedRef: MutableRefObject<(() => void) | null>
}

/**
 * Return type for useDashboardData hook
 */
export interface UseDashboardDataReturn {
  fetchData: (overrideApiKey?: string | null) => Promise<void>
  fetchVoucherWalletBalance: () => Promise<void>
  getCapacityColor: (amountInSats: number, balance: number | null) => string
}

/**
 * Hook for Dashboard data fetching: API key, transactions, wallets, voucher balance.
 *
 * Extracted from Dashboard.js — contains:
 * - fetchApiKey + fetch-on-user-change useEffect
 * - fetchData (NWC + Blink transaction fetcher, ~200 lines)
 * - fetchWallets + fetch-on-apiKey useEffect
 * - fetchVoucherWalletBalance + fetch-on-view/overlay useEffects
 * - getCapacityColor
 * - Display currency useEffect, refresh-on-view-switch, poll voucher amount,
 *   refresh-on-wallet-change, refresh-on-payment-received useEffects
 *
 * @param {UseDashboardDataParams} params - All required state, setters, and refs
 * @returns {UseDashboardDataReturn} fetchData, fetchVoucherWalletBalance, getCapacityColor
 */
export function useDashboardData({
  // From useCombinedAuth
  user,
  getApiKey: getApiKeyFn,
  hasServerSession,
  activeBlinkAccount,
  blinkAccounts,
  activeNWC,
  nwcClientReady,
  nwcListTransactions,
  nwcHasCapability,
  activeNpubCashWallet,
  // From useViewNavigation
  currentView,
  // From useDisplaySettings
  setDisplayCurrency,
  // From useUIVisibility
  showVoucherWalletSettings,
  showBoltcards,
  // From useWalletState
  apiKey,
  setApiKey,
  setWallets,
  // From useTransactionState
  setTransactions,
  setLoading,
  setError,
  setHasMoreTransactions,
  setPastTransactionsLoaded,
  setFilteredTransactions,
  setDateFilterActive,
  // From useVoucherWalletState
  voucherWallet,
  setVoucherWalletBalance,
  setVoucherWalletUsdBalance,
  setVoucherWalletBalanceLoading,
  setVoucherWalletBtcId,
  setVoucherWalletUsdId,
  setCurrentAmountInSats,
  setCurrentAmountInUsdCents,
  setCurrentVoucherCurrencyMode,
  // From useBlinkWebSocket
  lastPayment,
  // Refs (created in Dashboard, passed in)
  posPaymentReceivedRef,
}: UseDashboardDataParams): UseDashboardDataReturn {
  // --- fetchApiKey ---
  const fetchApiKey = async (): Promise<string | null> => {
    try {
      // useCombinedAuth.getApiKey() handles both auth methods:
      // - Legacy: fetches from server (/api/auth/get-api-key)
      // - Nostr: decrypts from local profile storage
      const key = await getApiKeyFn()
      if (key) {
        setApiKey(key)
        return key // Return the key so callers can use it immediately
      }
      return null
    } catch (error: unknown) {
      console.error("Failed to get API key:", error)
      return null
    }
  }

  // --- fetchWallets (defined before useEffects that reference it) ---
  const fetchWallets = useCallback(async (): Promise<void> => {
    if (!apiKey) {
      console.log("No API key available yet, skipping wallet fetch")
      return
    }

    try {
      const currentEnv = getEnvironment()
      const response = await fetch("/api/blink/wallets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiKey, environment: currentEnv }),
      })

      if (response.ok) {
        const walletsData = await response.json()
        const walletsList = walletsData.wallets || []
        setWallets(walletsList)

        // Debug log
        console.log("Fetched wallets:", walletsList)
      } else {
        console.error("Failed to fetch wallets:", response.status, response.statusText)
      }
    } catch (err: unknown) {
      console.error("Failed to fetch wallets:", err)
    }
  }, [apiKey])

  // --- fetchVoucherWalletBalance (defined before useEffects that reference it) ---
  const fetchVoucherWalletBalance = useCallback(async (): Promise<void> => {
    if (!voucherWallet?.apiKey) {
      setVoucherWalletBalance(null)
      setVoucherWalletUsdBalance(null)
      setVoucherWalletBtcId(null)
      setVoucherWalletUsdId(null)
      return
    }

    setVoucherWalletBalanceLoading(true)
    try {
      const currentEnv = getEnvironment()
      const response = await fetch("/api/blink/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: voucherWallet.apiKey, environment: currentEnv }),
      })

      const data = await response.json()
      if (data.success && data.wallets) {
        const btcWallet = data.wallets.find((w: Wallet) => w.walletCurrency === "BTC")
        const usdWallet = data.wallets.find((w: Wallet) => w.walletCurrency === "USD")
        setVoucherWalletBalance(btcWallet?.balance || 0)
        setVoucherWalletUsdBalance(usdWallet?.balance ?? null) // null if no USD wallet
        setVoucherWalletBtcId(btcWallet?.id || null)
        setVoucherWalletUsdId(usdWallet?.id || null)
        console.log(
          "[VoucherWallet] Balance fetched - BTC:",
          btcWallet?.balance || 0,
          "sats (id:",
          btcWallet?.id,
          "), USD:",
          usdWallet?.balance ?? "N/A",
          "cents (id:",
          usdWallet?.id,
          ")",
        )
      } else {
        console.error("[VoucherWallet] Failed to fetch balance:", data.error)
        setVoucherWalletBalance(null)
        setVoucherWalletUsdBalance(null)
        setVoucherWalletBtcId(null)
        setVoucherWalletUsdId(null)
      }
    } catch (error: unknown) {
      console.error("[VoucherWallet] Failed to fetch balance:", error)
      setVoucherWalletBalance(null)
      setVoucherWalletUsdBalance(null)
      setVoucherWalletBtcId(null)
      setVoucherWalletUsdId(null)
    } finally {
      setVoucherWalletBalanceLoading(false)
    }
  }, [voucherWallet?.apiKey])

  // --- fetchData: main transaction fetcher ---
  const fetchData = async (overrideApiKey: string | null = null): Promise<void> => {
    // Use override API key if provided (for account switching), otherwise use state
    const effectiveApiKey = overrideApiKey || apiKey

    // Check if NWC wallet is ACTIVE (user chose to use NWC for this session)
    const isNwcActive = activeNWC && nwcClientReady
    const _hasBlinkAccount = blinkAccounts && blinkAccounts.length > 0

    // If NWC wallet is ACTIVE, fetch NWC transactions (even if user also has Blink account)
    // This respects the user's choice of which wallet to use
    if (isNwcActive && nwcHasCapability("list_transactions")) {
      console.log(
        "Fetching NWC transaction history for ACTIVE NWC wallet:",
        activeNWC?.label,
      )
      setLoading(true)
      try {
        const result = await nwcListTransactions({ limit: 100 })
        console.log("NWC list_transactions raw result:", JSON.stringify(result, null, 2))
        if (result.success && result.transactions) {
          // Convert NWC transactions to our format
          // NIP-47 fields: type, amount (msats), description, payment_hash, created_at, settled_at
          // Load locally stored memos for NWC transactions
          // (needed because long memos are hashed in BOLT11 and NWC returns description_hash, not the text)
          let storedMemos: Record<string, { memo?: string }> = {}
          try {
            storedMemos = JSON.parse(localStorage.getItem("blinkpos_nwc_memos") || "{}")
          } catch (e: unknown) {
            console.warn("Failed to load stored NWC memos:", e)
          }

          const formattedTransactions: Transaction[] = result.transactions.map(
            (rawTx, index) => {
              const tx = rawTx as Record<string, unknown>
              const txMetadata = tx.metadata as Record<string, unknown> | undefined
              console.log(`NWC Transaction ${index}:`, JSON.stringify(tx, null, 2))
              // Convert millisats to sats
              const satsAmount = Math.round(((tx.amount as number) || 0) / 1000)
              // Format date like Blink API does
              const txDate = tx.created_at
                ? new Date((tx.created_at as number) * 1000).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : new Date().toLocaleDateString()

              // Try to find the memo:
              // 1. First check if we have it stored locally (for BlinkPOS-created invoices with long memos)
              // 2. Then try the NWC response fields
              // 3. Fall back to a descriptive default
              const localMemo =
                tx.payment_hash && storedMemos[tx.payment_hash as string]?.memo
              const memo =
                localMemo ||
                tx.description ||
                tx.memo ||
                txMetadata?.description ||
                txMetadata?.memo ||
                tx.invoice_description ||
                (tx.type === "incoming"
                  ? `Received ${satsAmount} sats`
                  : `Sent ${satsAmount} sats`)

              if (localMemo) {
                console.log(
                  `✓ Found stored memo for ${(tx.payment_hash as string)?.substring(0, 16)}:`,
                  (localMemo as string).substring(0, 50) + "...",
                )
              }

              return {
                id:
                  (tx.payment_hash as string) ||
                  (tx.preimage as string) ||
                  `nwc-${Date.now()}-${index}`,
                direction: tx.type === "incoming" ? "RECEIVE" : "SEND",
                status: tx.settled_at ? "SUCCESS" : "PENDING",
                // Format amount like Blink: "21 sats" or "-21 sats"
                amount:
                  tx.type === "incoming" ? `${satsAmount} sats` : `-${satsAmount} sats`,
                settlementAmount: satsAmount,
                settlementCurrency: "BTC",
                currency: "BTC",
                date: txDate,
                createdAt: tx.created_at
                  ? new Date((tx.created_at as number) * 1000).toISOString()
                  : new Date().toISOString(),
                memo: memo as string,
                isNwc: true,
              }
            },
          )
          console.log("Formatted NWC transactions:", formattedTransactions)
          setTransactions(formattedTransactions)
          setError("")
        } else {
          console.log("NWC transaction fetch failed:", result.error)
          setTransactions([])
        }
      } catch (err: unknown) {
        console.error("NWC transaction error:", err)
        setTransactions([])
      } finally {
        setLoading(false)
      }
      return // NWC transactions fetched, don't continue to Blink
    }

    // NWC is active but doesn't support list_transactions
    if (isNwcActive) {
      console.log("NWC wallet active but doesn't support list_transactions capability")
      setLoading(false)
      setTransactions([])
      return
    }

    // NWC is not active - check if we can fetch Blink transactions
    // Skip if active Blink wallet is a Lightning Address wallet (no transaction history available)
    if (activeBlinkAccount?.type === "ln-address") {
      console.log("Lightning Address wallet active - transaction history not available")
      setLoading(false)
      setTransactions([])
      return
    }

    // Skip if npub.cash wallet is active (no transaction history available via Blink API)
    if (activeNpubCashWallet) {
      console.log(
        "npub.cash wallet active - transaction history not available via Blink API",
      )
      setLoading(false)
      setTransactions([])
      return
    }

    // Skip if no Blink API credentials available
    if (!effectiveApiKey && !hasServerSession) {
      console.log("No wallet credentials available for transaction fetch")
      setLoading(false)
      setTransactions([])
      return
    }

    console.log(
      "Fetching Blink transaction history for active Blink wallet, apiKey:",
      effectiveApiKey ? effectiveApiKey.substring(0, 8) + "..." : "none",
    )

    try {
      setLoading(true)

      // ✅ ADDED: Fetch with 10 second timeout to prevent hanging
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout

      try {
        // Build request headers
        // Always include API key for Blink accounts to ensure correct account is used
        // (server session may have cached a different account's key)
        const headers: Record<string, string> = {}
        if (effectiveApiKey) {
          headers["X-API-KEY"] = effectiveApiKey
        }

        // Fetch transactions only (no balance for employee privacy)
        // Include environment for staging/production switching
        const currentEnv = getEnvironment()
        const transactionsRes = await fetch(
          `/api/blink/transactions?first=100&environment=${currentEnv}`,
          {
            signal: controller.signal,
            headers,
            credentials: "include", // Include cookies for session-based auth
          },
        )

        clearTimeout(timeoutId)

        if (transactionsRes.ok) {
          const transactionsData = await transactionsRes.json()

          setTransactions(transactionsData.transactions)
          setHasMoreTransactions(transactionsData.pageInfo?.hasNextPage || false)
          setError("")

          // Don't automatically load past transactions - user must click "Show" button
          // This saves bandwidth and respects user's data plan
        } else {
          const errorData = await transactionsRes.json().catch(() => ({}))
          throw new Error(errorData.error || "Failed to fetch transactions")
        }
      } catch (fetchErr: unknown) {
        clearTimeout(timeoutId)
        if (fetchErr instanceof Error && fetchErr.name === "AbortError") {
          throw new Error("Transaction loading timed out. Please try again.")
        }
        throw fetchErr
      }
    } catch (err: unknown) {
      console.error("Fetch error:", err)
      setError((err as Error).message || "Failed to load data")
    } finally {
      setLoading(false)
    }
  }

  // Get capacity indicator color based on amount vs wallet balance
  const getCapacityColor = useCallback(
    (amountInSats: number, balance: number | null): string => {
      // Gray: Balance unknown/loading OR amount is 0
      if (balance === null || amountInSats === 0) {
        return "bg-gray-400 dark:bg-gray-500"
      }

      const percentage = (amountInSats / balance) * 100

      // Green: Amount ≤ 50% of balance
      if (percentage <= 50) {
        return "bg-green-500"
      }
      // Yellow: Amount > 50% and ≤ 90% of balance
      if (percentage <= 90) {
        return "bg-yellow-500"
      }
      // Red: Amount > 90% of balance OR exceeds
      return "bg-red-500"
    },
    [],
  )

  // ============================================================================
  // useEffect hooks (all function references are now declared above)
  // ============================================================================

  // Fetch API key when user changes or active Blink account switches
  useEffect(() => {
    if (user) {
      fetchApiKey()
    }
  }, [user, activeBlinkAccount])

  // Set display currency from user preference (removed immediate fetchData)
  useEffect(() => {
    if (user) {
      // ✅ REMOVED: fetchData() - transactions now load ONLY when user clicks "Transactions" tab

      // Seed display currency from the account preference on first run only.
      // Once the device has a persisted choice, it is authoritative and must
      // not be overwritten on login (persist last selected currency per device).
      if (user.preferredCurrency && !hasStoredDisplayCurrency()) {
        console.log(
          `Seeding display currency from user preference: ${user.preferredCurrency}`,
        )
        setDisplayCurrency(user.preferredCurrency as DisplayCurrency)
      }
    }
  }, [user])

  // Refresh transaction data when switching to transaction history view
  useEffect(() => {
    if (currentView === "transactions" && user) {
      console.log("Switching to transaction history - refreshing data...")
      fetchData()
    }
  }, [currentView])

  // Fetch voucher wallet balance when switching to voucher/multivoucher view
  useEffect(() => {
    if (
      voucherWallet?.apiKey &&
      (currentView === "voucher" || currentView === "multivoucher")
    ) {
      fetchVoucherWalletBalance()
    }
  }, [voucherWallet?.apiKey, currentView, fetchVoucherWalletBalance])

  // Reset the capacity-indicator amount when leaving voucher views.
  // While ON a voucher view, the amount is pushed by Voucher/MultiVoucher via
  // their onAmountChange callback (previously this was a 300ms poll of the
  // child components' imperative getters).
  useEffect(() => {
    if (currentView !== "voucher" && currentView !== "multivoucher") {
      setCurrentAmountInSats(0)
      setCurrentAmountInUsdCents(0)
      setCurrentVoucherCurrencyMode("BTC")
    }
  }, [currentView])

  // Fetch balance when Send Wallet overlay opens
  useEffect(() => {
    if (showVoucherWalletSettings && voucherWallet?.apiKey) {
      fetchVoucherWalletBalance()
    }
  }, [showVoucherWalletSettings, voucherWallet?.apiKey, fetchVoucherWalletBalance])

  // Fetch balance when Boltcards overlay opens (needed for wallet IDs)
  useEffect(() => {
    if (showBoltcards && voucherWallet?.apiKey) {
      fetchVoucherWalletBalance()
    }
  }, [showBoltcards, voucherWallet?.apiKey, fetchVoucherWalletBalance])

  // Refresh transaction data when active wallet changes (NWC or Blink)
  // This ensures we show the correct wallet's transactions
  const prevActiveNWCRef = useRef<string | undefined>(activeNWC?.id)
  const prevActiveBlinkRef = useRef<string | undefined>(activeBlinkAccount?.id)

  useEffect(() => {
    const nwcChanged = activeNWC?.id !== prevActiveNWCRef.current
    const blinkChanged = activeBlinkAccount?.id !== prevActiveBlinkRef.current

    if (nwcChanged || blinkChanged) {
      console.log("[Dashboard] Active wallet changed:", {
        nwcFrom: prevActiveNWCRef.current?.substring(0, 8),
        nwcTo: activeNWC?.id?.substring(0, 8),
        blinkFrom: prevActiveBlinkRef.current?.substring(0, 8),
        blinkTo: activeBlinkAccount?.id?.substring(0, 8),
      })

      prevActiveNWCRef.current = activeNWC?.id
      prevActiveBlinkRef.current = activeBlinkAccount?.id

      // Clear existing transactions and reset all history state
      setTransactions([])
      setPastTransactionsLoaded(false)
      setHasMoreTransactions(false)
      setFilteredTransactions([])
      setDateFilterActive(false)

      // Refresh API key for the new account first, then fetch transactions
      if (blinkChanged && activeBlinkAccount) {
        fetchApiKey().then((newApiKey) => {
          // If we're viewing transactions, refresh the data for the new active wallet
          // Pass the new API key directly to avoid race condition with state update
          if (currentView === "transactions") {
            console.log(
              "[Dashboard] Refreshing transactions for new active Blink wallet, newApiKey:",
              newApiKey ? newApiKey.substring(0, 8) + "..." : "none",
            )
            fetchData(newApiKey)
          }
        })
      } else if (currentView === "transactions") {
        // For NWC changes, just fetch directly
        setTimeout(() => {
          console.log("[Dashboard] Refreshing transactions for new active wallet")
          fetchData()
        }, 100)
      }
    }
  }, [activeNWC?.id, activeBlinkAccount?.id, currentView])

  // Fetch wallets when API key becomes available
  useEffect(() => {
    if (apiKey) {
      fetchWallets()
    }
  }, [apiKey, fetchWallets])

  // Refresh data when payment received (direct Blink payments, NOT BlinkPOS forwarded payments)
  useEffect(() => {
    // Skip if this is a forwarded payment (already handled in BlinkPOS callback)
    // Forwarded payments have isForwarded: true set by triggerPaymentAnimation
    if (lastPayment && !lastPayment.isForwarded) {
      // Clear the POS invoice immediately when payment is received
      if (posPaymentReceivedRef.current) {
        posPaymentReceivedRef.current()
      }

      // Small delay to ensure transaction is processed
      setTimeout(() => {
        fetchData()
      }, 1000)
    }
  }, [lastPayment])

  return {
    fetchData,
    fetchVoucherWalletBalance,
    getCapacityColor,
  }
}

export default useDashboardData
