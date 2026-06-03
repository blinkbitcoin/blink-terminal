/**
 * CompanionAdapter - Deep link adapter for mobile printing via companion app
 *
 * This adapter sends ESC/POS data to a companion mobile app that handles
 * the actual Bluetooth communication with the thermal printer.
 *
 * Protocol: blink-pos-companion://print?...
 *
 * Version 2 protocol features:
 * - Pre-built ESC/POS commands (no parsing needed in app)
 * - Base64 encoded binary data
 * - Fallback voucher JSON for app-side rendering
 * - Paper width hints for proper formatting
 *
 * This is the PRIMARY adapter for mobile devices since:
 * - Web Bluetooth is not available on iOS Safari
 * - Web Bluetooth on Android has limited ESC/POS printer support
 * - Native apps can use optimized Bluetooth libraries
 */

import { BaseAdapter, AdapterStatus, AdapterCapabilities } from "./BaseAdapter"

/**
 * Deep link URL schemes
 */
export const URL_SCHEMES = {
  // Primary scheme for Blink companion app
  BLINK: "blink-pos-companion",
  // Alternative schemes for other apps that support ESC/POS
  RAWBT: "rawbt", // RawBT app (Android)
  ESCPOS: "escpos-print", // Generic ESC/POS scheme
} as const

interface CompanionOptions {
  scheme?: string
  version?: number
  timeout?: number
  maxDataSize?: number
  includeFallbackJson?: boolean
  paperWidth?: number
  qrMode?: string
  useLegacyFormat?: boolean
}

interface VoucherLike {
  lnurl?: string
  satsAmount?: number
  displayAmount?: number | string
  displayCurrency?: string
  voucherSecret?: string
  identifierCode?: string
  commissionPercent?: number
  commission?: number
  expiresAt?: number | string
  issuedBy?: string
  walletCurrency?: string
  usdAmountCents?: number
  amount?: number
}

interface ReceiptLike {
  /** Pre-formatted amount line, e.g. "5,000 sats ($50.00)" */
  amount?: string
  merchant?: string
  memo?: string
  paymentHash?: string
  timestamp?: number
}

interface PrintOptions {
  voucher?: VoucherLike
  receipt?: ReceiptLike
  paperWidth?: number
  qrMode?: string
  timeout?: number
}

interface PrintResult {
  printId?: number
  success?: boolean
  error?: string
  type?: string
}

interface InstructionInfo {
  title: string
  steps: string[]
  appStoreLink: string | null
  alternativeApps: Array<{ name: string; platform: string; scheme: string }>
}

/**
 * Default configuration
 */
const DEFAULT_OPTIONS: Required<CompanionOptions> = {
  scheme: URL_SCHEMES.BLINK,
  version: 2,
  timeout: 30000, // Timeout waiting for app response
  maxDataSize: 100000, // Max base64 data size (URL length limits)
  includeFallbackJson: true, // Include voucher JSON for app-side rendering
  paperWidth: 80,
  qrMode: "native", // 'native' or 'raster'
  useLegacyFormat: true, // Use legacy deep link format compatible with current companion app
}

/**
 * CompanionAdapter class
 */
class CompanionAdapter extends BaseAdapter {
  declare options: Required<CompanionOptions>
  private _pendingPrints: Map<number, PrintResult>
  private _printIdCounter: number

  /**
   * Create a companion adapter
   * @param {object} options - Adapter options
   */
  constructor(options: CompanionOptions = {}) {
    super(options as Record<string, unknown>)
    this.options = { ...DEFAULT_OPTIONS, ...options }

    // Companion adapter capabilities
    this.capabilities = new Set([
      AdapterCapabilities.NATIVE_QR,
      AdapterCapabilities.RASTER_IMAGE,
      AdapterCapabilities.AUTO_CUT,
    ])

    // Track pending prints for response handling
    this._pendingPrints = new Map()
    this._printIdCounter = 0

    // Set up response listener if in browser
    if (typeof window !== "undefined") {
      this._setupResponseListener()
    }
  }

  /**
   * Adapter type identifier
   * @returns {string}
   */
  get type(): string {
    return "companion"
  }

  /**
   * Human-readable name
   * @returns {string}
   */
  get name(): string {
    return "Companion App"
  }

  /**
   * Check if this adapter is available
   * Available on mobile browsers and any environment that can open URLs
   * @returns {Promise<boolean>}
   */
  async isAvailable(): Promise<boolean> {
    // Check if we're in a browser environment
    if (typeof window === "undefined") {
      return false
    }

    // Deep links work on mobile browsers
    const _isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

    // Also available on desktop (will prompt to install app or use fallback)
    // Return true to allow user to try companion app workflow
    return true
  }

