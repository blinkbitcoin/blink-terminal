import React, { useState, useEffect, forwardRef, useImperativeHandle } from "react"
import QRCode from "react-qr-code"

import { unlockAudioContext, playSound } from "../lib/audio-utils"
import type { Wallet } from "../lib/blink-api"
import { getEnvironment } from "../lib/config/api"
import {
  formatDisplayAmount as formatCurrency,
  getCurrencyById,
  isBitcoinCurrency,
  parseAmountParts,
  type CurrencyMetadata,
} from "../lib/currency-utils"
import type { PaymentData } from "../lib/hooks/useBlinkWebSocket"
import type { CombinedUser } from "../lib/hooks/useCombinedAuth"
import type {
  LocalNWCConnection,
  NWCInvoiceResult,
  NWCOperationResult,
} from "../lib/hooks/useNWC"
import type { LocalBlinkAccount } from "../lib/hooks/useProfile"
import { THEMES, type Theme } from "../lib/hooks/useTheme"
import type { CartCheckoutData } from "../lib/hooks/useViewNavigation"
import {
  formatNumber,
  type NumberFormatPreference,
  type BitcoinFormatPreference,
  type NumpadLayoutPreference,
} from "../lib/number-format"

import type { UseNFCReturn } from "./NFCPayment"
import Numpad from "./Numpad"

interface TipRecipient {
  username: string
  share?: number
  type?: string
}

interface CreateInvoiceRequest {
  amount: number
  currency: string
  memo: string
  displayCurrency: string
  environment: string
  baseAmount: number
  tipAmount: number
  tipPercent: number
  tipRecipients: TipRecipient[]
  baseAmountDisplay: number
  tipAmountDisplay: number
  walletId?: string
  userWalletId?: string
  apiKey?: string
  nwcActive: boolean
  nwcConnectionUri?: string | null
  blinkLnAddress?: boolean
  blinkLnAddressWalletId?: string | null
  blinkLnAddressUsername?: string | null
  npubCashActive?: boolean
  npubCashLightningAddress?: string | null
}

interface POSProps {
  apiKey: string | null
  user: CombinedUser | null
  displayCurrency: string
  numberFormat?: NumberFormatPreference
  bitcoinFormat?: BitcoinFormatPreference
  numpadLayout?: NumpadLayoutPreference
  currencies: CurrencyMetadata[]
  wallets: Wallet[]
  onPaymentReceived: React.MutableRefObject<(() => void) | null>
  connected: boolean
  manualReconnect?: () => void
  reconnectAttempts?: number
  tipsEnabled: boolean
  tipPresets: number[]
  tipRecipients?: TipRecipient[]
  soundEnabled: boolean
  onInvoiceStateChange?: (showing: boolean) => void
  onInvoiceChange?: (invoice: InvoiceData | null) => void
  darkMode: boolean
  theme?: Theme
  cycleTheme: () => void
  nfcState: UseNFCReturn | null
  activeNWC?: LocalNWCConnection | null
  nwcClientReady?: boolean
  nwcMakeInvoice?: (params: {
    amount: number
    description?: string
    expiry?: number
  }) => Promise<NWCInvoiceResult>
  nwcLookupInvoice?: (
    paymentHash: string,
  ) => Promise<NWCOperationResult & { invoice?: unknown }>
  getActiveNWCUri?: () => Promise<string | null>
  activeBlinkAccount: LocalBlinkAccount | null
  activeNpubCashWallet?: LocalBlinkAccount | null
  cartCheckoutData: CartCheckoutData | null
  onCartCheckoutProcessed?: () => void
  onInternalTransition?: () => void
  triggerPaymentAnimation?: (data: PaymentData) => void
  isPublicPOS?: boolean
  publicUsername?: string | null
}

export interface POSRef {
  handleDigitPress: (digit: string) => void
  handleBackspace: () => void
  handleClear: () => void
  handlePlusPress: () => void
  handleSubmit: () => void
  hasInvoice: () => boolean
  hasValidAmount: () => boolean
  isTipDialogOpen: () => boolean
  handleTipDialogKey: (key: string) => boolean
}

interface ExchangeRateInfo {
  satPriceInCurrency: number
  currency: string
}

interface InvoiceData {
  paymentRequest: string
  paymentHash?: string
  satoshis?: number
  amount?: number
  memo?: string
  displayAmount?: number
  displayCurrency?: string
  satAmount?: number
  [key: string]: string | number | boolean | undefined
}

