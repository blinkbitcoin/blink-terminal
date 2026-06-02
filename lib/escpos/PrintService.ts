/**
 * PrintService - Main orchestrator for ESC/POS thermal printing
 *
 * This is the primary entry point for printing vouchers from the Blink app.
 * It coordinates between:
 * - VoucherReceipt: Builds ESC/POS commands for voucher layout
 * - ConnectionManager: Detects platform and selects adapter
 * - Adapters: Handle actual printing via different methods
 *
 * Usage:
 * ```javascript
 * import { PrintService } from '@/lib/escpos';
 *
 * const printService = new PrintService();
 *
 * // Print a voucher
 * await printService.printVoucher(voucherData, {
 *   paperWidth: 80,
 *   autoCut: true,
 * });
 *
 * // Or get available print methods
 * const methods = await printService.getAvailableMethods();
 * ```
 */

import BaseAdapter from "./adapters/BaseAdapter"
import ConnectionManager, { getConnectionManager } from "./ConnectionManager"
import ReceiptBuilder, { type ReceiptData } from "./ReceiptBuilder"
import VoucherReceipt, { type VoucherData as VoucherReceiptData } from "./VoucherReceipt"

/**
 * Print job status
 */
export const PrintStatus = {
  PENDING: "pending",
  PREPARING: "preparing",
  SENDING: "sending",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const

export type PrintStatusType = (typeof PrintStatus)[keyof typeof PrintStatus]

/**
 * Receipt types
 */
export const ReceiptType = {
  STANDARD: "standard",
  MINIMAL: "minimal",
  REISSUE: "reissue",
} as const

export type ReceiptTypeValue = (typeof ReceiptType)[keyof typeof ReceiptType]

export interface PrintOptions {
  paperWidth?: number
  receiptType?: string
  qrSize?: number
  useNativeQR?: boolean
  autoCut?: boolean
  feedLinesAfter?: number
  copies?: number
  timeout?: number
  retryOnFail?: boolean
  maxRetries?: number
  showLogo?: boolean
  partialCut?: boolean
  qrErrorCorrection?: string
}

export interface VoucherData {
  lnurl: string
  satsAmount: number
  displayAmount?: number
  displayCurrency?: string
  voucherSecret?: string
  identifierCode?: string
  commissionPercent?: number
  expiresAt?: number | string
  issuedBy?: string
  walletCurrency?: string
  usdAmountCents?: number
  [key: string]: unknown
}

export interface PrintResult {
  success: boolean
  jobId: string
  error?: string
  adapter?: string
}

export interface BatchPrintResult {
  results: PrintResult[]
  successCount: number
  failCount: number
  total: number
}

export interface AvailableMethod {
  type: string
  name: string
  available: boolean
  recommended: boolean
}

export type EventCallback = (data: Record<string, unknown>) => void

/**
 * Default print options
 */
const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  paperWidth: 80, // 58 or 80
  receiptType: ReceiptType.STANDARD,
  qrSize: 8,
  useNativeQR: true,
  autoCut: false,
  feedLinesAfter: 4,
  copies: 1,
  timeout: 30000, // ms
  retryOnFail: false, // Disabled - adapter handles errors
  maxRetries: 0,
}

/**
 * PrintService class
 */
class PrintService {
  options: PrintOptions
  connectionManager: ConnectionManager
  _printQueue: unknown[]
  _currentJob: unknown
  _jobIdCounter: number
  _eventListeners: Map<string, Set<EventCallback>>

  /**
   * Create a PrintService instance
   * @param {object} options - Default options for all print jobs
   */
  constructor(options: PrintOptions = {}) {
    this.options = { ...DEFAULT_PRINT_OPTIONS, ...options }
    this.connectionManager = getConnectionManager()

    // Print job tracking
    this._printQueue = []
    this._currentJob = null
    this._jobIdCounter = 0

    // Event listeners
    this._eventListeners = new Map()
  }

  // ============================================================
  // MAIN PRINT METHODS
  // ============================================================

