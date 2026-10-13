/**
 * PDFAdapter - Fallback adapter that uses existing PDF generation
 *
 * When thermal printing is not available, this adapter falls back to
 * generating a PDF voucher using the existing VoucherPDF system.
 *
 * This ensures users can ALWAYS print vouchers, even if:
 * - No thermal printer is available
 * - Web Serial is not supported
 * - Companion app is not installed
 * - Bluetooth connection fails
 *
 * The PDF can be:
 * - Printed via system print dialog
 * - Downloaded for later printing
 * - Shared via native share API
 */

import { isVoucherPdfEnabled } from "../../config/features"

import { BaseAdapter, AdapterStatus } from "./BaseAdapter"

/** Shown when the PDF fallback is the only option but voucher PDF is disabled. */
export const PDF_FALLBACK_DISABLED_MESSAGE =
  "No thermal printer connected. Connect the Blink companion app or a USB printer to print."

interface PDFAdapterOptions {
  format?: string
  autoDownload?: boolean
  autoPrint?: boolean
  openInNewTab?: boolean
  apiEndpoint?: string
}

interface PDFPrintOptions {
  voucher?: PDFVoucher
  format?: string
  [key: string]: unknown
}

interface PDFVoucher {
  identifierCode?: string
  satsAmount?: number
  lnurl?: string
  [key: string]: unknown
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: Required<PDFAdapterOptions> = {
  format: "thermal-80", // 'thermal-80', 'thermal-58', 'a4', 'letter'
  autoDownload: false, // Automatically download PDF
  autoPrint: false, // Automatically open print dialog
  openInNewTab: true, // Open PDF in new tab
  apiEndpoint: "/api/voucher/pdf", // PDF generation endpoint
}

/**
 * PDFAdapter class
 */
class PDFAdapter extends BaseAdapter {
  declare options: Required<PDFAdapterOptions>

  /**
   * Create a PDF adapter
   * @param {object} options - Adapter options
   */
  constructor(options: PDFAdapterOptions = {}) {
    super(options as Record<string, unknown>)
    this.options = { ...DEFAULT_OPTIONS, ...options }

    // PDF adapter has limited capabilities
    this.capabilities = new Set([
      // No native ESC/POS capabilities
      // This adapter converts to PDF instead
    ])
  }

  /**
   * Adapter type identifier
   * @returns {string}
   */
  get type(): string {
    return "pdf"
  }

  /**
   * Human-readable name
   * @returns {string}
   */
  get name(): string {
    return "PDF (System Print)"
  }

  /**
   * PDF adapter is always available as a fallback
   * @returns {Promise<boolean>}
   */
  async isAvailable(): Promise<boolean> {
    // Server-side voucher PDF generation is disabled: never offer this adapter.
    if (!isVoucherPdfEnabled()) return false
    // Available in any browser environment
    return typeof window !== "undefined"
  }

  /**
   * Connect (no-op for PDF adapter)
   * @returns {Promise<boolean>}
   */
  async connect(): Promise<boolean> {
    this._setStatus(AdapterStatus.CONNECTED)
    return true
  }

  /**
   * Disconnect (no-op for PDF adapter)
   * @returns {Promise<void>}
   */
  async disconnect(): Promise<void> {
    this._setStatus(AdapterStatus.DISCONNECTED)
  }

  /**
   * Print voucher as PDF
   *
   * Note: This adapter ignores ESC/POS data and uses voucher data directly
   *
   * @param {Uint8Array} data - ESC/POS data (ignored)
   * @param {object} options - Print options
   * @param {object} options.voucher - Voucher data for PDF generation
   * @returns {Promise<boolean>}
   */
  async print(data: Uint8Array, options: PDFPrintOptions = {}): Promise<boolean> {
    // Reached as ConnectionManager.getBestAdapter()'s last-resort fallback when
    // no real printer is available. Fail clearly (thrown so PrintService
    // surfaces the message) without calling the disabled PDF route.
    if (!isVoucherPdfEnabled()) {
      const error = new Error(PDF_FALLBACK_DISABLED_MESSAGE)
      this._setError(error)
      throw error
    }

    const voucher = options.voucher

    if (!voucher) {
      this._setError("PDF adapter requires voucher data in options")
      return false
    }

    this._setStatus(AdapterStatus.PRINTING)

    try {
      // Generate PDF via API or client-side
      const pdfBlob = await this._generatePDF(voucher, options)

      // Handle the PDF based on options
      if (this.options.autoDownload) {
        this._downloadPDF(pdfBlob, voucher)
      } else if (this.options.autoPrint) {
        await this._printPDF(pdfBlob)
      } else if (this.options.openInNewTab) {
        this._openPDF(pdfBlob)
      } else {
        // Return the blob for caller to handle
        this._setStatus(AdapterStatus.CONNECTED)
        this._emit("printed", { blob: pdfBlob })
        return true
      }

      this._setStatus(AdapterStatus.CONNECTED)
      this._emit("printed", { format: options.format || this.options.format })
      return true
    } catch (err: unknown) {
      this._setError(err instanceof Error ? err : new Error(String(err)))
      return false
    }
  }