  /**
   * Check if we're likely on a mobile device
   * @returns {boolean}
   */
  isMobile(): boolean {
    if (typeof navigator === "undefined") return false
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  }

  /**
   * Check if we're on iOS
   * @returns {boolean}
   */
  isIOS(): boolean {
    if (typeof navigator === "undefined") return false
    return /iPhone|iPad|iPod/i.test(navigator.userAgent)
  }

  /**
   * Check if we're on Android
   * @returns {boolean}
   */
  isAndroid(): boolean {
    if (typeof navigator === "undefined") return false
    return /Android/i.test(navigator.userAgent)
  }

  /**
   * Connect to companion app
   * For deep link adapter, this just validates availability
   * @returns {Promise<boolean>}
   */
  async connect(): Promise<boolean> {
    this._setStatus(AdapterStatus.CONNECTING)

    const available = await this.isAvailable()
    if (!available) {
      this._setError("Companion adapter not available in this environment")
      return false
    }

    this._setStatus(AdapterStatus.CONNECTED)
    return true
  }

  /**
   * Disconnect (no-op for deep link adapter)
   * @returns {Promise<void>}
   */
  async disconnect(): Promise<void> {
    this._setStatus(AdapterStatus.DISCONNECTED)
  }

  /**
   * Send print job to companion app via deep link
   *
   * @param {Uint8Array} data - ESC/POS command bytes
   * @param {object} options - Print options
   * @param {object} options.voucher - Original voucher data for fallback
   * @returns {Promise<boolean>}
   */
  async print(data: Uint8Array, options: PrintOptions = {}): Promise<boolean> {
    if (this.status !== AdapterStatus.CONNECTED) {
      await this.connect()
    }

    this._setStatus(AdapterStatus.PRINTING)

    try {
      const url = this._buildDeepLinkUrl(data, options)

      // Check URL length
      if (url.length > 2000 && this.isIOS()) {
        // iOS has stricter URL length limits
        console.warn("Deep link URL may be too long for iOS:", url.length)
      }

      // Open the deep link
      const success = await this._openDeepLink(url, options)

      if (success) {
        this._setStatus(AdapterStatus.CONNECTED)
        this._emit("printed", { dataSize: data.length })
        return true
      } else {
        this._setError("Failed to open companion app")
        return false
      }
    } catch (err: unknown) {
      this._setError(err instanceof Error ? err : new Error(String(err)))
      return false
    }
  }

  /**
   * Build deep link URL with ESC/POS data
   * @private
   * @param {Uint8Array} data - ESC/POS bytes
   * @param {object} options - Print options
   * @returns {string} Deep link URL
   */
  private _buildDeepLinkUrl(data: Uint8Array, options: PrintOptions = {}): string {
    const scheme = this.options.scheme
    const params = new URLSearchParams()

    // Payment receipts use the V1 `app=payment` format. This is required because
    // the companion app's V2 raw-ESC/POS path is a no-op on Nyx/Bitcoinize
    // printers; the V1 path renders on both Nyx and generic Bluetooth printers.
    if (options.receipt) {
      return this._buildPaymentDeepLinkUrl(options.receipt)
    }

    // Check if we should use legacy format (compatible with current companion app)
    // The current companion app expects app=voucher with individual parameters
    if (this.options.useLegacyFormat && options.voucher) {
      return this._buildLegacyDeepLinkUrl(options.voucher)
    }

    // Version 2 protocol: Pre-built ESC/POS commands
    // Note: This requires companion app update to support

    // Protocol version
    params.set("version", String(this.options.version))

    // Base64 encoded ESC/POS data
    const base64Data = this._toBase64(data)

    // Check if data is too large
    if (base64Data.length > this.options.maxDataSize) {
      throw new Error(
        `ESC/POS data too large for deep link (${base64Data.length} bytes). ` +
          `Max: ${this.options.maxDataSize}. Consider using minimal receipt.`,
      )
    }

    params.set("escpos", base64Data)

    // Paper width hint
    params.set("paper_width", String(options.paperWidth || this.options.paperWidth))

    // QR mode hint
    params.set("qr_mode", options.qrMode || this.options.qrMode)

    // Print ID for tracking
    const printId = ++this._printIdCounter
    params.set("print_id", String(printId))

    // Callback URL for result (if supported by app)
    if (typeof window !== "undefined" && window.location) {
      const callbackUrl = `${window.location.origin}/print-callback`
      params.set("callback", callbackUrl)
    }

    // Include fallback voucher JSON if available and enabled
    if (this.options.includeFallbackJson && options.voucher) {
      try {
        const fallbackJson = JSON.stringify({
          lnurl: options.voucher.lnurl,
          satsAmount: options.voucher.satsAmount,
          displayAmount: options.voucher.displayAmount,
          displayCurrency: options.voucher.displayCurrency,
          voucherSecret: options.voucher.voucherSecret,
          identifierCode: options.voucher.identifierCode,
          expiresAt: options.voucher.expiresAt,
          issuedBy: options.voucher.issuedBy,
        })
        params.set("fallback", fallbackJson)
      } catch (e: unknown) {
        console.warn("Could not serialize voucher for fallback:", e)
      }
    }

    return `${scheme}://print?${params.toString()}`
  }

