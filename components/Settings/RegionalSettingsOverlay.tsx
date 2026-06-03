/**
 * RegionalSettingsOverlay - Number format, Bitcoin format, numpad layout, language
 * Extracted from Dashboard.js
 */
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
  NumberFormatPreference,
  BitcoinFormatPreference,
  NumpadLayoutPreference,
  AmountDisplayPreference,
} from "../../lib/number-format"

interface RegionalSettingsOverlayProps {
  numberFormat: NumberFormatPreference
  bitcoinFormat: BitcoinFormatPreference
  numpadLayout: NumpadLayoutPreference
  amountDisplay: AmountDisplayPreference
  setNumberFormat: (format: NumberFormatPreference) => void
  setBitcoinFormat: (format: BitcoinFormatPreference) => void
  setNumpadLayout: (layout: NumpadLayoutPreference) => void
  setAmountDisplay: (preference: AmountDisplayPreference) => void
  setShowRegionalSettings: (show: boolean) => void
  getSubmenuBgClasses: () => string
  getSubmenuHeaderClasses: () => string
  getSubmenuOptionClasses: () => string
  getSubmenuOptionActiveClasses: () => string
  getPrimaryTextClasses: () => string
  getSecondaryTextClasses: () => string
  getSectionLabelClasses: () => string
  getCheckmarkClasses: () => string
  getPreviewBoxClasses: () => string
}

