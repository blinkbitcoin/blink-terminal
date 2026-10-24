/**
 * ESCPOSBuilder - Pure ESC/POS command generator
 *
 * Design principles:
 * - No I/O, no side effects - pure command generation
 * - Chainable API for building complex receipts
 * - Supports both 58mm and 80mm paper widths
 * - Works in browser, Node.js, or React Native
 *
 * ESC/POS is the standard command language for thermal receipt printers.
 * Commands are sent as byte sequences that control text formatting,
 * images, barcodes, QR codes, and paper handling.
 */

import { asciiizeReceiptText } from "./asciiize"

type Alignment = "left" | "center" | "right"
type FontType = "A" | "B" | "C"
type ErrorCorrectionLevel = "L" | "M" | "Q" | "H"
type BarcodeType =
  | "UPC-A"
  | "UPC-E"
  | "EAN13"
  | "EAN8"
  | "CODE39"
  | "ITF"
  | "CODABAR"
  | "CODE93"
  | "CODE128"

interface ESCPOSBuilderOptions {
  paperWidth?: number
  encoding?: string
}

interface CenterLineOptions {
  bold?: boolean
  size?: number
}

interface LabelValueOptions {
  labelWidth?: number
  valueBold?: boolean
}

interface QRCodeOptions {
  size?: number
  errorCorrection?: ErrorCorrectionLevel
}

interface RasterImageOptions {
  mode?: number
}

interface BarcodeOptions {
  height?: number
  width?: number
  textPosition?: number
}

class ESCPOSBuilder {
  paperWidth: number
  encoding: string
  buffer: number[]
  dotsPerLine: number
  charsPerLine: number