  /**
   * Build legacy deep link URL format
   * This format is compatible with the current Blink POS Companion app
   * which expects app=voucher with individual voucher parameters
   *
   * @private
   * @param {object} voucher - Voucher data
   * @returns {string} Deep link URL
   */
  private _buildLegacyDeepLinkUrl(voucher: VoucherLike): string {
    const scheme = this.options.scheme
    const params = new URLSearchParams()

    // Set app type to voucher
    params.set("app", "voucher")

    // LNURL for QR code
    params.set("lnurl", voucher.lnurl || "")

    // Format voucherPrice - fiat amount with currency
    let voucherPrice = ""
    if (
      voucher.displayCurrency &&
      voucher.displayCurrency !== "BTC" &&
      voucher.displayAmount
    ) {
      const amount =
        typeof voucher.displayAmount === "number"
          ? voucher.displayAmount.toFixed(2)
          : voucher.displayAmount
      // Use $X.XX USD format for USD, otherwise CURRENCY X.XX
      if (voucher.displayCurrency === "USD") {
        voucherPrice = `$${amount} USD`
      } else {
        voucherPrice = `${voucher.displayCurrency} ${amount}`
      }
    }
    params.set("voucherPrice", voucherPrice)

    // Voucher amount - USD for Dollar Vouchers, sats for BTC vouchers
    if (voucher.walletCurrency === "USD" && voucher.usdAmountCents) {
      const usdAmount = (voucher.usdAmountCents / 100).toFixed(2)
      params.set("voucherAmount", `$${usdAmount} USD`)
    } else {
      const satsAmount = voucher.satsAmount || voucher.amount || 0
      params.set("voucherAmount", `${satsAmount} sats`)
    }

    // Voucher secret (12-char alphanumeric)
    params.set("voucherSecret", voucher.voucherSecret || "")

    // Commission percentage
    const commission = voucher.commissionPercent || voucher.commission || 0
    params.set("commissionPercentage", String(commission))

    // Identifier code (8-char uppercase)
    params.set("identifierCode", voucher.identifierCode || "")

    // Expiry timestamp (milliseconds)
    if (voucher.expiresAt) {
      params.set("expiresAt", String(voucher.expiresAt))
    }

    // Issued by (username)
    if (voucher.issuedBy) {
      params.set("issuedBy", voucher.issuedBy)
    }

    const url = `${scheme}://print?${params.toString()}`
    console.log("🖨️ Using legacy companion app format:", url)

    return url
  }

  /**
   * Build a payment-receipt deep link (V1 `app=payment` format).
   *
   * The companion app renders this on both Nyx/Bitcoinize and generic
   * Bluetooth printers. Params map to MainActivity.parseV1PrintJob():
   * username, amount, paymentHash, date, time, memo.
   *
   * @private
   */
  private _buildPaymentDeepLinkUrl(receipt: ReceiptLike): string {
    const scheme = this.options.scheme
    const params = new URLSearchParams()

    // Default app type is payment; set explicitly for clarity.
    params.set("app", "payment")

    if (receipt.merchant) {
      params.set("username", receipt.merchant)
    }

    // Pre-formatted combined amount string (e.g. "5,000 sats ($50.00)")
    if (receipt.amount) {
      params.set("amount", receipt.amount)
    }

    if (receipt.paymentHash) {
      params.set("paymentHash", receipt.paymentHash)
    }

    if (receipt.memo) {
      params.set("memo", receipt.memo)
    }

    // Split timestamp into date + time for the V1 template
    const date = new Date(receipt.timestamp ?? Date.now())
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, "0")
    const d = String(date.getDate()).padStart(2, "0")
    params.set("date", `${y}-${m}-${d}`)

    let hours = date.getHours()
    const minutes = String(date.getMinutes()).padStart(2, "0")
    const ampm = hours >= 12 ? "pm" : "am"
    hours = hours % 12
    if (hours === 0) hours = 12
    params.set("time", `${hours}:${minutes} ${ampm}`)

