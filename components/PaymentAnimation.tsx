import { useEffect, useRef, useState } from "react"

import { playSound, SOUND_THEMES, type SoundThemeName } from "../lib/audio-utils"
import {
  formatCombinedAmount,
  isBitcoinCurrency,
  type CurrencyMetadata,
} from "../lib/currency-utils"
import type { PaymentData } from "../lib/hooks/useBlinkWebSocket"
import {
  formatBitcoinAmount,
  formatNumber,
  DEFAULT_AMOUNT_DISPLAY,
  type AmountDisplayPreference,
  type BitcoinFormatPreference,
  type NumberFormatPreference,
} from "../lib/number-format"

interface PaymentAnimationProps {
  show: boolean
  payment: PaymentData | null
  onHide: () => void
  soundEnabled?: boolean
  soundTheme?: SoundThemeName
  // Formatting preferences (so amounts render nicely + honor user settings)
  amountDisplay?: AmountDisplayPreference
  numberFormat?: NumberFormatPreference
  bitcoinFormat?: BitcoinFormatPreference
  currencies?: CurrencyMetadata[]
  // Optional "Print Receipt" action. When provided (and printAvailable), a
  // Print Receipt button is shown. Printing is always manual (button tap).
  onPrintReceipt?: (payment: PaymentData) => Promise<void> | void
  printAvailable?: boolean
}

/**
 * Auto-scale the primary amount font so long values don't overflow on small
 * POS screens. Mirrors the approach used in POS.tsx.
 */
function getPrimaryFontSizeClass(text: string): string {
  const len = text.length
  if (len <= 8) return "text-6xl"
  if (len <= 12) return "text-5xl"
  if (len <= 18) return "text-4xl"
  if (len <= 26) return "text-3xl"
  return "text-2xl"
}

export default function PaymentAnimation({
  show,
  payment,
  onHide,
  soundEnabled = true,
  soundTheme = "success",
  amountDisplay = DEFAULT_AMOUNT_DISPLAY,
  numberFormat = "auto",
  bitcoinFormat = "sats",
  currencies = [],
  onPrintReceipt,
  printAvailable = false,
}: PaymentAnimationProps) {
  const soundPlayedRef = useRef<boolean>(false)
  const [printState, setPrintState] = useState<"idle" | "printing" | "done" | "error">(
    "idle",
  )
  const [printError, setPrintError] = useState<string>("")

  // Play sound when animation shows (uses shared audio utility for iOS compatibility)
  useEffect(() => {
    if (show && soundEnabled && !soundPlayedRef.current) {
      soundPlayedRef.current = true
      const themeConfig = SOUND_THEMES[soundTheme] || SOUND_THEMES.success
      playSound(themeConfig.payment, 0.7)
    }

    // Reset state when animation is hidden
    if (!show) {
      soundPlayedRef.current = false
      setPrintState("idle")
      setPrintError("")
    }
  }, [show, soundEnabled, soundTheme])

  if (!show) return null

  const handleDone = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    onHide()
  }

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only stop propagation; do NOT dismiss on overlay click (prevents accidental
    // dismissals while still allowing the buttons to work).
    e.stopPropagation()
  }

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    e.stopPropagation()
  }

  const handlePrint = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (!payment || !onPrintReceipt || printState === "printing") return
    try {
      setPrintState("printing")
      setPrintError("")
      await onPrintReceipt(payment)
      setPrintState("done")
    } catch (err: unknown) {
      setPrintState("error")
      setPrintError(err instanceof Error ? err.message : "Printing failed")
    }
  }

  // ---------------------------------------------------------------------------
  // Derive the formatted amounts
  // ---------------------------------------------------------------------------

  const sats = payment?.satAmount ?? payment?.amount
  const hasFiat =
    payment?.displayAmount !== undefined &&
    !!payment?.displayCurrency &&
    !isBitcoinCurrency(payment.displayCurrency)

  // Primary / secondary amount strings, ordered by the amount-display preference.
  let primaryAmount = ""
  let secondaryAmount = ""

  if (payment) {
    const satsStr =
      typeof sats === "number"
        ? formatBitcoinAmount(sats, bitcoinFormat, numberFormat)
        : ""
    const fiatStr = hasFiat
      ? formatCombinedAmount(
          undefined,
          payment.displayAmount,
          payment.displayCurrency,
          amountDisplay,
          numberFormat,
          bitcoinFormat,
          currencies,
        )
      : ""

    if (!hasFiat) {
      // Bitcoin-only payment: sats is primary, no secondary.
      primaryAmount = satsStr || `${payment.amount}`
    } else if (amountDisplay === "sats-primary") {
      primaryAmount = satsStr
      secondaryAmount = fiatStr
    } else {
      primaryAmount = fiatStr
      secondaryAmount = satsStr
    }
  }

  // Tip line (only when a tip was actually applied)
  let tipLine = ""
  if (payment?.tipAmount && payment.tipAmount > 0) {
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

  const showPrintButton = printAvailable && !!onPrintReceipt

  return (
    <div
      className={`payment-overlay ${show ? "active" : ""}`}
      onClick={handleOverlayClick}
      onTouchStart={handleTouchStart}
      style={{
        backgroundColor: "rgba(34, 197, 94, 0.95)",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
      }}
    >
      {/* Main content area */}
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        {/* Checkmark */}
        <img src="/checkmark.png" alt="Success" className="w-[100px] h-[100px] mb-6" />

        {/* Payment info */}
        <div
          className="text-white text-center w-full max-w-md"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          <div className="text-2xl font-semibold mb-4 opacity-95">Payment Received</div>

          {payment && (
            <>
              {/* Primary amount */}
              <div
                className={`${getPrimaryFontSizeClass(primaryAmount)} font-bold leading-tight break-words`}
              >
                {primaryAmount}
              </div>

              {/* Secondary amount */}
              {secondaryAmount && (
                <div className="text-xl font-medium mt-1 opacity-80">
                  {secondaryAmount}
                </div>
              )}

              {/* Tip line */}
              {tipLine && <div className="text-base mt-2 opacity-80">{tipLine}</div>}

              {/* Merchant */}
              {payment.merchant && (
                <div className="text-sm mt-3 opacity-75">Paid to @{payment.merchant}</div>
              )}

              {/* Memo */}
              {payment.memo && (
                <div className="text-sm mt-4 opacity-75 max-w-md mx-auto break-words">
                  {payment.memo}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="px-6 pb-10 pt-6 w-full space-y-3">
        {showPrintButton && (
          <button
            onClick={handlePrint}
            disabled={printState === "printing"}
            className="w-full h-14 bg-transparent border-2 border-white hover:bg-white/10 text-white rounded-lg text-lg font-semibold transition-colors disabled:opacity-60"
            style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
          >
            {printState === "printing"
              ? "Printing…"
              : printState === "done"
                ? "Printed ✓"
                : printState === "error"
                  ? "Retry Print"
                  : "Print Receipt"}
          </button>
        )}

        {printState === "error" && printError && (
          <div className="text-white text-center text-sm opacity-90">{printError}</div>
        )}

        <button
          onClick={handleDone}
          className="w-full h-14 bg-white hover:bg-gray-100 text-green-600 rounded-lg text-xl font-semibold transition-colors shadow-lg"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          Done
        </button>
      </div>
    </div>
  )
}
