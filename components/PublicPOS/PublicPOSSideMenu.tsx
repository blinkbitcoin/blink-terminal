import Link from "next/link"

import { type Theme, THEME_LABELS } from "../../lib/hooks/useTheme"
import { FORMAT_LABELS, type NumberFormatPreference } from "../../lib/number-format"

/**
 * PublicPOSSideMenu - Side menu overlay for PublicPOSDashboard
 *
 * Simplified menu with: Switch Account, Theme, Display Currency,
 * Regional, Paycodes, Sound Effects
 */

interface PublicPOSSideMenuProps {
  onClose: () => void
  theme: Theme
  onShowThemeCycle: () => void
  displayCurrency: string
  numberFormat: NumberFormatPreference
  soundEnabled: boolean
  soundTheme: string
  onShowCurrencySettings: () => void
  onShowRegionalSettings: () => void
  onShowPaycode: () => void
  onShowSoundSettings: () => void
  getSubmenuBgClasses: () => string
  getSubmenuHeaderClasses: () => string
  getMenuTileClasses: () => string
}

export default function PublicPOSSideMenu({
  onClose,
  theme,
  onShowThemeCycle,
  displayCurrency,
  numberFormat,
  soundEnabled,
  soundTheme,
  onShowCurrencySettings,
  onShowRegionalSettings,
  onShowPaycode,
  onShowSoundSettings,
  getSubmenuBgClasses,
  getSubmenuHeaderClasses,
  getMenuTileClasses,
}: PublicPOSSideMenuProps) {
  return (
    <div className={`fixed inset-0 ${getSubmenuBgClasses()} z-50 overflow-y-auto`}>
      <div
        className="min-h-screen"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {/* Menu Header */}
        <div className={`${getSubmenuHeaderClasses()} sticky top-0 z-10`}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center h-16">
              <button
                onClick={onClose}
                className="flex items-center text-gray-700 dark:text-white hover:text-blink-accent"
              >
                <span className="text-2xl mr-2">‹</span>
                <span className="text-lg">Back</span>
              </button>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">Menu</h1>
              <div className="w-16"></div>
            </div>
          </div>
        </div>

        {/* Menu Content */}
        <div className="max-w-md mx-auto px-4 py-6">
          <div className="space-y-4">
            {/* Switch Account - Go to /setuppwa to choose different username */}
            <Link
              href="/setuppwa"
              className={`block w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center bg-gray-500/20`}
                >
                  <svg
                    className="w-5 h-5 text-gray-500 dark:text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                    />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="text-base font-medium text-gray-900 dark:text-white">
                    Switch Account
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Use different Blink username
                  </p>
                </div>
                <span className="text-gray-400">›</span>
              </div>
            </Link>

            {/* Theme Selection — opens the selectable theme-cycle overlay */}
            <button
              onClick={() => {
                onShowThemeCycle()
                onClose()
              }}
              className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  Theme
                </span>
                <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                  <span>{THEME_LABELS[theme as Theme]}</span>
                </div>
              </div>
            </button>

            {/* Display Currency */}
            <button
              onClick={onShowCurrencySettings}
              className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  Display Currency
                </span>
                <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                  <span>{displayCurrency}</span>
                  <span className="ml-1">›</span>
                </div>
              </div>
            </button>

            {/* Regional Settings (Number Format) */}
            <button
              onClick={onShowRegionalSettings}
              className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  Regional
                </span>
                <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                  <span>{FORMAT_LABELS[numberFormat]}</span>
                  <span className="ml-1">›</span>
                </div>
              </div>
            </button>

            {/* Paycodes */}
            <button
              onClick={onShowPaycode}
              className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  Paycodes
                </span>
                <span className="text-gray-400">›</span>
              </div>
            </button>

            {/* Sound Effects */}
            <button
              onClick={onShowSoundSettings}
              className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  Sound Effects
                </span>
                <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                  <span>
                    {!soundEnabled
                      ? "None"
                      : soundTheme === "success"
                        ? "Success"
                        : soundTheme === "zelda"
                          ? "Zelda"
                          : soundTheme === "free"
                            ? "Free"
                            : soundTheme === "retro"
                              ? "Retro"
                              : "None"}
                  </span>
                  <span className="ml-1">›</span>
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
