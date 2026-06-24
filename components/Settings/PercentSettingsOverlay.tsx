/**
 * PercentSettingsOverlay - Menu for Tip % and Commission % sub-settings
 * Extracted from Dashboard.js
 */

interface TipProfile {
  id: string
  name: string
  tipOptions: number[]
}

interface PercentSettingsOverlayProps {
  activeTipProfile: TipProfile | null
  commissionEnabled: boolean
  commissionPresets: number[]
  /** True when the active receive wallet is a self-custodial (Spark) LN address.
      Tips can't be forwarded for such wallets, so Tip % Settings is disabled.
      Commission % Settings stays available (it's tied to the voucher sending
      wallet, unrelated to the Spark receive wallet). */
  isSparkLnAddress: boolean
  setShowPercentSettings: (show: boolean) => void
  setShowTipProfileSettings: (show: boolean) => void
  setShowCommissionSettings: (show: boolean) => void
  getSubmenuBgClasses: () => string
  getSubmenuHeaderClasses: () => string
  getSelectionTileClasses: () => string
}

export default function PercentSettingsOverlay({
  activeTipProfile,
  commissionEnabled,
  commissionPresets,
  isSparkLnAddress,
  setShowPercentSettings,
  setShowTipProfileSettings,
  setShowCommissionSettings,
  getSubmenuBgClasses,
  getSubmenuHeaderClasses,
  getSelectionTileClasses,
}: PercentSettingsOverlayProps) {
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
                onClick={() => setShowPercentSettings(false)}
                className="flex items-center text-gray-700 dark:text-white hover:text-blink-accent dark:hover:text-blink-accent"
              >
                <span className="text-2xl mr-2">&#8249;</span>
                <span className="text-lg">Back</span>
              </button>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                % Settings
              </h1>
              <div className="w-16"></div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-md mx-auto px-4 py-6">
          <div className="space-y-4">
            {/* Tip % Settings - disabled for self-custodial (Spark) receive
                wallets (tips can't be forwarded). */}
            <button
              onClick={() => {
                if (isSparkLnAddress) return
                setShowPercentSettings(false)
                setShowTipProfileSettings(true)
              }}
              disabled={isSparkLnAddress}
              aria-disabled={isSparkLnAddress}
              className={`w-full p-4 rounded-lg border-2 transition-all ${getSelectionTileClasses()} ${
                isSparkLnAddress ? "opacity-50 cursor-not-allowed" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
                    Tip % Settings
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {isSparkLnAddress
                      ? "Not available for self-custodial Lightning address wallets"
                      : "Configure tip percentages for POS payments"}
                  </p>
                </div>
                <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                  <span>{activeTipProfile?.name || "Custom"}</span>
                  {!isSparkLnAddress && <span className="ml-1">&#8250;</span>}
                </div>
              </div>
            </button>

            {/* Commission % Settings */}
            <button
              onClick={() => {
                setShowPercentSettings(false)
                setShowCommissionSettings(true)
              }}
              className={`w-full p-4 rounded-lg border-2 transition-all ${getSelectionTileClasses()}`}
            >
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <h3 className="text-lg font-semibold text-purple-600 dark:text-purple-400 mb-1">
                    Commission % Settings
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Configure commission for voucher creation
                  </p>
                </div>
                <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                  <span>
                    {commissionEnabled ? `${commissionPresets.join("%, ")}%` : "Disabled"}
                  </span>
                  <span className="ml-1">&#8250;</span>
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