  /**
   * Generate PDF from voucher data
   * @private
   * @param {object} voucher - Voucher data
   * @param {object} options - Generation options
   * @returns {Promise<Blob>}
   */
  private async _generatePDF(
    voucher: PDFVoucher,
    options: PDFPrintOptions = {},
  ): Promise<Blob> {
    const format = options.format || this.options.format

    // If we have an API endpoint, use server-side generation
    if (this.options.apiEndpoint && typeof fetch !== "undefined") {
      return this._generatePDFViaAPI(voucher, format)
    }

    // Otherwise try client-side generation
    return this._generatePDFClientSide(voucher, format)
  }

  /**
   * Generate PDF via API endpoint
   * @private
   */
  private async _generatePDFViaAPI(voucher: PDFVoucher, format: string): Promise<Blob> {
    const response = await fetch(this.options.apiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        voucher,
        format,
      }),
    })

    if (!response.ok) {
      throw new Error(`PDF generation failed: ${response.statusText}`)
    }

    return response.blob()
  }

  /**
   * Generate PDF client-side using @react-pdf/renderer
   * @private
   */
  private async _generatePDFClientSide(
    _voucher: PDFVoucher,
    _format: string,
  ): Promise<Blob> {
    // Client-side PDF generation is not supported in this adapter
    // Use the API endpoint instead
    throw new Error(
      "Client-side PDF generation not available. Use API endpoint or configure apiEndpoint option.",
    )
  }

  /**
   * Generate QR code data URL
   * @private
   */
  private async _generateQRDataUrl(data: string): Promise<string | null> {
    try {
      const QRCode: typeof import("qrcode") = await import("qrcode")
      return QRCode.toDataURL(data, {
        width: 200,
        margin: 1,
        errorCorrectionLevel: "M",
      })
    } catch (e: unknown) {
      console.warn("QR code generation failed:", e)
      return null
    }
  }

  /**
   * Get Blink logo data URL
   * @private
   */
  private async _getLogoDataUrl(): Promise<string | null> {
    // Try to load logo from public assets
    if (typeof fetch !== "undefined") {
      try {
        const response = await fetch("/logo-blink.png")
        const blob = await response.blob()
        return new Promise((resolve) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result as string)
          reader.readAsDataURL(blob)
        })
      } catch (_e: unknown) {
        return null
      }
    }
    return null
  }

  /**
   * Download PDF file
   * @private
   */
  private _downloadPDF(blob: Blob, voucher: PDFVoucher): void {
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `voucher-${voucher.identifierCode || "blink"}.pdf`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  /**
   * Open PDF in new tab
   * @private
   */
  private _openPDF(blob: Blob): void {
    const url = URL.createObjectURL(blob)
    window.open(url, "_blank")
    // Note: Don't revoke URL immediately as new tab needs it
    // Browser will clean up when tab is closed
  }

  /**
   * Open system print dialog for PDF
   * @private
   */
  private async _printPDF(blob: Blob): Promise<boolean> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob)

      // Create hidden iframe for printing
      const iframe = document.createElement("iframe")
      iframe.style.display = "none"
      iframe.src = url

      iframe.onload = () => {
        try {
          iframe.contentWindow!.print()
          // Give time for print dialog
          setTimeout(() => {
            document.body.removeChild(iframe)
            URL.revokeObjectURL(url)
            resolve(true)
          }, 1000)
        } catch (_e: unknown) {
          // Fallback: open in new tab
          window.open(url, "_blank")
          resolve(true)
        }
      }

      document.body.appendChild(iframe)
    })
  }

  /**
   * Get PDF blob for a voucher without printing
   * @param {object} voucher - Voucher data
   * @param {object} options - Generation options
   * @returns {Promise<Blob>}
   */
  async getPDFBlob(voucher: PDFVoucher, options: PDFPrintOptions = {}): Promise<Blob> {
    return this._generatePDF(voucher, options)
  }

  /**
   * Get PDF data URL for a voucher
   * @param {object} voucher - Voucher data
   * @param {object} options - Generation options
   * @returns {Promise<string>}
   */
  async getPDFDataUrl(
    voucher: PDFVoucher,
    options: PDFPrintOptions = {},
  ): Promise<string> {
    const blob = await this._generatePDF(voucher, options)
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  /**
   * Check if native share is available (for mobile)
   * @returns {boolean}
   */
  canShare(): boolean {
    return typeof navigator !== "undefined" && !!navigator.share
  }

  /**
   * Share PDF via native share API
   * @param {object} voucher - Voucher data
   * @param {object} options - Options
   * @returns {Promise<boolean>}
   */
  async sharePDF(voucher: PDFVoucher, options: PDFPrintOptions = {}): Promise<boolean> {
    if (!this.canShare()) {
      throw new Error("Native share not available")
    }

    const blob = await this._generatePDF(voucher, options)
    const file = new File([blob], `voucher-${voucher.identifierCode || "blink"}.pdf`, {
      type: "application/pdf",
    })

    try {
      await navigator.share({
        files: [file],
        title: "Blink Voucher",
        text: `Bitcoin voucher worth ${voucher.satsAmount} sats`,
      })
      return true
    } catch (e: unknown) {
      if ((e as Error).name === "AbortError") {
        // User cancelled
        return false
      }
      throw e
    }
  }
}

export default PDFAdapter
export { PDFAdapter }
