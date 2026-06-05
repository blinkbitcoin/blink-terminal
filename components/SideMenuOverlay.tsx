import React from "react"

import type { SoundThemeName } from "../lib/audio-utils"
import type {
  AuthMode,
  CombinedUser,
  LocalBlinkAccount,
  LocalNWCConnection,
  NostrProfile,
} from "../lib/hooks/useCombinedAuth"
import type { SplitProfile } from "../lib/hooks/useSplitProfiles"
import type { Theme } from "../lib/hooks/useTheme"
import type { TipProfile } from "../lib/hooks/useTipSettings"
import type { VoucherWallet } from "../lib/hooks/useVoucherWalletState"
import { FORMAT_LABELS, type NumberFormatPreference } from "../lib/number-format"

// ============================================================================
// Component Props
// ============================================================================

interface SideMenuOverlayProps {
  authMode: AuthMode
  nostrProfile: NostrProfile | null
  user: CombinedUser | null
  activeNWC: LocalNWCConnection | null
  activeNpubCashWallet: LocalBlinkAccount | null
  activeBlinkAccount: LocalBlinkAccount | null
  voucherWallet: VoucherWallet | null
  theme: Theme
  displayCurrency: string
  numberFormat: NumberFormatPreference
  activeSplitProfile: SplitProfile | null
  activeTipProfile: TipProfile | null
  soundEnabled: boolean
  soundTheme: SoundThemeName
  showInstallPrompt: boolean
  setSideMenuOpen: (open: boolean) => void
  setShowKeyManagement: (show: boolean) => void
  setShowAccountSettings: (show: boolean) => void
  setShowVoucherWalletSettings: (show: boolean) => void
  cycleTheme: () => void
  setShowCurrencySettings: (show: boolean) => void
  setShowRegionalSettings: (show: boolean) => void
  setShowTipSettings: (show: boolean) => void
  setShowPercentSettings: (show: boolean) => void
  setShowTipProfileSettings: (show: boolean) => void
  setShowSoundThemes: (show: boolean) => void
  setShowPaycode: (show: boolean) => void
  setShowBatchPayments: (show: boolean) => void
  setShowBoltcards: (show: boolean) => void
  handleInstallApp: () => void
  handleLogout: () => void
  getSubmenuBgClasses: () => string
  getSubmenuHeaderClasses: () => string
  getMenuTileClasses: () => string
}

