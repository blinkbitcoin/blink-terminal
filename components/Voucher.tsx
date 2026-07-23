import { bech32 } from "bech32"
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
  type ReactNode,
} from "react"
import QRCode from "react-qr-code"

import { unlockAudioContext, playSound } from "../lib/audio-utils"
import { getEnvironment } from "../lib/config/api"
import {
  formatDisplayAmount as formatCurrency,
  getCurrencyById,
  isBitcoinCurrency,
  parseAmountParts,
  type CurrencyMetadata,
} from "../lib/currency-utils"
import { useThermalPrint } from "../lib/escpos/hooks/useThermalPrint"
import type { ExchangeRateData } from "../lib/hooks/useExchangeRate"
import { THEMES, type Theme } from "../lib/hooks/useTheme"
import {
  formatNumber,
  type NumberFormatPreference,
  type BitcoinFormatPreference,
  type NumpadLayoutPreference,
} from "../lib/number-format"

import { DEFAULT_EXPIRY } from "./ExpirySelector"
import Numpad from "./Numpad"

// =============================================================================
// Types & Interfaces
// =============================================================================

/** Wallet descriptor passed in as a prop */
interface VoucherWallet {
  apiKey?: string
  walletId?: string
  username?: string
  [key: string]: unknown
}

/** The data stored in state once a voucher has been created */
interface VoucherData {
  id: string
  amount: number
  lnurl: string
  displayAmount: number
  displayCurrency: string
  commissionPercent: number
  commissionAmount: number
  netAmount: number
  expiresAt: string | null
  walletCurrency: "BTC" | "USD"
  usdAmountCents: number | null
  [key: string]: unknown // allow extra server-side fields
}

type VoucherCurrencyMode = "BTC" | "USD"

/** Props accepted by the Voucher component */
interface VoucherProps {
  voucherWallet: VoucherWallet | null
  walletBalance?: number | null
  displayCurrency: string
  numberFormat?: NumberFormatPreference
  bitcoinFormat?: BitcoinFormatPreference
  numpadLayout?: NumpadLayoutPreference
  currencies: CurrencyMetadata[]
  darkMode: boolean
  theme?: Theme
  cycleTheme: () => void
  soundEnabled: boolean
  onInternalTransition?: () => void
  onVoucherStateChange?: (isShowing: boolean) => void
  commissionEnabled: boolean
  commissionPresets?: number[]
  voucherCurrencyMode?: VoucherCurrencyMode
  onVoucherCurrencyToggle?: () => void
  usdExchangeRate?: ExchangeRateData | null
  usdWalletId?: string | null
  initialExpiry?: string
  /**
   * Push notification of the current entered amount (sats + USD cents) and
   * currency mode. Replaces the Dashboard's former 300ms polling of the
   * imperative getters for the capacity indicator.
   */
  onAmountChange?: (
    amountInSats: number,
    amountInUsdCents: number,
    currencyMode: VoucherCurrencyMode,
  ) => void
}

/** Methods exposed via the forwarded ref */
export interface VoucherHandle {
  handleDigitPress: (digit: string) => void
  handleBackspace: () => void
  handleClear: () => void
  handleSubmit: () => void
  hasVoucher: () => boolean
  hasValidAmount: () => boolean
  isRedeemed: () => boolean
  getAmountInSats: () => number
  getAmountInUsdCents: () => number
  getVoucherCurrencyMode: () => VoucherCurrencyMode
  getSelectedExpiry: () => string
  setSelectedExpiry: (expiryId: string) => void
  isCommissionDialogOpen: () => boolean
  handleCommissionDialogKey: (key: string) => boolean
}

// =============================================================================
// Component
// =============================================================================