  /**
   * Print a voucher
   *
   * @param {object} voucher - Voucher data
   * @param {string} voucher.lnurl - LNURL for QR code
   * @param {number} voucher.satsAmount - Value in satoshis
   * @param {number} voucher.displayAmount - Price in display currency
   * @param {string} voucher.displayCurrency - Display currency code
   * @param {string} voucher.voucherSecret - 12-char voucher secret
   * @param {string} voucher.identifierCode - 8-char identifier
   * @param {number} voucher.commissionPercent - Commission (optional)
   * @param {number} voucher.expiresAt - Expiry timestamp (optional)
   * @param {string} voucher.issuedBy - Issuer username (optional)
   * @param {object} options - Print options (merged with defaults)
   * @returns {Promise<{success: boolean, jobId: string, error?: string}>}
   */
  async printVoucher(
    voucher: VoucherData,
    options: PrintOptions = {},
  ): Promise<PrintResult> {
    const opts: PrintOptions = { ...this.options, ...options }
    const jobId: string = this._createJobId()

    this._emit("jobStarted", { jobId, voucher })

    try {
      // Validate voucher data
      this._validateVoucher(voucher)

      // Build ESC/POS receipt (async to support logo loading)
      this._emit("jobStatus", { jobId, status: PrintStatus.PREPARING })
      const escposData: Uint8Array = await this._buildReceipt(voucher, opts)

      // Get adapter and print
      this._emit("jobStatus", { jobId, status: PrintStatus.SENDING })
      const adapter: BaseAdapter = await this.connectionManager.getActiveAdapter()

      // Attempt to print
      let success = false
      let lastError: Error | null = null
      let attempts = 0
      const maxAttempts: number = opts.retryOnFail ? (opts.maxRetries || 0) + 1 : 1

      while (!success && attempts < maxAttempts) {
        attempts++

        try {
          success = await (
            adapter as BaseAdapter & {
              print: (
                data: Uint8Array,
                opts?: Record<string, unknown>,
              ) => Promise<boolean>
            }
          ).print(escposData, {
            voucher,
            paperWidth: opts.paperWidth,
            qrMode: opts.useNativeQR ? "native" : "raster",
          })
        } catch (err: unknown) {
          lastError = err as Error
          if (attempts < maxAttempts) {
            // Wait before retry
            await this._sleep(1000)
          }
        }
      }

      if (success) {
        this._emit("jobStatus", { jobId, status: PrintStatus.COMPLETED })
        this._emit("jobCompleted", { jobId, adapter: adapter.type })
        return { success: true, jobId, adapter: adapter.type }
      } else {
        const error: string = lastError?.message || "Print failed"
        this._emit("jobStatus", { jobId, status: PrintStatus.FAILED, error })
        this._emit("jobFailed", { jobId, error })
        return { success: false, jobId, error }
      }
    } catch (err: unknown) {
      const errorMsg: string = (err as Error).message || "Unknown error"
      this._emit("jobStatus", { jobId, status: PrintStatus.FAILED, error: errorMsg })
      this._emit("jobFailed", { jobId, error: errorMsg })
      return { success: false, jobId, error: errorMsg }
    }
  }

  /**
   * Print a payment receipt (received-payment slip).
   *
   * Parallel to printVoucher() but builds via ReceiptBuilder and routes the
   * receipt context to the adapter so the companion app can build an
   * `app=payment` deep link (which works on Nyx/Bitcoinize printers).
   *
   * @param receipt - Pre-formatted receipt data (amount string already combined)
   * @param options - Print options (merged with defaults)
   */
  async printReceipt(
    receipt: ReceiptData,
    options: PrintOptions = {},
  ): Promise<PrintResult> {
    const opts: PrintOptions = { ...this.options, ...options }
    const jobId: string = this._createJobId()

    this._emit("jobStarted", { jobId, receipt })

    try {
      // Build ESC/POS receipt (async to support logo loading)
      this._emit("jobStatus", { jobId, status: PrintStatus.PREPARING })
      const escposData: Uint8Array = await this._buildPaymentReceipt(receipt, opts)

      // Get adapter and print
      this._emit("jobStatus", { jobId, status: PrintStatus.SENDING })
      const adapter: BaseAdapter = await this.connectionManager.getActiveAdapter()

      let success = false
      let lastError: Error | null = null
      let attempts = 0
      const maxAttempts: number = opts.retryOnFail ? (opts.maxRetries || 0) + 1 : 1

      while (!success && attempts < maxAttempts) {
        attempts++
        try {
          success = await (
            adapter as BaseAdapter & {
              print: (
                data: Uint8Array,
                opts?: Record<string, unknown>,
              ) => Promise<boolean>
            }
          ).print(escposData, {
            receipt,
            paperWidth: opts.paperWidth,
          })
        } catch (err: unknown) {
          lastError = err as Error
          if (attempts < maxAttempts) {
            await this._sleep(1000)
          }
        }
      }

      if (success) {
        this._emit("jobStatus", { jobId, status: PrintStatus.COMPLETED })
        this._emit("jobCompleted", { jobId, adapter: adapter.type })
        return { success: true, jobId, adapter: adapter.type }
      } else {
        const error: string = lastError?.message || "Print failed"
        this._emit("jobStatus", { jobId, status: PrintStatus.FAILED, error })
        this._emit("jobFailed", { jobId, error })
        return { success: false, jobId, error }
      }
    } catch (err: unknown) {
      const errorMsg: string = (err as Error).message || "Unknown error"
      this._emit("jobStatus", { jobId, status: PrintStatus.FAILED, error: errorMsg })
      this._emit("jobFailed", { jobId, error: errorMsg })
      return { success: false, jobId, error: errorMsg }
    }
  }

