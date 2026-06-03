import {
  FORMAT_OPTIONS,
  FORMAT_LABELS,
  FORMAT_DESCRIPTIONS,
  getFormatPreview,
  BITCOIN_FORMAT_OPTIONS,
  BITCOIN_FORMAT_LABELS,
  BITCOIN_FORMAT_DESCRIPTIONS,
  getBitcoinFormatPreview,
  NUMPAD_LAYOUT_OPTIONS,
  NUMPAD_LAYOUT_LABELS,
  NUMPAD_LAYOUT_DESCRIPTIONS,
  AMOUNT_DISPLAY_OPTIONS,
  AMOUNT_DISPLAY_LABELS,
  AMOUNT_DISPLAY_DESCRIPTIONS,
  type NumberFormatPreference,
  type BitcoinFormatPreference,
  type NumpadLayoutPreference,
  type AmountDisplayPreference,
} from "../../lib/number-format"
import {
  ORANGE_PILL_OPTIONS,
  ORANGE_PILL_LABELS,
  ORANGE_PILL_DESCRIPTIONS,
  type OrangePillMode,
} from "../../lib/orangepill"

/**
 * PublicPOSRegionalOverlay - Regional settings overlay for PublicPOSDashboard
 *
 * Number format, Bitcoin format, numpad layout selection with live previews
 */

interface PublicPOSRegionalOverlayProps {
  onClose: () => void
  darkMode: boolean
  numberFormat: NumberFormatPreference
  setNumberFormat: (format: NumberFormatPreference) => void
  bitcoinFormat: BitcoinFormatPreference
  setBitcoinFormat: (format: BitcoinFormatPreference) => void
  numpadLayout: NumpadLayoutPreference
  setNumpadLayout: (layout: NumpadLayoutPreference) => void
  amountDisplay: AmountDisplayPreference
  setAmountDisplay: (preference: AmountDisplayPreference) => void
  orangePillMode: OrangePillMode
  setOrangePillMode: (mode: OrangePillMode) => void
  orangePillStaticUrl: string
  setOrangePillStaticUrl: (url: string) => void
  getSubmenuBgClasses: () => string
  getSubmenuHeaderClasses: () => string
}

