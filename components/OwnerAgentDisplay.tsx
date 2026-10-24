import React from "react"

import type { LocalNWCConnection } from "../lib/hooks/useNWC"
import type { LocalBlinkAccount } from "../lib/hooks/useProfile"
import type { SplitProfile } from "../lib/hooks/useSplitProfiles"
import type { DashboardView } from "../lib/hooks/useViewNavigation"
import type {
  VoucherWallet,
  VoucherCurrencyMode,
  VoucherExpiry,
} from "../lib/hooks/useVoucherWalletState"

import ExpirySelector from "./ExpirySelector"

interface VoucherImperativeHandle {
  setSelectedExpiry?: (expiryId: string) => void
  [key: string]: unknown
}

interface OwnerAgentDisplayProps {
  currentView: DashboardView
  showingInvoice: boolean
  showingVoucherQR: boolean
  voucherWallet: VoucherWallet | null
  activeNWC: LocalNWCConnection | null
  activeNpubCashWallet: LocalBlinkAccount | null
  activeBlinkAccount: LocalBlinkAccount | null
  voucherExpiry: VoucherExpiry
  activeSplitProfile: SplitProfile | null
  isSparkLnAddress: boolean
  voucherWalletBalanceLoading: boolean
  isBlinkClassic: boolean
  currentVoucherCurrencyMode: VoucherCurrencyMode
  currentAmountInUsdCents: number
  currentAmountInSats: number
  voucherWalletUsdBalance: number | null
  voucherWalletBalance: number | null
  setShowVoucherWalletSettings: (show: boolean) => void
  setShowAccountSettings: (show: boolean) => void
  setVoucherExpiry: (expiry: VoucherExpiry) => void
  voucherRef: React.RefObject<VoucherImperativeHandle | null>
  multiVoucherRef: React.RefObject<VoucherImperativeHandle | null>
  getCapacityColor: (currentAmount: number, walletBalance: number) => string
}