  /**
   * Build ESC/POS bytes for a payment receipt.
   * @private
   */
  async _buildPaymentReceipt(
    receipt: ReceiptData,
    options: PrintOptions,
  ): Promise<Uint8Array> {
    const builder = new ReceiptBuilder({
      paperWidth: options.paperWidth,
      autoCut: options.autoCut,
      feedLinesAfter: options.feedLinesAfter,
      showLogo: options.showLogo !== false,
    })
    if (options.showLogo !== false) {
      await builder.preloadLogo()
    }
    return builder.build(receipt).getBytes()
  }

  /**
   * Get ESC/POS data for a payment receipt without printing (preview/debug).
   */
  async getReceiptBytes(
    receipt: ReceiptData,
    options: PrintOptions = {},
  ): Promise<Uint8Array> {
    return this._buildPaymentReceipt(receipt, { ...this.options, ...options })
  }

  /**
   * Print multiple vouchers
   * @param {object[]} vouchers - Array of voucher data
   * @param {object} options - Print options
   * @returns {Promise<{results: Array, successCount: number, failCount: number}>}
   */
  async printVouchers(
    vouchers: VoucherData[],
    options: PrintOptions = {},
  ): Promise<BatchPrintResult> {
    const results: PrintResult[] = []
    let successCount = 0
    let failCount = 0

    for (const voucher of vouchers) {
      const result: PrintResult = await this.printVoucher(voucher, options)
      results.push(result)

      if (result.success) {
        successCount++
      } else {
        failCount++
      }

      // Small delay between prints
      if (vouchers.indexOf(voucher) < vouchers.length - 1) {
        await this._sleep(500)
      }
    }

    return { results, successCount, failCount, total: vouchers.length }
  }

  /**
   * Print using a specific adapter type
   * @param {object} voucher - Voucher data
   * @param {string} adapterType - Adapter type ('companion', 'webserial', 'pdf')
   * @param {object} options - Print options
   * @returns {Promise<{success: boolean, jobId: string, error?: string}>}
   */
  async printWithAdapter(
    voucher: VoucherData,
    adapterType: string,
    options: PrintOptions = {},
  ): Promise<PrintResult> {
    const adapter: BaseAdapter | null = this.connectionManager.getAdapter(adapterType)

    if (!adapter) {
      return {
        success: false,
        jobId: null as unknown as string,
        error: `Unknown adapter: ${adapterType}`,
      }
    }

    if (!(await adapter.isAvailable())) {
      return {
        success: false,
        jobId: null as unknown as string,
        error: `Adapter not available: ${adapterType}`,
      }
    }

    // Temporarily set as active adapter
    await this.connectionManager.setActiveAdapter(adapter)

    return this.printVoucher(voucher, options)
  }

  // ============================================================
  // RECEIPT BUILDING
  // ============================================================

