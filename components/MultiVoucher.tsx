import { bech32 } from "bech32"
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
  ReactElement,
} from "react"
import QRCode from "react-qr-code"

import { unlockAudioContext, playSound } from "../lib/audio-utils"
import { getEnvironment } from "../lib/config/api"
import {
  formatDisplayAmount as formatCurrency,
  getCurrencyById,
  isBitcoinCurrency,
  parseAmountParts,
  CurrencyMetadata,
} from "../lib/currency-utils"
import type { ExchangeRateData } from "../lib/hooks/useExchangeRate"
import type { Theme } from "../lib/hooks/useTheme"
import {
  formatNumber,
  NumberFormatPreference,
  BitcoinFormatPreference,
  NumpadLayoutPreference,
} from "../lib/number-format"

import { DEFAULT_EXPIRY, getExpiryOption } from "./ExpirySelector"
import Numpad from "./Numpad"

// =============================================================================
// Types & Interfaces
// =============================================================================

/** Grid layout configuration option */
interface GridOption {
  id: string
  label: string
  perPage: number
  description: string
}

/** Voucher wallet configuration */
interface VoucherWallet {
  apiKey?: string
  walletId?: string
  username?: string
  [key: string]: unknown
}

/** Generated voucher data returned from the API */
interface GeneratedVoucher {
  id: string
  amount: number
  lnurl: string
  displayAmount: number
  displayCurrency: string
  commissionPercent: number
  commissionAmount: number
  netAmount: number
  expiresAt?: number | string | null
  walletCurrency: string
  usdAmountCents: number | null
  index: number
}

/** Data sent to the PDF API for each voucher */
interface VoucherPdfData {
  satsAmount: number
  fiatAmount: string | null
  qrDataUrl: string | null
  logoDataUrl: string | null
  identifierCode: string | null
  voucherSecret: string | null
  commissionPercent: number
  expiresAt: number | string | null
  issuedBy: string | null
  walletCurrency: string
  usdAmountCents: number | null
}

/** Voucher API create response */
interface VoucherCreateResponse {
  success: boolean
  voucher?: {
    id: string
    amount: number
    expiresAt?: number | string | null
    [key: string]: unknown
  }
  error?: string
}

/** Exchange rate API response */
interface ExchangeRateResponse {
  success: boolean
  satPriceInCurrency?: number
  currency?: string
  error?: string
}

/** PDF API response */
interface PdfApiResponse {
  success: boolean
  pdf?: string
  error?: string
  message?: string
}

/** Voucher currency mode */
type VoucherCurrencyMode = "BTC" | "USD"

/** Props for the MultiVoucher component */
interface MultiVoucherProps {
  voucherWallet: VoucherWallet | null
  walletBalance?: number | null
  displayCurrency: string
  numberFormat?: NumberFormatPreference
  bitcoinFormat?: BitcoinFormatPreference
  numpadLayout?: NumpadLayoutPreference
  currencies: CurrencyMetadata[]
  darkMode: boolean
  theme: Theme
  cycleTheme: () => void
  soundEnabled: boolean
  onInternalTransition?: () => void
  commissionEnabled: boolean
  commissionPresets?: number[]
  voucherCurrencyMode?: VoucherCurrencyMode
  onVoucherCurrencyToggle?: () => void
  usdExchangeRate?: ExchangeRateData | null
  usdWalletId?: string | null
  initialExpiry?: string
  /**
   * Push notification of the current total amount (sats + USD cents, amount
   * x quantity) and currency mode. Replaces the Dashboard's former 300ms
   * polling of the imperative getters for the capacity indicator.
   */
  onAmountChange?: (
    amountInSats: number,
    amountInUsdCents: number,
    currencyMode: VoucherCurrencyMode,
  ) => void
}

/** Step names for the wizard flow */
type StepName = "amount" | "config" | "generating" | "preview"

/** Methods exposed via ref (imperative handle) */
export interface MultiVoucherHandle {
  handleDigitPress: (digit: string) => void
  handleBackspace: () => void
  handleClear: () => void
  handleSubmit: () => void
  hasValidAmount: () => boolean
  getCurrentStep: () => StepName
  getAmountInSats: () => number
  getAmountInUsdCents: () => number
  getVoucherCurrencyMode: () => string
  getSelectedExpiry: () => string
  setSelectedExpiry: (expiryId: string) => void
  isCommissionDialogOpen: () => boolean
  handleCommissionDialogKey: (key: string) => boolean
}

// =============================================================================
// Constants
// =============================================================================

// Grid configuration options
const GRID_OPTIONS: GridOption[] = [
  { id: "2x2", label: "2x2", perPage: 4, description: "4 per page" },
  { id: "2x3", label: "2x3", perPage: 6, description: "6 per page" },
  { id: "3x3", label: "3x3", perPage: 9, description: "9 per page" },
  { id: "3x4", label: "3x4", perPage: 12, description: "12 per page" },
]

// =============================================================================
// Component
// =============================================================================