export default function RegionalSettingsOverlay({
  numberFormat,
  bitcoinFormat,
  numpadLayout,
  amountDisplay,
  setNumberFormat,
  setBitcoinFormat,
  setNumpadLayout,
  setAmountDisplay,
  setShowRegionalSettings,
  getSubmenuBgClasses,
  getSubmenuHeaderClasses,
  getSubmenuOptionClasses,
  getSubmenuOptionActiveClasses,
  getPrimaryTextClasses,
  getSecondaryTextClasses,
  getSectionLabelClasses,
  getCheckmarkClasses,
  getPreviewBoxClasses,
}: RegionalSettingsOverlayProps) {
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
                onClick={() => setShowRegionalSettings(false)}
                className={`flex items-center ${getPrimaryTextClasses()} hover:text-blink-classic-amber`}
              >
                <span className="text-2xl mr-2">‹</span>
                <span className="text-lg">Back</span>
              </button>
              <h1 className={`text-xl font-bold ${getPrimaryTextClasses()}`}>Regional</h1>
              <div className="w-16"></div>
            </div>
          </div>
        </div>

        {/* Regional Settings Content */}
        <div className="max-w-md mx-auto px-4 py-6 space-y-6">
          {/* Number Format Section */}
          <div>
            <h3 className={`text-sm font-medium mb-3 ${getSectionLabelClasses()}`}>
              Number Format
            </h3>
            <div className="space-y-2">
              {FORMAT_OPTIONS.map((format) => (
                <button
                  key={format}
                  onClick={() => setNumberFormat(format)}
                  className={`w-full p-3 text-left transition-all ${
                    numberFormat === format
                      ? getSubmenuOptionActiveClasses()
                      : getSubmenuOptionClasses()
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className={`text-sm font-medium ${getPrimaryTextClasses()}`}>
                        {FORMAT_LABELS[format]}
                      </span>
                      <p className={`text-xs mt-0.5 ${getSecondaryTextClasses()}`}>
                        {FORMAT_DESCRIPTIONS[format]}
                      </p>
                    </div>
                    {numberFormat === format && (
                      <svg
                        className={`w-5 h-5 ${getCheckmarkClasses()} flex-shrink-0 ml-2`}
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
            <div className={`mt-4 p-4 ${getPreviewBoxClasses()}`}>
              <h4 className={`text-xs font-medium mb-2 ${getSectionLabelClasses()}`}>
                Preview
              </h4>
              <div className={`space-y-1 ${getPrimaryTextClasses()}`}>
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
            <h3 className={`text-sm font-medium mb-3 ${getSectionLabelClasses()}`}>
              Bitcoin Format
            </h3>
            <div className="space-y-2">
              {BITCOIN_FORMAT_OPTIONS.map((format) => (
                <button
                  key={format}
                  onClick={() => setBitcoinFormat(format)}
                  className={`w-full p-3 text-left transition-all ${
                    bitcoinFormat === format
                      ? getSubmenuOptionActiveClasses()
                      : getSubmenuOptionClasses()
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <span
                          className={`text-sm font-medium ${getPrimaryTextClasses()}`}
                        >
                          {BITCOIN_FORMAT_LABELS[format]}
                        </span>
                        <span
                          className={`text-sm font-mono ${getSecondaryTextClasses()}`}
                        >
                          {getBitcoinFormatPreview(format, numberFormat)}
                        </span>
                      </div>
                      <p className={`text-xs mt-0.5 ${getSecondaryTextClasses()}`}>
                        {BITCOIN_FORMAT_DESCRIPTIONS[format]}
                      </p>
                    </div>
                    {bitcoinFormat === format && (
                      <svg
                        className={`w-5 h-5 ${getCheckmarkClasses()} flex-shrink-0 ml-2`}
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
            <h3 className={`text-sm font-medium mb-3 ${getSectionLabelClasses()}`}>
              Amount Display
            </h3>
            <div className="space-y-2">
              {AMOUNT_DISPLAY_OPTIONS.map((preference) => (
                <button
                  key={preference}
                  onClick={() => setAmountDisplay(preference)}
                  className={`w-full p-3 text-left transition-all ${
                    amountDisplay === preference
                      ? getSubmenuOptionActiveClasses()
                      : getSubmenuOptionClasses()
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <span
                          className={`text-sm font-medium ${getPrimaryTextClasses()}`}
                        >
                          {AMOUNT_DISPLAY_LABELS[preference]}
                        </span>
                        <span
                          className={`text-sm font-mono ${getSecondaryTextClasses()}`}
                        >
                          {preference === "sats-primary"
                            ? `${getBitcoinFormatPreview(bitcoinFormat, numberFormat)} ($1.00)`
                            : `$1.00 (${getBitcoinFormatPreview(bitcoinFormat, numberFormat)})`}
                        </span>
                      </div>
                      <p className={`text-xs mt-0.5 ${getSecondaryTextClasses()}`}>
                        {AMOUNT_DISPLAY_DESCRIPTIONS[preference]}
                      </p>
                    </div>
                    {amountDisplay === preference && (
                      <svg
                        className={`w-5 h-5 ${getCheckmarkClasses()} flex-shrink-0 ml-2`}
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
            <h3 className={`text-sm font-medium mb-3 ${getSectionLabelClasses()}`}>
              Numpad Layout
            </h3>
            <div className="space-y-2">
              {NUMPAD_LAYOUT_OPTIONS.map((layout) => (
                <button
                  key={layout}
                  onClick={() => setNumpadLayout(layout)}
                  className={`w-full p-3 text-left transition-all ${
                    numpadLayout === layout
                      ? getSubmenuOptionActiveClasses()
                      : getSubmenuOptionClasses()
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className={`text-sm font-medium ${getPrimaryTextClasses()}`}>
                        {NUMPAD_LAYOUT_LABELS[layout]}
                      </span>
                      <p className={`text-xs mt-0.5 ${getSecondaryTextClasses()}`}>
                        {NUMPAD_LAYOUT_DESCRIPTIONS[layout]}
                      </p>
                    </div>
                    {numpadLayout === layout && (
                      <svg
                        className={`w-5 h-5 ${getCheckmarkClasses()} flex-shrink-0 ml-2`}
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
            <div className={`mt-4 p-4 ${getPreviewBoxClasses()}`}>
              <h4 className={`text-xs font-medium mb-3 ${getSectionLabelClasses()}`}>
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
                            ? `${getPreviewBoxClasses()} ${getPrimaryTextClasses()}`
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

          {/* Language Section (Placeholder) */}
          <div>
            <h3 className={`text-sm font-medium mb-3 ${getSectionLabelClasses()}`}>
              Language
            </h3>
            <div
              className={`p-3 ${getSubmenuOptionActiveClasses()} opacity-60 cursor-not-allowed`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className={`text-sm font-medium ${getPrimaryTextClasses()}`}>
                    English
                  </span>
                  <p className={`text-xs mt-0.5 ${getSecondaryTextClasses()}`}>
                    More languages coming soon
                  </p>
                </div>
                <svg
                  className={`w-5 h-5 ${getCheckmarkClasses()}`}
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