const POS = forwardRef<POSRef, POSProps>(
  (
    {
      apiKey,
      user: _user,
      displayCurrency,
      numberFormat = "auto",
      bitcoinFormat = "sats",
      numpadLayout = "calculator",
      currencies,
      wallets,
      onPaymentReceived,
      connected: _connected,
      manualReconnect: _manualReconnect,
      reconnectAttempts: _reconnectAttempts,
      tipsEnabled,
      tipPresets,
      tipRecipients = [],
      soundEnabled,
      onInvoiceStateChange,
      onInvoiceChange,
      darkMode,
      theme = THEMES.DARK,
      cycleTheme,
      nfcState,
      activeNWC,
      nwcClientReady,
      nwcMakeInvoice,
      nwcLookupInvoice: _nwcLookupInvoice,
      getActiveNWCUri,
      activeBlinkAccount,
      activeNpubCashWallet,
      cartCheckoutData,
      onCartCheckoutProcessed,
      onInternalTransition,
      triggerPaymentAnimation,
      isPublicPOS = false,
      publicUsername = null,
    },
    ref,
  ) => {
    const [amount, setAmount] = useState<string>("")
    const [total, setTotal] = useState<number>(0)
    const [items, setItems] = useState<number[]>([])
    const [invoice, setInvoice] = useState<InvoiceData | null>(null)
    const [loading, setLoading] = useState<boolean>(false)
    const [creatingInvoice, setCreatingInvoice] = useState<boolean>(false)
    const [error, setError] = useState<string>("")
    const [selectedWallet, setSelectedWallet] = useState<Wallet | null>(null)
    const [exchangeRate, setExchangeRate] = useState<ExchangeRateInfo | null>(null)
    const [loadingRate, setLoadingRate] = useState<boolean>(false)

    // Tip functionality state (local)
    const [selectedTipPercent, setSelectedTipPercent] = useState<number>(0)
    const [showTipDialog, setShowTipDialog] = useState<boolean>(false)
    const [pendingTipSelection, setPendingTipSelection] = useState<number | null>(null)
    const [showCustomTipInput, setShowCustomTipInput] = useState<boolean>(false)
    const [customTipValue, setCustomTipValue] = useState<string>("")
    const [tipOptionIndex, setTipOptionIndex] = useState<number>(0) // Keyboard navigation index

    // Cart memo (when coming from item cart)
    const [cartMemo, setCartMemo] = useState<string>("")

    // BC Theme helpers
    const isBlinkClassic =
      theme === "blink-classic-dark" || theme === "blink-classic-light"
    const isBlinkClassicDark = theme === "blink-classic-dark"
    const isBlinkClassicLight = theme === "blink-classic-light"

    // Get tip option button classes based on theme
    const getTipButtonClasses = (isSelected: boolean): string => {
      if (isBlinkClassicDark) {
        return isSelected
          ? "bg-blink-classic-bg border border-blink-classic-amber text-white ring-2 ring-blink-classic-amber"
          : "bg-transparent border border-blink-classic-border text-white hover:bg-blink-classic-bg hover:border-blink-classic-amber"
      }
      if (isBlinkClassicLight) {
        return isSelected
          ? "bg-blink-classic-hover-light border border-blink-classic-amber text-black ring-2 ring-blink-classic-amber"
          : "bg-transparent border border-blink-classic-border-light text-black hover:bg-blink-classic-hover-light hover:border-blink-classic-amber"
      }
      // Standard themes - use original green styling
      return isSelected
        ? "border border-green-400 ring-2 ring-green-400 bg-green-50 dark:bg-green-900 text-green-700 dark:text-green-300"
        : "border border-green-500 hover:border-green-400 hover:bg-green-50 dark:hover:bg-green-900 text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300"
    }

    // Get custom button classes (blue in standard, amber in BC)
    const getCustomButtonClasses = (isSelected: boolean): string => {
      if (isBlinkClassicDark) {
        return isSelected
          ? "bg-blink-classic-bg border border-blink-classic-amber text-white ring-2 ring-blink-classic-amber"
          : "bg-transparent border border-blink-classic-border text-white hover:bg-blink-classic-bg hover:border-blink-classic-amber"
      }
      if (isBlinkClassicLight) {
        return isSelected
          ? "bg-blink-classic-hover-light border border-blink-classic-amber text-black ring-2 ring-blink-classic-amber"
          : "bg-transparent border border-blink-classic-border-light text-black hover:bg-blink-classic-hover-light hover:border-blink-classic-amber"
      }
      // Standard themes - use original blue styling
      return isSelected
        ? "border border-blue-400 ring-2 ring-blue-400 bg-blue-50 dark:bg-blue-900 text-blue-700 dark:text-blue-300"
        : "border border-blue-600 dark:border-blue-500 hover:border-blue-700 dark:hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
    }

    // Get cancel button classes (red in standard, themed in BC)
    const getCancelButtonClasses = (isSelected: boolean): string => {
      if (isBlinkClassicDark) {
        return isSelected
          ? "bg-blink-classic-bg border border-red-500 text-red-400 ring-2 ring-red-500"
          : "bg-transparent border border-blink-classic-border text-gray-400 hover:bg-blink-classic-bg hover:border-red-500 hover:text-red-400"
      }
      if (isBlinkClassicLight) {
        return isSelected
          ? "bg-red-50 border border-red-500 text-red-600 ring-2 ring-red-500"
          : "bg-transparent border border-blink-classic-border-light text-gray-600 hover:bg-red-50 hover:border-red-500 hover:text-red-600"
      }
      // Standard themes
      return isSelected
        ? "border border-red-400 ring-2 ring-red-400 bg-red-50 dark:bg-red-900 text-red-700 dark:text-red-300"
        : "border border-red-500 hover:border-red-600 hover:bg-red-50 dark:hover:bg-red-900 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
    }

    // Get no tip/skip button classes (yellow in standard, themed in BC)
    const getNoTipButtonClasses = (isSelected: boolean): string => {
      if (isBlinkClassicDark) {
        return isSelected
          ? "bg-blink-classic-bg border border-blink-classic-amber text-blink-classic-amber ring-2 ring-blink-classic-amber"
          : "bg-transparent border border-blink-classic-border text-gray-400 hover:bg-blink-classic-bg hover:border-blink-classic-amber hover:text-blink-classic-amber"
      }
      if (isBlinkClassicLight) {
        return isSelected
          ? "bg-blink-classic-hover-light border border-blink-classic-amber text-amber-600 ring-2 ring-blink-classic-amber"
          : "bg-transparent border border-blink-classic-border-light text-gray-600 hover:bg-blink-classic-hover-light hover:border-blink-classic-amber hover:text-amber-600"
      }
      // Standard themes
      return isSelected
        ? "border border-yellow-400 ring-2 ring-yellow-400 bg-yellow-50 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300"
        : "border border-yellow-500 dark:border-yellow-400 hover:border-yellow-600 dark:hover:border-yellow-300 hover:bg-yellow-50 dark:hover:bg-yellow-900 text-yellow-600 dark:text-yellow-400 hover:text-yellow-700 dark:hover:text-yellow-300"
    }

    // Get background for tip dialog overlay
    const getTipDialogBgClasses = (): string => {
      if (isBlinkClassicDark) return "bg-black"
      if (isBlinkClassicLight) return "bg-white"
      return "bg-white dark:bg-black"
    }

    // Get text color classes
    const getTipDialogTextClasses = (): string => {
      if (isBlinkClassicDark) return "text-white"
      if (isBlinkClassicLight) return "text-black"
      return "text-gray-800 dark:text-white"
    }

    // Get secondary text color classes
    const getTipDialogSecondaryTextClasses = (): string => {
      if (isBlinkClassicDark) return "text-gray-400"
      if (isBlinkClassicLight) return "text-gray-600"
      return "text-gray-600 dark:text-gray-400"
    }

    // Helper function to get dynamic font size based on amount length
    // Returns mobile size + desktop size (20% larger on desktop via md: breakpoint)
    // Considers BOTH numeric digits AND total display length to prevent overflow
    const getDynamicFontSize = (displayText: string | number): string => {
      const text = String(displayText)

      // Extract only numeric characters (remove currency symbols, spaces, "sats", commas, etc.)
      const numericOnly = text.replace(/[^0-9.]/g, "")
      const numericLength = numericOnly.length

      // Total display length (includes symbols, spaces, commas)
      const totalLength = text.length

      // Calculate size based on numeric length (original thresholds)
      let sizeFromNumeric: number
      if (numericLength <= 6)
        sizeFromNumeric = 7 // text-6xl md:text-7xl
      else if (numericLength <= 9)
        sizeFromNumeric = 6 // text-5xl md:text-6xl
      else if (numericLength <= 11)
        sizeFromNumeric = 5 // text-4xl md:text-5xl
      else if (numericLength <= 13)
        sizeFromNumeric = 4 // text-3xl md:text-4xl
      else if (numericLength <= 15)
        sizeFromNumeric = 3 // text-2xl md:text-3xl
      else if (numericLength <= 16)
        sizeFromNumeric = 2 // text-xl md:text-2xl
      else sizeFromNumeric = 1 // text-lg md:text-xl

      // Calculate size based on total display length (for long currency symbols/names)
      let sizeFromTotal: number
      if (totalLength <= 10)
        sizeFromTotal = 7 // Short display: "P 1,000.00"
      else if (totalLength <= 14)
        sizeFromTotal = 6 // Medium: "KSh 10,000.00"
      else if (totalLength <= 18)
        sizeFromTotal = 5 // Longer: "10,000 sats"
      else if (totalLength <= 22)
        sizeFromTotal = 4 // "1,000,000.00 sats"
      else if (totalLength <= 26)
        sizeFromTotal = 3 // Very long
      else if (totalLength <= 30)
        sizeFromTotal = 2 // Extra long
      else sizeFromTotal = 1 // Maximum length

      // Use the SMALLER size to prevent overflow
      const finalSize = Math.min(sizeFromNumeric, sizeFromTotal)

      // Map size number to Tailwind classes
      const sizeClasses: Record<number, string> = {
        7: "text-6xl md:text-7xl",
        6: "text-5xl md:text-6xl",
        5: "text-4xl md:text-5xl",
        4: "text-3xl md:text-4xl",
        3: "text-2xl md:text-3xl",
        2: "text-xl md:text-2xl",
        1: "text-lg md:text-xl",
      }

      return sizeClasses[finalSize] || sizeClasses[1]
    }

    // Handle tip selection and create invoice after state update
    useEffect(() => {
      if (pendingTipSelection !== null) {
        const newTipPercent = pendingTipSelection

        // Trigger transition animation when confirming tip selection
        if (onInternalTransition) onInternalTransition()

        setSelectedTipPercent(newTipPercent)
        setShowTipDialog(false)
        setPendingTipSelection(null)

        // Create invoice with the specific tip percentage
        createInvoiceWithTip(newTipPercent)
      }
    }, [pendingTipSelection])

    // Set default wallet when wallets are loaded or account is switched
    useEffect(() => {
      console.log("Wallets changed:", wallets)
      if (wallets && wallets.length > 0) {
        // Always use BTC wallet for POS
        const btcWallet = wallets.find((w) => w.walletCurrency === "BTC")

        if (!btcWallet) {
          console.error("No BTC wallet found in:", wallets)
          setError("No BTC wallet available for invoice generation")
          return
        }

        // Update wallet if:
        // 1. No wallet is selected yet (initial load)
        // 2. Current wallet is from a different account (account switched)
        //    Detected by checking if current wallet ID exists in new wallets list
        const currentWalletStillValid =
          selectedWallet && wallets.some((w) => w.id === selectedWallet.id)

        if (!selectedWallet || !currentWalletStillValid) {
          console.log("Updating selected wallet:", {
            reason: !selectedWallet ? "initial load" : "account switched",
            oldWallet: selectedWallet?.id,
            newWallet: btcWallet.id,
          })
          setSelectedWallet(btcWallet)
        }
      }
    }, [wallets])

    // Check if we have a Blink Lightning Address wallet (no API key required)
    const hasBlinkLnAddressWallet = activeBlinkAccount?.type === "ln-address"

    // Check if we have an npub.cash wallet (no API key required - uses LNURL-pay)
    const hasNpubCashWallet =
      activeNpubCashWallet?.type === "npub-cash" &&
      !!activeNpubCashWallet?.lightningAddress

    // Fetch exchange rate when currency changes
    // For NWC-only or LN Address users (no apiKey), use BlinkPOS credentials via useBlinkpos flag
    // For public POS mode, also use BlinkPOS credentials
    useEffect(() => {
      if (
        !isBitcoinCurrency(displayCurrency) &&
        (apiKey ||
          activeNWC ||
          hasBlinkLnAddressWallet ||
          hasNpubCashWallet ||
          isPublicPOS)
      ) {
        fetchExchangeRate()
      } else if (isBitcoinCurrency(displayCurrency)) {
        setExchangeRate({ satPriceInCurrency: 1, currency: "BTC" })
      }
    }, [
      displayCurrency,
      apiKey,
      activeNWC,
      hasBlinkLnAddressWallet,
      hasNpubCashWallet,
      isPublicPOS,
    ])

    // Clear invoice when payment is received
    useEffect(() => {
      if (onPaymentReceived) {
        const clearInvoiceOnPayment = () => {
          console.log("Payment received - clearing invoice and returning to numpad")
          setInvoice(null)
          if (onInvoiceChange) {
            onInvoiceChange(null)
          }
          setAmount("")
          setTotal(0)
          setItems([])
          setCartMemo("") // Clear cart memo
          setError("")
          setSelectedTipPercent(0)
          setShowTipDialog(false)
          setPendingTipSelection(null)
        }

        // Set up the callback
        onPaymentReceived.current = clearInvoiceOnPayment
      }
    }, [onPaymentReceived, onInvoiceChange])

    // Handle cart checkout data - prefill total when coming from cart
    useEffect(() => {
      if (cartCheckoutData && cartCheckoutData.amount > 0) {
        console.log("Cart checkout data received:", cartCheckoutData)
        // Set the total from cart
        setTotal(cartCheckoutData.amount)
        setAmount("")
        // Store the cart memo for invoice creation
        setCartMemo(cartCheckoutData.memo || "")
        // We use items array to store numeric values for the calculation display
        setItems([cartCheckoutData.amount])
        setError("")

        // Mark as processed
        if (onCartCheckoutProcessed) {
          onCartCheckoutProcessed()
        }
      }
    }, [cartCheckoutData, onCartCheckoutProcessed])

    // Check if invoice was paid when app regains focus (handles webhook forwarding case)
    useEffect(() => {
      if (!invoice?.paymentHash) return

      const checkPaymentOnFocus = async () => {
        try {
          console.log("🔍 Checking if invoice was paid while app was in background...")
          const response = await fetch("/api/blink/check-payment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              paymentHash: invoice.paymentHash,
              environment: getEnvironment(),
            }),
          })

          if (response.ok) {
            const result = await response.json()
            if (result.paid) {
              console.log("✅ Invoice was paid while app was in background!")
              const paymentAmount =
                result.transaction?.amount || invoice.satoshis || invoice.amount

              // For NWC wallets, try to forward from client as fallback
              // (webhook should handle this in production, but client provides fallback)
              console.log("🔍 NWC check:", {
                hasActiveNWC: !!activeNWC,
                nwcClientReady,
                hasNwcMakeInvoice: !!nwcMakeInvoice,
              })

              if (activeNWC && nwcMakeInvoice) {
                // Note: nwcClientReady might be false after app was in background
                // We'll try to forward anyway - nwcMakeInvoice should handle reconnection internally
                if (!nwcClientReady) {
                  console.log("⚠️ NWC client not ready - attempting forwarding anyway...")
                }
                console.log("💳 NWC wallet detected - forwarding payment from client...")
                try {
                  // Step 1: Get tip data and base amount (defer tips for correct chronology)
                  const tipResponse = await fetch("/api/blink/forward-nwc-with-tips", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      paymentHash: invoice.paymentHash,
                      totalAmount: paymentAmount,
                      memo: invoice.memo,
                      deferTips: true, // Get tip data but don't send yet
                      environment: getEnvironment(),
                    }),
                  })

                  if (tipResponse.status === 409) {
                    console.log("ℹ️ Payment already being processed (409)")
                  } else if (tipResponse.ok) {
                    const tipResult = await tipResponse.json()

                    // Check if we should skip forwarding (already processed, being processed, or data not found)
                    // CRITICAL: noPaymentData means data was cleaned up - likely already forwarded
                    if (
                      tipResult.skipForwarding ||
                      tipResult.alreadyProcessed ||
                      tipResult.alreadyProcessing ||
                      tipResult.noPaymentData
                    ) {
                      console.log(
                        "ℹ️ Payment forwarding skipped:",
                        tipResult.message || "Already handled or no data",
                      )
                    } else {
                      const baseAmount = tipResult.baseAmount || paymentAmount
                      const enhancedMemo = tipResult.enhancedMemo || invoice.memo

                      console.log("📄 NWC forwarding data:", {
                        baseAmount,
                        hasTips: !!tipResult.tipData,
                      })

                      // Step 2: Create NWC invoice for base amount
                      console.log("📝 Creating NWC invoice for base amount:", baseAmount)
                      let nwcInvoiceResult: NWCInvoiceResult
                      try {
                        nwcInvoiceResult = await nwcMakeInvoice({
                          amount: baseAmount * 1000, // NWC uses millisats
                          description: enhancedMemo,
                          expiry: 3600,
                        })
                        console.log("📋 NWC makeInvoice result:", nwcInvoiceResult)
                      } catch (nwcError: unknown) {
                        console.error("❌ NWC makeInvoice threw error:", nwcError)
                        nwcInvoiceResult = {
                          success: false,
                          error: (nwcError as Error).message,
                        }
                      }

                      if (nwcInvoiceResult?.success && nwcInvoiceResult?.invoice) {
                        console.log("✅ NWC invoice created, paying from BlinkPOS...")

                        // Step 3: Pay NWC invoice from BlinkPOS
                        // SECURITY: paymentHash is required to authenticate this is a legitimate BlinkPOS payment
                        const payResponse = await fetch("/api/blink/pay-invoice", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            paymentHash: invoice.paymentHash,
                            paymentRequest: nwcInvoiceResult.invoice,
                            memo: enhancedMemo,
                            environment: getEnvironment(),
                          }),
                        })

                        if (payResponse.ok) {
                          console.log("✅ NWC base amount forwarded successfully!")

                          // Step 4: Send tips if there are deferred tips
                          if (tipResult.tipsDeferred && tipResult.tipData) {
                            console.log("💰 Sending deferred tips...")
                            await fetch("/api/blink/send-nwc-tips", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                paymentHash: invoice.paymentHash,
                                tipData: tipResult.tipData,
                                environment: getEnvironment(),
                              }),
                            })
                            console.log("✅ Tips sent!")
                          }
                        } else {
                          console.error(
                            "❌ Failed to pay NWC invoice:",
                            await payResponse.text(),
                          )
                        }
                      } else {
                        console.error(
                          "❌ Failed to create NWC invoice:",
                          nwcInvoiceResult,
                        )
                      }
                    }
                  } else {
                    console.error(
                      "❌ Failed to get NWC forwarding data:",
                      await tipResponse.text(),
                    )
                  }
                } catch (forwardError: unknown) {
                  console.error("❌ Error forwarding NWC payment:", forwardError)
                }
              }

              // Trigger the payment animation with sound (same as real-time payment)
              if (triggerPaymentAnimation) {
                triggerPaymentAnimation({
                  amount: paymentAmount,
                  currency: "BTC",
                  memo: invoice.memo || `BlinkPOS: ${paymentAmount} sats`,
                  isForwarded: true,
                })
              }

              // Clear the invoice after animation is triggered
              if (onPaymentReceived?.current) {
                onPaymentReceived.current()
              }
            }
          }
        } catch (err: unknown) {
          console.error("Failed to check payment status:", err)
        }
      }

      const handleVisibilityChange = () => {
        if (!document.hidden && invoice?.paymentHash) {
          // Small delay to let the app settle after focus
          setTimeout(checkPaymentOnFocus, 500)
        }
      }

      const handleFocus = () => {
        if (invoice?.paymentHash) {
          setTimeout(checkPaymentOnFocus, 500)
        }
      }

      document.addEventListener("visibilitychange", handleVisibilityChange)
      window.addEventListener("focus", handleFocus)

      return () => {
        document.removeEventListener("visibilitychange", handleVisibilityChange)
        window.removeEventListener("focus", handleFocus)
      }
    }, [
      invoice?.paymentHash,
      invoice?.satoshis,
      invoice?.amount,
      invoice?.memo,
      onPaymentReceived,
      triggerPaymentAnimation,
    ])

    // Notify parent when invoice or tip dialog state changes
    useEffect(() => {
      if (onInvoiceStateChange) {
        // Consider both invoice and tip dialog as "showing invoice" state
        onInvoiceStateChange(!!invoice || showTipDialog)
      }
    }, [invoice, showTipDialog, onInvoiceStateChange])

    // Reset tip option index when dialog opens
    useEffect(() => {
      if (showTipDialog && !showCustomTipInput) {
        setTipOptionIndex(0)
      }
    }, [showTipDialog, showCustomTipInput])

    const fetchExchangeRate = async () => {
      if (isBitcoinCurrency(displayCurrency)) return

      setLoadingRate(true)
      try {
        const response = await fetch("/api/rates/exchange-rate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            apiKey: apiKey,
            currency: displayCurrency,
            // For NWC-only, LN Address, npub.cash, or public POS users, use BlinkPOS credentials to fetch exchange rate
            useBlinkpos:
              !apiKey &&
              (!!activeNWC ||
                hasBlinkLnAddressWallet ||
                hasNpubCashWallet ||
                isPublicPOS),
          }),
        })

        const data = await response.json()

        if (data.success) {
          setExchangeRate({
            satPriceInCurrency: data.satPriceInCurrency,
            currency: data.currency,
          })
          console.log(`Exchange rate for ${displayCurrency}:`, data.satPriceInCurrency)
        } else {
          throw new Error(data.error || "Failed to fetch exchange rate")
        }
      } catch (err: unknown) {
        console.error("Exchange rate error:", err)
        setError(
          `Failed to fetch ${displayCurrency} exchange rate: ${(err as Error).message}`,
        )
      } finally {
        setLoadingRate(false)
      }
    }

    const formatDisplayAmount = (value: number | string, currency: string): string => {
      // Use dynamic currency formatting from currency-utils with numberFormat and bitcoinFormat preferences
      return formatCurrency(value, currency, currencies, numberFormat, bitcoinFormat)
    }

    // Render amount with properly styled Bitcoin symbol (smaller ₿ for BIP-177)
    const renderStyledAmount = (
      value: number | string,
      currency: string,
      className: string = "",
    ): React.JSX.Element => {
      const formatted = formatDisplayAmount(value, currency)
      const parts = parseAmountParts(formatted, currency, bitcoinFormat)

      if (parts.isBip177) {
        // Render BIP-177 with smaller, lighter Bitcoin symbol moved up 10%
        return (
          <span className={className}>
            <span
              style={{
                fontSize: "0.75em",
                fontWeight: 300,
                position: "relative",
                top: "-0.07em",
              }}
            >
              {parts.symbol}
            </span>
            {parts.value}
          </span>
        )
      }

      // For all other currencies, render as-is
      return <span className={className}>{formatted}</span>
    }

    // Get current currency metadata
    const getCurrentCurrency = (): CurrencyMetadata | null => {
      return getCurrencyById(displayCurrency, currencies)
    }

    // Validate if amount meets minimum requirements for the currency
    const isValidAmount = (amountValue: string): boolean => {
      if (!amountValue || amountValue === "" || amountValue === "0") {
        return false
      }

      const numValue = parseFloat(amountValue)
      if (isNaN(numValue) || numValue <= 0) {
        return false
      }

      // For BTC (sats), check minimum 1 sat
      if (isBitcoinCurrency(displayCurrency)) {
        return numValue >= 1
      }

      // For fiat currencies, check minimum based on fraction digits
      const currency = getCurrentCurrency()
      if (!currency) {
        return numValue > 0 // Fallback
      }

      // Minimum is 1 in the smallest unit (e.g., 0.01 for 2 decimals, 1 for 0 decimals)
      const fractionDigits = currency.fractionDigits ?? 0
      const minimumAmount = fractionDigits > 0 ? 1 / Math.pow(10, fractionDigits) : 1

      if (numValue < minimumAmount) {
        return false
      }

      // Also check if it converts to at least 1 satoshi
      if (exchangeRate && exchangeRate.satPriceInCurrency) {
        const sats = convertToSatoshis(numValue, displayCurrency)
        if (sats < 1) {
          return false
        }
      }

      return true
    }

    // Check if current amount or total is valid for creating invoice
    const hasValidAmount = (): boolean => {
      if (total > 0) {
        return true // If there's a total from items, it's valid
      }
      return isValidAmount(amount)
    }

    // Convert display currency amount to satoshis for invoice creation
    const convertToSatoshis = (amount: number, currency: string): number => {
      if (currency === "BTC") {
        return Math.round(amount) // Already in sats
      }

      if (!exchangeRate || !exchangeRate.satPriceInCurrency) {
        throw new Error(`Exchange rate not available for ${currency}`)
      }

      // Use currency's fractionDigits (0 for KRW/JPY, 2 for USD/EUR, etc.)
      const currencyInfo = getCurrencyById(currency, currencies)
      const fractionDigits = currencyInfo?.fractionDigits ?? 2
      const amountInMinorUnits = amount * Math.pow(10, fractionDigits)
      const satsAmount = Math.round(amountInMinorUnits / exchangeRate.satPriceInCurrency)

      return satsAmount
    }

    // Calculate tip amount based on percentage
    const calculateTipAmount = (baseAmount: number, tipPercent: number): number => {
      return (tipPercent / 100) * baseAmount
    }

    // Get total amount including selected tip
    const getTotalWithTip = (): number => {
      let finalTotal = total
      if (amount) {
        const numericAmount = parseFloat(amount)
        if (!isNaN(numericAmount) && numericAmount > 0) {
          finalTotal += numericAmount
        }
      }

      if (selectedTipPercent > 0) {
        const tipAmount = calculateTipAmount(finalTotal, selectedTipPercent)
        return finalTotal + tipAmount
      }

      return finalTotal
    }

    // Calculate sats equivalent from fiat amount using user's number format
    const getSatsEquivalent = (fiatAmount: number): string => {
      if (!exchangeRate?.satPriceInCurrency) return "0"
      if (fiatAmount <= 0) return "0"
      const currency = getCurrencyById(displayCurrency, currencies)
      const fractionDigits = currency?.fractionDigits ?? 2
      const amountInMinorUnits = fiatAmount * Math.pow(10, fractionDigits)
      const sats = Math.round(amountInMinorUnits / exchangeRate.satPriceInCurrency)
      return formatNumber(sats, numberFormat, 0)
    }

    // Get tip amount in current display currency
    const getTipAmount = (): number => {
      let finalTotal = total
      if (amount) {
        const numericAmount = parseFloat(amount)
        if (!isNaN(numericAmount) && numericAmount > 0) {
          finalTotal += numericAmount
        }
      }

      if (selectedTipPercent > 0) {
        return calculateTipAmount(finalTotal, selectedTipPercent)
      }

      return 0
    }

    // Play keystroke sound (also unlocks iOS audio on first press)
    const playKeystrokeSound = () => {
      if (soundEnabled) {
        // Unlock AudioContext on user gesture for iOS Safari
        unlockAudioContext()
        playSound("/click.mp3", 0.3)
      }
    }

    const handleDigitPress = (digit: string) => {
      // Play sound effect for keystroke
      playKeystrokeSound()

      // Maximum bitcoin supply in sats: 21,000,000 BTC * 100,000,000 sats/BTC = 2,100,000,000,000,000 sats
      const MAX_SATS = 2100000000000000

      // Check if adding this digit would exceed the maximum bitcoin supply
      if (digit !== ".") {
        const newAmount = amount + digit
        const numericValue = parseFloat(newAmount.replace(/[^0-9.]/g, ""))

        // For BTC currency (sats), the amount is in sats already
        if (isBitcoinCurrency(displayCurrency) && numericValue > MAX_SATS) {
          return // Don't allow exceeding max bitcoin supply
        }

        // For fiat currencies, we can't validate until we have exchange rate,
        // but we cap at 16 digits as a reasonable limit
        const currentNumericDigits = amount.replace(/[^0-9]/g, "").length
        if (currentNumericDigits >= 16) {
          return // Already at max 16 digits
        }
      }

      // Special handling for '0' as first digit: treat as "0." for fiat currencies
      if (amount === "" && digit === "0") {
        if (isBitcoinCurrency(displayCurrency)) {
          setAmount("0")
        } else {
          setAmount("0.")
        }
        return
      }

      // Special handling for '.' as first digit: treat same as '0' (i.e., "0." for fiat)
      if (amount === "" && digit === ".") {
        // Don't allow decimal points for zero-decimal currencies (BTC, JPY, XOF, etc.)
        const currency = getCurrentCurrency()
        if (isBitcoinCurrency(displayCurrency) || currency?.fractionDigits === 0) {
          return
        } else {
          setAmount("0.")
        }
        return
      }

      if (amount === "0" && digit !== ".") {
        setAmount(digit)
      } else if (digit === "." && amount.includes(".")) {
        // Don't add multiple decimal points
        return
      } else if (digit === ".") {
        // Don't allow decimal points for zero-decimal currencies (BTC, JPY, XOF, HUF, etc.)
        const currency = getCurrentCurrency()
        if (isBitcoinCurrency(displayCurrency) || currency?.fractionDigits === 0) {
          return
        }
        setAmount(amount + digit)
      } else if (amount.includes(".")) {
        // Check decimal places based on currency fractionDigits
        const currency = getCurrentCurrency()
        const maxDecimals = currency ? (currency.fractionDigits ?? 2) : 2
        const currentDecimals = amount.split(".")[1].length

        if (currentDecimals >= maxDecimals) {
          // Don't allow more decimals than the currency supports
          return
        }
        setAmount(amount + digit)
      } else {
        setAmount(amount + digit)
      }
    }

    const handleBackspace = () => {
      playKeystrokeSound()
      setAmount(amount.slice(0, -1))
    }

    const handleClear = () => {
      playKeystrokeSound()

      // Trigger transition animation when canceling from invoice view
      if (invoice && onInternalTransition) {
        onInternalTransition()
      }

      setAmount("")
      setTotal(0)
      setItems([])
      setInvoice(null)
      setCartMemo("") // Clear cart memo
      if (onInvoiceChange) {
        onInvoiceChange(null)
      }
      setError("")
      // Reset all tip-related state
      setSelectedTipPercent(0)
      setShowTipDialog(false)
      setPendingTipSelection(null)

      // Note: Payment detection is handled via webhook + polling in Dashboard
    }

    const handlePlusPress = () => {
      playKeystrokeSound()

      // Silently ignore if no amount entered or amount is invalid
      if (!amount) {
        return
      }

      const numericAmount = parseFloat(amount)
      if (isNaN(numericAmount) || numericAmount <= 0) {
        return
      }

      // Add current amount to items and total
      setItems((prev) => [...prev, numericAmount])
      setTotal((prev) => prev + numericAmount)
      setAmount("") // Clear input for next item
      setError("")
    }

    // Expose numpad handlers for keyboard navigation
    useImperativeHandle(ref, () => ({
      handleDigitPress,
      handleBackspace,
      handleClear,
      handlePlusPress,
      handleSubmit: () => createInvoice(),
      hasInvoice: () => !!invoice,
      hasValidAmount: () => hasValidAmount(),
      // Tip dialog keyboard navigation
      isTipDialogOpen: () => showTipDialog && !showCustomTipInput,
      handleTipDialogKey: (key: string) => {
        if (!showTipDialog || showCustomTipInput) return false

        const presets = tipPresets || [10, 15, 20]
        const hasCustomButton = presets.length === 3
        const totalOptions = presets.length + (hasCustomButton ? 1 : 0) + 2

        if (key === "ArrowRight") {
          setTipOptionIndex((prev) => (prev + 1) % totalOptions)
          return true
        } else if (key === "ArrowLeft") {
          setTipOptionIndex((prev) => (prev - 1 + totalOptions) % totalOptions)
          return true
        } else if (key === "ArrowDown") {
          setTipOptionIndex((prev) => Math.min(prev + 2, totalOptions - 1))
          return true
        } else if (key === "ArrowUp") {
          setTipOptionIndex((prev) => Math.max(prev - 2, 0))
          return true
        } else if (key === "Enter") {
          // Determine which option is selected
          if (tipOptionIndex < presets.length) {
            setPendingTipSelection(presets[tipOptionIndex])
          } else if (hasCustomButton && tipOptionIndex === presets.length) {
            setShowCustomTipInput(true)
            setCustomTipValue("")
          } else if (tipOptionIndex === totalOptions - 2) {
            if (onInternalTransition) onInternalTransition()
            setShowTipDialog(false)
          } else if (tipOptionIndex === totalOptions - 1) {
            setPendingTipSelection(0)
          }
          return true
        } else if (key === "Escape") {
          if (onInternalTransition) onInternalTransition()
          setShowTipDialog(false)
          return true
        }
        return false
      },
    }))

    // Create invoice with specific tip percentage (bypasses state timing issues)
    const createInvoiceWithTip = async (tipPercent: number) => {
      return createInvoice(true, tipPercent)
    }

    const createInvoice = async (
      skipTipDialog: boolean | React.SyntheticEvent = false,
      forceTipPercent: number | null = null,
    ) => {
      // Ensure skipTipDialog is a boolean (handle event objects)
      const shouldSkipTipDialog =
        typeof skipTipDialog === "boolean" ? skipTipDialog : false

      // Use forced tip percent if provided, otherwise use state
      const effectiveTipPercent =
        forceTipPercent !== null ? forceTipPercent : selectedTipPercent

      // Calculate final total (current amount + existing total)
      let finalTotal = total

      if (amount) {
        const numericAmount = parseFloat(amount)
        if (isNaN(numericAmount) || numericAmount <= 0) {
          setError("Please enter a valid amount")
          return
        }

        // Validate minimum amount for currency
        if (!isValidAmount(amount)) {
          const currency = getCurrentCurrency()
          const minAmount =
            currency && (currency.fractionDigits ?? 0) > 0
              ? (1 / Math.pow(10, currency.fractionDigits ?? 2)).toFixed(
                  currency.fractionDigits ?? 2,
                )
              : "1"
          setError(`Minimum amount is ${formatDisplayAmount(minAmount, displayCurrency)}`)
          return
        }

        finalTotal += numericAmount
      }

      if (finalTotal <= 0) {
        setError("Please add some items or enter an amount")
        return
      }

      // Show tip overlay if tips are enabled and we haven't skipped it
      if (
        tipsEnabled &&
        tipRecipients &&
        tipRecipients.length > 0 &&
        !shouldSkipTipDialog &&
        effectiveTipPercent === 0
      ) {
        if (onInternalTransition) onInternalTransition()
        setShowTipDialog(true)
        return
      }

      // PUBLIC POS MODE: Skip wallet validation - invoices go directly to user's wallet
      if (isPublicPOS && publicUsername) {
        console.log("🌐 Public POS mode - creating invoice directly to:", publicUsername)
        // Continue to invoice creation (no wallet required on our side)
      } else {
        // AUTHENTICATED MODE: Invoices are created via Blink's blinkpos account
        // Payments are forwarded via webhook to either:
        // - User's Blink wallet via API key (if they have one), OR
        // - User's Blink wallet via Lightning Address (if they have one), OR
        // - User's NWC wallet (if active)
        const hasBlinkApiKeyWallet = selectedWallet && apiKey
        const hasNwcWallet = activeNWC && nwcClientReady

        if (
          !hasBlinkApiKeyWallet &&
          !hasNwcWallet &&
          !hasBlinkLnAddressWallet &&
          !hasNpubCashWallet
        ) {
          setError(
            "No wallet available. Please connect a Blink, NWC, or npub.cash wallet.",
          )
          return
        }

        // Payment detection is now handled via webhook + polling in Dashboard
        // No client-side WebSocket connection needed (security fix)
      }

      setLoading(true)
      setCreatingInvoice(true)
      setError("")

      try {
        // Calculate total including tip using effective tip percent
        const tipAmount =
          effectiveTipPercent > 0
            ? calculateTipAmount(finalTotal, effectiveTipPercent)
            : 0
        const totalWithTip = finalTotal + tipAmount

        // Convert the final total to satoshis if using fiat currency
        let finalTotalInSats = totalWithTip
        let memo = ""

        if (!isBitcoinCurrency(displayCurrency)) {
          // Check if we have exchange rates
          if (!exchangeRate) {
            setError(
              `Exchange rate not available for ${displayCurrency}. Please try again.`,
            )
            setLoading(false)
            return
          }

          finalTotalInSats = convertToSatoshis(totalWithTip, displayCurrency)

          // Validate minimum 1 satoshi
          if (finalTotalInSats < 1) {
            setError(
              `Amount too small. Converts to less than 1 satoshi. Minimum is ${formatDisplayAmount(0.01, displayCurrency)}`,
            )
            setLoading(false)
            return
          }

          // Build memo - use cart memo if available, otherwise show calculation
          if (cartMemo) {
            // Cart checkout - show item names with amounts
            if (effectiveTipPercent > 0) {
              memo = `${cartMemo} + ${effectiveTipPercent}% tip = ${formatDisplayAmount(totalWithTip, displayCurrency)} (${finalTotalInSats} sats)`
            } else {
              memo = `${cartMemo} = ${formatDisplayAmount(finalTotal, displayCurrency)} (${finalTotalInSats} sats)`
            }
          } else {
            // Manual numpad entry - show calculation
            const allItems = amount ? [...items, parseFloat(amount)] : items
            if (effectiveTipPercent > 0) {
              if (allItems.length > 1) {
                memo = `${allItems.join(" + ")} + ${effectiveTipPercent}% tip = ${formatDisplayAmount(totalWithTip, displayCurrency)} (${finalTotalInSats} sats)`
              } else {
                memo = `${formatDisplayAmount(finalTotal, displayCurrency)} + ${effectiveTipPercent}% tip = ${formatDisplayAmount(totalWithTip, displayCurrency)} (${finalTotalInSats} sats)`
              }
            } else {
              if (allItems.length > 1) {
                memo = `${allItems.join(" + ")} = ${formatDisplayAmount(finalTotal, displayCurrency)} (${finalTotalInSats} sats)`
              } else {
                memo = `${formatDisplayAmount(finalTotal, displayCurrency)} (${finalTotalInSats} sats)`
              }
            }
          }
        } else {
          // BTC - show calculation in sats
          if (cartMemo) {
            // Cart checkout - show item names with amounts
            if (effectiveTipPercent > 0) {
              memo = `${cartMemo} + ${effectiveTipPercent}% tip = ${totalWithTip} sats`
            } else {
              memo = `${cartMemo} = ${finalTotal} sats`
            }
          } else {
            // Manual numpad entry
            const allItems = amount ? [...items, parseFloat(amount)] : items
            if (effectiveTipPercent > 0) {
              memo =
                allItems.length > 1
                  ? `${allItems.join(" + ")} + ${effectiveTipPercent}% tip = ${totalWithTip} sats`
                  : `${finalTotal} + ${effectiveTipPercent}% tip = ${totalWithTip} sats`
            } else {
              // Even with no tip, include amount in memo to avoid Blink's default "From $username"
              memo =
                allItems.length > 1
                  ? `${allItems.join(" + ")} = ${finalTotal} sats`
                  : `${finalTotal} sats`
            }
          }
          finalTotalInSats = Math.round(totalWithTip)
        }

        // PUBLIC POS MODE: Create invoice directly to user's wallet
        if (isPublicPOS && publicUsername) {
          // Get current environment (staging or production) from client-side localStorage
          const currentEnvironment = getEnvironment()
          console.log(
            "🌐 Creating public invoice for:",
            publicUsername,
            "Amount:",
            finalTotalInSats,
            "Environment:",
            currentEnvironment,
          )

          const response = await fetch("/api/blink/public-invoice", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              username: publicUsername,
              amount: finalTotalInSats,
              memo: memo || `Payment to ${publicUsername}`,
              walletCurrency: "BTC",
              environment: currentEnvironment, // Pass environment to API
            }),
          })

          const data = await response.json()

          console.log("Public invoice response:", data)

          if (!response.ok) {
            throw new Error(data.error || `Server error: ${response.status}`)
          }

          if (data.success && data.invoice) {
            // Enhance invoice with display currency information
            const enhancedInvoice: InvoiceData = {
              ...data.invoice,
              displayAmount: totalWithTip,
              displayCurrency: displayCurrency,
              satAmount: finalTotalInSats,
              memo: memo,
            }
            setInvoice(enhancedInvoice)
            // Notify parent of invoice creation with full invoice data
            if (onInvoiceChange) {
              console.log(
                "📋 Public invoice created with payment hash:",
                data.invoice.paymentHash?.substring(0, 16) + "...",
              )
              onInvoiceChange(enhancedInvoice)
            }
          } else {
            throw new Error("Invalid response from server")
          }
        } else {
          // AUTHENTICATED MODE: Create invoice via Blink API (through blinkpos account)
          // For NWC-only or LN Address users, Blink wallet fields are optional
          // Calculate base and tip amounts in sats
          // CRITICAL: Calculate tip as (total - base) to avoid rounding errors
          // When base and tip are rounded independently, their sum may differ from total
          const baseInSats = convertToSatoshis(
            finalTotal,
            !isBitcoinCurrency(displayCurrency) ? displayCurrency : "BTC",
          )
          // Tip is the difference between total invoice and base (ensures base + tip = total)
          const tipInSats =
            effectiveTipPercent > 0 ? Math.max(0, finalTotalInSats - baseInSats) : 0

          // Get NWC connection URI for server-side forwarding (if NWC is active)
          let nwcConnectionUri: string | null = null
          if (activeNWC && nwcClientReady && getActiveNWCUri) {
            try {
              nwcConnectionUri = await getActiveNWCUri()
              if (nwcConnectionUri) {
                console.log("📱 NWC URI retrieved for server-side forwarding")
              }
            } catch (nwcUriError: unknown) {
              console.error("Failed to get NWC URI:", nwcUriError)
            }
          }

          const requestBody: CreateInvoiceRequest = {
            amount: finalTotalInSats,
            currency: "BTC", // Always create BTC invoices
            memo: memo, // Show calculation in memo
            displayCurrency: displayCurrency, // Pass the actual display currency for tip memo
            // Environment for staging/production switching (client-side state)
            environment: getEnvironment(),
            // Tip information for payment splitting
            baseAmount: baseInSats,
            tipAmount: tipInSats,
            tipPercent: effectiveTipPercent,
            tipRecipients: tipRecipients || [],
            // Display currency amounts for memo calculation
            baseAmountDisplay: finalTotal,
            tipAmountDisplay: tipAmount,
            // Include Blink wallet info only if available (for Blink API key forwarding)
            // NWC-only or LN Address users won't have these
            ...(selectedWallet && {
              walletId: selectedWallet.id,
              userWalletId: selectedWallet.id,
            }),
            ...(apiKey && { apiKey }),
            // Flag to indicate if NWC is active (for forwarding logic)
            nwcActive: !!activeNWC && !!nwcClientReady,
            // NWC connection URI for server-side webhook forwarding
            // This allows the webhook to forward payments even when the app is in background
            ...(nwcConnectionUri && { nwcConnectionUri }),
            // Flag and data for Blink Lightning Address wallet (no API key required)
            ...(hasBlinkLnAddressWallet && {
              blinkLnAddress: true,
              blinkLnAddressWalletId: activeBlinkAccount.walletId,
              blinkLnAddressUsername: activeBlinkAccount.username,
            }),
            // Flag and data for npub.cash wallet (uses LNURL-pay)
            ...(hasNpubCashWallet && {
              npubCashActive: true,
              npubCashLightningAddress: activeNpubCashWallet.lightningAddress,
            }),
          }

          console.log("Creating invoice with request body:", requestBody)

          const response = await fetch("/api/blink/create-invoice", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
          })

          const data = await response.json()

          console.log("Invoice response:", data)

          if (!response.ok) {
            throw new Error(data.error || `Server error: ${response.status}`)
          }

          if (data.success && data.invoice) {
            // Enhance invoice with display currency information
            const enhancedInvoice: InvoiceData = {
              ...data.invoice,
              displayAmount: totalWithTip, // Use totalWithTip to include tip amount
              displayCurrency: displayCurrency,
              satAmount: finalTotalInSats,
              memo: memo,
            }
            setInvoice(enhancedInvoice)
            // Notify parent of invoice creation for NFC scanning and payment hash tracking
            if (onInvoiceChange) {
              console.log(
                "📋 Invoice created with payment hash:",
                data.invoice.paymentHash?.substring(0, 16) + "...",
              )
              onInvoiceChange(enhancedInvoice)
            }
          } else {
            throw new Error("Invalid response from server")
          }
        }
      } catch (err: unknown) {
        console.error("Invoice creation error:", err)
        setError((err as Error).message || "Failed to create invoice")
        setCreatingInvoice(false)
      } finally {
        setLoading(false)
        // Keep creatingInvoice true for a moment to show the animation
        setTimeout(() => setCreatingInvoice(false), 500)
      }
    }

    const copyToClipboard = async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        // You could add a toast notification here
      } catch (err: unknown) {
        console.error("Failed to copy:", err)
      }
    }

    // Show loading animation while creating invoice
    if (creatingInvoice) {
      // Calculate display values for loading state
      const finalTotal = total + (parseFloat(amount) || 0)
      const tipAmount =
        selectedTipPercent > 0 ? calculateTipAmount(finalTotal, selectedTipPercent) : 0
      const totalWithTip = finalTotal + tipAmount

      return (
        <div
          className="h-full flex flex-col bg-white dark:bg-black"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          {/* Error Message Space - Same as numpad view */}
          <div className="mx-3 mt-1 min-h-[44px]"></div>

          {/* Amount Display - Same as numpad */}
          <div className="px-4 pt-2 pb-2">
            <div className="text-center mb-4">
              <div className="text-center">
                <div className="text-6xl font-semibold text-gray-800 dark:text-gray-100 mb-1 min-h-[96px] flex items-center justify-center leading-none tracking-normal">
                  {total > 0 ? (
                    <div>
                      <span className="text-blink-accent">
                        {formatDisplayAmount(total, displayCurrency)}
                      </span>
                      {amount && (
                        <span className="text-4xl text-gray-600 dark:text-gray-400">
                          {" "}
                          + {amount}
                        </span>
                      )}
                    </div>
                  ) : amount === "0" || amount === "0." ? (
                    isBitcoinCurrency(displayCurrency) ||
                    getCurrencyById(displayCurrency, currencies)?.fractionDigits === 0 ? (
                      "0"
                    ) : (
                      getCurrencyById(displayCurrency, currencies)?.symbol + "0."
                    )
                  ) : amount ? (
                    formatDisplayAmount(amount, displayCurrency)
                  ) : (
                    formatDisplayAmount(0, displayCurrency)
                  )}
                </div>
                {selectedTipPercent > 0 && (
                  <div className="text-2xl text-green-600 dark:text-green-400 font-semibold">
                    + {selectedTipPercent}% tip (
                    {formatDisplayAmount(tipAmount, displayCurrency)})
                    <div className="text-3xl text-green-700 dark:text-green-400 mt-1">
                      Total: {formatDisplayAmount(totalWithTip, displayCurrency)}
                    </div>
                  </div>
                )}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400">
                <div className="mb-1 min-h-[20px]">
                  {items.length > 0 && (
                    <div>
                      Items: {items.join(" + ")}
                      {amount && ` + ${amount}`}
                      {total > 0 &&
                        amount &&
                        ` = ${formatDisplayAmount(total + (parseFloat(amount) || 0), displayCurrency)}`}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Loading Animation - Contained in center */}
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center bg-gray-50 dark:bg-blink-dark rounded-lg p-8 shadow-lg">
              <div className="animate-spin rounded-full h-16 w-16 border-4 border-blink-accent border-t-transparent mb-4"></div>
              <div className="text-xl font-semibold text-gray-800 dark:text-gray-100">
                Creating Invoice...
              </div>
            </div>
          </div>
        </div>
      )
    }

    if (invoice) {
      return (
        <div
          className="h-full flex flex-col bg-white dark:bg-black overflow-hidden"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          {/* Header - Match main header structure exactly */}
          <div
            className={`${theme === THEMES.BLINK_CLASSIC_DARK ? "bg-black border-blink-classic-border" : "bg-white dark:bg-blink-dark border-gray-200 dark:border-gray-700"} border-b shadow-sm dark:shadow-black flex-shrink-0`}
          >
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex items-center justify-between py-4">
                {/* Blink Logo - Left (tap to cycle theme) */}
                <button
                  onClick={cycleTheme}
                  className="flex items-center focus:outline-none"
                  aria-label="Cycle theme"
                >
                  <img
                    src="/logos/blink-icon-light.svg"
                    alt="Blink"
                    className={`h-12 w-12 ${darkMode ? "hidden" : "block"}`}
                  />
                  <img
                    src="/logos/blink-icon-dark.svg"
                    alt="Blink"
                    className={`h-12 w-12 ${darkMode ? "block" : "hidden"}`}
                  />
                </button>

                {/* NFC Icon - Center (only if supported) */}
                {nfcState && nfcState.isNfcSupported && (
                  <div className="absolute left-1/2 transform -translate-x-1/2">
                    <button
                      onClick={nfcState.activateNfcScan}
                      disabled={nfcState.hasNFCPermission}
                      className="flex items-center justify-center transition-all hover:scale-110 disabled:cursor-default"
                      aria-label={
                        nfcState.hasNFCPermission ? "NFC Activated" : "Activate NFC"
                      }
                      title={
                        nfcState.hasNFCPermission
                          ? "NFC ready - tap your card now"
                          : "Click to activate NFC"
                      }
                    >
                      <img
                        src={nfcState.hasNFCPermission ? "/greennfc.svg" : "/bluenfc.svg"}
                        alt="NFC"
                        className="h-10 w-10"
                      />
                    </button>
                  </div>
                )}

                {/* Spacer for layout balance */}
                <div className="w-12"></div>
              </div>
            </div>
          </div>

          {/* Invoice Display - Scrollable content area */}
          <div className="flex-1 overflow-y-auto overscroll-contain flex flex-col">
            {/* Amount - Fixed at top position */}
            <div className="px-4 pt-4 pb-2">
              <div className="text-center">
                <div className="text-6xl font-semibold text-gray-800 dark:text-gray-100 mb-1 leading-none tracking-normal">
                  {!isBitcoinCurrency(invoice.displayCurrency as string) ? (
                    <div>
                      <div>
                        {formatDisplayAmount(
                          invoice.displayAmount as number,
                          invoice.displayCurrency as string,
                        )}
                      </div>
                      <div className="text-lg text-gray-600 dark:text-gray-400 mt-1">
                        ({formatNumber(invoice.satAmount as number, numberFormat, 0)}{" "}
                        sats)
                      </div>
                    </div>
                  ) : (
                    formatDisplayAmount(
                      invoice.satAmount || (invoice.displayAmount as number),
                      invoice.displayCurrency as string,
                    )
                  )}
                </div>
              </div>
            </div>

            {/* QR Code and Invoice - Centered */}
            <div
              className="flex-1 flex flex-col items-center justify-center space-y-4 px-6"
              data-testid="invoice-container"
            >
              {/* QR Code */}
              <div
                className="bg-white dark:bg-white p-4 rounded-lg shadow-lg border-2 border-gray-200 dark:border-gray-600"
                data-testid="invoice-qr"
              >
                <QRCode
                  value={invoice.paymentRequest}
                  size={256}
                  bgColor="#ffffff"
                  fgColor="#000000"
                />
              </div>

              {/* Payment Request */}
              <div className="w-full max-w-md">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Lightning Invoice
                </label>
                <div className="flex">
                  <input
                    type="text"
                    value={invoice.paymentRequest}
                    readOnly
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    data-testid="invoice-string"
                    className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-l-md bg-gray-50 dark:bg-blink-dark text-sm font-mono text-black dark:text-gray-100"
                  />
                  <button
                    onClick={() => copyToClipboard(invoice.paymentRequest)}
                    className="px-4 py-2 bg-blue-500 dark:bg-blue-600 text-white rounded-r-md hover:bg-blue-600 dark:hover:bg-blue-700 transition-colors"
                    data-testid="copy-invoice"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* Cancel Button - Bottom */}
            <div className="px-4 pb-4 pt-4">
              <button
                onClick={handleClear}
                className="w-full h-12 bg-white dark:bg-black border-2 border-red-600 dark:border-red-500 hover:border-red-700 dark:hover:border-red-400 hover:bg-red-50 dark:hover:bg-red-900 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 rounded-lg text-lg font-normal transition-colors shadow-md"
                style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div
        className="h-full flex flex-col bg-white dark:bg-black relative"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {/* Compact Amount Display */}
        <div className="px-4">
          <div className="text-center">
            <div className="text-center">
              <div
                data-testid="amount-display"
                className={`font-inter-tight font-semibold text-gray-800 dark:text-gray-100 min-h-[72px] flex items-center justify-center leading-none tracking-normal max-w-full overflow-hidden px-2 ${
                  showTipDialog
                    ? getDynamicFontSize(
                        formatDisplayAmount(
                          total + (parseFloat(amount) || 0),
                          displayCurrency,
                        ),
                      )
                    : total > 0
                      ? getDynamicFontSize(
                          formatDisplayAmount(total, displayCurrency) +
                            (amount ? " + " + amount : ""),
                        )
                      : getDynamicFontSize(
                          amount === "0" || amount === "0."
                            ? isBitcoinCurrency(displayCurrency) ||
                              getCurrencyById(displayCurrency, currencies)
                                ?.fractionDigits === 0
                              ? "0"
                              : getCurrencyById(displayCurrency, currencies)?.symbol +
                                "0."
                            : amount
                              ? formatDisplayAmount(amount, displayCurrency)
                              : formatDisplayAmount(0, displayCurrency),
                        )
                }`}
                style={{ wordBreak: "keep-all", overflowWrap: "normal" }}
              >
                {showTipDialog ? (
                  // When tip dialog is showing, show the combined total in white/black (not orange)
                  <div className="max-w-full">
                    {renderStyledAmount(
                      total + (parseFloat(amount) || 0),
                      displayCurrency,
                      "text-gray-800 dark:text-white",
                    )}
                  </div>
                ) : total > 0 ? (
                  <div className="max-w-full flex flex-wrap items-center justify-center gap-2">
                    {renderStyledAmount(total, displayCurrency, "text-blink-accent")}
                    {amount && (
                      <span
                        className={`text-gray-600 dark:text-gray-400 ${
                          // Secondary amount is 2 sizes smaller than main amount (with desktop scaling)
                          getDynamicFontSize(amount).includes("text-6xl")
                            ? "text-4xl md:text-5xl"
                            : getDynamicFontSize(amount).includes("text-5xl")
                              ? "text-3xl md:text-4xl"
                              : getDynamicFontSize(amount).includes("text-4xl")
                                ? "text-2xl md:text-3xl"
                                : getDynamicFontSize(amount).includes("text-3xl")
                                  ? "text-xl md:text-2xl"
                                  : getDynamicFontSize(amount).includes("text-2xl")
                                    ? "text-lg md:text-xl"
                                    : "text-base md:text-lg"
                        }`}
                      >
                        {" "}
                        + {amount}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="max-w-full">
                    {amount === "0" || amount === "0."
                      ? isBitcoinCurrency(displayCurrency) ||
                        getCurrencyById(displayCurrency, currencies)?.fractionDigits === 0
                        ? "0"
                        : getCurrencyById(displayCurrency, currencies)?.symbol + "0."
                      : renderStyledAmount(amount || 0, displayCurrency)}
                  </div>
                )}
              </div>
              {selectedTipPercent > 0 && (
                <div
                  className={`text-green-600 dark:text-green-400 font-semibold max-w-full overflow-hidden px-2 ${getDynamicFontSize(formatDisplayAmount(getTipAmount(), displayCurrency)).includes("text-6xl") ? "text-2xl md:text-3xl" : getDynamicFontSize(formatDisplayAmount(getTipAmount(), displayCurrency)).includes("text-5xl") ? "text-xl md:text-2xl" : "text-lg md:text-xl"}`}
                >
                  + {selectedTipPercent}% tip (
                  {renderStyledAmount(getTipAmount(), displayCurrency)})
                  <div
                    className={`text-green-700 dark:text-green-400 mt-1 max-w-full ${getDynamicFontSize(formatDisplayAmount(getTotalWithTip(), displayCurrency))}`}
                    style={{ wordBreak: "keep-all", overflowWrap: "normal" }}
                  >
                    Total: {renderStyledAmount(getTotalWithTip(), displayCurrency)}
                    {!isBitcoinCurrency(displayCurrency) && (
                      <span className="text-sm ml-2">
                        ({getSatsEquivalent(getTotalWithTip())} sats)
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              <div className="mb-1 min-h-[20px] max-w-full overflow-x-auto px-2">
                {items.length > 0 ? (
                  <div className="whitespace-nowrap">
                    {items.join(" + ")}
                    {amount && ` + ${amount}`}
                    {!showTipDialog &&
                      total > 0 &&
                      amount &&
                      ` = ${formatDisplayAmount(total + (parseFloat(amount) || 0), displayCurrency)}`}
                  </div>
                ) : !isBitcoinCurrency(displayCurrency) ? (
                  `(${getSatsEquivalent(parseFloat(amount) || 0)} sats)`
                ) : null}
              </div>
            </div>
            {/* Reserve space for consistency with voucher screens that show balance warnings */}
            <div className="min-h-[20px]"></div>
            {/* Error Message - inline below amount */}
            {error && (
              <div className="mt-2 bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-200 px-3 py-2 rounded text-sm animate-pulse">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Redesigned Numpad - Scaled up for better visibility on desktop, original on mobile */}
        <div className="flex-1 px-4 pb-4 relative">
          {/* Spacer to align numpad with item list (below Search/Add Item row level) */}
          <div className="h-16 mb-2"></div>
          <Numpad
            theme={theme}
            layout={numpadLayout}
            onDigitPress={handleDigitPress}
            onClear={handleClear}
            onBackspace={handleBackspace}
            onPlusPress={handlePlusPress}
            onOkPress={() => createInvoice()}
            okDisabled={
              !hasValidAmount() ||
              loading ||
              (!(isPublicPOS && publicUsername) &&
                !selectedWallet &&
                !activeNWC &&
                !hasBlinkLnAddressWallet &&
                !hasNpubCashWallet) ||
              (!isBitcoinCurrency(displayCurrency) && !exchangeRate) ||
              loadingRate
            }
            okLabel={loading ? "Creating..." : "OK"}
            decimalDisabled={
              isBitcoinCurrency(displayCurrency) ||
              getCurrentCurrency()?.fractionDigits === 0
            }
            plusDisabled={!amount || parseFloat(amount) <= 0}
            accentColor="blue"
            showPlus={true}
          />

          {/* Tip Selection Overlay (over numpad) */}
          {showTipDialog &&
            !showCustomTipInput &&
            (() => {
              const presets = tipPresets || [10, 15, 20]
              const hasCustomButton = presets.length === 3
              const totalOptions = presets.length + (hasCustomButton ? 1 : 0) + 2
              const cancelIndex = totalOptions - 2
              const noTipIndex = totalOptions - 1
              const customIndex = hasCustomButton ? presets.length : -1

              return (
                <div className={`absolute inset-0 ${getTipDialogBgClasses()} z-30 pt-24`}>
                  <div
                    className="grid grid-cols-4 gap-3 max-w-sm md:max-w-md mx-auto"
                    style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
                  >
                    <h3
                      className={`col-span-4 text-xl font-bold mb-2 text-center ${getTipDialogTextClasses()}`}
                    >
                      Tip Options
                    </h3>

                    {/* Tip preset buttons in grid */}
                    {presets.map((percent: number, idx: number) => (
                      <button
                        key={percent}
                        onClick={() => {
                          setPendingTipSelection(percent)
                        }}
                        className={`col-span-2 h-16 md:h-20 ${isBlinkClassic ? "rounded-xl" : "rounded-lg"} text-lg md:text-xl font-normal transition-colors ${isBlinkClassic ? "" : "shadow-md"} ${getTipButtonClasses(tipOptionIndex === idx)}`}
                      >
                        {percent}%
                        <div
                          className={`text-sm md:text-base ${isBlinkClassic ? "opacity-70" : ""}`}
                        >
                          +
                          {formatDisplayAmount(
                            calculateTipAmount(
                              total + (parseFloat(amount) || 0),
                              percent,
                            ),
                            displayCurrency,
                          )}
                        </div>
                      </button>
                    ))}

                    {/* Show Custom button when exactly 3 presets */}
                    {hasCustomButton && (
                      <button
                        onClick={() => {
                          setShowCustomTipInput(true)
                          setCustomTipValue("")
                        }}
                        className={`col-span-2 h-16 md:h-20 ${isBlinkClassic ? "rounded-xl" : "rounded-lg"} text-lg md:text-xl font-normal transition-colors ${isBlinkClassic ? "" : "shadow-md"} ${getCustomButtonClasses(tipOptionIndex === customIndex)}`}
                      >
                        Custom
                      </button>
                    )}

                    {/* Cancel and No Tip buttons */}
                    <button
                      onClick={() => {
                        if (onInternalTransition) onInternalTransition()
                        setShowTipDialog(false)
                      }}
                      className={`col-span-2 h-16 md:h-20 ${isBlinkClassic ? "rounded-xl" : "rounded-lg"} text-lg md:text-xl font-normal transition-colors ${isBlinkClassic ? "" : "shadow-md"} ${getCancelButtonClasses(tipOptionIndex === cancelIndex)}`}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        setPendingTipSelection(0)
                      }}
                      className={`col-span-2 h-16 md:h-20 ${isBlinkClassic ? "rounded-xl" : "rounded-lg"} text-lg md:text-xl font-normal transition-colors ${isBlinkClassic ? "" : "shadow-md"} ${getNoTipButtonClasses(tipOptionIndex === noTipIndex)}`}
                    >
                      No Tip
                    </button>
                  </div>
                </div>
              )
            })()}

          {/* Custom Tip Input Overlay */}
          {showTipDialog && showCustomTipInput && (
            <div
              className={`absolute inset-0 ${getTipDialogBgClasses()} flex items-center justify-center z-30`}
            >
              <div
                className="max-w-md w-full px-4"
                style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
              >
                <h3
                  className={`text-xl md:text-2xl font-bold mb-4 text-center ${getTipDialogTextClasses()}`}
                >
                  Custom Tip
                </h3>
                <div className="mb-6">
                  <label
                    className={`block text-base font-medium mb-2 text-center ${getTipDialogSecondaryTextClasses()}`}
                  >
                    Enter Tip Percentage
                  </label>
                  <input
                    type="number"
                    value={customTipValue}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setCustomTipValue(e.target.value)
                    }
                    placeholder="e.g., 15"
                    min="0"
                    max="100"
                    step="0.5"
                    className={`w-full px-4 py-3 md:py-4 text-center text-3xl border ${isBlinkClassic ? "rounded-xl" : "rounded-lg"} focus:outline-none focus:ring-2 ${
                      isBlinkClassicDark
                        ? "bg-transparent border-blink-classic-border text-white focus:border-blink-classic-amber focus:ring-blink-classic-amber"
                        : isBlinkClassicLight
                          ? "bg-transparent border-blink-classic-border-light text-black focus:border-blink-classic-amber focus:ring-blink-classic-amber"
                          : "border-blue-600 dark:border-blue-500 bg-white dark:bg-blink-dark text-gray-900 dark:text-white focus:ring-blue-500 dark:focus:ring-blue-600"
                    }`}
                    autoFocus
                  />
                  {customTipValue && parseFloat(customTipValue) > 0 && (
                    <div
                      className={`mt-2 text-center text-lg ${getTipDialogSecondaryTextClasses()}`}
                    >
                      +
                      {formatDisplayAmount(
                        calculateTipAmount(
                          total + (parseFloat(amount) || 0),
                          parseFloat(customTipValue),
                        ),
                        displayCurrency,
                      )}
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => {
                      setShowCustomTipInput(false)
                      setCustomTipValue("")
                    }}
                    className={`h-16 md:h-20 ${isBlinkClassic ? "rounded-xl" : "rounded-lg"} text-lg md:text-xl font-normal transition-colors ${isBlinkClassic ? "" : "shadow-md"} ${getCancelButtonClasses(false)}`}
                  >
                    Back
                  </button>
                  <button
                    onClick={() => {
                      const tipPercent = parseFloat(customTipValue) || 0
                      if (tipPercent >= 0 && tipPercent <= 100) {
                        setPendingTipSelection(tipPercent)
                        setShowCustomTipInput(false)
                        setCustomTipValue("")
                      }
                    }}
                    disabled={
                      !customTipValue ||
                      parseFloat(customTipValue) < 0 ||
                      parseFloat(customTipValue) > 100
                    }
                    className={`h-16 md:h-20 ${isBlinkClassic ? "rounded-xl" : "rounded-lg"} text-lg md:text-xl font-normal transition-colors ${isBlinkClassic ? "" : "shadow-md"} disabled:opacity-50 disabled:cursor-not-allowed ${getTipButtonClasses(false)}`}
                  >
                    Apply
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  },
)

POS.displayName = "POS"
export default POS
