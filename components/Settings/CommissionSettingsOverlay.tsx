/**
 * CommissionSettingsOverlay - Commission percentage configuration
 * Extracted from Dashboard.js
 */

interface CommissionSettingsOverlayProps {
  commissionEnabled: boolean
  commissionPresets: number[]
  setCommissionEnabled: (enabled: boolean) => void
  setCommissionPresets: (presets: number[]) => void
  setShowCommissionSettings: (show: boolean) => void
  setShowPercentSettings: (show: boolean) => void
  isBlinkClassic: boolean
  getSubmenuBgClasses: () => string
  getSubmenuHeaderClasses: () => string
  getSelectionTileClasses: () => string
}

export default function CommissionSettingsOverlay({
  commissionEnabled,
  commissionPresets,
  setCommissionEnabled,
  setCommissionPresets,
  setShowCommissionSettings,
  setShowPercentSettings,
  isBlinkClassic,
  getSubmenuBgClasses,
  getSubmenuHeaderClasses,
  getSelectionTileClasses,
}: CommissionSettingsOverlayProps) {
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
                onClick={() => {
                  setShowCommissionSettings(false)
                  setShowPercentSettings(true)
                }}
                className="flex items-center text-gray-700 dark:text-white hover:text-blink-accent dark:hover:text-blink-accent"
              >
                <span className="text-2xl mr-2">‹</span>
                <span className="text-lg">Back</span>
              </button>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                Commission % Settings
              </h1>
              <div className="w-16"></div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-md mx-auto px-4 py-6">
          <div className="space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              When enabled, a commission selection screen will appear after entering a
              voucher amount. The commission percentage is deducted from the voucher value
              - for example, a $100 voucher with 2% commission creates a voucher worth $98
              in sats.
            </p>

            {/* Enable/Disable Commission */}
            <div
              className={`p-4 rounded-lg border-2 transition-all ${
                commissionEnabled
                  ? isBlinkClassic
                    ? "border-blink-classic-amber bg-blink-classic-bg"
                    : "border-purple-600 dark:border-purple-500 bg-purple-50 dark:bg-purple-900/20"
                  : getSelectionTileClasses()
              }`}
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    Enable Commission
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Show commission options when creating vouchers
                  </p>
                </div>
                <button
                  onClick={() => setCommissionEnabled(!commissionEnabled)}
                  className="inline-flex gap-0.5 cursor-pointer focus:outline-none"
                >
                  <span
                    className={`w-5 h-5 transition-colors ${
                      commissionEnabled
                        ? "bg-purple-600 dark:bg-purple-500"
                        : "bg-gray-300 dark:bg-gray-600"
                    }`}
                  />
                  <span
                    className={`w-5 h-5 transition-colors ${
                      commissionEnabled
                        ? "bg-gray-300 dark:bg-gray-600"
                        : "bg-purple-600 dark:bg-purple-500"
                    }`}
                  />
                </button>
              </div>

              {commissionEnabled && (
                <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                    Commission Percentage Options (1-4 presets)
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {commissionPresets.map((preset, index) => (
                      <div key={index} className="flex items-center">
                        <input
                          type="number"
                          value={preset}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                            const newPresets = [...commissionPresets]
                            newPresets[index] = parseFloat(e.target.value) || 0
                            setCommissionPresets(newPresets)
                          }}
                          className="w-16 px-2 py-2 text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded text-center"
                          min="0"
                          max="100"
                          step="0.5"
                        />
                        <span className="ml-1 text-gray-500 dark:text-gray-400">%</span>
                        {commissionPresets.length > 1 && (
                          <button
                            onClick={() =>
                              setCommissionPresets(
                                commissionPresets.filter((_, i) => i !== index),
                              )
                            }
                            className="ml-2 text-red-500 hover:text-red-700"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {commissionPresets.length < 4 && (
                    <button
                      onClick={() =>
                        setCommissionPresets([
                          ...commissionPresets,
                          commissionPresets.length === 1
                            ? 2
                            : commissionPresets.length === 2
                              ? 3
                              : 4,
                        ])
                      }
                      className="mt-3 px-4 py-2 text-sm bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-white rounded transition-colors"
                    >
                      Add Option
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
