/**
 * usePrintReceipt - Builds and prints a payment receipt from PaymentData.
 *
 * Wraps useThermalPrint, converting the rich PaymentData available at
 * payment-success time into a ReceiptData (with a combined, preference-aware
 * amount string) and routing it through the ESC/POS print stack.
 *
 * Printing is always manual (invoked from the "Print Receipt" button on the
 * payment-success screen) — this hook never prints automatically.
 *
 * @module lib/hooks/usePrintReceipt
 */

import { useCallback, useMemo } from "react"

import {
  formatCombinedAmount,
  isBitcoinCurrency,
  type CurrencyMetadata,
} from "../currency-utils"
import { useThermalPrint } from "../escpos/hooks/useThermalPrint"
import type { ReceiptData } from "../escpos/ReceiptBuilder"
import {
  formatNumber,
  DEFAULT_AMOUNT_DISPLAY,
  type AmountDisplayPreference,
  type BitcoinFormatPreference,
  type NumberFormatPreference,
} from "../number-format"

import type { PaymentData } from "./useBlinkWebSocket"

interface UsePrintReceiptParams {
  amountDisplay?: AmountDisplayPreference
  numberFormat?: NumberFormatPreference
  bitcoinFormat?: BitcoinFormatPreference
  currencies?: CurrencyMetadata[]
  /** Paper width in mm (58 or 80). Defaults to the connection/service default. */
  paperWidth?: number
}

interface UsePrintReceiptReturn {
  /** Whether any thermal print method is available (controls button visibility) */
  printAvailable: boolean
  /** Print a receipt built from PaymentData. Throws on failure. */
  printReceipt: (payment: PaymentData) => Promise<void>
  isPrinting: boolean
}

export function usePrintReceipt({
  amountDisplay = DEFAULT_AMOUNT_DISPLAY,
  numberFormat = "auto",
  bitcoinFormat = "sats",
  currencies = [],
  paperWidth,
}: UsePrintReceiptParams = {}): UsePrintReceiptReturn {
  const {
    printReceipt: thermalPrintReceipt,
    printMethods,
    isPrinting,
  } = useThermalPrint()

  // Printing is available when at least one non-PDF method is available
  // (PDF is voucher-only; receipts use companion / local-server / webserial).
  const printAvailable = useMemo(
    () => printMethods.some((m) => m.available && m.type !== "pdf"),
    [printMethods],
  )

  const printReceipt = useCallback(
    async (payment: PaymentData): Promise<void> => {
      const sats = payment.satAmount ?? payment.amount

      // Combined, preference-ordered amount string (e.g. "5,000 sats ($50.00)").
      const amount = formatCombinedAmount(
        typeof sats === "number" ? sats : undefined,
        payment.displayAmount,
        payment.displayCurrency,
        amountDisplay,
        numberFormat,
        bitcoinFormat,
        currencies,
      )

      // Optional tip line for the receipt.
      let tipLine: string | undefined
      if (payment.tipAmount && payment.tipAmount > 0) {
        const tipCurrency = payment.tipCurrency
        const tipValue =
          tipCurrency && !isBitcoinCurrency(tipCurrency)
            ? formatCombinedAmount(
                undefined,
                payment.tipAmount,
                tipCurrency,
                "fiat-primary",
                numberFormat,
                bitcoinFormat,
                currencies,
              )
            : `${formatNumber(payment.tipAmount, numberFormat, 0)} sats`
        const pct =
          payment.tipPercent && payment.tipPercent > 0 ? ` (${payment.tipPercent}%)` : ""
        tipLine = `incl. ${tipValue} tip${pct}`
      }

      const receipt: ReceiptData = {
        amount,
        merchant: payment.merchant,
        memo: payment.memo,
        paymentHash: payment.paymentHash,
        timestamp: payment.timestamp,
        tipLine,
      }

      const opts: Record<string, unknown> = {}
      if (paperWidth) opts.paperWidth = paperWidth

      const result = await thermalPrintReceipt(
        receipt as unknown as Record<string, unknown>,
        opts,
      )
      if (!result.success) {
        throw new Error(result.error || "Printing failed")
      }
    },
    [
      amountDisplay,
      numberFormat,
      bitcoinFormat,
      currencies,
      paperWidth,
      thermalPrintReceipt,
    ],
  )

  return { printAvailable, printReceipt, isPrinting }
}

export default usePrintReceipt