export default function PublicPOSRegionalOverlay({
  onClose,
  darkMode,
  numberFormat,
  setNumberFormat,
  bitcoinFormat,
  setBitcoinFormat,
  numpadLayout,
  setNumpadLayout,
  amountDisplay,
  setAmountDisplay,
  orangePillMode,
  setOrangePillMode,
  orangePillStaticUrl,
  setOrangePillStaticUrl,
  getSubmenuBgClasses,
  getSubmenuHeaderClasses,
}: PublicPOSRegionalOverlayProps) {
  return (
    <div className={`fixed inset-0 ${getSubmenuBgClasses()} z-50 overflow-y-auto`}>
      <div
        className="min-h-screen"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {/* Header */}
        <div className={`${getSubmenuHeaderClasses()} sticky top-0 z-10`}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center h-16">
              <button
                onClick={onClose}
                className="flex items-center text-gray-700 dark:text-white hover:text-blink-accent dark:hover:text-blink-accent"
              >
                <span className="text-2xl mr-2">‹</span>
                <span className="text-lg">Back</span>
              </button>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                Regional
              </h1>
              <div className="w-16"></div>
            </div>
          </div>
        </div>

        {/* Regional Settings Content */}
        <div className="max-w-md mx-auto px-4 py-6 space-y-6">
          {/* Number Format Section */}
          <div>
            <h3
              className={`text-sm font-medium mb-3 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
            >
              Number Format
            </h3>
            <div className="space-y-2">
              {FORMAT_OPTIONS.map((format) => (
                <button
                  key={format}
                  onClick={() => setNumberFormat(format)}
                  className={`w-full p-3 rounded-lg text-left transition-all ${
                    numberFormat === format
                      ? "bg-blink-accent/20 border-2 border-blink-accent"
                      : darkMode
                        ? "bg-gray-900 hover:bg-gray-800 border-2 border-transparent"
                        : "bg-gray-50 hover:bg-gray-100 border-2 border-transparent"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span
                        className={`text-sm font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                      >
                        {FORMAT_LABELS[format]}
                      </span>
                      <p
                        className={`text-xs mt-0.5 ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                      >
                        {FORMAT_DESCRIPTIONS[format]}
                      </p>
                    </div>
                    {numberFormat === format && (
                      <svg
                        className="w-5 h-5 text-blink-accent flex-shrink-0 ml-2"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </div>
                </button>
              ))}
            </div>

            {/* Live Preview */}
            <div
              className={`mt-4 p-4 rounded-lg ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}
            >
              <h4
                className={`text-xs font-medium mb-2 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
              >
                Preview
              </h4>
              <div className={`space-y-1 ${darkMode ? "text-white" : "text-gray-900"}`}>
                <div className="flex justify-between text-sm">
                  <span>Bitcoin:</span>
                  <span className="font-mono">
                    {getBitcoinFormatPreview(bitcoinFormat, numberFormat)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>USD:</span>
                  <span className="font-mono">
                    ${getFormatPreview(numberFormat).decimal}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Bitcoin Format Section */}
          <div>
            <h3
              className={`text-sm font-medium mb-3 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
            >
              Bitcoin Format
            </h3>
            <div className="space-y-2">
              {BITCOIN_FORMAT_OPTIONS.map((format) => (
                <button
                  key={format}
                  onClick={() => setBitcoinFormat(format)}
                  className={`w-full p-3 rounded-lg text-left transition-all ${
                    bitcoinFormat === format
                      ? "bg-blink-accent/20 border-2 border-blink-accent"
                      : darkMode
                        ? "bg-gray-900 hover:bg-gray-800 border-2 border-transparent"
                        : "bg-gray-50 hover:bg-gray-100 border-2 border-transparent"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <span
                          className={`text-sm font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                        >
                          {BITCOIN_FORMAT_LABELS[format]}
                        </span>
                        <span
                          className={`text-sm font-mono ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                        >
                          {getBitcoinFormatPreview(format, numberFormat)}
                        </span>
                      </div>
                      <p
                        className={`text-xs mt-0.5 ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                      >
                        {BITCOIN_FORMAT_DESCRIPTIONS[format]}
                      </p>
                    </div>
                    {bitcoinFormat === format && (
                      <svg
                        className="w-5 h-5 text-blink-accent flex-shrink-0 ml-2"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Amount Display Section */}
          <div>
            <h3
              className={`text-sm font-medium mb-3 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
            >
              Amount Display
            </h3>
            <div className="space-y-2">
              {AMOUNT_DISPLAY_OPTIONS.map((preference) => (
                <button
                  key={preference}
                  onClick={() => setAmountDisplay(preference)}
                  className={`w-full p-3 rounded-lg text-left transition-all ${
                    amountDisplay === preference
                      ? "bg-blink-accent/20 border-2 border-blink-accent"
                      : darkMode
                        ? "bg-gray-900 hover:bg-gray-800 border-2 border-transparent"
                        : "bg-gray-50 hover:bg-gray-100 border-2 border-transparent"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <span
                          className={`text-sm font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                        >
                          {AMOUNT_DISPLAY_LABELS[preference]}
                        </span>
                        <span
                          className={`text-sm font-mono ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                        >
                          {preference === "sats-primary"
                            ? `${getBitcoinFormatPreview(bitcoinFormat, numberFormat)} ($1.00)`
                            : `$1.00 (${getBitcoinFormatPreview(bitcoinFormat, numberFormat)})`}
                        </span>
                      </div>
                      <p
                        className={`text-xs mt-0.5 ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                      >
                        {AMOUNT_DISPLAY_DESCRIPTIONS[preference]}
                      </p>
                    </div>
                    {amountDisplay === preference && (
                      <svg
                        className="w-5 h-5 text-blink-accent flex-shrink-0 ml-2"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Numpad Layout Section */}
          <div>
            <h3
              className={`text-sm font-medium mb-3 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
            >
              Numpad Layout
            </h3>
            <div className="space-y-2">
              {NUMPAD_LAYOUT_OPTIONS.map((layout) => (
                <button
                  key={layout}
                  onClick={() => setNumpadLayout(layout)}
                  className={`w-full p-3 rounded-lg text-left transition-all ${
                    numpadLayout === layout
                      ? "bg-blink-accent/20 border-2 border-blink-accent"
                      : darkMode
                        ? "bg-gray-900 hover:bg-gray-800 border-2 border-transparent"
                        : "bg-gray-50 hover:bg-gray-100 border-2 border-transparent"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span
                        className={`text-sm font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                      >
                        {NUMPAD_LAYOUT_LABELS[layout]}
                      </span>
                      <p
                        className={`text-xs mt-0.5 ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                      >
                        {NUMPAD_LAYOUT_DESCRIPTIONS[layout]}
                      </p>
                    </div>
                    {numpadLayout === layout && (
                      <svg
                        className="w-5 h-5 text-blink-accent flex-shrink-0 ml-2"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </div>
                </button>
              ))}
            </div>

            {/* Numpad Layout Preview */}
            <div
              className={`mt-4 p-4 rounded-lg ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}
            >
              <h4
                className={`text-xs font-medium mb-3 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
              >
                Preview
              </h4>
              <div className="flex justify-center">
                <div className="grid grid-cols-3 gap-1.5 text-center">
                  {(numpadLayout === "telephone"
                    ? [
                        ["1", "2", "3"],
                        ["4", "5", "6"],
                        ["7", "8", "9"],
                        ["", "0", ""],
                      ]
                    : [
                        ["7", "8", "9"],
                        ["4", "5", "6"],
                        ["1", "2", "3"],
                        ["", "0", ""],
                      ]
                  ).map((row, rowIdx) =>
                    row.map((digit, colIdx) => (
                      <div
                        key={`${rowIdx}-${colIdx}`}
                        className={`w-8 h-8 flex items-center justify-center rounded text-sm font-medium ${
                          digit
                            ? `${darkMode ? "bg-gray-800 text-white" : "bg-gray-200 text-gray-900"}`
                            : ""
                        }`}
                      >
                        {digit}
                      </div>
                    )),
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Receipt Education (Orange-pill) Section */}
          <div>
            <h3
              className={`text-sm font-medium mb-3 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
            >
              Bitcoin Education on Receipts
            </h3>
            <div className="space-y-2">
              {ORANGE_PILL_OPTIONS.map((mode) => (
                <button
                  key={mode}
                  onClick={() => setOrangePillMode(mode)}
                  className={`w-full p-3 rounded-lg text-left transition-all ${
                    orangePillMode === mode
                      ? "bg-blink-accent/20 border-2 border-blink-accent"
                      : darkMode
                        ? "bg-gray-900 hover:bg-gray-800 border-2 border-transparent"
                        : "bg-gray-50 hover:bg-gray-100 border-2 border-transparent"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span
                        className={`text-sm font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                      >
                        {ORANGE_PILL_LABELS[mode]}
                      </span>
                      <p
                        className={`text-xs mt-0.5 ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                      >
                        {ORANGE_PILL_DESCRIPTIONS[mode]}
                      </p>
                    </div>
                    {orangePillMode === mode && (
                      <svg
                        className="w-5 h-5 text-blink-accent flex-shrink-0 ml-2"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </div>
                </button>
              ))}
            </div>

            {orangePillMode === "static" && (
              <div className="mt-3">
                <label
                  className={`text-xs font-medium mb-1 block ${darkMode ? "text-gray-400" : "text-gray-600"}`}
                >
                  QR destination URL
                </label>
                <input
                  type="url"
                  inputMode="url"
                  value={orangePillStaticUrl}
                  onChange={(e) => setOrangePillStaticUrl(e.target.value)}
                  placeholder="https://www.blink.sv/en/blog/articles"
                  className={`w-full p-3 text-sm rounded-lg border-2 border-transparent ${
                    darkMode ? "bg-gray-900 text-white" : "bg-gray-50 text-gray-900"
                  }`}
                />
                <p
                  className={`text-xs mt-1 ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                >
                  Leave blank to use the Blink blog.
                </p>
              </div>
            )}
          </div>

          {/* Language Section (Placeholder) */}
          <div>
            <h3
              className={`text-sm font-medium mb-3 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
            >
              Language
            </h3>
            <div
              className={`p-3 rounded-lg ${darkMode ? "bg-gray-900" : "bg-gray-50"} opacity-60 cursor-not-allowed`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <span
                    className={`text-sm font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                  >
                    English
                  </span>
                  <p
                    className={`text-xs mt-0.5 ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                  >
                    More languages coming soon
                  </p>
                </div>
                <svg
                  className="w-5 h-5 text-blink-accent"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
