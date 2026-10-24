/**
 * ESC/POS Thermal Printing Module for Blink Bitcoin Terminal
 *
 * This module provides thermal receipt printing capabilities for Blink vouchers.
 * It supports multiple connection methods to accommodate different devices and printers:
 *
 * - Companion App: Deep links to mobile app for Bluetooth printing
 * - Web Serial: Direct USB connection on desktop Chrome/Edge
 * - WebSocket: Network printers via bridge daemon
 * - PDF Fallback: System print dialog when thermal isn't available
 *
 * Quick Start:
 * ```javascript
 * import { getPrintService } from '@/lib/escpos';
 *
 * const printer = getPrintService();
 *
 * await printer.printVoucher({
 *   lnurl: 'LNURL1...',
 *   satsAmount: 5000,
 *   displayAmount: 100,
 *   displayCurrency: 'KES',
 *   voucherSecret: 'q6pvY79EftnZ',
 *   identifierCode: 'A1B2C3D4',
 * });
 * ```
 *
 * @module lib/escpos
 */

// Core components
export { default as ESCPOSBuilder } from "./ESCPOSBuilder"
export {
  default as VoucherReceipt,
  formatVoucherSecret,
  formatExpiry,
  formatSats,
} from "./VoucherReceipt"
export { default as ReceiptBuilder } from "./ReceiptBuilder"
export type { ReceiptData, ReceiptOptions } from "./ReceiptBuilder"
export {
  default as QRCodeRasterizer,
  imageDataToBitmap,
  matrixToBitmap,
} from "./QRCodeRasterizer"
export {
  loadLogoForPrint,
  preloadLogo,
  clearLogoCache,
  getBlinkLogoUrl,
  bitmapToESCPOS,
} from "./LogoRasterizer"

// Connection management
export {
  default as ConnectionManager,
  getConnectionManager,
  Platform,
  Browser,
  DeviceType,
} from "./ConnectionManager"

// Main service
export {
  default as PrintService,
  getPrintService,
  PrintStatus,
  ReceiptType,
} from "./PrintService"

// Re-export types from PrintService
export type {
  PrintOptions,
  VoucherData,
  PrintResult,
  BatchPrintResult,
  AvailableMethod,
  PrintStatusType,
  ReceiptTypeValue,
  EventCallback,
} from "./PrintService"

// Local imports for convenience functions below
import {
  getPrintService as _getPrintService,
  type AvailableMethod as _AvailableMethod,
} from "./PrintService"

// Adapters
export {
  default as BaseAdapter,
  AdapterStatus,
  AdapterCapabilities,
} from "./adapters/BaseAdapter"
export { default as CompanionAdapter, URL_SCHEMES } from "./adapters/CompanionAdapter"
export {
  default as WebSerialAdapter,
  SERIAL_CONFIGS,
  PRINTER_VENDORS,
} from "./adapters/WebSerialAdapter"
export { default as PDFAdapter } from "./adapters/PDFAdapter"
export { default as LocalPrintAdapter } from "./adapters/LocalPrintAdapter"

// React hooks
export { useThermalPrint } from "./hooks/useThermalPrint"

// Re-export commonly used types
export const PaperWidth = {
  MM_58: 58,
  MM_80: 80,
} as const

export type PaperWidthValue = (typeof PaperWidth)[keyof typeof PaperWidth]

export interface VoucherLike {
  lnurl: string
  satsAmount: number
  [key: string]: unknown
}

export interface PrintVoucherResult {
  success: boolean
  error?: string
}

/**
 * Quick print function - convenience wrapper
 *
 * @param {object} voucher - Voucher data
 * @param {object} options - Print options
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function printVoucher(
  voucher: VoucherLike,
  options: Record<string, unknown> = {},
): Promise<PrintVoucherResult> {
  const service = _getPrintService()
  return service.printVoucher(voucher as never, options)
}

/**
 * Get available printing methods
 * @returns {Promise<Array>}
 */
export async function getAvailablePrintMethods(): Promise<_AvailableMethod[]> {
  const service = _getPrintService()
  return service.getAvailableMethods()
}

/**
 * Get platform-specific recommendations
 * @returns {Promise<object>}
 */
export async function getPrintRecommendations(): Promise<Record<string, unknown>> {
  const service = _getPrintService()
  return service.getRecommendations()
}
