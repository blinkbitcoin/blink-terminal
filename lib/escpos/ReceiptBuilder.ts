/**
 * ReceiptBuilder - High-level payment-receipt layout builder for ESC/POS printers
 *
 * Produces a thermal payment receipt matching the agreed mockup:
 *
 *         [Blink logo]
 *   ================================
 *   Date: 2026-01-05
 *   Time: 11:30 pm
 *   Merchant: <username>
 *   Memo: drinks
 *   Amount : 5,000 sats ($50.00)
 *   ================================
 *            Payment Hash
 *    787ec76dcafd20c1908eb0936a12f...
 *               Thank You!
 *   ================================
 *
 * The `amount` string is pre-formatted by the caller (via formatCombinedAmount)
 * so the ESC/POS layer doesn't need the currency metadata list. The order of
 * sats vs fiat in that string follows the user's amount-display preference.
 *
 * Mirrors the structure/approach of VoucherReceipt.ts and reuses the generic
 * ESCPOSBuilder + LogoRasterizer. Supports 58mm and 80mm paper.
 */

import ESCPOSBuilder from "./ESCPOSBuilder"
import { loadLogoForPrint, getBlinkLogoUrl, bitmapToESCPOS } from "./LogoRasterizer"

export interface ReceiptData {
  /** Pre-formatted amount line, e.g. "5,000 sats ($50.00)" or "$50.00 (5,000 sats)" */
  amount: string
  /** Merchant / Blink username the payment was made to */
  merchant?: string
  /** Memo / description */
  memo?: string
  /** Lightning payment hash (hex) */
  paymentHash?: string
  /** Payment timestamp (ms since epoch). Defaults to now. */
  timestamp?: number
  /** Optional pre-formatted tip line, e.g. "incl. $0.15 tip (15%)" */
  tipLine?: string
}

export interface ReceiptOptions {
  paperWidth?: number
  showLogo?: boolean
  logoUrl?: string | null
  autoCut?: boolean
  partialCut?: boolean
  feedLinesAfter?: number
  compactMode?: boolean
}

interface LogoData {
  bitmap: Uint8Array
  width: number
  height: number
  bytesPerRow: number
}

type RequiredReceiptOptions = Required<ReceiptOptions>

const DEFAULT_OPTIONS: RequiredReceiptOptions = {
  paperWidth: 80,
  showLogo: true,
  logoUrl: null,
  autoCut: false,
  partialCut: true,
  feedLinesAfter: 4,
  compactMode: false,
}

/**
 * Format a date as "YYYY-MM-DD".
 */
function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/**
 * Format a time as "h:mm am/pm".
 */
function formatTime(date: Date): string {
  let hours = date.getHours()
  const minutes = String(date.getMinutes()).padStart(2, "0")
  const ampm = hours >= 12 ? "pm" : "am"
  hours = hours % 12
  if (hours === 0) hours = 12
  return `${hours}:${minutes} ${ampm}`
}

/**
 * ReceiptBuilder - builds ESC/POS commands for a Blink payment receipt
 */
class ReceiptBuilder {
  options: RequiredReceiptOptions
  builder: ESCPOSBuilder
  _logoData: LogoData | null

  /**
   * Create a payment receipt and return the ESC/POS bytes.
   */
  static createStandard(data: ReceiptData, options: ReceiptOptions = {}): Uint8Array {
    return new ReceiptBuilder(options).build(data).getBytes()
  }

  /**
   * Create a payment receipt and return Base64 (for companion deep links / local server).
   */
  static createBase64(data: ReceiptData, options: ReceiptOptions = {}): string {
    return new ReceiptBuilder(options).build(data).toBase64()
  }

  constructor(options: ReceiptOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.builder = new ESCPOSBuilder({ paperWidth: this.options.paperWidth })
    this._logoData = null
  }

  /**
   * Pre-load the logo for faster build. Call before build() to avoid async in build.
   */
  async preloadLogo(): Promise<void> {
    if (!this.options.showLogo) return
    try {
      const logoUrl = this.options.logoUrl || getBlinkLogoUrl()
      this._logoData = await loadLogoForPrint(logoUrl, {
        paperWidth: this.options.paperWidth,
      })
    } catch (err: unknown) {
      console.warn("[ReceiptBuilder] Failed to load logo:", (err as Error).message)
      this._logoData = null
    }
  }

