import React from "react"

import { THEMES, type Theme } from "../lib/hooks/useTheme"
import type { NumpadLayoutPreference } from "../lib/number-format"

type ButtonType =
  | "digit"
  | "plus"
  | "clear"
  | "backspace"
  | "decimal"
  | "currencyToggle"
  | "ok"
type AccentColor = "blue" | "purple"
type VoucherCurrencyMode = "BTC" | "USD"

interface NumpadProps {
  theme?: Theme
  layout?: NumpadLayoutPreference
  onDigitPress: (digit: string) => void
  onClear: () => void
  onBackspace: () => void
  onPlusPress?: () => void
  onOkPress: () => void
  okDisabled?: boolean
  okLabel?: string
  decimalDisabled?: boolean
  plusDisabled?: boolean
  accentColor?: AccentColor
  showPlus?: boolean
  showCurrencyToggle?: boolean
  voucherCurrencyMode?: VoucherCurrencyMode
  onCurrencyToggle?: () => void
}

export default function Numpad({
  theme = THEMES.DARK,
  layout = "calculator",
  onDigitPress,
  onClear,
  onBackspace,
  onPlusPress,
  onOkPress,
  okDisabled = false,
  okLabel = "OK",
  decimalDisabled = false,
  plusDisabled = false,
  accentColor = "blue",
  showPlus = true,
  showCurrencyToggle = false,
  voucherCurrencyMode = "BTC",
  onCurrencyToggle,
}: NumpadProps) {
  const isBlinkClassicDark = theme === THEMES.BLINK_CLASSIC_DARK
  const isBlinkClassicLight = theme === THEMES.BLINK_CLASSIC_LIGHT
  const isBlinkClassic = isBlinkClassicDark || isBlinkClassicLight

  // Base button styles for different themes
  const getButtonClasses = (type: ButtonType = "digit"): string => {
    if (isBlinkClassicDark) {
      // BC Dark (main-app keypad, issue #44): transparent bg, #393939 1px border,
      // 28px digits, hover → #1D1D1D bg + #FFAD0D border. C/backspace amber.
      const baseClassic =
        "h-16 md:h-20 bg-transparent border border-blink-classic-border hover:bg-blink-classic-bg hover:border-blink-classic-amber rounded-xl text-[28px] leading-8 font-bold transition-colors"

      switch (type) {
        case "digit":
          return `${baseClassic} text-white`
        case "plus":
          return `${baseClassic} text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center`
        case "clear":
          return `${baseClassic} text-blink-classic-amber`
        case "backspace":
          return `${baseClassic} text-blink-classic-amber flex items-center justify-center`
        case "decimal":
          return `${baseClassic} text-white disabled:opacity-50 disabled:cursor-not-allowed`
        case "currencyToggle": {
          // Dynamic border and text color based on voucher currency mode
          const toggleColorDark =
            voucherCurrencyMode === "BTC"
              ? "border-orange-500 text-orange-500 hover:border-orange-400 hover:text-orange-400"
              : "border-green-500 text-green-500 hover:border-green-400 hover:text-green-400"
          return `h-16 md:h-20 bg-transparent border ${toggleColorDark} rounded-xl text-[28px] leading-8 font-bold transition-colors flex items-center justify-center`
        }
        case "ok":
          // 2px green (success) border + green text, 24px label — matches the design.
          return "h-[136px] md:h-[172px] bg-transparent border-2 border-success hover:bg-blink-classic-bg rounded-xl text-[24px] font-bold transition-colors text-success disabled:opacity-50 disabled:cursor-not-allowed row-span-2 flex items-center justify-center"
        default:
          return baseClassic
      }
    }

    if (isBlinkClassicLight) {
      // BC Light (main-app keypad, issue #44): transparent bg, #E2E2E4 1px border,
      // 28px digits, hover → #F2F2F4 bg. C/backspace primary orange (#FC5805).
      const baseClassic =
        "h-16 md:h-20 bg-transparent border border-blink-classic-border-light hover:bg-blink-classic-hover-light hover:border-blink-classic-amber rounded-xl text-[28px] leading-8 font-bold transition-colors"

      switch (type) {
        case "digit":
          return `${baseClassic} text-black`
        case "plus":
          return `${baseClassic} text-black disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center`
        case "clear":
          return `${baseClassic} text-blink-primary`
        case "backspace":
          return `${baseClassic} text-blink-primary flex items-center justify-center`
        case "decimal":
          return `${baseClassic} text-black disabled:opacity-50 disabled:cursor-not-allowed`
        case "currencyToggle": {
          // Dynamic border and text color based on voucher currency mode
          const toggleColorLight =
            voucherCurrencyMode === "BTC"
              ? "border-orange-500 text-orange-500 hover:border-orange-400 hover:text-orange-400"
              : "border-green-500 text-green-500 hover:border-green-400 hover:text-green-400"
          return `h-16 md:h-20 bg-transparent border ${toggleColorLight} rounded-xl text-[28px] leading-8 font-bold transition-colors flex items-center justify-center`
        }
        case "ok":
          // 2px green (success) border + green text, 24px label — matches the design.
          return "h-[136px] md:h-[172px] bg-transparent border-2 border-success hover:bg-blink-classic-hover-light rounded-xl text-[24px] font-bold transition-colors text-success disabled:opacity-50 disabled:cursor-not-allowed row-span-2 flex items-center justify-center"
        default:
          return baseClassic
      }
    }

    // Standard dark/light theme styling
    const colorMap: Record<
      AccentColor,
      {
        border: string
        hoverBorder: string
        text: string
        hoverText: string
        hoverBg: string
      }
    > = {
      blue: {
        border: "border-blue-600 dark:border-blue-500",
        hoverBorder: "hover:border-blue-700 dark:hover:border-blue-400",
        text: "text-blue-600 dark:text-blue-400",
        hoverText: "hover:text-blue-700 dark:hover:text-blue-300",
        hoverBg: "hover:bg-blue-50 dark:hover:bg-blue-900",
      },
      purple: {
        border: "border-purple-400 dark:border-purple-400",
        hoverBorder: "hover:border-purple-500 dark:hover:border-purple-300",
        text: "text-purple-600 dark:text-purple-400",
        hoverText: "hover:text-purple-700 dark:hover:text-purple-300",
        hoverBg: "hover:bg-purple-50 dark:hover:bg-purple-900",
      },
    }

    const colors = colorMap[accentColor] || colorMap.blue
    const baseStandard = `h-16 md:h-20 bg-white dark:bg-black border-2 rounded-lg text-xl md:text-2xl font-normal leading-none tracking-normal transition-colors shadow-md`

    switch (type) {
      case "digit":
        return `${baseStandard} ${colors.border} ${colors.hoverBorder} ${colors.hoverBg} ${colors.text} ${colors.hoverText}`
      case "plus":
        return `${baseStandard} ${colors.border} ${colors.hoverBorder} ${colors.hoverBg} ${colors.text} ${colors.hoverText} disabled:bg-gray-200 dark:disabled:bg-blink-dark disabled:border-gray-400 dark:disabled:border-gray-600 disabled:text-gray-400 dark:disabled:text-gray-500 disabled:cursor-not-allowed flex items-center justify-center`
      case "clear":
        return `${baseStandard} border-red-600 dark:border-red-500 hover:border-red-700 dark:hover:border-red-400 hover:bg-red-50 dark:hover:bg-red-900 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300`
      case "backspace":
        return `${baseStandard} border-orange-500 dark:border-orange-500 hover:border-orange-600 dark:hover:border-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900 text-orange-500 dark:text-orange-400 hover:text-orange-600 dark:hover:text-orange-300 flex items-center justify-center`
      case "decimal":
        return `${baseStandard} ${colors.border} ${colors.hoverBorder} ${colors.hoverBg} ${colors.text} ${colors.hoverText} disabled:bg-gray-200 dark:disabled:bg-blink-dark disabled:border-gray-400 dark:disabled:border-gray-600 disabled:text-gray-400 dark:disabled:text-gray-500 disabled:cursor-not-allowed`
      case "currencyToggle": {
        // Dynamic border and text color based on voucher currency mode
        // Using cyan/teal to avoid conflict with orange (backspace) and green (OK)
        const toggleColorStd =
          voucherCurrencyMode === "BTC"
            ? "border-cyan-500 dark:border-cyan-500 hover:border-cyan-600 dark:hover:border-cyan-400 hover:bg-cyan-50 dark:hover:bg-cyan-900/30 text-cyan-500 dark:text-cyan-400"
            : "border-teal-500 dark:border-teal-500 hover:border-teal-600 dark:hover:border-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/30 text-teal-500 dark:text-teal-400"
        return `${baseStandard} ${toggleColorStd} flex items-center justify-center`
      }
      case "ok":
        return `h-[136px] md:h-[172px] bg-white dark:bg-black border-2 border-green-600 dark:border-green-500 hover:border-green-700 dark:hover:border-green-400 hover:bg-green-50 dark:hover:bg-green-900 text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 disabled:bg-gray-200 dark:disabled:bg-blink-dark disabled:border-gray-400 dark:disabled:border-gray-600 disabled:text-gray-400 dark:disabled:text-gray-500 rounded-lg text-lg md:text-xl font-normal leading-none tracking-normal transition-colors shadow-md flex items-center justify-center row-span-2`
      default:
        return baseStandard
    }
  }

  // Container background based on theme
  // Note: BC themes use pb-4 only (no top/horizontal padding) to maintain consistent numpad positioning and key widths across all themes
  const getContainerClasses = (): string => {
    if (isBlinkClassicDark) {
      return "bg-black pb-4 rounded-xl"
    }
    if (isBlinkClassicLight) {
      return "bg-white pb-4 rounded-xl"
    }
    return "" // Standard themes don't need container bg
  }

  const fontStyle: React.CSSProperties = { fontFamily: "'Source Sans Pro', sans-serif" }

  // Backspace icon SVG
  const BackspaceIcon = () => (
    <svg
      className="w-5 h-5 md:w-6 md:h-6"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={isBlinkClassic ? "1.75" : "2"}
        d="M12 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 12l6.414 6.414a2 2 0 001.414.586H19a2 2 0 002-2V7a2 2 0 00-2-2h-8.172a2 2 0 00-1.414.586L3 12z"
      />
    </svg>
  )

  const containerClasses = getContainerClasses()

  // Get digit rows based on layout
  // Calculator: 7-8-9 on top (standard calculator layout)
  // Telephone: 1-2-3 on top (phone/ATM style)
  const digitRows: string[][] =
    layout === "telephone"
      ? [
          ["1", "2", "3"],
          ["4", "5", "6"],
          ["7", "8", "9"],
        ]
      : [
          ["7", "8", "9"],
          ["4", "5", "6"],
          ["1", "2", "3"],
        ]

  return (
    <div className={containerClasses} data-testid="numpad">
      <div
        className="grid grid-cols-4 gap-3 max-w-sm md:max-w-md mx-auto"
        data-1p-ignore
        data-lpignore="true"
      >
        {/* Row 1: First digit row + Plus/CurrencyToggle */}
        {digitRows[0].map((digit) => (
          <button
            key={digit}
            onClick={() => onDigitPress(digit)}
            className={getButtonClasses("digit")}
            style={fontStyle}
            data-testid={`numpad-${digit}`}
          >
            {digit}
          </button>
        ))}
        {showPlus ? (
          <button
            onClick={onPlusPress}
            disabled={plusDisabled}
            className={getButtonClasses("plus")}
            style={fontStyle}
            data-testid="numpad-plus"
          >
            +
          </button>
        ) : showCurrencyToggle && onCurrencyToggle ? (
          <button
            onClick={onCurrencyToggle}
            className={getButtonClasses("currencyToggle")}
            style={fontStyle}
            data-testid="numpad-currency-toggle"
            title={
              voucherCurrencyMode === "BTC"
                ? "Bitcoin voucher (click to switch to USD)"
                : "USD voucher (click to switch to Bitcoin)"
            }
          >
            {voucherCurrencyMode === "BTC" ? (
              <span className="text-[10px] md:text-xs font-medium leading-tight text-center">
                Bitcoin
                <br />
                Voucher
              </span>
            ) : (
              <span className="text-[10px] md:text-xs font-medium leading-tight text-center">
                Dollar
                <br />
                Voucher
              </span>
            )}
          </button>
        ) : (
          <div></div> // Empty cell when showPlus is false and no toggle
        )}

        {/* Row 2: Second digit row + OK (starts) */}
        {digitRows[1].map((digit) => (
          <button
            key={digit}
            onClick={() => onDigitPress(digit)}
            className={getButtonClasses("digit")}
            style={fontStyle}
            data-testid={`numpad-${digit}`}
          >
            {digit}
          </button>
        ))}
        <button
          onClick={onOkPress}
          disabled={okDisabled}
          className={getButtonClasses("ok")}
          style={fontStyle}
          data-testid="generate-invoice"
        >
          {okLabel}
        </button>

        {/* Row 3: Third digit row, OK (continues via row-span-2) */}
        {digitRows[2].map((digit) => (
          <button
            key={digit}
            onClick={() => onDigitPress(digit)}
            className={getButtonClasses("digit")}
            style={fontStyle}
            data-testid={`numpad-${digit}`}
          >
            {digit}
          </button>
        ))}

        {/* Row 4: C, 0, ., Backspace */}
        <button
          onClick={onClear}
          className={getButtonClasses("clear")}
          style={fontStyle}
          data-testid="clear-button"
        >
          C
        </button>
        <button
          onClick={() => onDigitPress("0")}
          className={getButtonClasses("digit")}
          style={fontStyle}
          data-testid="numpad-0"
        >
          0
        </button>
        <button
          onClick={() => onDigitPress(".")}
          disabled={decimalDisabled}
          className={getButtonClasses("decimal")}
          style={fontStyle}
          data-testid="numpad-decimal"
        >
          .
        </button>
        <button
          onClick={onBackspace}
          className={getButtonClasses("backspace")}
          style={fontStyle}
          data-testid="numpad-backspace"
        >
          <BackspaceIcon />
        </button>
      </div>
    </div>
  )
}