    const url = `${scheme}://print?${params.toString()}`
    console.log("🖨️ Using payment receipt companion format:", url)

    return url
  }

  /**
   * Open deep link URL
   * @private
   * @param {string} url - Deep link URL
   * @param {object} options - Options
   * @returns {Promise<boolean>}
   */
  private async _openDeepLink(url: string, options: PrintOptions = {}): Promise<boolean> {
    if (typeof window === "undefined") {
      throw new Error("Cannot open deep link outside browser environment")
    }

    return new Promise((resolve) => {
      // Track if we successfully opened the app
      let appOpened = false
      let visibilityChanged = false

      // When app opens, the page loses visibility
      const handleVisibilityChange = (): void => {
        if (document.hidden) {
          visibilityChanged = true
          appOpened = true
        }
      }

      // Set up visibility listener
      document.addEventListener("visibilitychange", handleVisibilityChange)

      // Attempt to open the deep link
      const link = document.createElement("a")
      link.href = url
      link.style.display = "none"
      document.body.appendChild(link)

      // Use click to trigger the link
      link.click()

      // Also try window.location for better compatibility
      setTimeout(() => {
        if (!appOpened) {
          window.location.href = url
        }
      }, 100)

      // Check result after timeout
      setTimeout(() => {
        document.removeEventListener("visibilitychange", handleVisibilityChange)
        document.body.removeChild(link)

        if (visibilityChanged || appOpened) {
          resolve(true)
        } else {
          // App might not be installed - still resolve true
          // as we can't reliably detect this
          // The user will see the result
          resolve(true)
        }
      }, options.timeout || 1000)
    })
  }

  /**
   * Convert Uint8Array to Base64
   * @private
   * @param {Uint8Array} data
   * @returns {string}
   */
  private _toBase64(data: Uint8Array): string {
    if (typeof btoa !== "undefined") {
      let binary = ""
      for (const byte of data) {
        binary += String.fromCharCode(byte)
      }
      return btoa(binary)
    } else if (typeof Buffer !== "undefined") {
      return Buffer.from(data).toString("base64")
    }
    throw new Error("No Base64 encoding available")
  }

  /**
   * Set up listener for responses from companion app
   * @private
   */
  private _setupResponseListener(): void {
    // Listen for custom URL handling (callback from app)
    if (typeof window !== "undefined") {
      window.addEventListener("message", (event: MessageEvent) => {
        if (event.data?.type === "blink-print-result") {
          this._handlePrintResult(event.data as PrintResult)
        }
      })
    }
  }

  /**
   * Handle print result from companion app
   * @private
   * @param {object} result
   */
  private _handlePrintResult(result: PrintResult): void {
    const { printId, success, error } = result

    if (success) {
      this._emit("printed", { printId })
    } else {
      this._emit("error", { printId, error })
    }
  }

  /**
   * Get the deep link URL for a print job (without executing)
   * Useful for showing QR code or copy-able link
   *
   * @param {Uint8Array} data - ESC/POS bytes
   * @param {object} options - Options
   * @returns {string} Deep link URL
   */
  getDeepLinkUrl(data: Uint8Array, options: PrintOptions = {}): string {
    return this._buildDeepLinkUrl(data, options)
  }

  /**
   * Get store link for companion app
   * @returns {string|null}
   */
  getAppStoreLink(): string | null {
    if (this.isIOS()) {
      return "https://apps.apple.com/app/blink-pos-companion/id000000000" // TODO: Real app ID
    }
    if (this.isAndroid()) {
      return "https://play.google.com/store/apps/details?id=com.blink.pos.companion" // TODO: Real package
    }
    return null
  }

  /**
   * Get instructions for using companion app
   * @returns {object}
   */
  getInstructions(): InstructionInfo {
    return {
      title: "Print with Companion App",
      steps: [
        "1. Install the Blink POS Companion app",
        "2. Open the app and connect your Bluetooth printer",
        '3. Return here and tap "Print"',
        "4. The voucher will be sent to your printer",
      ],
      appStoreLink: this.getAppStoreLink(),
      alternativeApps: [
        { name: "RawBT", platform: "Android", scheme: URL_SCHEMES.RAWBT },
      ],
    }
  }

  /**
   * Create a deep link URL directly (static method)
   * Useful when you don't need the full adapter
   *
   * @param {Uint8Array} escposData - ESC/POS bytes
   * @param {object} options - URL options
   * @returns {string} Deep link URL
   */
  static createDeepLink(escposData: Uint8Array, options: CompanionOptions = {}): string {
    const adapter = new CompanionAdapter(options)
    return adapter.getDeepLinkUrl(escposData, options)
  }
}

export default CompanionAdapter
export { CompanionAdapter }