const MultiVoucher = forwardRef<MultiVoucherHandle, MultiVoucherProps>(
  (
    {
      voucherWallet,
      walletBalance = null,
      displayCurrency,
      numberFormat = "auto",
      bitcoinFormat = "sats",
      numpadLayout = "calculator",
      currencies,
      darkMode: _darkMode,
      theme,
      cycleTheme: _cycleTheme,
      soundEnabled,
      onInternalTransition,
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
    // Amount input state
    const [amount, setAmount] = useState<string>("")
    const [exchangeRate, setExchangeRate] = useState<ExchangeRateData | null>(null)
    const [_loadingRate, setLoadingRate] = useState<boolean>(false)
    const [error, setError] = useState<string>("")

    // Multi-voucher configuration
    const [quantity, setQuantity] = useState<number>(4)
    const [gridSize, setGridSize] = useState<string>("2x2")
    const [selectedCommissionPercent, setSelectedCommissionPercent] = useState<number>(0)
    const [selectedExpiry, setSelectedExpiry] = useState<string>(initialExpiry)

    // Generation state
    const [_generating, setGenerating] = useState<boolean>(false)
    const [generatedVouchers, setGeneratedVouchers] = useState<GeneratedVoucher[]>([])
    const [_showPreview, setShowPreview] = useState<boolean>(false)
    const [downloadingPdf, setDownloadingPdf] = useState<boolean>(false)
    const [printing, setPrinting] = useState<boolean>(false)

    // UI state
    const [currentStep, setCurrentStep] = useState<StepName>("amount")
    const [showCommissionDialog, setShowCommissionDialog] = useState<boolean>(false)
    const [commissionOptionIndex, setCommissionOptionIndex] = useState<number>(0)
    const [pendingCommissionSelection, setPendingCommissionSelection] = useState<
      number | null
    >(null)

    const qrRefs = useRef<(HTMLDivElement | null)[]>([])

    // Fetch exchange rate when currency changes
    useEffect(() => {
      if (!isBitcoinCurrency(displayCurrency)) {
        fetchExchangeRate()
      } else {
        setExchangeRate({ satPriceInCurrency: 1, currency: "BTC" })
      }
    }, [displayCurrency])

    // Handle commission selection
    useEffect(() => {
      if (pendingCommissionSelection !== null) {
        const newCommissionPercent = pendingCommissionSelection
        if (onInternalTransition) onInternalTransition()
        setSelectedCommissionPercent(newCommissionPercent)
        setShowCommissionDialog(false)
        setPendingCommissionSelection(null)
        // Move to config step after commission selection
        setCurrentStep("config")
      }
    }, [pendingCommissionSelection, onInternalTransition])

    // Reset commission option index when dialog opens
    useEffect(() => {
      if (showCommissionDialog) {
        setCommissionOptionIndex(0)
      }
    }, [showCommissionDialog])

    // Sync selectedExpiry with initialExpiry prop when it changes (from preferences)
    useEffect(() => {
      setSelectedExpiry(initialExpiry)
    }, [initialExpiry])

    const fetchExchangeRate = async (): Promise<void> => {
      if (isBitcoinCurrency(displayCurrency)) return

      setLoadingRate(true)
      try {
        const response = await fetch("/api/rates/exchange-rate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            currency: displayCurrency,
            useBlinkpos: true,
          }),
        })

        const data: ExchangeRateResponse = await response.json()

        if (data.success) {
          setExchangeRate({
            satPriceInCurrency: data.satPriceInCurrency!,
            currency: data.currency!,
          })
        } else {
          throw new Error(data.error || "Failed to fetch exchange rate")
        }
      } catch (error: unknown) {
        console.error("Exchange rate error:", error)
        const message = error instanceof Error ? error.message : "Unknown error"
        setError(`Failed to fetch ${displayCurrency} exchange rate: ${message}`)
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

    // Format display amount
    const formatDisplayAmount = (value: number | string, currency: string): string => {
      return formatCurrency(value, currency, currencies, numberFormat, bitcoinFormat)
    }

    // Render amount with properly styled Bitcoin symbol (smaller ₿ for BIP-177)
    const renderStyledAmount = (
      value: number | string,
      currency: string,
      className: string = "",
    ): ReactElement => {
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

    // Helper function to get dynamic font size (same as Single Voucher)
    // Returns mobile size + desktop size (20% larger on desktop via md: breakpoint)
    // Considers BOTH numeric digits AND total display length to prevent overflow
    const getDynamicFontSize = (displayText: string): string => {
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

    // Calculate commission amount
    const calculateCommissionAmount = (
      baseAmount: number,
      commissionPercent: number,
    ): number => {
      return (commissionPercent / 100) * baseAmount
    }

    // Convert display currency amount to satoshis
    const convertToSatoshis = (amount: number, currency: string): number => {
      if (currency === "BTC") {
        return Math.round(amount)
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

    const handleDigitPress = (digit: string): void => {
      playKeystrokeSound()

      const MAX_SATS = 2100000000000000

      if (digit !== ".") {
        const newAmount = amount + digit
        const numericValue = parseFloat(newAmount.replace(/[^0-9.]/g, ""))

        if (isBitcoinCurrency(displayCurrency) && numericValue > MAX_SATS) {
          return
        }

        const currentNumericDigits = amount.replace(/[^0-9]/g, "").length
        if (currentNumericDigits >= 16) {
          return
        }
      }

      if (amount === "" && digit === "0") {
        if (isBitcoinCurrency(displayCurrency)) {
          setAmount("0")
        } else {
          setAmount("0.")
        }
        return
      }

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
        return
      } else if (digit === ".") {
        const currency = getCurrentCurrency()
        if (isBitcoinCurrency(displayCurrency) || currency?.fractionDigits === 0) {
          return
        }
        setAmount(amount + digit)
      } else if (amount.includes(".")) {
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

      if (
        onInternalTransition &&
        (currentStep !== "amount" || generatedVouchers.length > 0)
      ) {
        onInternalTransition()
      }

      setAmount("")
      setError("")
      setCurrentStep("amount")
      setGeneratedVouchers([])
      setShowPreview(false)
      setSelectedCommissionPercent(0)
      setShowCommissionDialog(false)
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

      if (isBitcoinCurrency(displayCurrency)) {
        return numValue >= 1
      }

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

    // Calculate total amount in sats (for multi-voucher: amount × quantity)
    const getTotalInSats = useCallback((): number => {
      if (!amount || amount === "" || amount === "0") return 0

      const numericAmount = parseFloat(amount)
      if (isNaN(numericAmount) || numericAmount <= 0) return 0

      let amountInSats: number
      if (isBitcoinCurrency(displayCurrency)) {
        amountInSats = Math.round(numericAmount)
      } else if (exchangeRate?.satPriceInCurrency) {
        const currency = getCurrencyById(displayCurrency, currencies)
        const fractionDigits = currency?.fractionDigits ?? 2
        const amountInMinorUnits = numericAmount * Math.pow(10, fractionDigits)
        amountInSats = Math.round(amountInMinorUnits / exchangeRate.satPriceInCurrency)
      } else {
        return 0
      }

      return amountInSats * quantity
    }, [amount, quantity, displayCurrency, exchangeRate, currencies])

    // Check if total amount exceeds wallet balance
    // In USD mode: walletBalance is in USD cents, compare against USD cents
    // In BTC mode: walletBalance is in sats, compare against sats
    const isBalanceExceeded = useCallback((): boolean => {
      if (walletBalance === null) return false
      const totalSats = getTotalInSats()
      if (totalSats === 0) return false

      // In USD mode, convert sats to USD cents for comparison
      if (voucherCurrencyMode === "USD") {
        if (!usdExchangeRate?.satPriceInCurrency) return false
        const totalUsdCents = Math.round(totalSats * usdExchangeRate.satPriceInCurrency)
        return totalUsdCents > walletBalance
      }

      // In BTC mode, compare sats directly
      return totalSats > walletBalance
    }, [walletBalance, getTotalInSats, voucherCurrencyMode, usdExchangeRate])

    const encodeLnurl = (url: string): string => {
      try {
        const bytes = new TextEncoder().encode(url)
        const words = bech32.toWords(bytes)
        const encoded = bech32.encode("lnurl", words, 2000)
        return encoded.toUpperCase()
      } catch (error) {
        console.error("Failed to encode LNURL:", error)
        throw error
      }
    }

    // Handle OK button press - either show commission dialog or go to config
    const handleOkPress = (): void => {
      if (!isValidAmount()) {
        setError("Please enter a valid amount (minimum 1 sat)")
        return
      }

      // Check if total amount exceeds wallet balance
      if (walletBalance !== null && isBalanceExceeded()) {
        setError("Total exceeds wallet balance")
        return
      }

      if (commissionEnabled && commissionPresets && commissionPresets.length > 0) {
        if (onInternalTransition) onInternalTransition()
        setShowCommissionDialog(true)
      } else {
        if (onInternalTransition) onInternalTransition()
        setCurrentStep("config")
      }
    }

    // Generate multiple vouchers
    const generateVouchers = async (): Promise<void> => {
      if (!isValidAmount()) {
        setError("Please enter a valid amount")
        return
      }

      // Check if total amount exceeds wallet balance
      if (walletBalance !== null && isBalanceExceeded()) {
        setError("Total exceeds wallet balance")
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

      setGenerating(true)
      setCurrentStep("generating")
      setError("")
      setGeneratedVouchers([])

      try {
        const numericAmount = parseFloat(amount)
        const commissionAmount =
          selectedCommissionPercent > 0
            ? calculateCommissionAmount(numericAmount, selectedCommissionPercent)
            : 0
        const netAmount = numericAmount - commissionAmount

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
        let usdAmountCents: number | null = null
        if (voucherCurrencyMode === "USD") {
          if (!usdExchangeRate || !usdExchangeRate.satPriceInCurrency) {
            throw new Error("USD exchange rate not available. Please try again.")
          }
          usdAmountCents = Math.round(amountInSats * usdExchangeRate.satPriceInCurrency)

          if (usdAmountCents < 1) {
            throw new Error("Amount too small. Converts to less than $0.01.")
          }
        }

        console.log(
          `Creating ${quantity} ${voucherCurrencyMode} vouchers of ${amountInSats} sats each...`,
        )

        const vouchers: GeneratedVoucher[] = []

        for (let i = 0; i < quantity; i++) {
          const response = await fetch("/api/voucher/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              amount: amountInSats,
              apiKey: voucherWallet.apiKey,
              walletId:
                voucherCurrencyMode === "USD" ? usdWalletId : voucherWallet.walletId,
              expiryId: selectedExpiry,
              commissionPercent: selectedCommissionPercent,
              displayAmount: numericAmount,
              displayCurrency: displayCurrency,
              // USD voucher support
              walletCurrency: voucherCurrencyMode, // 'BTC' or 'USD'
              usdAmount: usdAmountCents, // USD cents (only for USD vouchers)
              // Environment for staging/production support
              environment: getEnvironment(),
            }),
          })

          const data: VoucherCreateResponse = await response.json()

          if (!response.ok) {
            throw new Error(data.error || `Failed to create voucher ${i + 1}`)
          }

          if (data.success && data.voucher) {
            const protocol = window.location.protocol
            const host = window.location.host
            // LNURL always uses sats - even for USD vouchers, Lightning payout is based on sats equivalent
            const lnurlUrl = `${protocol}//${host}/api/voucher/lnurl/${data.voucher.id}/${amountInSats}`
            const lnurl = encodeLnurl(lnurlUrl)

            vouchers.push({
              ...data.voucher,
              lnurl: lnurl,
              displayAmount: numericAmount,
              displayCurrency: displayCurrency,
              commissionPercent: selectedCommissionPercent,
              commissionAmount: commissionAmount,
              netAmount: netAmount,
              expiresAt: data.voucher.expiresAt, // Include expiry for PDF
              walletCurrency: voucherCurrencyMode, // Track whether this is a USD or BTC voucher
              usdAmountCents: usdAmountCents, // USD amount in cents (for USD vouchers)
              index: i + 1,
            } as GeneratedVoucher)
          }
        }

        setGeneratedVouchers(vouchers)
        setCurrentStep("preview")
        console.log(
          `Successfully created ${vouchers.length} ${voucherCurrencyMode} vouchers`,
        )
      } catch (err: unknown) {
        console.error("Voucher generation error:", err)
        const message = err instanceof Error ? err.message : "Failed to create vouchers"
        setError(message)
        setCurrentStep("config")
      } finally {
        setGenerating(false)
      }
    }

    // Get QR code as data URL
    const getQrDataUrl = (qrElement: HTMLDivElement): Promise<string> => {
      return new Promise((resolve, reject) => {
        if (!qrElement) {
          reject(new Error("QR element not found"))
          return
        }

        const svg = qrElement.querySelector("svg")
        if (!svg) {
          reject(new Error("SVG element not found"))
          return
        }

        const clonedSvg = svg.cloneNode(true) as SVGSVGElement
        clonedSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg")

        const width = 256
        const height = 256
        clonedSvg.setAttribute("width", String(width))
        clonedSvg.setAttribute("height", String(height))

        const svgData = new XMLSerializer().serializeToString(clonedSvg)
        const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" })
        const svgUrl = URL.createObjectURL(svgBlob)

        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement("canvas")
          canvas.width = width
          canvas.height = height
          const ctx = canvas.getContext("2d")!

          ctx.fillStyle = "#FFFFFF"
          ctx.fillRect(0, 0, width, height)
          ctx.drawImage(img, 0, 0, width, height)

          const pngDataUrl = canvas.toDataURL("image/png")
          URL.revokeObjectURL(svgUrl)
          resolve(pngDataUrl)
        }

        img.onerror = () => {
          URL.revokeObjectURL(svgUrl)
          reject(new Error("Failed to load SVG image"))
        }

        img.src = svgUrl
      })
    }

    // Get logo data URL
    const getLogoDataUrl = (): Promise<string | null> => {
      return new Promise((resolve) => {
        const img = new Image()
        img.crossOrigin = "anonymous"
        img.onload = () => {
          const canvas = document.createElement("canvas")
          canvas.width = 300
          canvas.height = 125
          const ctx = canvas.getContext("2d")!
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

    // Generate voucher secret from charge ID
    const generateVoucherSecret = (chargeId: string | undefined): string | null => {
      if (!chargeId) return null
      return chargeId.replace(/-/g, "").substring(0, 12)
    }

    // Download PDF with all vouchers
    const downloadPdf = async (): Promise<void> => {
      if (generatedVouchers.length === 0) return

      setDownloadingPdf(true)
      setError("")

      try {
        // Get logo
        const logoDataUrl = await getLogoDataUrl()

        // Get QR codes for all vouchers
        const voucherData: VoucherPdfData[] = await Promise.all(
          generatedVouchers.map(async (voucher, index): Promise<VoucherPdfData> => {
            const qrElement = qrRefs.current[index]
            const qrDataUrl = qrElement ? await getQrDataUrl(qrElement) : null

            let fiatAmount: string | null = null
            if (voucher.displayCurrency && !isBitcoinCurrency(voucher.displayCurrency)) {
              fiatAmount = formatDisplayAmount(
                voucher.displayAmount,
                voucher.displayCurrency,
              )
            }

            return {
              satsAmount: voucher.amount,
              fiatAmount: fiatAmount,
              qrDataUrl: qrDataUrl,
              logoDataUrl: logoDataUrl,
              identifierCode: voucher.id?.substring(0, 8)?.toUpperCase() || null,
              voucherSecret: generateVoucherSecret(voucher.id),
              commissionPercent: voucher.commissionPercent || 0,
              expiresAt: voucher.expiresAt || null,
              issuedBy: voucherWallet?.username || null,
              walletCurrency: voucher.walletCurrency || "BTC",
              usdAmountCents: voucher.usdAmountCents || null,
            }
          }),
        )

        // Call PDF API with grid size
        const response = await fetch("/api/voucher/pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vouchers: voucherData,
            format: "a4",
            gridSize: gridSize,
          }),
        })

        const data: PdfApiResponse = await response.json()

        if (!response.ok || !data.success) {
          throw new Error(data.error || data.message || "Failed to generate PDF")
        }

        // Convert base64 to blob and download
        const byteCharacters = atob(data.pdf!)
        const byteNumbers = new Array(byteCharacters.length)
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i)
        }
        const byteArray = new Uint8Array(byteNumbers)
        const blob = new Blob([byteArray], { type: "application/pdf" })

        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")
        link.href = url
        link.download = `blink-vouchers-${quantity}x-${generatedVouchers[0]?.amount}sats.pdf`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)

        console.log("PDF downloaded successfully")
      } catch (err: unknown) {
        console.error("PDF generation error:", err)
        const message = err instanceof Error ? err.message : "Failed to generate PDF"
        setError(message)
      } finally {
        setDownloadingPdf(false)
      }
    }

    // Print vouchers - generates PDF and opens print dialog
    const printVouchers = async (): Promise<void> => {
      if (generatedVouchers.length === 0) return

      setPrinting(true)
      setError("")

      try {
        // Get logo
        const logoDataUrl = await getLogoDataUrl()

        // Get QR codes for all vouchers
        const voucherData: VoucherPdfData[] = await Promise.all(
          generatedVouchers.map(async (voucher, index): Promise<VoucherPdfData> => {
            const qrElement = qrRefs.current[index]
            const qrDataUrl = qrElement ? await getQrDataUrl(qrElement) : null

            let fiatAmount: string | null = null
            if (voucher.displayCurrency && !isBitcoinCurrency(voucher.displayCurrency)) {
              fiatAmount = formatDisplayAmount(
                voucher.displayAmount,
                voucher.displayCurrency,
              )
            }

            return {
              satsAmount: voucher.amount,
              fiatAmount: fiatAmount,
              qrDataUrl: qrDataUrl,
              logoDataUrl: logoDataUrl,
              identifierCode: voucher.id?.substring(0, 8)?.toUpperCase() || null,
              voucherSecret: generateVoucherSecret(voucher.id),
              commissionPercent: voucher.commissionPercent || 0,
              expiresAt: voucher.expiresAt || null,
              issuedBy: voucherWallet?.username || null,
              walletCurrency: voucher.walletCurrency || "BTC",
              usdAmountCents: voucher.usdAmountCents || null,
            }
          }),
        )

        // Call PDF API with grid size
        const response = await fetch("/api/voucher/pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vouchers: voucherData,
            format: "a4",
            gridSize: gridSize,
          }),
        })

        const data: PdfApiResponse = await response.json()

        if (!response.ok || !data.success) {
          throw new Error(data.error || data.message || "Failed to generate PDF")
        }

        // Convert base64 to blob
        const byteCharacters = atob(data.pdf!)
        const byteNumbers = new Array(byteCharacters.length)
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i)
        }
        const byteArray = new Uint8Array(byteNumbers)
        const blob = new Blob([byteArray], { type: "application/pdf" })

        // Open PDF in new window and trigger print
        const url = URL.createObjectURL(blob)
        const printWindow = window.open(url, "_blank")

        if (printWindow) {
          printWindow.onload = () => {
            printWindow.print()
          }
        } else {
          // Fallback: if popup blocked, download instead
          const link = document.createElement("a")
          link.href = url
          link.download = `blink-vouchers-${quantity}x-${generatedVouchers[0]?.amount}sats.pdf`
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
        }

        // Clean up after a delay to allow print dialog
        setTimeout(() => URL.revokeObjectURL(url), 60000)

        console.log("Print dialog opened")
      } catch (err: unknown) {
        console.error("Print error:", err)
        const message = err instanceof Error ? err.message : "Failed to print vouchers"
        setError(message)
      } finally {
        setPrinting(false)
      }
    }

    // Sats per voucher for the current entered amount (0 when not resolvable).
    const computeSatsPerVoucher = (): number => {
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

    // Current total amount in sats (amount x quantity, for capacity indicator)
    const computeAmountInSats = (): number => computeSatsPerVoucher() * quantity

    // Current total amount in USD cents (amount x quantity)
    const computeAmountInUsdCents = (): number => {
      const satsPerVoucher = computeSatsPerVoucher()
      if (satsPerVoucher <= 0 || !usdExchangeRate?.satPriceInCurrency) return 0
      const centsPerVoucher = Math.round(
        satsPerVoucher * usdExchangeRate.satPriceInCurrency,
      )
      return centsPerVoucher * quantity // Total for all vouchers
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
      quantity,
      displayCurrency,
      exchangeRate,
      usdExchangeRate,
      currencies,
      voucherCurrencyMode,
      onAmountChange,
    ])

    // Expose handlers for keyboard navigation
    useImperativeHandle(ref, () => ({
      handleDigitPress,
      handleBackspace,
      handleClear,
      handleSubmit: (): void => {
        if (currentStep === "amount") {
          handleOkPress()
        } else if (currentStep === "config") {
          generateVouchers()
        } else if (currentStep === "preview") {
          downloadPdf()
        }
      },
      hasValidAmount: (): boolean => isValidAmount(),
      getCurrentStep: (): StepName => currentStep,
      getAmountInSats: computeAmountInSats,
      getAmountInUsdCents: computeAmountInUsdCents,
      // Get current voucher currency mode
      getVoucherCurrencyMode: (): string => voucherCurrencyMode,
      getSelectedExpiry: (): string => selectedExpiry,
      setSelectedExpiry: (expiryId: string): void => {
        setSelectedExpiry(expiryId)
      },
      isCommissionDialogOpen: (): boolean => showCommissionDialog,
      handleCommissionDialogKey: (key: string): boolean => {
        if (!showCommissionDialog) return false

        const presetCount = commissionPresets.length
        const totalOptions = presetCount + 2
        const cancelIndex = presetCount
        const noCommissionIndex = presetCount + 1

        if (key === "ArrowRight") {
          setCommissionOptionIndex((prev) => (prev + 1) % totalOptions)
          return true
        } else if (key === "ArrowLeft") {
          setCommissionOptionIndex((prev) => (prev - 1 + totalOptions) % totalOptions)
          return true
        } else if (key === "Enter") {
          if (commissionOptionIndex < commissionPresets.length) {
            setPendingCommissionSelection(commissionPresets[commissionOptionIndex])
          } else if (commissionOptionIndex === cancelIndex) {
            if (onInternalTransition) onInternalTransition()
            setShowCommissionDialog(false)
          } else if (commissionOptionIndex === noCommissionIndex) {
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

    // Render amount input step (numpad screen - same size as Single Voucher)
    const renderAmountStep = (): ReactElement => (
      <div
        className="h-full flex flex-col bg-white dark:bg-black relative"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {/* Amount Display - Same size as Single Voucher */}
        <div className="px-4">
          <div className="text-center">
            <div
              className={`font-inter-tight font-semibold text-gray-800 dark:text-gray-100 min-h-[72px] flex items-center justify-center leading-none tracking-normal max-w-full overflow-hidden px-2 ${getDynamicFontSize(
                formatDisplayAmount(amount || "0", displayCurrency),
              )}`}
              style={{ wordBreak: "keep-all", overflowWrap: "normal" }}
            >
              <div className="max-w-full">
                {amount === "0" || amount === "0."
                  ? isBitcoinCurrency(displayCurrency) ||
                    getCurrentCurrency()?.fractionDigits === 0
                    ? "0"
                    : getCurrentCurrency()?.symbol + "0."
                  : renderStyledAmount(amount || "0", displayCurrency)}
              </div>
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              <div className="mb-1 min-h-[20px] max-w-full overflow-x-auto px-2">
                {!isBitcoinCurrency(displayCurrency)
                  ? `(${getSatsEquivalent(parseFloat(amount) || 0)} sats)`
                  : null}
              </div>
            </div>
            {/* Always reserve space for balance warning to prevent numpad layout shift */}
            <div className="min-h-[20px]">
              {isBalanceExceeded() && walletBalance !== null && (
                <div className="text-xs text-red-500 dark:text-red-400 font-medium">
                  Total exceeds wallet balance
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

        {/* Numpad */}
        <div className="flex-1 px-4 pb-4 relative">
          <div className="h-16 mb-2"></div>
          <Numpad
            theme={theme}
            layout={numpadLayout}
            onDigitPress={handleDigitPress}
            onClear={handleClear}
            onBackspace={handleBackspace}
            onOkPress={handleOkPress}
            okDisabled={!isValidAmount() || isBalanceExceeded()}
            okLabel="OK"
            decimalDisabled={
              isBitcoinCurrency(displayCurrency) ||
              getCurrentCurrency()?.fractionDigits === 0
            }
            accentColor="purple"
            showPlus={false}
            showCurrencyToggle={!!onVoucherCurrencyToggle}
            voucherCurrencyMode={voucherCurrencyMode}
            onCurrencyToggle={onVoucherCurrencyToggle}
          />

          {/* Commission Selection Overlay */}
          {showCommissionDialog &&
            (() => {
              const totalOptions = commissionPresets.length + 2
              const cancelIndex = totalOptions - 2
              const noCommissionIndex = totalOptions - 1

              return (
                <div className="absolute inset-0 bg-white dark:bg-black z-30 pt-24">
                  <div className="grid grid-cols-4 gap-3 max-w-sm md:max-w-md mx-auto">
                    <h3 className="col-span-4 text-xl md:text-2xl font-bold mb-2 text-center text-gray-800 dark:text-white">
                      Commission Options
                    </h3>

                    {commissionPresets.map((percent, index) => (
                      <button
                        key={percent}
                        onClick={() => setPendingCommissionSelection(percent)}
                        className={`col-span-2 h-16 md:h-20 bg-white dark:bg-black border-2 rounded-lg text-lg md:text-xl font-normal transition-colors shadow-md ${
                          commissionOptionIndex === index
                            ? "border-purple-400 ring-2 ring-purple-400 bg-purple-50 dark:bg-purple-900 text-purple-700 dark:text-purple-300"
                            : "border-purple-500 hover:border-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900 text-purple-600 dark:text-purple-400"
                        }`}
                      >
                        {percent}%
                        <div className="text-sm md:text-base">
                          -
                          {formatDisplayAmount(
                            calculateCommissionAmount(parseFloat(amount) || 0, percent),
                            displayCurrency,
                          )}
                        </div>
                      </button>
                    ))}

                    {commissionPresets.length % 2 === 1 && (
                      <div className="col-span-2"></div>
                    )}

                    <button
                      onClick={() => {
                        if (onInternalTransition) onInternalTransition()
                        setShowCommissionDialog(false)
                      }}
                      className={`col-span-2 h-16 md:h-20 bg-white dark:bg-black border-2 rounded-lg text-lg md:text-xl font-normal transition-colors shadow-md ${
                        commissionOptionIndex === cancelIndex
                          ? "border-red-400 ring-2 ring-red-400 bg-red-50 dark:bg-red-900 text-red-700 dark:text-red-300"
                          : "border-red-500 hover:border-red-600 hover:bg-red-50 dark:hover:bg-red-900 text-red-600 dark:text-red-400"
                      }`}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => setPendingCommissionSelection(0)}
                      className={`col-span-2 h-16 md:h-20 bg-white dark:bg-black border-2 rounded-lg text-lg md:text-xl font-normal transition-colors shadow-md ${
                        commissionOptionIndex === noCommissionIndex
                          ? "border-yellow-400 ring-2 ring-yellow-400 bg-yellow-50 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300"
                          : "border-yellow-500 dark:border-yellow-400 hover:border-yellow-600 dark:hover:border-yellow-300 hover:bg-yellow-50 dark:hover:bg-yellow-900 text-yellow-600 dark:text-yellow-400"
                      }`}
                    >
                      No Commission
                    </button>
                  </div>
                </div>
              )
            })()}
        </div>
      </div>
    )

    // Render configuration step
    const renderConfigStep = (): ReactElement => (
      <div
        className="h-full flex flex-col bg-white dark:bg-black"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {/* Header - centered */}
        <div className="px-4 pt-4 pb-2">
          <div className="text-center">
            <div className="text-3xl font-semibold text-purple-600 dark:text-purple-400 mb-2">
              {formatDisplayAmount(amount, displayCurrency)}
              {selectedCommissionPercent > 0 && (
                <span className="text-lg text-gray-500 dark:text-gray-400 ml-2">
                  ({selectedCommissionPercent}% commission)
                </span>
              )}
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              Configure your voucher batch
            </div>
          </div>
        </div>

        {/* Configuration Options */}
        <div className="flex-1 px-4 py-4 overflow-y-auto">
          {/* Quantity Selector */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 text-center">
              Number of Vouchers
            </label>
            <div className="flex items-center justify-center gap-4">
              <button
                onClick={() => setQuantity(Math.max(1, quantity - 1))}
                className="w-12 h-12 bg-white dark:bg-black border-2 border-purple-500 dark:border-purple-400 text-purple-600 dark:text-purple-400 rounded-lg text-2xl font-bold hover:bg-purple-50 dark:hover:bg-purple-900 transition-colors"
              >
                -
              </button>
              <div className="w-20 text-center">
                <span className="text-4xl font-bold text-purple-600 dark:text-purple-400">
                  {quantity}
                </span>
              </div>
              <button
                onClick={() => setQuantity(Math.min(24, quantity + 1))}
                className="w-12 h-12 bg-white dark:bg-black border-2 border-purple-500 dark:border-purple-400 text-purple-600 dark:text-purple-400 rounded-lg text-2xl font-bold hover:bg-purple-50 dark:hover:bg-purple-900 transition-colors"
              >
                +
              </button>
            </div>
            <div className="text-center mt-2 text-sm text-gray-500 dark:text-gray-400">
              Total: {formatDisplayAmount(parseFloat(amount) * quantity, displayCurrency)}
            </div>
          </div>

          {/* Grid Size Selector */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Grid Layout (vouchers per page)
            </label>
            <div className="grid grid-cols-2 gap-2">
              {GRID_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  onClick={() => setGridSize(option.id)}
                  className={`p-3 rounded-lg border-2 transition-colors ${
                    gridSize === option.id
                      ? "border-purple-500 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300"
                      : "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-gray-400"
                  }`}
                >
                  <div className="font-medium">{option.label}</div>
                  <div className="text-xs opacity-70">{option.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Summary */}
          <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 mb-4">
            <h4 className="font-medium text-gray-800 dark:text-gray-200 mb-2">Summary</h4>
            <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
              <div className="flex justify-between">
                <span>Vouchers:</span>
                <span className="font-medium">{quantity}</span>
              </div>
              <div className="flex justify-between">
                <span>Amount each:</span>
                <span className="font-medium">
                  {formatDisplayAmount(amount, displayCurrency)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Total:</span>
                <span className="font-medium">
                  {formatDisplayAmount(parseFloat(amount) * quantity, displayCurrency)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Expiry:</span>
                <span className="font-medium">
                  {getExpiryOption(selectedExpiry)?.label || selectedExpiry}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Pages:</span>
                <span className="font-medium">
                  {Math.ceil(
                    quantity /
                      (GRID_OPTIONS.find((g) => g.id === gridSize)?.perPage || 4),
                  )}
                </span>
              </div>
            </div>
          </div>

          {error && (
            <div className="bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-200 px-3 py-2 rounded text-sm mb-4">
              {error}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="px-4 pb-4 space-y-3">
          <button
            onClick={generateVouchers}
            className="w-full h-14 bg-purple-600 dark:bg-purple-500 hover:bg-purple-700 dark:hover:bg-purple-600 text-white rounded-lg text-lg font-semibold transition-colors shadow-md flex items-center justify-center gap-2"
          >
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
                d="M12 6v6m0 0v6m0-6h6m-6 0H6"
              />
            </svg>
            Generate {quantity} Vouchers
          </button>
          <button
            onClick={handleClear}
            className="w-full h-12 bg-white dark:bg-black border-2 border-gray-400 dark:border-gray-600 text-gray-600 dark:text-gray-400 rounded-lg text-lg font-normal transition-colors"
          >
            Back
          </button>
        </div>
      </div>
    )

    // Render generating step
    const renderGeneratingStep = (): ReactElement => (
      <div
        className="h-full flex flex-col bg-white dark:bg-black items-center justify-center"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        <div className="flex flex-col items-center bg-gray-50 dark:bg-blink-dark rounded-lg p-8 shadow-lg">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-purple-500 border-t-transparent mb-4"></div>
          <div className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-2">
            Creating Vouchers...
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400">
            {generatedVouchers.length} of {quantity} created
          </div>
        </div>
      </div>
    )

    // Render preview step
    const renderPreviewStep = (): ReactElement => (
      <div
        className="h-full flex flex-col bg-white dark:bg-black"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {/* Title Section */}
        <div className="px-4 py-4">
          <div className="text-center">
            <div className="text-2xl font-semibold text-purple-600 dark:text-purple-400">
              {generatedVouchers.length} Vouchers Created
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {formatDisplayAmount(amount, displayCurrency)} each
            </div>
          </div>
        </div>

        {/* Voucher Grid Preview */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            {generatedVouchers.map((voucher, index) => (
              <div
                key={voucher.id}
                className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-3 shadow-sm"
              >
                <div className="text-center mb-2">
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    #{index + 1}
                  </div>
                  <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    {voucher.amount} sats
                  </div>
                </div>
                <div
                  ref={(el: HTMLDivElement | null) => {
                    qrRefs.current[index] = el
                  }}
                  className="flex justify-center"
                >
                  <QRCode
                    value={voucher.lnurl}
                    size={80}
                    bgColor="#ffffff"
                    fgColor="#000000"
                  />
                </div>
                <div className="text-center mt-2 text-xs text-gray-500 dark:text-gray-400 font-mono">
                  {voucher.id?.substring(0, 8)?.toUpperCase()}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="px-4 pb-4 space-y-3">
          {/* Print and Download buttons row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Print button - green outline (main action) */}
            <button
              onClick={printVouchers}
              disabled={printing || downloadingPdf}
              className="h-14 bg-white dark:bg-black border-2 border-green-600 dark:border-green-500 hover:border-green-700 dark:hover:border-green-400 hover:bg-green-50 dark:hover:bg-green-900 text-green-600 dark:text-green-400 disabled:border-gray-400 disabled:text-gray-400 disabled:cursor-not-allowed rounded-lg text-lg font-normal transition-colors shadow-md flex items-center justify-center gap-2"
            >
              {printing ? (
                <>
                  <div className="animate-spin w-5 h-5 border-2 border-green-600 dark:border-green-400 border-t-transparent rounded-full"></div>
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
                  Print
                </>
              )}
            </button>

            {/* Download PDF button - orange/yellow outline */}
            <button
              onClick={downloadPdf}
              disabled={downloadingPdf || printing}
              className="h-14 bg-white dark:bg-black border-2 border-orange-500 dark:border-orange-500 hover:border-orange-600 dark:hover:border-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900 text-orange-500 dark:text-orange-400 disabled:border-gray-400 disabled:text-gray-400 disabled:cursor-not-allowed rounded-lg text-lg font-normal transition-colors shadow-md flex items-center justify-center gap-2"
            >
              {downloadingPdf ? (
                <>
                  <div className="animate-spin w-5 h-5 border-2 border-orange-500 dark:border-orange-400 border-t-transparent rounded-full"></div>
                  PDF...
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
                  Download
                </>
              )}
            </button>
          </div>

          {/* Create New Batch button - purple outline */}
          <button
            onClick={handleClear}
            className="w-full h-12 bg-white dark:bg-black border-2 border-purple-500 dark:border-purple-400 hover:border-purple-600 dark:hover:border-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/30 text-purple-600 dark:text-purple-400 rounded-lg text-lg font-normal transition-colors"
          >
            Create New Batch
          </button>

          {error && (
            <div className="bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-200 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}
        </div>
      </div>
    )

    // Main render
    switch (currentStep) {
      case "amount":
        return renderAmountStep()
      case "config":
        return renderConfigStep()
      case "generating":
        return renderGeneratingStep()
      case "preview":
        return renderPreviewStep()
      default:
        return renderAmountStep()
    }
  },
)

MultiVoucher.displayName = "MultiVoucher"
export default MultiVoucher