  /**
   * Build ESC/POS receipt from voucher
   * @private
   */
  async _buildReceipt(voucher: VoucherData, options: PrintOptions): Promise<Uint8Array> {
    const receipt = new VoucherReceipt({
      paperWidth: options.paperWidth,
      qrSize: options.qrSize,
      useNativeQR: options.useNativeQR,
      autoCut: options.autoCut,
      feedLinesAfter: options.feedLinesAfter,
      showLogo: options.showLogo !== false, // Default to true
    })

    // Preload logo for non-minimal receipts
    if (options.receiptType !== ReceiptType.MINIMAL) {
      await receipt.preloadLogo()
    }

    // Cast voucher to satisfy VoucherReceipt's stricter JSDoc-inferred param types
    // (the JS source uses @param with required fields, but our VoucherData has optional ones)
    const voucherArg: VoucherReceiptData = voucher as VoucherReceiptData

    switch (options.receiptType) {
      case ReceiptType.MINIMAL:
        receipt.buildMinimal(voucherArg)
        break
      case ReceiptType.REISSUE:
        receipt.buildReissue(voucherArg)
        break
      case ReceiptType.STANDARD:
      default:
        receipt.build(voucherArg)
        break
    }

    return receipt.getBytes()
  }

  /**
   * Get ESC/POS data without printing (for preview/debugging)
   * @param {object} voucher - Voucher data
   * @param {object} options - Receipt options
   * @returns {Promise<Uint8Array>}
   */
  async getReceiptData(
    voucher: VoucherData,
    options: PrintOptions = {},
  ): Promise<Uint8Array> {
    return this._buildReceipt(voucher, { ...this.options, ...options })
  }

  /**
   * Get receipt as Base64 (for deep links)
   * @param {object} voucher - Voucher data
   * @param {object} options - Receipt options
   * @returns {Promise<string>}
   */
  async getReceiptBase64(
    voucher: VoucherData,
    options: PrintOptions = {},
  ): Promise<string> {
    const receipt = new VoucherReceipt({
      paperWidth: options.paperWidth || this.options.paperWidth,
      showLogo: options.showLogo !== false,
      ...options,
    })

    const type: string = options.receiptType || ReceiptType.STANDARD

    // Preload logo for non-minimal receipts
    if (type !== ReceiptType.MINIMAL) {
      await receipt.preloadLogo()
    }

    const voucherArg: VoucherReceiptData = voucher as VoucherReceiptData

    switch (type) {
      case ReceiptType.MINIMAL:
        receipt.buildMinimal(voucherArg)
        break
      case ReceiptType.REISSUE:
        receipt.buildReissue(voucherArg)
        break
      default:
        receipt.build(voucherArg)
    }

    return receipt.toBase64()
  }

  // ============================================================
  // CONNECTION & ADAPTER MANAGEMENT
  // ============================================================

  /**
   * Get available print methods for current platform
   * @returns {Promise<Array<{type: string, name: string, available: boolean, recommended: boolean}>>}
   */
  async getAvailableMethods(): Promise<AvailableMethod[]> {
    const adapters = await this.connectionManager.getAvailableAdapters()
    return adapters.map(({ adapter, available, recommended }) => ({
      type: adapter.type,
      name: adapter.name,
      available,
      recommended,
    }))
  }

  /**
   * Get printing recommendations for current platform
   * @returns {Promise<object>}
   */
  async getRecommendations(): Promise<Record<string, unknown>> {
    return this.connectionManager.getRecommendations() as unknown as Promise<
      Record<string, unknown>
    >
  }

  /**
   * Set preferred print method
   * @param {string} adapterType
   * @returns {Promise<boolean>}
   */
  async setPreferredMethod(adapterType: string): Promise<boolean> {
    return this.connectionManager.setActiveAdapter(adapterType)
  }

  /**
   * Get current printer connection status
   * @returns {string}
   */
  async getConnectionStatus(): Promise<string | null> {
    const adapter: BaseAdapter = await this.connectionManager.getActiveAdapter()
    return adapter.getStatus() as string | null
  }

  /**
   * Connect to printer
   * @returns {Promise<boolean>}
   */
  async connect(): Promise<boolean> {
    const adapter: BaseAdapter = await this.connectionManager.getActiveAdapter()
    return adapter.connect()
  }

  /**
   * Disconnect from printer
   * @returns {Promise<void>}
   */
  async disconnect(): Promise<void> {
    const adapter: BaseAdapter = await this.connectionManager.getActiveAdapter()
    return adapter.disconnect()
  }

  // ============================================================
  // DEEP LINK HELPERS (for mobile companion app)
  // ============================================================