  /**
   * Create a new ESC/POS command builder
   * @param {object} options - Configuration options
   * @param {number} options.paperWidth - Paper width in mm (58 or 80)
   * @param {string} options.encoding - Character encoding (default: 'cp437')
   */
  constructor(options: ESCPOSBuilderOptions = {}) {
    this.paperWidth = options.paperWidth || 80 // mm
    this.encoding = options.encoding || "cp437"
    this.buffer = []

    // Calculate print width in dots (8 dots/mm is standard for 203 DPI)
    // 58mm paper: ~48mm printable = 384 dots
    // 80mm paper: ~72mm printable = 576 dots
    this.dotsPerLine = this.paperWidth === 58 ? 384 : 576
    this.charsPerLine = this.paperWidth === 58 ? 32 : 48
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  /**
   * Initialize printer (ESC @)
   * MUST be called first - resets printer to default state
   * Resets: text formatting, character set, margins, line spacing
   * @returns {ESCPOSBuilder} this (for chaining)
   */
  initialize(): ESCPOSBuilder {
    this.buffer.push(0x1b, 0x40) // ESC @
    // Select CP437 code page (ESC t 0) for deterministic single-byte output.
    // Text is transliterated to ASCII before printing, so only the ASCII range
    // is ever used, but pinning the table avoids printer-default surprises.
    this.buffer.push(0x1b, 0x74, 0x00) // ESC t n (n=0 -> CP437)
    return this
  }

  /**
   * Reset text formatting to defaults
   * Use mid-receipt to clear accumulated formatting
   * @returns {ESCPOSBuilder}
   */
  resetFormatting(): ESCPOSBuilder {
    // Reset: bold off, underline off, double-strike off, size normal
    this.bold(false)
    this.underline(0)
    this.textSize(1, 1)
    this.align("left")
    return this
  }

  // ============================================================
  // TEXT FORMATTING
  // ============================================================

  /**
   * Set text alignment
   * @param {'left'|'center'|'right'} align - Text alignment
   * @returns {ESCPOSBuilder}
   */
  align(align: Alignment): ESCPOSBuilder {
    const alignCodes: Record<Alignment, number> = { left: 0, center: 1, right: 2 }
    this.buffer.push(0x1b, 0x61, alignCodes[align] || 0) // ESC a n
    return this
  }

  /**
   * Set bold/emphasis mode
   * @param {boolean} enabled - Enable bold
   * @returns {ESCPOSBuilder}
   */
  bold(enabled: boolean = true): ESCPOSBuilder {
    this.buffer.push(0x1b, 0x45, enabled ? 1 : 0) // ESC E n
    return this
  }

  /**
   * Set underline mode
   * @param {number} mode - 0=off, 1=1-dot, 2=2-dot
   * @returns {ESCPOSBuilder}
   */
  underline(mode: number = 1): ESCPOSBuilder {
    this.buffer.push(0x1b, 0x2d, Math.min(Math.max(mode, 0), 2)) // ESC - n
    return this
  }

  /**
   * Set text size (width and height multiplier)
   * @param {number} width - Width multiplier 1-8
   * @param {number} height - Height multiplier 1-8
   * @returns {ESCPOSBuilder}
   */
  textSize(width: number = 1, height: number = 1): ESCPOSBuilder {
    const w = Math.min(Math.max(width, 1), 8) - 1
    const h = Math.min(Math.max(height, 1), 8) - 1
    this.buffer.push(0x1d, 0x21, (w << 4) | h) // GS ! n
    return this
  }

  /**
   * Set double-width text
   * @param {boolean} enabled
   * @returns {ESCPOSBuilder}
   */
  doubleWidth(enabled: boolean = true): ESCPOSBuilder {
    return this.textSize(enabled ? 2 : 1, 1)
  }

  /**
   * Set double-height text
   * @param {boolean} enabled
   * @returns {ESCPOSBuilder}
   */
  doubleHeight(enabled: boolean = true): ESCPOSBuilder {
    return this.textSize(1, enabled ? 2 : 1)
  }

  /**
   * Set inverted (white on black) mode
   * @param {boolean} enabled
   * @returns {ESCPOSBuilder}
   */
  invert(enabled: boolean = true): ESCPOSBuilder {
    this.buffer.push(0x1d, 0x42, enabled ? 1 : 0) // GS B n
    return this
  }

  /**
   * Set character font
   * @param {'A'|'B'|'C'} font - Font selection (A is standard, B is smaller)
   * @returns {ESCPOSBuilder}
   */
  font(font: FontType = "A"): ESCPOSBuilder {
    const fontCodes: Record<FontType, number> = { A: 0, B: 1, C: 2 }
    this.buffer.push(0x1b, 0x4d, fontCodes[font] || 0) // ESC M n
    return this
  }

  // ============================================================
  // TEXT OUTPUT
  // ============================================================

  /**
   * Print raw text (no newline)
   * @param {string} text - Text to print
   * @returns {ESCPOSBuilder}
   */
  text(text: string): ESCPOSBuilder {
    // Transliterate to printer-safe ASCII first: the printer reads CP437, so
    // raw UTF-8 multi-byte chars (smart quotes, em dashes, accents) would print
    // as mojibake. asciiizeReceiptText maps them to ASCII equivalents.
    const safe = asciiizeReceiptText(text)
    const encoder = new TextEncoder()
    const bytes = encoder.encode(safe)
    this.buffer.push(...bytes)
    return this
  }

  /**
   * Print text and advance to next line
   * @param {string} text - Text to print
   * @returns {ESCPOSBuilder}
   */
  line(text: string = ""): ESCPOSBuilder {
    return this.text(text + "\n")
  }

  /**
   * Print centered line with optional formatting
   * @param {string} text - Text to center
   * @param {object} options - Formatting options
   * @param {boolean} options.bold - Make text bold
   * @param {number} options.size - Text size multiplier (1-8)
   * @returns {ESCPOSBuilder}
   */
  centerLine(text: string, options: CenterLineOptions = {}): ESCPOSBuilder {
    this.align("center")
    if (options.bold) this.bold(true)
    if (options.size) this.textSize(options.size, options.size)
    this.line(text)
    if (options.size) this.textSize(1, 1)
    if (options.bold) this.bold(false)
    this.align("left")
    return this
  }

  /**
   * Print a separator line
   * @param {string} char - Character to repeat
   * @returns {ESCPOSBuilder}
   */
  separator(char: string = "-"): ESCPOSBuilder {
    this.line(char.repeat(this.charsPerLine))
    return this
  }

  /**
   * Print a dashed separator (better looking)
   * @returns {ESCPOSBuilder}
   */
  dashedLine(): ESCPOSBuilder {
    return this.separator("-")
  }

  /**
   * Print a double-line separator (equals signs)
   * @returns {ESCPOSBuilder}
   */
  doubleLine(): ESCPOSBuilder {
    return this.separator("=")
  }

  /**
   * Print two-column row (label: value)
   * @param {string} label - Left column text
   * @param {string} value - Right column text
   * @param {object} options - Formatting options
   * @param {number} options.labelWidth - Label column width in chars
   * @param {boolean} options.valueBold - Make value bold
   * @returns {ESCPOSBuilder}
   */
  labelValue(
    label: string,
    value: string,
    options: LabelValueOptions = {},
  ): ESCPOSBuilder {
    const totalWidth = this.charsPerLine
    const labelWidth = options.labelWidth || 12
    const valueWidth = totalWidth - labelWidth

    const paddedLabel = label.padEnd(labelWidth).slice(0, labelWidth)
    const paddedValue = String(value).slice(0, valueWidth)

    if (options.valueBold) {
      this.text(paddedLabel)
      this.bold(true)
      this.line(paddedValue)
      this.bold(false)
    } else {
      this.line(paddedLabel + paddedValue)
    }
    return this
  }

  /**
   * Print a two-column row with right alignment for value
   * @param {string} left - Left text
   * @param {string} right - Right text
   * @returns {ESCPOSBuilder}
   */
  twoColumn(left: string, right: string): ESCPOSBuilder {
    const totalWidth = this.charsPerLine
    const leftStr = String(left)
    const rightStr = String(right)
    const padding = totalWidth - leftStr.length - rightStr.length

    if (padding > 0) {
      this.line(leftStr + " ".repeat(padding) + rightStr)
    } else {
      this.line(leftStr.slice(0, totalWidth - rightStr.length - 1) + " " + rightStr)
    }
    return this
  }

  /**
   * Print empty lines
   * @param {number} count - Number of blank lines
   * @returns {ESCPOSBuilder}
   */
  emptyLines(count: number = 1): ESCPOSBuilder {
    for (let i = 0; i < count; i++) {
      this.line("")
    }
    return this
  }

  // ============================================================
  // QR CODE (Native Printer Commands)
  // ============================================================

  /**
   * Print QR code using native GS ( k commands
   * This is the preferred method - smaller data, faster print
   * Works on most modern ESC/POS printers
   *
   * @param {string} data - QR code content (LNURL string, URL, etc.)
   * @param {object} options - QR code options
   * @param {number} options.size - Module size in dots (1-16, default 6)
   * @param {'L'|'M'|'Q'|'H'} options.errorCorrection - Error correction level
   * @returns {ESCPOSBuilder}
   */
  qrCode(data: string, options: QRCodeOptions = {}): ESCPOSBuilder {
    const size = Math.min(Math.max(options.size || 6, 1), 16)
    const ecLevel = (
      { L: 48, M: 49, Q: 50, H: 51 } as Record<ErrorCorrectionLevel, number>
    )[options.errorCorrection || "M"]

    const dataBytes = new TextEncoder().encode(data)
    const dataLen = dataBytes.length

    // GS ( k - QR Code commands (Function 165-181)
    // Reference: ESC/POS Application Programming Guide

    // 1. Select QR model (Model 2 for best compatibility)
    // GS ( k pL pH cn fn n1 n2
    // pL pH = 4 (parameter length), cn = 49 ('1'), fn = 65 ('A')
    // n1 = 50 ('2' for Model 2), n2 = 0
    this.buffer.push(0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00)

    // 2. Set module size
    // GS ( k pL pH cn fn n
    // pL pH = 3, cn = 49 ('1'), fn = 67 ('C'), n = size
    this.buffer.push(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size)

    // 3. Set error correction level
    // GS ( k pL pH cn fn n
    // pL pH = 3, cn = 49 ('1'), fn = 69 ('E'), n = level
    this.buffer.push(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, ecLevel)

    // 4. Store QR code data in symbol storage area
    // GS ( k pL pH cn fn m d1...dk
    // cn = 49 ('1'), fn = 80 ('P'), m = 48 ('0')
    const storeLen = dataLen + 3
    const pL = storeLen & 0xff
    const pH = (storeLen >> 8) & 0xff
    this.buffer.push(0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30)
    this.buffer.push(...dataBytes)

    // 5. Print the QR code from symbol storage
    // GS ( k pL pH cn fn m
    // pL pH = 3, cn = 49 ('1'), fn = 81 ('Q'), m = 48 ('0')
    this.buffer.push(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30)

    return this
  }

  /**
   * Print QR code with auto-sizing based on data length
   * Automatically selects appropriate module size
   * @param {string} data - QR code content
   * @returns {ESCPOSBuilder}
   */
  qrCodeAuto(data: string): ESCPOSBuilder {
    // Larger data needs smaller modules to fit
    const len = data.length
    let size = 6

    if (len > 500) size = 3
    else if (len > 300) size = 4
    else if (len > 150) size = 5

    return this.qrCode(data, { size, errorCorrection: "M" })
  }

  // ============================================================
  // RASTER IMAGE
  // ============================================================

  /**
   * Print raster image (1-bit monochrome bitmap)
   * Used for QR code fallback, logos, or custom graphics
   *
   * Image data format: Each byte contains 8 horizontal pixels
   * MSB is leftmost pixel, 1 = black (print), 0 = white (no print)
   *
   * @param {Uint8Array} imageData - 1-bit bitmap data
   * @param {number} width - Image width in pixels (should be multiple of 8)
   * @param {number} height - Image height in pixels
   * @param {object} options - Image options
   * @param {number} options.mode - 0=normal, 1=double width, 2=double height, 3=quadruple
   * @returns {ESCPOSBuilder}
   */
  rasterImage(
    imageData: Uint8Array,
    width: number,
    height: number,
    options: RasterImageOptions = {},
  ): ESCPOSBuilder {
    // GS v 0 - Print raster bit image
    // GS v 0 m xL xH yL yH d1...dk
    const bytesPerLine = Math.ceil(width / 8)
    const mode = options.mode || 0

    const xL = bytesPerLine & 0xff
    const xH = (bytesPerLine >> 8) & 0xff
    const yL = height & 0xff
    const yH = (height >> 8) & 0xff

    this.buffer.push(0x1d, 0x76, 0x30, mode, xL, xH, yL, yH)
    this.buffer.push(...imageData)

    return this
  }

  /**
   * Print image from canvas data
   * Converts RGBA canvas to 1-bit bitmap with threshold
   *
   * @param {ImageData} imageData - Canvas ImageData object
   * @param {number} width - Image width
   * @param {number} height - Image height
   * @param {number} threshold - Grayscale threshold for black (0-255, default 128)
   * @returns {ESCPOSBuilder}
   */
  imageFromCanvas(
    imageData: { data: Uint8Array | number[]; [key: string]: unknown },
    width: number,
    height: number,
    threshold: number = 128,
  ): ESCPOSBuilder {
    const { data } = imageData
    const bytesPerRow = Math.ceil(width / 8)
    const bitmap = new Uint8Array(bytesPerRow * height)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * width + x) * 4
        const r = data[pixelIndex]
        const g = data[pixelIndex + 1]
        const b = data[pixelIndex + 2]

        // Convert to grayscale and threshold
        const gray = (r + g + b) / 3
        const isBlack = gray < threshold

        if (isBlack) {
          const byteIndex = y * bytesPerRow + Math.floor(x / 8)
          const bitIndex = 7 - (x % 8)
          bitmap[byteIndex] |= 1 << bitIndex
        }
      }
    }

    return this.rasterImage(bitmap, width, height)
  }

  // ============================================================
  // PAPER CONTROL
  // ============================================================

  /**
   * Feed paper by n lines
   * @param {number} lines - Number of lines to feed
   * @returns {ESCPOSBuilder}
   */
  feed(lines: number = 1): ESCPOSBuilder {
    this.buffer.push(0x1b, 0x64, Math.min(Math.max(lines, 0), 255)) // ESC d n
    return this
  }

  /**
   * Feed paper by n dots
   * @param {number} dots - Number of dots to feed
   * @returns {ESCPOSBuilder}
   */
  feedDots(dots: number): ESCPOSBuilder {
    this.buffer.push(0x1b, 0x4a, Math.min(Math.max(dots, 0), 255)) // ESC J n
    return this
  }

  /**
   * Full paper cut
   * @returns {ESCPOSBuilder}
   */
  cut(): ESCPOSBuilder {
    this.feed(3) // Feed before cut to clear print head
    this.buffer.push(0x1d, 0x56, 0x00) // GS V 0 (full cut)
    return this
  }

  /**
   * Partial paper cut (leaves small connection)
   * Preferred for receipt paper - easier to tear
   * @returns {ESCPOSBuilder}
   */
  partialCut(): ESCPOSBuilder {
    this.feed(3)
    this.buffer.push(0x1d, 0x56, 0x01) // GS V 1 (partial cut)
    return this
  }

  /**
   * Cut with feed
   * @param {number} feedLines - Lines to feed before cut
   * @param {boolean} partial - Use partial cut
   * @returns {ESCPOSBuilder}
   */
  cutWithFeed(feedLines: number = 3, partial: boolean = true): ESCPOSBuilder {
    this.feed(feedLines)
    this.buffer.push(0x1d, 0x56, partial ? 0x01 : 0x00)
    return this
  }

  // ============================================================
  // CASH DRAWER
  // ============================================================

  /**
   * Open cash drawer
   * @param {number} pin - Drawer pin (2 or 5)
   * @param {number} onTime - On time in 2ms units
   * @param {number} offTime - Off time in 2ms units
   * @returns {ESCPOSBuilder}
   */
  openDrawer(pin: number = 2, onTime: number = 50, offTime: number = 50): ESCPOSBuilder {
    const m = pin === 5 ? 1 : 0
    this.buffer.push(0x1b, 0x70, m, onTime, offTime) // ESC p m t1 t2
    return this
  }

  // ============================================================
  // BARCODE
  // ============================================================

  /**
   * Print barcode
   * @param {string} data - Barcode data
   * @param {string} type - Barcode type
   * @param {object} options - Barcode options
   * @returns {ESCPOSBuilder}
   */
  barcode(
    data: string,
    type: BarcodeType = "CODE128",
    options: BarcodeOptions = {},
  ): ESCPOSBuilder {
    const types: Record<BarcodeType, number> = {
      "UPC-A": 65,
      "UPC-E": 66,
      "EAN13": 67,
      "EAN8": 68,
      "CODE39": 69,
      "ITF": 70,
      "CODABAR": 71,
      "CODE93": 72,
      "CODE128": 73,
    }

    const typeCode = types[type] || 73
    const height = options.height || 50
    const width = options.width || 2
    const position = options.textPosition || 0 // 0=none, 1=above, 2=below, 3=both

    // Set barcode height
    this.buffer.push(0x1d, 0x68, height) // GS h n

    // Set barcode width
    this.buffer.push(0x1d, 0x77, width) // GS w n

    // Set HRI position
    this.buffer.push(0x1d, 0x48, position) // GS H n

    // Print barcode
    const dataBytes = new TextEncoder().encode(data)
    this.buffer.push(0x1d, 0x6b, typeCode, dataBytes.length, ...dataBytes)

    return this
  }

  // ============================================================
  // OUTPUT
  // ============================================================

  /**
   * Get the built command buffer as Uint8Array
   * @returns {Uint8Array}
   */
  build(): Uint8Array {
    return new Uint8Array(this.buffer)
  }

  /**
   * Get buffer length
   * @returns {number}
   */
  get length(): number {
    return this.buffer.length
  }

  /**
   * Get as base64 string (for URL encoding in deep links)
   * @returns {string}
   */
  toBase64(): string {
    const bytes = this.build()
    let binary = ""
    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }
    // Use btoa in browser, Buffer in Node
    if (typeof btoa !== "undefined") {
      return btoa(binary)
    } else if (typeof Buffer !== "undefined") {
      return Buffer.from(bytes).toString("base64")
    }
    throw new Error("No base64 encoding available")
  }

  /**
   * Create from base64 string
   * @param {string} base64 - Base64 encoded ESC/POS data
   * @returns {Uint8Array}
   */
  static fromBase64(base64: string): Uint8Array {
    if (typeof atob !== "undefined") {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      return bytes
    } else if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(base64, "base64"))
    }
    throw new Error("No base64 decoding available")
  }

  /**
   * Get as hex string (for debugging)
   * @returns {string}
   */
  toHex(): string {
    return Array.from(this.build())
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")
  }

  /**
   * Get human-readable representation (for debugging)
   * @returns {string}
   */
  toString(): string {
    return `ESCPOSBuilder(${this.paperWidth}mm, ${this.buffer.length} bytes)`
  }

  /**
   * Clone the builder
   * @returns {ESCPOSBuilder}
   */
  clone(): ESCPOSBuilder {
    const cloned = new ESCPOSBuilder({
      paperWidth: this.paperWidth,
      encoding: this.encoding,
    })
    cloned.buffer = [...this.buffer]
    return cloned
  }

  /**
   * Append another builder's commands
   * @param {ESCPOSBuilder} other - Another builder to append
   * @returns {ESCPOSBuilder}
   */
  append(other: ESCPOSBuilder): ESCPOSBuilder {
    this.buffer.push(...other.buffer)
    return this
  }

  /**
   * Append raw bytes
   * @param {...number} bytes - Bytes to append
   * @returns {ESCPOSBuilder}
   */
  raw(...bytes: number[]): ESCPOSBuilder {
    this.buffer.push(...bytes)
    return this
  }
}

export default ESCPOSBuilder
export type {
  Alignment,
  FontType,
  ErrorCorrectionLevel,
  BarcodeType,
  ESCPOSBuilderOptions,
  CenterLineOptions,
  LabelValueOptions,
  QRCodeOptions,
  RasterImageOptions,
  BarcodeOptions,
}