const Voucher = forwardRef<VoucherHandle, VoucherProps>(
  (
    {
      voucherWallet,
      walletBalance = null,
      displayCurrency,
      numberFormat = "auto",
      bitcoinFormat = "sats",
      numpadLayout = "calculator",
      currencies,
      darkMode,
      theme = THEMES.DARK,
      cycleTheme,
      soundEnabled,
      onInternalTransition,
      onVoucherStateChange,
      commissionEnabled,
      commissionPresets = [1, 2, 3],
      voucherCurrencyMode = "BTC",
      onVoucherCurrencyToggle,
      usdExchangeRate = null,
      usdWalletId = null,
      initialExpiry = DEFAULT_EXPIRY,
      onAmountChange,
    },
    ref,
  ) => {
    const [amount, setAmount] = useState<string>("")
    const [voucher, setVoucher] = useState<VoucherData | null>(null)
    const [loading, setLoading] = useState<boolean>(false)
    const [error, setError] = useState<string>("")
    const [exchangeRate, setExchangeRate] = useState<ExchangeRateData | null>(null)
    const [_loadingRate, setLoadingRate] = useState<boolean>(false)
    const [redeemed, setRedeemed] = useState<boolean>(false)
    const [showPrintModal, setShowPrintModal] = useState<boolean>(false)
    const [printFormat, setPrintFormat] = useState<string>("a4")
    const [generatingPdf, setGeneratingPdf] = useState<boolean>(false)
    const [_companionAppInstalled, setCompanionAppInstalled] = useState<boolean>(false)
    const [printing, setPrinting] = useState<boolean>(false)
    // Commission selection state
    const [showCommissionDialog, setShowCommissionDialog] = useState<boolean>(false)
    const [selectedCommissionPercent, setSelectedCommissionPercent] = useState<number>(0)
    const [pendingCommissionSelection, setPendingCommissionSelection] = useState<
      number | null
    >(null)
    const [commissionOptionIndex, setCommissionOptionIndex] = useState<number>(0) // Keyboard navigation index
    // Expiry selection state
    const [selectedExpiry, setSelectedExpiry] = useState<string>(initialExpiry)
    // Thermal print state
    const [_thermalPrintMethod, _setThermalPrintMethod] = useState<string>("auto")
    const [_showThermalOptions, _setShowThermalOptions] = useState<boolean>(false)
    const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const successSoundRef = useRef<HTMLAudioElement | null>(null)
    const qrRef = useRef<HTMLDivElement | null>(null)

    // Thermal print hook
    const {
      print: thermalPrint,
      printMethods,
      selectedMethod: activePrintMethod,
      selectMethod: setActivePrintMethod,
      isPrinting: isThermalPrinting,
      error: thermalPrintError,
      recommendations: printRecommendations,
      isLoading: _isPrintSystemLoading,
      isMobile: _checkIsMobile,
    } = useThermalPrint({ paperWidth: printFormat === "thermal-58" ? 58 : 80 })

    // BC Theme helpers
    const isBlinkClassic =
      theme === "blink-classic-dark" || theme === "blink-classic-light"
    const isBlinkClassicDark = theme === "blink-classic-dark"
    const isBlinkClassicLight = theme === "blink-classic-light"

    // Get commission option button classes based on theme
    const getCommissionButtonClasses = (isSelected: boolean): string => {
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
      // Standard themes - use original purple styling
      return isSelected
        ? "border border-purple-400 ring-2 ring-purple-400 bg-purple-50 dark:bg-purple-900 text-purple-700 dark:text-purple-300"
        : "border border-purple-500 hover:border-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900 text-purple-600 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-300"
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

    // Get no commission/skip button classes (yellow in standard, themed in BC)
    const getNoCommissionButtonClasses = (isSelected: boolean): string => {
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

    // Get background for commission dialog overlay
    const getCommissionDialogBgClasses = (): string => {
      if (isBlinkClassicDark) return "bg-black"
      if (isBlinkClassicLight) return "bg-white"
      return "bg-white dark:bg-black"
    }

    // Get text color classes
    const getCommissionDialogTextClasses = (): string => {
      if (isBlinkClassicDark) return "text-white"
      if (isBlinkClassicLight) return "text-black"
      return "text-gray-800 dark:text-white"
    }

    // Notify parent when voucher QR or commission dialog is showing (to hide header elements)
    useEffect(() => {
      if (onVoucherStateChange) {
        // Hide header when voucher QR is showing OR commission dialog is showing
        onVoucherStateChange((!!voucher && !redeemed) || showCommissionDialog)
      }
    }, [voucher, redeemed, showCommissionDialog, onVoucherStateChange])

    // Check if POS companion app is installed
    useEffect(() => {
      const checkCompanionApp = async (): Promise<void> => {
        try {
          if ("getInstalledRelatedApps" in navigator) {
            const apps = await navigator.getInstalledRelatedApps!()
            const hasCompanion = apps.some((app) => app.id === "com.blink.pos.companion")
            setCompanionAppInstalled(hasCompanion)
            if (hasCompanion) {
              console.log("✅ POS companion app detected")
            }
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          console.log("Could not check for companion app:", msg)
        }
      }
      checkCompanionApp()
    }, [])

    // Play success sound (uses shared audio utility for iOS compatibility)
    const playSuccessSound = useCallback((): void => {
      if (soundEnabled) {
        playSound("/success.mp3", 0.5)
      }
    }, [soundEnabled])

    // Poll voucher status to detect redemption
    const pollVoucherStatus = useCallback(
      async (chargeId: string): Promise<void> => {
        try {
          const response = await fetch(`/api/voucher/status/${chargeId}`)
          const data = await response.json()

          if (data.claimed) {
            console.log("✅ Voucher has been redeemed!")
            setRedeemed(true)
            playSuccessSound()

            // Stop polling
            if (pollingIntervalRef.current) {
              clearInterval(pollingIntervalRef.current)
              pollingIntervalRef.current = null
            }
          }
        } catch (error) {
          console.error("Error polling voucher status:", error)
        }
      },
      [playSuccessSound],
    )

    // Start polling when voucher is created
    useEffect(() => {
      if (voucher && voucher.id && !redeemed) {
        console.log("🔄 Starting voucher status polling for:", voucher.id)

        // Poll immediately
        pollVoucherStatus(voucher.id)

        // Then poll every 2 seconds (skipping ticks while the tab is hidden)
        pollingIntervalRef.current = setInterval(() => {
          if (document.visibilityState === "hidden") return
          pollVoucherStatus(voucher.id)
        }, 2000)

        return () => {
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current)
            pollingIntervalRef.current = null
          }
        }
      }
    }, [voucher, redeemed, pollVoucherStatus])

    // Cleanup on unmount
    useEffect(() => {
      return () => {
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current)
        }
        if (successSoundRef.current) {
          successSoundRef.current.pause()
        }
      }
    }, [])

    // Sync selectedExpiry with initialExpiry prop when it changes (from preferences)
    useEffect(() => {
      setSelectedExpiry(initialExpiry)
    }, [initialExpiry])

    // Handle commission selection and create voucher after state update
    useEffect(() => {
      if (pendingCommissionSelection !== null) {
        const newCommissionPercent = pendingCommissionSelection

        // Trigger transition animation when confirming commission selection
        if (onInternalTransition) onInternalTransition()

        setSelectedCommissionPercent(newCommissionPercent)
        setShowCommissionDialog(false)
        setPendingCommissionSelection(null)

        // Create voucher with the specific commission percentage
        createVoucherWithCommission(newCommissionPercent)
      }
    }, [pendingCommissionSelection])

    // Reset commission option index when dialog opens
    useEffect(() => {
      if (showCommissionDialog) {
        setCommissionOptionIndex(0)
      }
    }, [showCommissionDialog])

    // Calculate commission amount
    const calculateCommissionAmount = (
      baseAmount: number,
      commissionPercent: number,
    ): number => {
      return (commissionPercent / 100) * baseAmount
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
      if (numericLength <= 6) sizeFromNumeric = 7
      else if (numericLength <= 9) sizeFromNumeric = 6
      else if (numericLength <= 11) sizeFromNumeric = 5
      else if (numericLength <= 13) sizeFromNumeric = 4
      else if (numericLength <= 15) sizeFromNumeric = 3
      else if (numericLength <= 16) sizeFromNumeric = 2
      else sizeFromNumeric = 1

      // Calculate size based on total display length (for long currency symbols/names)
      let sizeFromTotal: number
      if (totalLength <= 10) sizeFromTotal = 7
      else if (totalLength <= 14) sizeFromTotal = 6
      else if (totalLength <= 18) sizeFromTotal = 5
      else if (totalLength <= 22) sizeFromTotal = 4
      else if (totalLength <= 26) sizeFromTotal = 3
      else if (totalLength <= 30) sizeFromTotal = 2
      else sizeFromTotal = 1

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

    // Format display amount
    const formatDisplayAmount = (value: string | number, currency: string): string => {
      return formatCurrency(value, currency, currencies, numberFormat, bitcoinFormat)
    }

    // Render amount with properly styled Bitcoin symbol (smaller ₿ for BIP-177)
    const renderStyledAmount = (
      value: string | number,
      currency: string,
      className: string = "",
    ): ReactNode => {
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

    // Fetch exchange rate when currency changes
    useEffect(() => {
      if (!isBitcoinCurrency(displayCurrency)) {
        fetchExchangeRate()
      } else {
        setExchangeRate({ satPriceInCurrency: 1, currency: "BTC" })
      }
    }, [displayCurrency])

    const fetchExchangeRate = async (): Promise<void> => {
      if (isBitcoinCurrency(displayCurrency)) return

      setLoadingRate(true)
      try {
        const response = await fetch("/api/rates/exchange-rate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            currency: displayCurrency,
            useBlinkpos: true, // Use BlinkPOS credentials for exchange rate
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
      } catch (error: unknown) {
        console.error("Exchange rate error:", error)
        const msg = error instanceof Error ? error.message : String(error)
        setError(`Failed to fetch ${displayCurrency} exchange rate: ${msg}`)
      } finally {
        setLoadingRate(false)
      }
    }

    // Play keystroke sound (also unlocks iOS audio on first press)
    const playKeystrokeSound = (): void => {
      if (soundEnabled) {
        // Unlock AudioContext on user gesture for iOS Safari
        unlockAudioContext()
        playSound("/click.mp3", 0.3)
      }
    }

    // Convert display currency amount to satoshis
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

    // Calculate USD equivalent from any fiat/BTC amount (for Dollar Voucher bracket display)
    const getUsdEquivalent = (inputAmount: number): string | null => {
      if (!usdExchangeRate?.satPriceInCurrency) return null
      if (inputAmount <= 0) return null

      // First convert display amount to sats
      let satsAmount: number
      if (isBitcoinCurrency(displayCurrency)) {
        // Input is already in sats
        satsAmount = inputAmount
      } else {
        // Convert fiat to sats using the display currency exchange rate
        if (!exchangeRate?.satPriceInCurrency) return null
        const currency = getCurrencyById(displayCurrency, currencies)
        const fractionDigits = currency?.fractionDigits ?? 2
        const amountInMinorUnits = inputAmount * Math.pow(10, fractionDigits)
        satsAmount = Math.round(amountInMinorUnits / exchangeRate.satPriceInCurrency)
      }

      if (!satsAmount || satsAmount <= 0) return null

      // Then convert sats to USD cents and format
      const usdCents = Math.round(satsAmount * usdExchangeRate.satPriceInCurrency)
      return `$${(usdCents / 100).toFixed(2)}`
    }

    const handleDigitPress = (digit: string): void => {
      playKeystrokeSound()

      const MAX_SATS = 2100000000000000

      if (digit !== ".") {
        const newAmount = amount + digit
        const numericValue = parseFloat(newAmount.replace(/[^0-9.]/g, ""))

        // For BTC currency (sats), validate against max sats
        if (isBitcoinCurrency(displayCurrency) && numericValue > MAX_SATS) {
          return
        }

        // Cap at 16 digits
        const currentNumericDigits = amount.replace(/[^0-9]/g, "").length
        if (currentNumericDigits >= 16) {
          return
        }
      }

      // Special handling for '0' as first digit
      if (amount === "" && digit === "0") {
        if (isBitcoinCurrency(displayCurrency)) {
          setAmount("0")
        } else {
          setAmount("0.")
        }
        return
      }

      // Special handling for '.' as first digit
      if (amount === "" && digit === ".") {
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
        // Don't allow decimal points for zero-decimal currencies
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
          return
        }
        setAmount(amount + digit)
      } else {
        setAmount(amount + digit)
      }
    }

    const handleBackspace = (): void => {
      playKeystrokeSound()
      setAmount(amount.slice(0, -1))
    }

    const handleClear = (): void => {
      playKeystrokeSound()

      if ((voucher || redeemed) && onInternalTransition) {
        onInternalTransition()
      }

      // Stop polling
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }

      setAmount("")
      setVoucher(null)
      setError("")
      setRedeemed(false)
      // Reset commission state
      setSelectedCommissionPercent(0)
      setShowCommissionDialog(false)
      setPendingCommissionSelection(null)
      // Reset expiry to default
      setSelectedExpiry(DEFAULT_EXPIRY)
    }

    const isValidAmount = (): boolean => {
      if (!amount || amount === "" || amount === "0") {
        return false
      }

      const numValue = parseFloat(amount)
      if (isNaN(numValue) || numValue <= 0) {
        return false
      }

      // For BTC (sats), minimum 1 sat
      if (isBitcoinCurrency(displayCurrency)) {
        return numValue >= 1
      }

      // For fiat, check minimum based on fraction digits
      const currency = getCurrentCurrency()
      if (!currency) {
        return numValue > 0
      }

      const minimumAmount =
        (currency.fractionDigits ?? 0) > 0
          ? 1 / Math.pow(10, currency.fractionDigits!)
          : 1

      if (numValue < minimumAmount) {
        return false
      }

      // Also check if it converts to at least 1 satoshi
      if (exchangeRate && exchangeRate.satPriceInCurrency) {
        try {
          const sats = convertToSatoshis(numValue, displayCurrency)
          if (sats < 1) {
            return false
          }
        } catch (_e) {
          return false
        }
      }

      return true
    }

    // Check if current amount exceeds wallet balance
    // In USD mode: walletBalance is in USD cents, compare against USD cents
    // In BTC mode: walletBalance is in sats, compare against sats
    const isBalanceExceeded = useCallback((): boolean => {
      if (walletBalance === null) return false
      if (!amount || amount === "" || amount === "0") return false

      const numericAmount = parseFloat(amount)
      if (isNaN(numericAmount) || numericAmount <= 0) return false

      // First calculate amount in sats (needed for both modes)
      let amountInSats: number
      if (isBitcoinCurrency(displayCurrency)) {
        amountInSats = Math.round(numericAmount)
      } else if (exchangeRate?.satPriceInCurrency) {
        const currency = getCurrencyById(displayCurrency, currencies)
        const fractionDigits = currency?.fractionDigits ?? 2
        const amountInMinorUnits = numericAmount * Math.pow(10, fractionDigits)
        amountInSats = Math.round(amountInMinorUnits / exchangeRate.satPriceInCurrency)
      } else {
        return false // Can't determine, allow creation
      }

      // In USD mode, convert sats to USD cents for comparison
      if (voucherCurrencyMode === "USD") {
        if (!usdExchangeRate?.satPriceInCurrency) return false
        const amountInUsdCents = Math.round(
          amountInSats * usdExchangeRate.satPriceInCurrency,
        )
        return amountInUsdCents > walletBalance
      }

      // In BTC mode, compare sats directly
      return amountInSats > walletBalance
    }, [
      amount,
      walletBalance,
      displayCurrency,
      exchangeRate,
      currencies,
      voucherCurrencyMode,
      usdExchangeRate,
    ])

    const encodeLnurl = (url: string): string => {
      try {
        console.log("🔨 Encoding URL to LNURL:", url)
        const bytes = new TextEncoder().encode(url)
        console.log("📦 Bytes length:", bytes.length)
        const words = bech32.toWords(bytes)
        console.log("📝 Words length:", words.length)
        const encoded = bech32.encode("lnurl", words, 2000)
        console.log("✅ Encoded (lowercase):", encoded)

        // Verify by decoding
        try {
          const decoded = bech32.decode(encoded, 2000)
          const decodedBytes = bech32.fromWords(decoded.words)
          const decodedUrl = new TextDecoder().decode(new Uint8Array(decodedBytes))
          console.log("✓ Verification - Decoded URL:", decodedUrl)
          console.log("✓ URL match:", url === decodedUrl)
        } catch (verifyError) {
          console.error("⚠️ Verification failed:", verifyError)
        }

        return encoded.toUpperCase()
      } catch (error) {
        console.error("Failed to encode LNURL:", error)
        throw error
      }
    }

    // Create voucher with specific commission percentage (bypasses state timing issues)
    const createVoucherWithCommission = async (
      commissionPercent: number,
    ): Promise<void> => {
      return createVoucherInternal(true, commissionPercent)
    }

    const createVoucher = async (): Promise<void> => {
      return createVoucherInternal(false, null)
    }

    // Current amount in sats (for capacity indicator in Dashboard)
    const computeAmountInSats = (): number => {
      if (!amount || amount === "" || amount === "0") return 0
      const numericAmount = parseFloat(amount)
      if (isNaN(numericAmount) || numericAmount <= 0) return 0

      if (isBitcoinCurrency(displayCurrency)) return Math.round(numericAmount)
      if (!exchangeRate?.satPriceInCurrency) return 0

      const currency = getCurrencyById(displayCurrency, currencies)
      const fractionDigits = currency?.fractionDigits ?? 2
      const amountInMinorUnits = numericAmount * Math.pow(10, fractionDigits)
      return Math.round(amountInMinorUnits / exchangeRate.satPriceInCurrency)
    }

    // Current amount in USD cents (for capacity indicator when in USD mode)
    const computeAmountInUsdCents = (): number => {
      const amountInSats = computeAmountInSats()
      if (amountInSats <= 0 || !usdExchangeRate?.satPriceInCurrency) return 0
      return Math.round(amountInSats * usdExchangeRate.satPriceInCurrency)
    }

    // Push amount changes to the parent (capacity indicator) instead of
    // being polled via the imperative handle on a timer.
    useEffect(() => {
      onAmountChange?.(
        computeAmountInSats(),
        computeAmountInUsdCents(),
        voucherCurrencyMode as VoucherCurrencyMode,
      )
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      amount,
      displayCurrency,
      exchangeRate,
      usdExchangeRate,
      currencies,
      voucherCurrencyMode,
      onAmountChange,
    ])

    // Expose numpad handlers for keyboard navigation
    useImperativeHandle(ref, () => ({
      handleDigitPress,
      handleBackspace,
      handleClear,
      handleSubmit: () => createVoucher(),
      hasVoucher: () => !!voucher,
      hasValidAmount: () => isValidAmount(),
      isRedeemed: () => redeemed,
      getAmountInSats: computeAmountInSats,
      getAmountInUsdCents: computeAmountInUsdCents,
      // Get current voucher currency mode
      getVoucherCurrencyMode: () => voucherCurrencyMode as VoucherCurrencyMode,
      // Expiry state for external rendering
      getSelectedExpiry: () => selectedExpiry,
      setSelectedExpiry: (expiryId: string) => setSelectedExpiry(expiryId),
      // Commission dialog keyboard navigation
      isCommissionDialogOpen: () => showCommissionDialog,
      handleCommissionDialogKey: (key: string): boolean => {
        if (!showCommissionDialog) return false

        const presetCount = commissionPresets.length
        const totalOptions = presetCount + 2
        const cancelIndex = presetCount
        const noCommissionIndex = presetCount + 1

        // Build column indices for proper up/down navigation
        // Column 0: even preset indices + Cancel
        // Column 1: odd preset indices + No Commission
        const col0Indices: number[] = []
        const col1Indices: number[] = []
        for (let i = 0; i < presetCount; i++) {
          if (i % 2 === 0) col0Indices.push(i)
          else col1Indices.push(i)
        }
        col0Indices.push(cancelIndex)
        col1Indices.push(noCommissionIndex)

        // Determine which column current index is in
        const getColumn = (idx: number): number => {
          if (col0Indices.includes(idx)) return 0
          return 1
        }

        if (key === "ArrowRight") {
          setCommissionOptionIndex((prev) => (prev + 1) % totalOptions)
          return true
        } else if (key === "ArrowLeft") {
          setCommissionOptionIndex((prev) => (prev - 1 + totalOptions) % totalOptions)
          return true
        } else if (key === "ArrowDown") {
          setCommissionOptionIndex((prev) => {
            const col = getColumn(prev)
            const colIndices = col === 0 ? col0Indices : col1Indices
            const posInCol = colIndices.indexOf(prev)
            if (posInCol < colIndices.length - 1) {
              return colIndices[posInCol + 1]
            }
            return prev // Already at bottom of column
          })
          return true
        } else if (key === "ArrowUp") {
          setCommissionOptionIndex((prev) => {
            const col = getColumn(prev)
            const colIndices = col === 0 ? col0Indices : col1Indices
            const posInCol = colIndices.indexOf(prev)
            if (posInCol > 0) {
              return colIndices[posInCol - 1]
            }
            return prev // Already at top of column
          })
          return true
        } else if (key === "Enter") {
          if (commissionOptionIndex < commissionPresets.length) {
            setPendingCommissionSelection(commissionPresets[commissionOptionIndex])
          } else if (commissionOptionIndex === totalOptions - 2) {
            if (onInternalTransition) onInternalTransition()
            setShowCommissionDialog(false)
          } else if (commissionOptionIndex === totalOptions - 1) {
            setPendingCommissionSelection(0)
          }
          return true
        } else if (key === "Escape") {
          if (onInternalTransition) onInternalTransition()
          setShowCommissionDialog(false)
          return true
        }
        return false
      },
    }))

    const createVoucherInternal = async (
      skipCommissionDialog: boolean | unknown = false,
      forceCommissionPercent: number | null = null,
    ): Promise<void> => {
      // Ensure skipCommissionDialog is a boolean
      const shouldSkipCommissionDialog =
        typeof skipCommissionDialog === "boolean" ? skipCommissionDialog : false

      // Use forced commission percent if provided, otherwise use state
      const effectiveCommissionPercent =
        forceCommissionPercent !== null
          ? forceCommissionPercent
          : selectedCommissionPercent

      if (!isValidAmount()) {
        setError(
          voucherCurrencyMode === "USD"
            ? "Please enter a valid amount (minimum $0.01)"
            : "Please enter a valid amount (minimum 1 sat)",
        )
        return
      }

      // Check if amount exceeds wallet balance
      if (walletBalance !== null && isBalanceExceeded()) {
        setError("Insufficient balance")
        return
      }

      if (!voucherWallet || !voucherWallet.apiKey || !voucherWallet.walletId) {
        setError("Voucher wallet not configured")
        return
      }

      // For USD vouchers, check if USD wallet ID is available
      if (voucherCurrencyMode === "USD" && !usdWalletId) {
        setError("USD wallet not configured. Please set up a USD/Stablesats wallet.")
        return
      }

      // Skip commission entirely when Bitcoin Voucher + Bitcoin display currency
      const shouldSkipCommissionForBtcBtc =
        voucherCurrencyMode === "BTC" && isBitcoinCurrency(displayCurrency)

      // Show commission dialog if commission is enabled and we haven't skipped it
      if (
        commissionEnabled &&
        commissionPresets &&
        commissionPresets.length > 0 &&
        !shouldSkipCommissionDialog &&
        effectiveCommissionPercent === 0 &&
        !shouldSkipCommissionForBtcBtc
      ) {
        if (onInternalTransition) onInternalTransition()
        setShowCommissionDialog(true)
        return
      }

      setLoading(true)
      setError("")

      try {
        const numericAmount = parseFloat(amount)

        // Calculate commission-adjusted amount
        // Commission is deducted from the voucher value
        // E.g., $100 voucher with 2% commission = voucher encodes $98 worth of sats
        const commissionAmount =
          effectiveCommissionPercent > 0
            ? calculateCommissionAmount(numericAmount, effectiveCommissionPercent)
            : 0
        const netAmount = numericAmount - commissionAmount

        // Convert to sats if needed (use netAmount after commission deduction)
        let amountInSats: number
        if (isBitcoinCurrency(displayCurrency)) {
          amountInSats = Math.round(netAmount)
        } else {
          if (!exchangeRate || !exchangeRate.satPriceInCurrency) {
            throw new Error(`Exchange rate not available for ${displayCurrency}`)
          }
          amountInSats = convertToSatoshis(netAmount, displayCurrency)

          if (amountInSats < 1) {
            throw new Error("Amount too small. Converts to less than 1 satoshi.")
          }
        }

        // For USD vouchers, calculate USD cents from sats
        // Display amount → Sats → USD cents (two-step conversion)
        let usdAmountCents: number | null = null
        if (voucherCurrencyMode === "USD") {
          if (!usdExchangeRate || !usdExchangeRate.satPriceInCurrency) {
            throw new Error("USD exchange rate not available. Please try again.")
          }
          // Convert sats to USD cents: sats * (price per sat in USD) * 100
          // satPriceInCurrency is cents per sat, so multiply by sats to get cents
          usdAmountCents = Math.round(amountInSats * usdExchangeRate.satPriceInCurrency)

          if (usdAmountCents < 1) {
            throw new Error("Amount too small. Converts to less than $0.01.")
          }
        }

        console.log("🔨 Creating voucher:", {
          voucherCurrencyMode: voucherCurrencyMode,
          displayAmount: numericAmount,
          displayCurrency: displayCurrency,
          commissionPercent: effectiveCommissionPercent,
          commissionAmount: commissionAmount,
          netAmount: netAmount,
          amountInSats: amountInSats,
          usdAmountCents: usdAmountCents,
          exchangeRate: exchangeRate,
          usdExchangeRate: usdExchangeRate,
          expiryId: selectedExpiry,
        })

        // Create voucher charge
        const response = await fetch("/api/voucher/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amount: amountInSats,
            apiKey: voucherWallet.apiKey,
            walletId:
              voucherCurrencyMode === "USD" ? usdWalletId : voucherWallet.walletId,
            expiryId: selectedExpiry,
            // Include commission info for memo and printout
            commissionPercent: effectiveCommissionPercent,
            displayAmount: numericAmount,
            displayCurrency: displayCurrency,
            // USD voucher support
            walletCurrency: voucherCurrencyMode, // 'BTC' or 'USD'
            usdAmount: usdAmountCents, // USD cents (only for USD vouchers)
            // Environment for staging/production support
            environment: getEnvironment(),
          }),
        })

        const data = await response.json()
        console.log("📦 Voucher creation response:", data)

        if (!response.ok) {
          throw new Error(data.error || `Server error: ${response.status}`)
        }

        if (data.success && data.voucher) {
          // Build LNURL - ALWAYS use sats for the amount since LNURL-withdraw works in millisats
          // Even for USD vouchers, the Lightning payout is based on the sats equivalent
          const protocol = window.location.protocol
          const host = window.location.host
          const lnurlUrl = `${protocol}//${host}/api/voucher/lnurl/${data.voucher.id}/${amountInSats}`

          console.log("🔗 LNURL URL:", lnurlUrl)

          // Encode as bech32 LNURL
          const lnurl = encodeLnurl(lnurlUrl)

          console.log("🔐 Encoded LNURL:", lnurl)

          setVoucher({
            ...data.voucher,
            lnurl: lnurl,
            displayAmount: numericAmount, // Original entered amount (voucher price)
            displayCurrency: displayCurrency,
            commissionPercent: effectiveCommissionPercent,
            commissionAmount: commissionAmount,
            netAmount: netAmount, // Amount after commission deduction
            expiresAt: data.voucher.expiresAt, // Include expiry for PDF
            walletCurrency: voucherCurrencyMode as "BTC" | "USD", // Track whether this is a USD or BTC voucher
            usdAmountCents: usdAmountCents, // USD amount in cents (for USD vouchers)
          })

          console.log("✅ Voucher created:", {
            chargeId: data.voucher.id.substring(0, 8) + "...",
            walletCurrency: voucherCurrencyMode,
            amount: amountInSats,
            usdAmountCents: usdAmountCents,
            displayAmount: numericAmount,
            displayCurrency: displayCurrency,
            commissionPercent: effectiveCommissionPercent,
            lnurlUrl: lnurlUrl,
            lnurl: lnurl.substring(0, 30) + "...",
          })
        } else {
          throw new Error("Invalid response from server")
        }
      } catch (err: unknown) {
        console.error("Voucher creation error:", err)
        const msg = err instanceof Error ? err.message : "Failed to create voucher"
        setError(msg)
      } finally {
        setLoading(false)
      }
    }

    const copyToClipboard = async (text: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text)
      } catch (err) {
        console.error("Failed to copy:", err)
      }
    }

    // Generate QR code as PNG data URL for PDF (PNG is better supported than SVG)
    const getQrDataUrl = (): Promise<string> => {
      return new Promise((resolve, reject) => {
        if (!qrRef.current) {
          reject(new Error("QR ref not found"))
          return
        }

        const svg = qrRef.current.querySelector("svg")
        if (!svg) {
          reject(new Error("SVG element not found"))
          return
        }

        // Clone SVG and set dimensions
        const clonedSvg = svg.cloneNode(true) as SVGElement
        clonedSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg")

        // Get dimensions
        const width = 256
        const height = 256
        clonedSvg.setAttribute("width", String(width))
        clonedSvg.setAttribute("height", String(height))

        // Serialize SVG to string
        const svgData = new XMLSerializer().serializeToString(clonedSvg)
        const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" })
        const svgUrl = URL.createObjectURL(svgBlob)

        // Create image and canvas to convert to PNG
        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement("canvas")
          canvas.width = width
          canvas.height = height
          const ctx = canvas.getContext("2d")!

          // Draw white background
          ctx.fillStyle = "#FFFFFF"
          ctx.fillRect(0, 0, width, height)

          // Draw SVG
          ctx.drawImage(img, 0, 0, width, height)

          // Get PNG data URL
          const pngDataUrl = canvas.toDataURL("image/png")
          URL.revokeObjectURL(svgUrl)

          console.log("✅ QR code converted to PNG, length:", pngDataUrl.length)
          resolve(pngDataUrl)
        }

        img.onerror = (_err: string | Event) => {
          URL.revokeObjectURL(svgUrl)
          reject(new Error("Failed to load SVG image"))
        }

        img.src = svgUrl
      })
    }

    // Convert Blink logo SVG to PNG data URL (using black version for print)
    const getLogoDataUrl = (): Promise<string | null> => {
      return new Promise((resolve) => {
        const img = new Image()
        img.crossOrigin = "anonymous"
        img.onload = () => {
          // Use wider canvas for the full "blink" logo with text
          const canvas = document.createElement("canvas")
          canvas.width = 300
          canvas.height = 125
          const ctx = canvas.getContext("2d")!
          // White background for print
          ctx.fillStyle = "#FFFFFF"
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          ctx.drawImage(img, 0, 0, 300, 125)
          resolve(canvas.toDataURL("image/png"))
        }
        img.onerror = () => {
          console.warn("Could not load logo")
          resolve(null)
        }
        img.src = "/blink-logo-black.svg"
      })
    }

    // Generate a formatted voucher secret from the charge ID
    const generateVoucherSecret = (chargeId: string): string | null => {
      if (!chargeId) return null
      // Take first 12 characters and format as "xxxx xxxx xxxx"
      const cleaned = chargeId.replace(/-/g, "").substring(0, 12)
      return cleaned
    }

    // Generate and download PDF
    const generatePdf = async (): Promise<void> => {
      if (!voucher) return

      setGeneratingPdf(true)
      setError("")

      try {
        console.log("📄 Starting PDF generation...")

        // Get QR code and logo as PNG data URLs
        const [qrDataUrl, logoDataUrl] = await Promise.all([
          getQrDataUrl(),
          getLogoDataUrl(),
        ])

        if (!qrDataUrl) {
          throw new Error("Could not capture QR code")
        }

        console.log("📷 QR captured, logo:", logoDataUrl ? "yes" : "no")

        // Build fiat amount string (show for fiat currencies, not for BTC/BTC-BIP177)
        let fiatAmount: string | null = null
        if (voucher.displayCurrency && !isBitcoinCurrency(voucher.displayCurrency)) {
          fiatAmount = formatDisplayAmount(voucher.displayAmount, voucher.displayCurrency)
        }

        // Generate voucher secret for display
        const voucherSecret = generateVoucherSecret(voucher.id)

        // Call PDF generation API
        const response = await fetch("/api/voucher/pdf", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            vouchers: [
              {
                satsAmount: voucher.amount,
                fiatAmount: fiatAmount,
                qrDataUrl: qrDataUrl,
                logoDataUrl: logoDataUrl,
                identifierCode: voucher.id?.substring(0, 8)?.toUpperCase() || null,
                voucherSecret: voucherSecret,
                commissionPercent: voucher.commissionPercent || 0,
                expiresAt: voucher.expiresAt || null,
                issuedBy: voucherWallet?.username || null,
                walletCurrency: voucher.walletCurrency || "BTC",
                usdAmountCents: voucher.usdAmountCents || null,
              },
            ],
            format: printFormat,
          }),
        })

        const data = await response.json()
        console.log("📦 API response:", {
          success: data.success,
          error: data.error,
          pdfLength: data.pdf?.length,
        })

        if (!response.ok || !data.success) {
          throw new Error(data.error || data.message || "Failed to generate PDF")
        }

        // Convert base64 to blob and download
        const byteCharacters = atob(data.pdf)
        const byteNumbers = new Array(byteCharacters.length)
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i)
        }
        const byteArray = new Uint8Array(byteNumbers)
        const blob = new Blob([byteArray], { type: "application/pdf" })

        // Create download link
        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")
        link.href = url
        link.download = `blink-voucher-${voucher.amount}sats.pdf`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)

        setShowPrintModal(false)
        console.log("✅ PDF downloaded successfully")
      } catch (err: unknown) {
        console.error("PDF generation error:", err)
        const msg = err instanceof Error ? err.message : "Failed to generate PDF"
        setError(msg)
      } finally {
        setGeneratingPdf(false)
      }
    }

    // Print voucher using ESC/POS thermal printing system
    const printVoucher = async (): Promise<void> => {
      if (!voucher) return

      setPrinting(true)
      setError("")

      try {
        // Build voucher data for thermal print
        const voucherData: Record<string, unknown> = {
          lnurl: voucher.lnurl,
          satsAmount: voucher.amount,
          displayAmount: voucher.displayAmount,
          displayCurrency: voucher.displayCurrency,
          voucherSecret: voucher.id?.replace(/-/g, "").substring(0, 12) || "",
          identifierCode: voucher.id?.substring(0, 8)?.toUpperCase() || "",
          commissionPercent: voucher.commissionPercent || 0,
          expiresAt: voucher.expiresAt || null,
          issuedBy: voucherWallet?.username || null,
          walletCurrency: voucher.walletCurrency || "BTC",
          usdAmountCents: voucher.usdAmountCents || null,
        }

        // Determine paper width from format
        const paperWidth = printFormat === "thermal-58" ? 58 : 80

        console.log("🖨️ Printing via thermal system:", {
          method: activePrintMethod,
          paperWidth,
        })

        // Use thermal print system
        const result = await thermalPrint(voucherData, {
          paperWidth,
          autoCut: false,
          useNativeQR: true,
        })

        if (result.success) {
          console.log("✅ Thermal print successful:", result)
          setShowPrintModal(false)
        } else {
          console.error("❌ Thermal print failed:", result.error)
          setError(result.error || "Print failed")
        }
      } catch (err: unknown) {
        console.error("Print error:", err)
        const msg = err instanceof Error ? err.message : "Failed to print"
        setError(msg)
      } finally {
        setPrinting(false)
      }
    }

    // Legacy companion app print (fallback if needed)
    const _printVoucherLegacy = (): void => {
      if (!voucher) return

      // Build the display amounts (show for fiat currencies, not for BTC/BTC-BIP177)
      let voucherPrice = ""
      if (voucher.displayCurrency && !isBitcoinCurrency(voucher.displayCurrency)) {
        voucherPrice = formatDisplayAmount(voucher.displayAmount, voucher.displayCurrency)
      }

      const voucherAmount = `${voucher.amount} sats`
      const voucherSecret = voucher.id?.replace(/-/g, "").substring(0, 12) || ""
      const identifierCode = voucher.id?.substring(0, 8)?.toUpperCase() || ""
      const commissionPercent = voucher.commissionPercent || 0
      const expiresAt = voucher.expiresAt || ""
      const issuedBy = voucherWallet?.username || ""

      // Build companion app deep link URL (same format as Blink voucher app)
      let deepLinkUrl = `blink-pos-companion://print?app=voucher&lnurl=${encodeURIComponent(voucher.lnurl)}&voucherPrice=${encodeURIComponent(voucherPrice)}&voucherAmount=${encodeURIComponent(voucherAmount)}&voucherSecret=${encodeURIComponent(voucherSecret)}&commissionPercentage=${encodeURIComponent(commissionPercent)}&identifierCode=${encodeURIComponent(identifierCode)}`

      // Add optional fields
      if (expiresAt) {
        deepLinkUrl += `&expiresAt=${encodeURIComponent(expiresAt)}`
      }
      if (issuedBy) {
        deepLinkUrl += `&issuedBy=${encodeURIComponent(issuedBy)}`
      }

      console.log("🖨️ Printing via legacy companion app:", deepLinkUrl)

      // Use window.location.href to trigger the deep link (same as Blink voucher app)
      window.location.href = deepLinkUrl

      setShowPrintModal(false)
    }

    // Browser print fallback (for desktop or when companion app is not available)
    const browserPrint = async (): Promise<void> => {
      if (!voucher) return

      setPrinting(true)
      setError("")

      try {
        // Build the display amounts (show for fiat currencies, not for BTC/BTC-BIP177)
        let voucherPrice = ""
        if (voucher.displayCurrency && !isBitcoinCurrency(voucher.displayCurrency)) {
          voucherPrice = formatDisplayAmount(
            voucher.displayAmount,
            voucher.displayCurrency,
          )
        }

        const voucherAmount = `${voucher.amount} sats`
        const voucherSecret = voucher.id?.replace(/-/g, "").substring(0, 12) || ""
        const identifierCode = voucher.id?.substring(0, 8)?.toUpperCase() || ""
        const commissionPercent = voucher.commissionPercent || 0
        const qrDataUrl = await getQrDataUrl()

        // Create a printable iframe (better than popup for some browsers)
        const printFrame = document.createElement("iframe")
        printFrame.style.position = "fixed"
        printFrame.style.top = "-10000px"
        printFrame.style.left = "-10000px"
        printFrame.style.width = "0"
        printFrame.style.height = "0"
        document.body.appendChild(printFrame)

        const printDoc = (printFrame.contentDocument ||
          printFrame.contentWindow?.document)!
        printDoc.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Blink Voucher</title>
          <style>
            body { 
              font-family: Helvetica, Arial, sans-serif; 
              padding: 20px; 
              max-width: 300px; 
              margin: 0 auto;
              text-align: center;
            }
            .logo { max-width: 150px; margin-bottom: 15px; }
            .info { text-align: left; margin: 10px 0; font-size: 14px; }
            .info-row { display: flex; margin: 5px 0; }
            .info-label { width: 80px; }
            .info-value { font-weight: bold; }
            .qr { margin: 15px 0; }
            .qr img { max-width: 200px; }
            .dashed { border-top: 1px dashed #666; margin: 10px 0; }
            .secret { margin: 10px 0; padding: 10px; border-top: 1px dashed #666; border-bottom: 1px dashed #666; }
            .secret-label { font-size: 12px; color: #666; }
            .secret-code { font-size: 16px; font-weight: bold; letter-spacing: 2px; }
            .footer { margin-top: 15px; font-size: 12px; }
          </style>
        </head>
        <body>
          <img src="/blink-logo-black.svg" alt="Blink" class="logo">
          <div class="info">
            ${voucherPrice ? `<div class="info-row"><span class="info-label">Price:</span><span class="info-value">${voucherPrice}</span></div>` : ""}
            <div class="info-row"><span class="info-label">Value:</span><span class="info-value">${voucherAmount}</span></div>
            <div class="info-row"><span class="info-label">Identifier:</span><span class="info-value">${identifierCode}</span></div>
            ${commissionPercent > 0 ? `<div class="info-row"><span class="info-label">Commission:</span><span class="info-value">${commissionPercent}%</span></div>` : ""}
          </div>
          <div class="dashed"></div>
          <div class="qr">
            ${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR Code">` : "<p>QR Code</p>"}
          </div>
          <div class="secret">
            <div class="secret-label">voucher secret</div>
            <div class="secret-code">${voucherSecret.match(/.{1,4}/g)?.join(" ") || voucherSecret}</div>
          </div>
          <div class="footer">blink.sv</div>
        </body>
        </html>
      `)
        printDoc.close()

        // Wait for content to load then print
        setTimeout(() => {
          printFrame.contentWindow?.print()
          // Clean up after print dialog closes
          setTimeout(() => {
            document.body.removeChild(printFrame)
          }, 1000)
        }, 250)

        setShowPrintModal(false)
      } catch (err: unknown) {
        console.error("Print error:", err)
        const msg = err instanceof Error ? err.message : "Failed to print"
        setError(msg)
      } finally {
        setPrinting(false)
      }
    }

    if (loading) {
      return (
        <div
          className="h-full flex flex-col bg-white dark:bg-black"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          {/* Error Message Space */}
          <div className="mx-3 mt-1 min-h-[44px]"></div>

          {/* Amount Display */}
          <div className="px-4 pt-2 pb-2">
            <div className="text-center mb-4">
              <div className="text-6xl font-semibold text-purple-600 dark:text-purple-400 mb-1 min-h-[96px] flex items-center justify-center leading-none tracking-normal">
                {amount
                  ? formatDisplayAmount(amount, displayCurrency)
                  : formatDisplayAmount(0, displayCurrency)}
              </div>
            </div>
          </div>

          {/* Loading Animation */}
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center bg-gray-50 dark:bg-blink-dark rounded-lg p-8 shadow-lg">
              <div className="animate-spin rounded-full h-16 w-16 border-4 border-purple-500 border-t-transparent mb-4"></div>
              <div className="text-xl font-semibold text-gray-800 dark:text-gray-100">
                Creating Voucher...
              </div>
            </div>
          </div>
        </div>
      )
    }

    // Success screen when voucher is redeemed - Full screen overlay
    if (redeemed && voucher) {
      return (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-purple-600 dark:bg-purple-800 transition-colors duration-500"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          {/* Success Animation - Full screen purple */}
          <div className="flex-1 flex flex-col items-center justify-center">
            {/* Animated Checkmark */}
            <div className="relative mb-8">
              <div className="w-32 h-32 rounded-full bg-white dark:bg-white flex items-center justify-center shadow-2xl animate-pulse">
                <svg
                  className="w-20 h-20 text-purple-600 dark:text-purple-700"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="3"
                    d="M5 13l4 4L19 7"
                    className="animate-[draw_0.5s_ease-out_forwards]"
                    style={{
                      strokeDasharray: 24,
                      strokeDashoffset: 0,
                    }}
                  />
                </svg>
              </div>
              {/* Animated rings */}
              <div className="absolute inset-0 w-32 h-32 rounded-full border-4 border-white opacity-50 animate-ping"></div>
            </div>

            {/* Success Text */}
            <div className="text-center text-white">
              <h2 className="text-3xl font-bold mb-2">Voucher Redeemed!</h2>
              <div className="text-2xl font-semibold mb-1">
                {voucher.displayCurrency &&
                !isBitcoinCurrency(voucher.displayCurrency) ? (
                  <div>
                    <div>
                      {formatDisplayAmount(
                        voucher.displayAmount,
                        voucher.displayCurrency,
                      )}
                    </div>
                    <div className="text-lg opacity-80 mt-1">({voucher.amount} sats)</div>
                  </div>
                ) : (
                  <div>
                    {formatDisplayAmount(
                      voucher.amount,
                      voucher.displayCurrency || "BTC",
                    )}
                  </div>
                )}
              </div>
              <p className="text-lg opacity-80 mt-4">Successfully sent to wallet</p>
            </div>
          </div>

          {/* Done Button */}
          <div className="px-6 pb-10 pt-6">
            <button
              onClick={handleClear}
              className="w-full h-14 bg-white dark:bg-white hover:bg-gray-100 dark:hover:bg-gray-100 text-purple-600 dark:text-purple-700 rounded-lg text-xl font-semibold transition-colors shadow-lg"
              style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
            >
              Done
            </button>
          </div>
        </div>
      )
    }

    if (voucher) {
      return (
        <>
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

                  {/* Print Icon - Center */}
                  <div className="absolute left-1/2 transform -translate-x-1/2">
                    <button
                      onClick={() => setShowPrintModal(true)}
                      className="flex items-center justify-center transition-all hover:scale-110"
                      aria-label="Print voucher"
                      title="Print voucher"
                    >
                      <svg
                        className="h-10 w-10 text-purple-600 dark:text-purple-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                        />
                      </svg>
                    </button>
                  </div>

                  {/* Spacer for layout balance */}
                  <div className="w-12"></div>
                </div>
              </div>
            </div>

            {/* Voucher Display */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Amount - Fixed at top position, matching numpad screen styling */}
              <div className="px-4 pt-4 pb-2 flex-shrink-0">
                <div className="text-center">
                  <div
                    className={`font-inter-tight font-semibold text-gray-800 dark:text-gray-100 min-h-[72px] flex items-center justify-center leading-none tracking-normal max-w-full overflow-hidden px-2 ${getDynamicFontSize(
                      formatDisplayAmount(
                        voucher.displayAmount || voucher.amount,
                        voucher.displayCurrency || "BTC",
                      ),
                    )}`}
                    style={{ wordBreak: "keep-all", overflowWrap: "normal" }}
                  >
                    <div className="max-w-full">
                      {renderStyledAmount(
                        voucher.displayAmount || voucher.amount,
                        voucher.displayCurrency || "BTC",
                      )}
                    </div>
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-400">
                    <div className="mb-1 min-h-[20px] max-w-full overflow-x-auto px-2">
                      {(() => {
                        // Dollar Voucher: show USD equivalent
                        if (voucher.walletCurrency === "USD" && voucher.usdAmountCents) {
                          return `($${(voucher.usdAmountCents / 100).toFixed(2)} USD)`
                        }
                        // Bitcoin Voucher with BTC display: no brackets
                        if (isBitcoinCurrency(voucher.displayCurrency)) {
                          return null
                        }
                        // Bitcoin Voucher with fiat display: show sats
                        return `(${voucher.amount} sats)`
                      })()}
                    </div>
                  </div>
                </div>
              </div>

              {/* QR Code and LNURL - Centered */}
              <div className="flex-1 flex flex-col items-center justify-center space-y-4 px-6">
                {/* QR Code */}
                <div
                  ref={qrRef}
                  className="bg-white dark:bg-white p-4 rounded-lg shadow-lg border-2 border-gray-200 dark:border-gray-600"
                >
                  <QRCode
                    value={voucher.lnurl}
                    size={256}
                    bgColor="#ffffff"
                    fgColor="#000000"
                  />
                </div>

                {/* LNURL */}
                <div className="w-full max-w-md">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    LNURL-withdraw
                  </label>
                  <div className="flex">
                    <input
                      type="text"
                      value={voucher.lnurl}
                      readOnly
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-l-md bg-gray-50 dark:bg-blink-dark text-sm font-mono text-black dark:text-gray-100"
                    />
                    <button
                      onClick={() => copyToClipboard(voucher.lnurl)}
                      className="px-4 py-2 bg-purple-500 dark:bg-purple-600 text-white rounded-r-md hover:bg-purple-600 dark:hover:bg-purple-700 transition-colors"
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

              {/* Close Button - Bottom */}
              <div className="px-4 pb-4 pt-4 flex-shrink-0">
                <button
                  onClick={handleClear}
                  className="w-full h-12 bg-white dark:bg-black border-2 border-purple-500 dark:border-purple-400 hover:border-purple-600 dark:hover:border-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/30 text-purple-600 dark:text-purple-400 rounded-lg text-lg font-normal transition-colors shadow-md"
                  style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>

          {/* Print Modal - Outside main container */}
          {showPrintModal && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
              <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-sm w-full p-6 max-h-[90vh] overflow-y-auto">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  Print Voucher
                </h3>

                {/* Print Method Selection (for thermal formats) */}
                {(printFormat === "thermal-80" || printFormat === "thermal-58") && (
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Print Method
                    </label>
                    <div className="space-y-2">
                      {printMethods
                        .filter((m) => m.available && m.type !== "pdf")
                        .map((method) => (
                          <button
                            key={method.type}
                            onClick={() => setActivePrintMethod(method.type)}
                            className={`w-full p-3 rounded-lg border-2 transition-colors text-left ${
                              activePrintMethod === method.type
                                ? "border-purple-500 bg-purple-50 dark:bg-purple-900/30"
                                : "border-gray-300 dark:border-gray-600 hover:border-gray-400"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <div
                                  className={`font-medium ${activePrintMethod === method.type ? "text-purple-700 dark:text-purple-300" : "text-gray-700 dark:text-gray-300"}`}
                                >
                                  {method.name}
                                </div>
                                <div className="text-xs opacity-70 text-gray-600 dark:text-gray-400">
                                  {method.type === "localprint" &&
                                    "Local printer via print server"}
                                  {method.type === "companion" &&
                                    "Bluetooth via mobile app"}
                                  {method.type === "webserial" && "Direct USB connection"}
                                  {method.type === "websocket" && "Network printer"}
                                </div>
                              </div>
                              {method.recommended && (
                                <span className="text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-2 py-1 rounded">
                                  Recommended
                                </span>
                              )}
                            </div>
                          </button>
                        ))}
                    </div>
                    {printRecommendations?.tips?.length &&
                      printRecommendations.tips.length > 0 && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                          {printRecommendations.tips[0]}
                        </p>
                      )}

                    {/* Companion App Download Link */}
                    {activePrintMethod === "companion" && (
                      <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg">
                        <p className="text-sm text-blue-800 dark:text-blue-200 font-medium mb-1">
                          Need the companion app?
                        </p>
                        <p className="text-xs text-blue-600 dark:text-blue-300 mb-2">
                          Works with Bitcoinize POS and Bluetooth thermal printers (Netum,
                          PT-230, MP583, etc.)
                        </p>
                        <a
                          href="https://github.com/pretyflaco/pos-print-companion/releases/latest"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                          </svg>
                          Download APK
                        </a>
                      </div>
                    )}
                  </div>
                )}

                {/* Format Selection */}
                <div className="mb-6">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                    Paper Format
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setPrintFormat("a4")}
                      className={`p-3 rounded-lg border-2 transition-colors ${
                        printFormat === "a4"
                          ? "border-purple-500 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300"
                          : "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-gray-400"
                      }`}
                    >
                      <div className="font-medium">A4</div>
                      <div className="text-xs opacity-70">210×297mm</div>
                    </button>
                    <button
                      onClick={() => setPrintFormat("letter")}
                      className={`p-3 rounded-lg border-2 transition-colors ${
                        printFormat === "letter"
                          ? "border-purple-500 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300"
                          : "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-gray-400"
                      }`}
                    >
                      <div className="font-medium">Letter</div>
                      <div className="text-xs opacity-70">8.5×11 in</div>
                    </button>
                    <button
                      onClick={() => setPrintFormat("thermal-80")}
                      className={`p-3 rounded-lg border-2 transition-colors ${
                        printFormat === "thermal-80"
                          ? "border-purple-500 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300"
                          : "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-gray-400"
                      }`}
                    >
                      <div className="font-medium">Thermal 80mm</div>
                      <div className="text-xs opacity-70">Receipt printer</div>
                    </button>
                    <button
                      onClick={() => setPrintFormat("thermal-58")}
                      className={`p-3 rounded-lg border-2 transition-colors ${
                        printFormat === "thermal-58"
                          ? "border-purple-500 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300"
                          : "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-gray-400"
                      }`}
                    >
                      <div className="font-medium">Thermal 58mm</div>
                      <div className="text-xs opacity-70">Mini printer</div>
                    </button>
                  </div>
                </div>

                {/* Error Display */}
                {(error || thermalPrintError) && (
                  <div className="mb-4 p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg">
                    <p className="text-sm text-red-700 dark:text-red-300">
                      {error || thermalPrintError}
                    </p>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex flex-col gap-3">
                  {/* Thermal Print Button - For thermal formats */}
                  {(printFormat === "thermal-80" || printFormat === "thermal-58") && (
                    <button
                      onClick={printVoucher}
                      disabled={printing || isThermalPrinting}
                      className="w-full px-4 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {printing || isThermalPrinting ? (
                        <>
                          <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full"></div>
                          Printing...
                        </>
                      ) : (
                        <>
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="2"
                              d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                            />
                          </svg>
                          Print Thermal
                        </>
                      )}
                    </button>
                  )}

                  {/* Download PDF Button */}
                  <button
                    onClick={generatePdf}
                    disabled={generatingPdf}
                    className={`w-full px-4 py-3 border-2 border-purple-600 text-purple-600 dark:text-purple-400 dark:border-purple-400 rounded-lg hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
                      printFormat === "a4" || printFormat === "letter"
                        ? "bg-purple-600 text-white hover:bg-purple-700 border-purple-600"
                        : ""
                    }`}
                  >
                    {generatingPdf ? (
                      <>
                        <div className="animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full"></div>
                        Generating...
                      </>
                    ) : (
                      <>
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                        Download PDF
                      </>
                    )}
                  </button>

                  {/* Browser Print Button - Fallback for desktop */}
                  <button
                    onClick={browserPrint}
                    disabled={printing}
                    className="w-full px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {printing ? (
                      <>
                        <div className="animate-spin w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full"></div>
                        Preparing...
                      </>
                    ) : (
                      <>
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
                            d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                          />
                        </svg>
                        Browser Print
                      </>
                    )}
                  </button>

                  {/* Cancel Button */}
                  <button
                    onClick={() => setShowPrintModal(false)}
                    className="w-full px-4 py-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )
    }

    return (
      <div
        className="h-full flex flex-col bg-white dark:bg-black relative"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {/* Compact Amount Display - Match POS spacing */}
        <div className="px-4">
          <div className="text-center">
            <div className="text-center">
              <div
                className={`font-inter-tight font-semibold text-gray-800 dark:text-gray-100 min-h-[72px] flex items-center justify-center leading-none tracking-normal max-w-full overflow-hidden px-2 ${getDynamicFontSize(
                  formatDisplayAmount(amount || 0, displayCurrency),
                )}`}
                style={{ wordBreak: "keep-all", overflowWrap: "normal" }}
              >
                <div className="max-w-full">
                  {amount === "0" || amount === "0."
                    ? isBitcoinCurrency(displayCurrency) ||
                      getCurrencyById(displayCurrency, currencies)?.fractionDigits === 0
                      ? "0"
                      : getCurrencyById(displayCurrency, currencies)?.symbol + "0."
                    : renderStyledAmount(amount || 0, displayCurrency)}
                </div>
              </div>
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              <div className="mb-1 min-h-[20px] max-w-full overflow-x-auto px-2">
                {(() => {
                  // Dollar Voucher: always show USD equivalent
                  if (voucherCurrencyMode === "USD") {
                    const usdEquiv = getUsdEquivalent(parseFloat(amount) || 0)
                    return usdEquiv ? `(${usdEquiv} USD)` : null
                  }
                  // Bitcoin Voucher with BTC display: no brackets (same currency)
                  if (isBitcoinCurrency(displayCurrency)) {
                    return null
                  }
                  // Bitcoin Voucher with fiat display: show sats equivalent
                  return `(${getSatsEquivalent(parseFloat(amount) || 0)} sats)`
                })()}
              </div>
            </div>
            {/* Always reserve space for balance warning to prevent numpad layout shift */}
            <div className="min-h-[20px]">
              {isBalanceExceeded() && walletBalance !== null && (
                <div className="text-xs text-red-500 dark:text-red-400 font-medium">
                  Exceeds wallet balance
                </div>
              )}
            </div>
            {error && (
              <div className="mt-2 bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-200 px-3 py-2 rounded text-sm animate-pulse">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Numpad - Match POS layout exactly */}
        <div className="flex-1 px-4 pb-4 relative">
          {/* Spacer for consistent layout */}
          <div className="h-16 mb-2"></div>
          <Numpad
            theme={theme}
            layout={numpadLayout}
            onDigitPress={handleDigitPress}
            onClear={handleClear}
            onBackspace={handleBackspace}
            onOkPress={createVoucher}
            okDisabled={!isValidAmount() || loading || isBalanceExceeded()}
            okLabel="OK"
            decimalDisabled={
              isBitcoinCurrency(displayCurrency) ||
              getCurrencyById(displayCurrency, currencies)?.fractionDigits === 0
            }
            plusDisabled={true}
            accentColor="purple"
            showPlus={false}
            showCurrencyToggle={!!onVoucherCurrencyToggle}
            voucherCurrencyMode={voucherCurrencyMode}
            onCurrencyToggle={onVoucherCurrencyToggle}
          />
        </div>

        {/* Commission Selection Overlay (over numpad) */}
        {showCommissionDialog &&
          (() => {
            const totalOptions = commissionPresets.length + 2
            const cancelIndex = totalOptions - 2
            const noCommissionIndex = totalOptions - 1

            return (
              <div
                className={`absolute inset-0 ${getCommissionDialogBgClasses()} z-30 pt-24`}
              >
                <div
                  className="grid grid-cols-4 gap-3 max-w-sm md:max-w-md mx-auto"
                  style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
                >
                  <h3
                    className={`col-span-4 text-xl md:text-2xl font-bold mb-2 text-center ${getCommissionDialogTextClasses()}`}
                  >
                    Commission Options
                  </h3>

                  {/* Commission preset buttons in grid - render all presets */}
                  {commissionPresets.map((percent, index) => (
                    <button
                      key={percent}
                      onClick={() => {
                        setPendingCommissionSelection(percent)
                      }}
                      className={`col-span-2 h-16 md:h-20 ${isBlinkClassic ? "rounded-xl" : "rounded-lg"} text-lg md:text-xl font-normal transition-colors ${isBlinkClassic ? "" : "shadow-md"} ${getCommissionButtonClasses(commissionOptionIndex === index)}`}
                    >
                      {percent}%
                      <div
                        className={`text-sm md:text-base ${isBlinkClassic ? "opacity-70" : ""}`}
                      >
                        -
                        {formatDisplayAmount(
                          calculateCommissionAmount(parseFloat(amount) || 0, percent),
                          displayCurrency,
                        )}
                      </div>
                    </button>
                  ))}

                  {/* Empty placeholder after odd number of presets to complete the row */}
                  {commissionPresets.length % 2 === 1 && (
                    <div className="col-span-2"></div>
                  )}

                  {/* Cancel and No Commission buttons - always on the same row */}
                  <button
                    onClick={() => {
                      if (onInternalTransition) onInternalTransition()
                      setShowCommissionDialog(false)
                    }}
                    className={`col-span-2 h-16 md:h-20 ${isBlinkClassic ? "rounded-xl" : "rounded-lg"} text-lg md:text-xl font-normal transition-colors ${isBlinkClassic ? "" : "shadow-md"} ${getCancelButtonClasses(commissionOptionIndex === cancelIndex)}`}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      setPendingCommissionSelection(0)
                    }}
                    className={`col-span-2 h-16 md:h-20 ${isBlinkClassic ? "rounded-xl" : "rounded-lg"} text-lg md:text-xl font-normal transition-colors ${isBlinkClassic ? "" : "shadow-md"} ${getNoCommissionButtonClasses(commissionOptionIndex === noCommissionIndex)}`}
                  >
                    No Commission
                  </button>
                </div>
              </div>
            )
          })()}
      </div>
    )
  },
)

Voucher.displayName = "Voucher"
export default Voucher