export default function SideMenuOverlay({
  authMode,
  nostrProfile,
  user,
  activeNWC,
  activeNpubCashWallet,
  activeBlinkAccount,
  voucherWallet,
  theme,
  displayCurrency,
  numberFormat,
  activeSplitProfile,
  activeTipProfile,
  soundEnabled,
  soundTheme,
  showInstallPrompt,
  setSideMenuOpen,
  setShowKeyManagement,
  setShowAccountSettings,
  setShowVoucherWalletSettings,
  cycleTheme,
  setShowCurrencySettings,
  setShowRegionalSettings,
  setShowTipSettings,
  setShowPercentSettings,
  setShowTipProfileSettings,
  setShowSoundThemes,
  setShowPaycode,
  setShowBatchPayments,
  setShowBoltcards,
  handleInstallApp,
  handleLogout,
  getSubmenuBgClasses,
  getSubmenuHeaderClasses,
  getMenuTileClasses,
}: SideMenuOverlayProps) {
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
                onClick={() => setSideMenuOpen(false)}
                className="flex items-center text-gray-700 dark:text-white hover:text-blink-accent dark:hover:text-blink-accent"
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
            {/* Profile Info - Clickable to access Key Management */}
            <button
              onClick={() => {
                if (authMode === "nostr") {
                  setShowKeyManagement(true)
                  setSideMenuOpen(false)
                }
              }}
              className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors ${authMode === "nostr" ? "cursor-pointer" : "cursor-default"}`}
            >
              <div className="flex items-center gap-3">
                {/* Avatar */}
                {authMode === "nostr" && nostrProfile?.picture ? (
                  <img
                    src={nostrProfile.picture}
                    alt="Profile"
                    className="w-10 h-10 rounded-full object-cover ring-2 ring-purple-500/30"
                    onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                      // Fallback to default avatar on error
                      const target = e.currentTarget
                      target.style.display = "none"
                      const nextSibling = target.nextElementSibling as HTMLElement | null
                      if (nextSibling) {
                        nextSibling.style.display = "flex"
                      }
                    }}
                  />
                ) : null}
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center ${
                    authMode === "nostr" ? "bg-purple-500/20" : "bg-blink-accent/20"
                  }`}
                  style={{
                    display:
                      authMode === "nostr" && nostrProfile?.picture ? "none" : "flex",
                  }}
                >
                  <svg
                    className={`w-5 h-5 ${authMode === "nostr" ? "text-purple-400" : "text-blink-accent"}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                    />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-base font-medium text-blink-accent truncate">
                    {authMode === "nostr"
                      ? nostrProfile?.display_name ||
                        nostrProfile?.name ||
                        user?.username ||
                        "Nostr User"
                      : user?.username || "User"}
                  </p>
                </div>
                {/* Key icon indicator for nostr users */}
                {authMode === "nostr" && (
                  <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                      />
                    </svg>
                    <span className="ml-1">›</span>
                  </div>
                )}
              </div>
            </button>

            {/* Receive Wallet */}
            <button
              onClick={() => setShowAccountSettings(true)}
              className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  Receive Wallet
                </span>
                <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                  <span>
                    {activeNWC
                      ? activeNWC.label
                      : activeNpubCashWallet
                        ? activeNpubCashWallet.label ||
                          activeNpubCashWallet.lightningAddress
                        : activeBlinkAccount?.label ||
                          activeBlinkAccount?.username ||
                          "None"}
                  </span>
                  <span className="ml-1">›</span>
                </div>
              </div>
            </button>

            {/* Send Wallet - For voucher feature (requires Blink API key with WRITE scope) */}
            <button
              onClick={() => setShowVoucherWalletSettings(true)}
              className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    Sending Wallet
                  </span>
                  <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-purple-500/20 text-purple-400">
                    Beta
                  </span>
                </div>
                <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                  <span>
                    {voucherWallet
                      ? voucherWallet.label ||
                        String(voucherWallet.username ?? "") ||
                        "Connected"
                      : "None"}
                  </span>
                  <span className="ml-1">›</span>
                </div>
              </div>
            </button>

            {/* Theme Selection */}
            <button
              onClick={cycleTheme}
              className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  Theme
                </span>
                <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                  <span>
                    {theme === "dark"
                      ? "Dark"
                      : theme === "blink-classic-dark"
                        ? "BC Dark"
                        : theme === "light"
                          ? "Light"
                          : "BC Light"}
                  </span>
                  <span className="ml-1 text-xs">(tap to change)</span>
                </div>
              </div>
            </button>

            {/* Currency Selection */}
            <button
              onClick={() => setShowCurrencySettings(true)}
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
              onClick={() => setShowRegionalSettings(true)}
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

            {/* Payment Splits */}
            <button
              onClick={() => setShowTipSettings(true)}
              className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  Payment Splits
                </span>
                <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                  <span>{activeSplitProfile?.label || "None"}</span>
                  <span className="ml-1">›</span>
                </div>
              </div>
            </button>

            {/* Tip Settings / Tip & Commission Settings */}
            <button
              onClick={() =>
                voucherWallet
                  ? setShowPercentSettings(true)
                  : setShowTipProfileSettings(true)
              }
              className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  {voucherWallet ? "Tip & Commission Settings" : "Tip Settings"}
                </span>
                <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                  <span>{activeTipProfile?.name || "Custom"}</span>
                  <span className="ml-1">›</span>
                </div>
              </div>
            </button>

            {/* Sound Effects */}
            <button
              onClick={() => setShowSoundThemes(true)}
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

            {/* Paycodes (only show if user has active Blink account with username) */}
            {activeBlinkAccount?.username && (
              <button
                onClick={() => {
                  setShowPaycode(true)
                  setSideMenuOpen(false)
                }}
                className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    Paycodes
                  </span>
                  <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                      />
                    </svg>
                    <span className="ml-1">›</span>
                  </div>
                </div>
              </button>
            )}

            {/* Batch Payments (only show if user has Voucher wallet with WRITE API key) */}
            {voucherWallet?.apiKey && (
              <button
                onClick={() => {
                  setShowBatchPayments(true)
                  setSideMenuOpen(false)
                }}
                className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    Batch Payments
                  </span>
                  <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"
                      />
                    </svg>
                    <span className="ml-1">›</span>
                  </div>
                </div>
              </button>
            )}

            {/* Boltcards (only show for Nostr users) */}
            {authMode === "nostr" && (
              <button
                onClick={() => {
                  setShowBoltcards(true)
                  setSideMenuOpen(false)
                }}
                className={`w-full rounded-lg p-4 ${getMenuTileClasses()} transition-colors`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      Boltcards
                    </span>
                    <span className="px-2 py-0.5 text-xs font-medium rounded bg-purple-500/20 text-purple-400">
                      Beta
                    </span>
                  </div>
                  <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                      />
                    </svg>
                    <span className="ml-1">›</span>
                  </div>
                </div>
              </button>
            )}

            {/* Action Buttons */}
            <div className="space-y-3 pt-4">
              {showInstallPrompt && (
                <button
                  onClick={() => {
                    handleInstallApp()
                    setSideMenuOpen(false)
                  }}
                  className="w-full py-3 bg-green-500 hover:bg-green-600 text-white rounded-lg text-base font-medium transition-colors flex items-center justify-center gap-2"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                    />
                  </svg>
                  Install App
                </button>
              )}

              <button
                onClick={() => {
                  handleLogout()
                  setSideMenuOpen(false)
                }}
                className="w-full py-3 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg text-base font-medium transition-colors"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