  /**
   * Build the payment receipt.
   *
   * Note: paper width is fixed at construction (it determines the underlying
   * ESCPOSBuilder character width). Any `paperWidth` passed in `options` here is
   * ignored so the layout math (label widths, hash wrapping) can never diverge
   * from the actual printer width. Other options (autoCut, feedLinesAfter, etc.)
   * may still be overridden per build.
   *
   * @returns this (for chaining)
   */
  build(data: ReceiptData, options: ReceiptOptions = {}): ReceiptBuilder {
    // Merge non-width options, but force paperWidth to the constructor value so
    // it stays in sync with the underlying ESCPOSBuilder (single source of truth).
    const opts: RequiredReceiptOptions = {
      ...this.options,
      ...options,
      paperWidth: this.options.paperWidth,
    }
    const b = this.builder
    const compact = opts.compactMode || opts.paperWidth === 58
    const labelWidth = compact ? 9 : 11

    b.initialize()

    // ===== HEADER WITH LOGO =====
    b.align("center")
    if (opts.showLogo && this._logoData) {
      this._printLogo(this._logoData)
      b.emptyLines(1)
    } else {
      b.bold(true)
      b.textSize(2, 2)
      b.line("blink")
      b.textSize(1, 1)
      b.bold(false)
      b.emptyLines(1)
    }

    // ===== DETAILS SECTION =====
    b.doubleLine()
    b.align("left")

    const date = new Date(data.timestamp || Date.now())
    b.labelValue("Date:", formatDate(date), { labelWidth })
    b.labelValue("Time:", formatTime(date), { labelWidth })

    if (data.merchant) {
      b.labelValue("Merchant:", data.merchant, { labelWidth })
    }

    if (data.memo) {
      b.labelValue("Memo:", data.memo, { labelWidth })
    }

    b.labelValue("Amount:", data.amount, { labelWidth, valueBold: true })

    if (data.tipLine) {
      b.line(data.tipLine)
    }

    // ===== PAYMENT HASH SECTION =====
    b.doubleLine()

    if (data.paymentHash) {
      b.align("center")
      b.bold(true)
      b.line("Payment Hash")
      b.bold(false)
      this._printWrappedHash(data.paymentHash)
      b.emptyLines(1)
    }

    // ===== THANK YOU =====
    b.align("center")
    b.bold(true)
    b.line("Thank You!")
    b.bold(false)

    b.doubleLine()

    // Paper feed and optional auto-cut
    if (opts.autoCut) {
      if (opts.partialCut) {
        b.partialCut()
      } else {
        b.cut()
      }
    } else {
      b.feed(opts.feedLinesAfter)
    }

    return this
  }

  /**
   * Print the payment hash wrapped to the printer's line width, centered.
   *
   * Wraps based on the underlying ESCPOSBuilder's actual `charsPerLine` so the
   * wrapping always matches the real paper width (single source of truth).
   * @private
   */
  _printWrappedHash(hash: string): void {
    const b = this.builder
    const width = b.charsPerLine
    for (let i = 0; i < hash.length; i += width) {
      b.line(hash.slice(i, i + width))
    }
  }

  /**
   * Print a rasterized logo image.
   * @private
   */
  _printLogo(logoData: LogoData): void {
    if (!logoData || !logoData.bitmap) return
    const { bitmap, width, height } = logoData
    const escposData = bitmapToESCPOS(bitmap, width, height, 0)
    this.builder.raw(...escposData)
  }

  /**
   * Get the built ESC/POS commands as Uint8Array.
   */
  getBytes(): Uint8Array {
    return this.builder.build()
  }

  /**
   * Get the built ESC/POS commands as Base64 string.
   */
  toBase64(): string {
    return this.builder.toBase64()
  }

  /**
   * Get the underlying ESCPOSBuilder for advanced customization.
   */
  getBuilder(): ESCPOSBuilder {
    return this.builder
  }

  get byteCount(): number {
    return this.builder.length
  }
}

export default ReceiptBuilder
export { DEFAULT_OPTIONS, formatDate, formatTime }