export default function OwnerAgentDisplay({
  currentView,
  showingInvoice,
  showingVoucherQR,
  voucherWallet,
  activeNWC,
  activeNpubCashWallet,
  activeBlinkAccount,
  voucherExpiry,
  activeSplitProfile,
  isSparkLnAddress,
  voucherWalletBalanceLoading,
  isBlinkClassic,
  currentVoucherCurrencyMode,
  currentAmountInUsdCents,
  currentAmountInSats,
  voucherWalletUsdBalance,
  voucherWalletBalance,
  setShowVoucherWalletSettings,
  setShowAccountSettings,
  setVoucherExpiry,
  voucherRef,
  multiVoucherRef,
  getCapacityColor,
}: OwnerAgentDisplayProps) {
  // Only render when visible
  if (showingInvoice || showingVoucherQR) return null
  if (
    currentView !== "pos" &&
    currentView !== "cart" &&
    currentView !== "voucher" &&
    currentView !== "multivoucher" &&
    currentView !== "vouchermanager"
  )
    return null

  return (
    <div className="flex flex-col gap-1 mb-2 bg-white dark:bg-black">
      {/* Owner Display Row - 3-column layout: Owner | View Label | Expiry Selector */}
      <div className="flex items-center justify-between">
        {/* Left side: Owner info */}
        <div className="flex-1">
          {(() => {
            // For voucher, multivoucher, and vouchermanager views, show voucher wallet
            if (
              currentView === "voucher" ||
              currentView === "multivoucher" ||
              currentView === "vouchermanager"
            ) {
              if (voucherWallet) {
                return (
                  <div className="flex items-center gap-2">
                    <img src="/purpledot.svg" alt="Voucher Wallet" className="w-2 h-2" />
                    <span
                      className="font-semibold text-purple-600 dark:text-purple-400"
                      style={{ fontSize: "11.2px" }}
                    >
                      {voucherWallet.label ||
                        String(voucherWallet.username ?? "") ||
                        "Voucher Wallet"}
                    </span>
                  </div>
                )
              } else {
                return (
                  <button
                    onClick={() => setShowVoucherWalletSettings(true)}
                    className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                  >
                    <img src="/yellowdot.svg" alt="No Wallet" className="w-2 h-2" />
                    <span
                      className="font-semibold text-yellow-600 dark:text-yellow-400"
                      style={{ fontSize: "11.2px" }}
                    >
                      Connect voucher wallet
                    </span>
                  </button>
                )
              }
            }

            // For POS/Cart view, show regular wallet
            const hasWallet = activeNWC || activeNpubCashWallet || activeBlinkAccount
            const noWallet = !hasWallet
            const dotColor = activeNWC
              ? "/purpledot.svg"
              : activeNpubCashWallet
                ? "/tealdot.svg"
                : hasWallet
                  ? "/bluedot.svg"
                  : "/yellowdot.svg"
            const textColorClass = activeNWC
              ? "text-purple-600 dark:text-purple-400"
              : activeNpubCashWallet
                ? "text-teal-600 dark:text-teal-400"
                : hasWallet
                  ? "text-blue-600 dark:text-blue-400"
                  : "text-yellow-600 dark:text-yellow-400"
            const displayText = activeNWC
              ? activeNWC.label
              : activeNpubCashWallet
                ? activeNpubCashWallet.label || activeNpubCashWallet.lightningAddress
                : activeBlinkAccount?.label ||
                  activeBlinkAccount?.username ||
                  "Connect wallet to start"

            if (noWallet) {
              return (
                <button
                  onClick={() => setShowAccountSettings(true)}
                  className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                >
                  <img src={dotColor} alt="Owner" className="w-2 h-2" />
                  <span
                    className={`font-semibold ${textColorClass}`}
                    style={{ fontSize: "11.2px" }}
                  >
                    {displayText}
                  </span>
                </button>
              )
            }

            return (
              <div className="flex items-center gap-2">
                <img src={dotColor} alt="Owner" className="w-2 h-2" />
                <span
                  className={`font-semibold ${textColorClass}`}
                  style={{ fontSize: "11.2px" }}
                >
                  {displayText}
                </span>
              </div>
            )
          })()}
        </div>

        {/* Center: View label */}
        <div className="flex-1 text-center">
          <span className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            {currentView === "pos"
              ? "Point Of Sale"
              : currentView === "cart"
                ? "Item Cart"
                : currentView === "voucher"
                  ? "Single Voucher"
                  : currentView === "multivoucher"
                    ? "Multi-Voucher"
                    : currentView === "vouchermanager"
                      ? "Voucher Manager"
                      : ""}
          </span>
        </div>

        {/* Right side: Expiry Selector (on Voucher and MultiVoucher screens) */}
        <div className="flex-1 flex justify-end">
          {(currentView === "voucher" || currentView === "multivoucher") &&
            !showingVoucherQR && (
              <>
                {currentView === "voucher" && (
                  <ExpirySelector
                    value={voucherExpiry}
                    onChange={(expiryId: string) => {
                      setVoucherExpiry(expiryId as VoucherExpiry)
                      voucherRef.current?.setSelectedExpiry?.(expiryId)
                    }}
                  />
                )}
                {currentView === "multivoucher" && (
                  <ExpirySelector
                    value={voucherExpiry}
                    onChange={(expiryId: string) => {
                      setVoucherExpiry(expiryId as VoucherExpiry)
                      multiVoucherRef.current?.setSelectedExpiry?.(expiryId)
                    }}
                  />
                )}
              </>
            )}
        </div>
      </div>

      {/* Agent Display Row - Always reserve space for consistent numpad positioning */}
      {/* On POS/Cart: Show split profile if active, otherwise empty placeholder */}
      {/* On Voucher/MultiVoucher: Show Capacity indicator on right */}
      <div className="flex items-center gap-2 min-h-[18px]">
        {activeSplitProfile &&
          !isSparkLnAddress &&
          currentView !== "voucher" &&
          currentView !== "multivoucher" &&
          currentView !== "vouchermanager" && (
            <>
              <img src="/greendot.svg" alt="Split Active" className="w-2 h-2" />
              <span
                className="text-green-600 dark:text-green-400 font-semibold"
                style={{ fontSize: "11.2px" }}
              >
                {activeSplitProfile.label}
              </span>
            </>
          )}
        {/* Capacity Indicator - Right aligned on Voucher and MultiVoucher views */}
        {(currentView === "voucher" || currentView === "multivoucher") &&
          !showingVoucherQR && (
            <div className="flex-1 flex justify-end">
              <div className="flex items-center gap-1.5" title="Wallet capacity">
                {voucherWalletBalanceLoading ? (
                  <div className="animate-spin w-2.5 h-2.5 border border-gray-400 border-t-transparent rounded-full"></div>
                ) : (
                  <>
                    <span
                      className={`text-xs font-medium ${
                        isBlinkClassic
                          ? currentVoucherCurrencyMode === "USD"
                            ? "text-green-500"
                            : "text-orange-500"
                          : currentVoucherCurrencyMode === "USD"
                            ? "text-teal-500"
                            : "text-cyan-500"
                      }`}
                    >
                      {currentVoucherCurrencyMode === "USD" ? "Dollar" : "Bitcoin"}
                    </span>
                    <div
                      className={`w-2.5 h-2.5 rounded-full ${getCapacityColor(
                        currentVoucherCurrencyMode === "USD"
                          ? currentAmountInUsdCents
                          : currentAmountInSats,
                        currentVoucherCurrencyMode === "USD"
                          ? (voucherWalletUsdBalance ?? 0)
                          : (voucherWalletBalance ?? 0),
                      )}`}
                    ></div>
                  </>
                )}
              </div>
            </div>
          )}
      </div>
    </div>
  )
}