  /**
   * Get deep link URL for printing voucher
   * Useful for generating QR codes or links to open companion app
   *
   * @param {object} voucher - Voucher data
   * @param {object} options - Options
   * @returns {Promise<string>}
   */
  async getDeepLinkUrl(
    voucher: VoucherData,
    options: PrintOptions = {},
  ): Promise<string> {
    const CompanionAdapter: BaseAdapter | null =
      this.connectionManager.getAdapter("companion")
    if (!CompanionAdapter) {
      throw new Error("Companion adapter not available")
    }

    const escposData: Uint8Array = await this._buildReceipt(voucher, {
      ...this.options,
      ...options,
    })
    return (
      CompanionAdapter as BaseAdapter & {
        getDeepLinkUrl: (data: Uint8Array, opts: Record<string, unknown>) => string
      }
    ).getDeepLinkUrl(escposData, {
      voucher,
      paperWidth: options.paperWidth || this.options.paperWidth,
    })
  }

  /**
   * Check if companion app is likely installed
   * @returns {boolean}
   */
  isCompanionAppLikely(): boolean {
    const adapter = this.connectionManager.getAdapter("companion") as
      | (BaseAdapter & { isMobile?: () => boolean })
      | null
    return adapter?.isMobile?.() || false
  }

  /**
   * Get app store link for companion app
   * @returns {string|null}
   */
  getCompanionAppLink(): string | null {
    const adapter = this.connectionManager.getAdapter("companion") as
      | (BaseAdapter & { getAppStoreLink?: () => string })
      | null
    return adapter?.getAppStoreLink?.() || null
  }

  // ============================================================
  // VALIDATION
  // ============================================================

  /**
   * Validate voucher data
   * @private
   */
  _validateVoucher(voucher: VoucherData): void {
    if (!voucher) {
      throw new Error("Voucher data is required")
    }

    if (!voucher.lnurl) {
      throw new Error("Voucher must have an LNURL")
    }

    if (!voucher.satsAmount && voucher.satsAmount !== 0) {
      throw new Error("Voucher must have satsAmount")
    }
  }

  // ============================================================
  // JOB MANAGEMENT
  // ============================================================

  /**
   * Create unique job ID
   * @private
   */
  _createJobId(): string {
    return `print-${Date.now()}-${++this._jobIdCounter}`
  }

  // ============================================================
  // EVENTS
  // ============================================================

  /**
   * Add event listener
   * @param {string} event - Event name
   * @param {function} callback - Handler
   * @returns {function} Unsubscribe function
   */
  on(event: string, callback: EventCallback): () => void {
    if (!this._eventListeners.has(event)) {
      this._eventListeners.set(event, new Set())
    }
    this._eventListeners.get(event)!.add(callback)
    return () => this.off(event, callback)
  }

  /**
   * Remove event listener
   * @param {string} event
   * @param {function} callback
   */
  off(event: string, callback: EventCallback): void {
    const listeners: Set<EventCallback> | undefined = this._eventListeners.get(event)
    if (listeners) {
      listeners.delete(callback)
    }
  }

  /**
   * Emit event
   * @private
   */
  _emit(event: string, data: Record<string, unknown> = {}): void {
    const listeners: Set<EventCallback> | undefined = this._eventListeners.get(event)
    if (listeners) {
      listeners.forEach((cb: EventCallback) => {
        try {
          cb(data)
        } catch (err: unknown) {
          console.error("Error in PrintService event handler:", err)
        }
      })
    }
  }

  // ============================================================
  // UTILITIES
  // ============================================================

  /**
   * Sleep utility
   * @private
   */
  _sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Get debug info
   * @returns {object}
   */
  getDebugInfo(): Record<string, unknown> {
    return {
      options: this.options,
      connectionManager: this.connectionManager.getDebugInfo(),
      pendingJobs: this._printQueue.length,
    }
  }
}

// Singleton instance
let _instance: PrintService | null = null

/**
 * Get singleton PrintService instance
 * @param {object} options - Options (only used on first call)
 * @returns {PrintService}
 */
function getPrintService(options: PrintOptions = {}): PrintService {
  if (!_instance) {
    _instance = new PrintService(options)
  }
  return _instance
}

export default PrintService
export { PrintService, getPrintService }
