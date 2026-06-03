import { useRef } from "react"

import { useCurrencies } from "../lib/hooks/useCurrencies"
import { usePrintReceipt } from "../lib/hooks/usePrintReceipt"
import { usePublicPOSExchangeRate } from "../lib/hooks/usePublicPOSExchangeRate"
import { usePublicPOSMenuState } from "../lib/hooks/usePublicPOSMenuState"
import {
  usePublicPOSNavigation,
  type PosRefHandle,
  type CartRefHandle,
} from "../lib/hooks/usePublicPOSNavigation"
import { usePublicPOSPayment } from "../lib/hooks/usePublicPOSPayment"
import { usePublicPOSSettings } from "../lib/hooks/usePublicPOSSettings"
import { usePublicPOSValidation } from "../lib/hooks/usePublicPOSValidation"
import { usePublicPOSViewState } from "../lib/hooks/usePublicPOSViewState"
import { useTheme } from "../lib/hooks/useTheme"
import type { CartCheckoutData } from "../lib/hooks/useViewNavigation"

import ItemCart from "./ItemCart"
import { useNFC } from "./NFCPayment"
import PaymentAnimation from "./PaymentAnimation"
import POS from "./POS"
import PublicPOSCurrencyOverlay from "./PublicPOS/PublicPOSCurrencyOverlay"
import PublicPOSPaycodeOverlay from "./PublicPOS/PublicPOSPaycodeOverlay"
import PublicPOSRegionalOverlay from "./PublicPOS/PublicPOSRegionalOverlay"
import PublicPOSSideMenu from "./PublicPOS/PublicPOSSideMenu"
import PublicPOSSoundOverlay from "./PublicPOS/PublicPOSSoundOverlay"
import PublicPOSValidationOverlay from "./PublicPOS/PublicPOSValidationOverlay"
import StagingBanner from "./StagingBanner"

/**
 * PublicPOSDashboard - Public-facing POS for any Blink username
 *
 * Similar to main Dashboard but:
 * - Only Cart and POS views (no transactions)
 * - Limited menu (Display Currency, Paycodes, Sound Effects)
 * - No authentication required
 * - Invoices go directly to the Blink user's wallet
 * - 150% zoom on desktop
 * - Polls for payment status (no webhook)
 */

interface PublicPOSDashboardProps {
  username: string
}

export default function PublicPOSDashboard({ username }: PublicPOSDashboardProps) {
  const {
    currencies,
    loading: currenciesLoading,
    getAllCurrencies,
    popularCurrencyIds: _popularCurrencyIds,
    addToPopular,
    removeFromPopular,
    isPopularCurrency,
  } = useCurrencies()
  const { theme, cycleTheme, darkMode } = useTheme()

  // Username validation - validates against current environment (production or staging)
  const {
    validationError,
    validating,
    validatedWalletCurrency: _validatedWalletCurrency,
  } = usePublicPOSValidation({ username })

  // Helper functions for consistent theme styling across all menus/submenus
  const _isBlinkClassic =
    theme === "blink-classic-dark" || theme === "blink-classic-light"

  // Menu tile styling (for main menu items)
  const getMenuTileClasses = (): string => {
    switch (theme) {
      case "blink-classic-dark":
        return "bg-transparent border border-blink-classic-border hover:bg-blink-classic-bg hover:border-blink-classic-amber"
      case "blink-classic-light":
        return "bg-transparent border border-blink-classic-border-light hover:bg-blink-classic-hover-light hover:border-blink-classic-amber"
      case "light":
        return "bg-gray-50 hover:bg-gray-100"
      case "dark":
      default:
        return "bg-gray-900 hover:bg-gray-800"
    }
  }

  // Submenu overlay background
  const getSubmenuBgClasses = (): string => {
    switch (theme) {
      case "blink-classic-dark":
        return "bg-black"
      case "blink-classic-light":
        return "bg-white"
      default:
        return "bg-white dark:bg-black"
    }
  }

  // Submenu header styling
  const getSubmenuHeaderClasses = (): string => {
    switch (theme) {
      case "blink-classic-dark":
        return "bg-black border-b border-blink-classic-border"
      case "blink-classic-light":
        return "bg-white border-b border-blink-classic-border-light"
      default:
        return "bg-gray-50 dark:bg-blink-dark shadow dark:shadow-black"
    }
  }

  // Selection tile styling (for option buttons in submenus) - unselected state
  const getSelectionTileClasses = (): string => {
    switch (theme) {
      case "blink-classic-dark":
        return "border-blink-classic-border bg-transparent hover:bg-blink-classic-bg hover:border-blink-classic-amber"
      case "blink-classic-light":
        return "border-blink-classic-border-light bg-transparent hover:bg-blink-classic-hover-light hover:border-blink-classic-amber"
      default:
        return "border-gray-300 dark:border-gray-700 bg-white dark:bg-blink-dark hover:border-gray-400 dark:hover:border-gray-600"
    }
  }

  // Selection tile styling - selected/active state
  const getSelectionTileActiveClasses = (): string => {
    switch (theme) {
      case "blink-classic-dark":
        return "border-blink-classic-amber bg-blink-classic-bg"
      case "blink-classic-light":
        return "border-blink-classic-amber bg-blink-classic-hover-light"
      default:
        return "border-blink-accent bg-blink-accent/10"
    }
  }

  // Refs (declared before hooks that need them)
  const posRef = useRef<PosRefHandle | null>(null)
  const cartRef = useRef<CartRefHandle | null>(null)
  const posPaymentReceivedRef = useRef<(() => void) | null>(null)

  // Settings (display currency, number/bitcoin format, numpad layout, sound)
  // Must be declared before usePublicPOSPayment and useNFC which consume soundEnabled/soundTheme
  const {
    displayCurrency,
    setDisplayCurrency,
    numberFormat,
    setNumberFormat,
    bitcoinFormat,
    setBitcoinFormat,
    numpadLayout,
    setNumpadLayout,
    amountDisplay,
    setAmountDisplay,
    soundEnabled,
    setSoundEnabled,
    soundTheme,
    setSoundTheme,
  } = usePublicPOSSettings()

  // View navigation state
  const {
    currentView,
    isViewTransitioning,
    transitionColorIndex,
    cartCheckoutData,
    setCartCheckoutData,
    showingInvoice,
    setShowingInvoice,
    handleViewTransition,
    handleInternalTransition,
    SPINNER_COLORS,
  } = usePublicPOSViewState({ cartRef })

  // Payment state and polling
  const {
    currentInvoice,
    paymentSuccess,
    paymentData,
    handleInvoiceChange,
    handlePaymentAnimationHide,
  } = usePublicPOSPayment({
    showingInvoice,
    soundEnabled,
    posPaymentReceivedRef,
    merchant: username,
  })

  // Receipt printing for the payment-success screen (manual, button-triggered)
  const { printReceipt, printAvailable } = usePrintReceipt({
    amountDisplay,
    numberFormat,
    bitcoinFormat,
    currencies,
  })

  // Exchange rate for sats equivalent display
  const { exchangeRate, loadingRate: _loadingRate } = usePublicPOSExchangeRate({
    displayCurrency,
  })

  // Setup NFC for Boltcard payments (after soundEnabled/soundTheme are declared)
  const nfcState = useNFC({
    paymentRequest: currentInvoice?.paymentRequest,
    onPaymentSuccess: () => {
      console.log("🎉 NFC Boltcard payment successful (Public POS)")
      // Payment will be picked up by polling
    },
    onPaymentError: (error: string) => {
      console.error("NFC payment error (Public POS):", error)
    },
    soundEnabled,
    soundTheme,
  })

  // Menu/overlay visibility state
  const {
    sideMenuOpen,
    setSideMenuOpen,
    showCurrencySettings,
    setShowCurrencySettings,
    currencyFilter,
    setCurrencyFilter,
    currencyFilterDebounced,
    showRegionalSettings,
    setShowRegionalSettings,
    showSoundSettings,
    setShowSoundSettings,
    showPaycode,
    setShowPaycode,
    paycodeAmount,
    setPaycodeAmount,
    paycodeGeneratingPdf,
    setPaycodeGeneratingPdf,
  } = usePublicPOSMenuState()

  // Touch + keyboard navigation
  const { handleTouchStart, handleTouchMove, handleTouchEnd } = usePublicPOSNavigation({
    currentView,
    showingInvoice,
    paymentSuccess,
    sideMenuOpen,
    showCurrencySettings,
    showSoundSettings,
    showPaycode,
    handleViewTransition,
    handlePaymentAnimationHide,
    posRef,
    cartRef,
  })

  const isFixedView = currentView === "pos" || currentView === "cart"

  return (
    <div
      className={`bg-white dark:bg-black ${isFixedView ? "h-screen overflow-hidden fixed inset-0" : "min-h-screen"}`}
    >
      {/* Staging Banner */}
      <StagingBanner />

      {/* Username Validation Overlay (error + loading) */}
      <PublicPOSValidationOverlay
        validationError={validationError}
        validating={validating}
        darkMode={darkMode}
      />

      {/* Header - Hidden when showing invoice */}
      {!showingInvoice && (
        <header
          className={`${theme === "blink-classic-dark" ? "bg-black" : "bg-gray-50 dark:bg-blink-dark"} shadow dark:shadow-black sticky top-0 z-40`}
        >
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between py-4">
              {/* Blink Logo - Left (tap to cycle theme) */}
              <button
                onClick={cycleTheme}
                className="flex items-center focus:outline-none"
                aria-label="Cycle theme"
              >
                {/* For Blink Classic Dark, header is black so show dark logo */}
                <img
                  src="/logos/blink-icon-light.svg"
                  alt="Blink"
                  className={`h-12 w-12 ${theme === "light" || theme === "blink-classic-light" ? "block" : "hidden"}`}
                />
                <img
                  src="/logos/blink-icon-dark.svg"
                  alt="Blink"
                  className={`h-12 w-12 ${theme === "light" || theme === "blink-classic-light" ? "hidden" : "block"}`}
                />
              </button>

              {/* Navigation Dots - Center (only Cart and POS) */}
              <div className="flex gap-2">
                <button
                  onClick={() => handleViewTransition("cart")}
                  disabled={isViewTransitioning}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    currentView === "cart"
                      ? "bg-blink-accent"
                      : "bg-gray-300 dark:bg-gray-600 hover:bg-gray-400 dark:hover:bg-gray-500"
                  }`}
                  aria-label="Cart"
                />
                <button
                  onClick={() => handleViewTransition("pos")}
                  disabled={isViewTransitioning}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    currentView === "pos"
                      ? "bg-blink-accent"
                      : "bg-gray-300 dark:bg-gray-600 hover:bg-gray-400 dark:hover:bg-gray-500"
                  }`}
                  aria-label="POS"
                />
              </div>

              {/* Menu Button - Right */}
              <button
                onClick={() => setSideMenuOpen(!sideMenuOpen)}
                className="p-2 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-blink-dark focus:outline-none"
                aria-label="Open menu"
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                </svg>
              </button>
            </div>
          </div>
        </header>
      )}

      {/* Side Menu */}
      {sideMenuOpen && (
        <PublicPOSSideMenu
          onClose={() => setSideMenuOpen(false)}
          theme={theme}
          cycleTheme={cycleTheme}
          displayCurrency={displayCurrency}
          numberFormat={numberFormat}
          soundEnabled={soundEnabled}
          soundTheme={soundTheme}
          onShowCurrencySettings={() => setShowCurrencySettings(true)}
          onShowRegionalSettings={() => setShowRegionalSettings(true)}
          onShowPaycode={() => {
            setShowPaycode(true)
            setSideMenuOpen(false)
          }}
          onShowSoundSettings={() => setShowSoundSettings(true)}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
          getMenuTileClasses={getMenuTileClasses}
        />
      )}

      {/* Currency Settings Overlay */}
      {showCurrencySettings && (
        <PublicPOSCurrencyOverlay
          onClose={() => setShowCurrencySettings(false)}
          darkMode={darkMode}
          displayCurrency={displayCurrency}
          setDisplayCurrency={setDisplayCurrency}
          currencyFilter={currencyFilter}
          setCurrencyFilter={setCurrencyFilter}
          currencyFilterDebounced={currencyFilterDebounced}
          currenciesLoading={currenciesLoading}
          getAllCurrencies={getAllCurrencies}
          isPopularCurrency={isPopularCurrency}
          addToPopular={addToPopular}
          removeFromPopular={removeFromPopular}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
        />
      )}

      {/* Regional Settings Overlay */}
      {showRegionalSettings && (
        <PublicPOSRegionalOverlay
          onClose={() => setShowRegionalSettings(false)}
          darkMode={darkMode}
          numberFormat={numberFormat}
          setNumberFormat={setNumberFormat}
          bitcoinFormat={bitcoinFormat}
          setBitcoinFormat={setBitcoinFormat}
          numpadLayout={numpadLayout}
          setNumpadLayout={setNumpadLayout}
          amountDisplay={amountDisplay}
          setAmountDisplay={setAmountDisplay}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
        />
      )}

      {/* Sound Settings Overlay */}
      {showSoundSettings && (
        <PublicPOSSoundOverlay
          onClose={() => setShowSoundSettings(false)}
          soundEnabled={soundEnabled}
          setSoundEnabled={setSoundEnabled}
          soundTheme={soundTheme}
          setSoundTheme={setSoundTheme}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
          getSelectionTileClasses={getSelectionTileClasses}
          getSelectionTileActiveClasses={getSelectionTileActiveClasses}
        />
      )}

      {/* Paycode Overlay */}
      {showPaycode && (
        <PublicPOSPaycodeOverlay
          onClose={() => setShowPaycode(false)}
          username={username}
          darkMode={darkMode}
          paycodeAmount={paycodeAmount}
          setPaycodeAmount={setPaycodeAmount}
          paycodeGeneratingPdf={paycodeGeneratingPdf}
          setPaycodeGeneratingPdf={setPaycodeGeneratingPdf}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
        />
      )}

      {/* Main Content */}
      <main
        className={`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mobile-content ${isFixedView ? "h-[calc(100vh-80px)] overflow-hidden py-2" : "py-6"}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Spacer - Fixed height to prevent numpad jumping when switching views */}
        {!showingInvoice && (
          <div className="h-16 mb-2 flex flex-col justify-center bg-white dark:bg-black">
            {/* Owner Display Row - 3-column layout: Owner | View Label | Spacer */}
            <div className="flex items-center justify-between">
              {/* Left side: Owner info */}
              <div className="flex-1 flex items-center gap-2">
                <img src="/bluedot.svg" alt="Owner" className="w-2 h-2" />
                <span
                  className="font-semibold text-blue-600 dark:text-blue-400"
                  style={{ fontSize: "11.2px" }}
                >
                  {username}
                </span>
              </div>

              {/* Center: View label */}
              <div className="flex-1 text-center">
                <span className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                  {currentView === "cart" ? "Item Cart" : "Point Of Sale"}
                </span>
              </div>

              {/* Right side: Spacer for balance */}
              <div className="flex-1"></div>
            </div>
          </div>
        )}

        {/* View Transition Loading Overlay */}
        {isViewTransitioning && (
          <div className="fixed inset-0 z-40 bg-white/80 dark:bg-black/80 flex items-center justify-center backdrop-blur-sm">
            <div
              className={`animate-spin rounded-full h-12 w-12 border-4 ${SPINNER_COLORS[transitionColorIndex]} border-t-transparent`}
            ></div>
          </div>
        )}

        {/* Payment Success Animation */}
        <PaymentAnimation
          show={paymentSuccess}
          payment={paymentData}
          onHide={handlePaymentAnimationHide}
          soundEnabled={soundEnabled}
          soundTheme={soundTheme}
          amountDisplay={amountDisplay}
          numberFormat={numberFormat}
          bitcoinFormat={bitcoinFormat}
          currencies={currencies}
          onPrintReceipt={printReceipt}
          printAvailable={printAvailable}
        />

        {/* Conditional Content Based on Current View */}
        {currentView === "cart" ? (
          <div className="h-[calc(100vh-160px)] min-h-[400px]">
            <ItemCart
              ref={cartRef}
              displayCurrency={displayCurrency}
              numberFormat={numberFormat}
              bitcoinFormat={bitcoinFormat}
              currencies={currencies}
              publicKey={null} // No auth in public mode - cart items stored locally
              onCheckout={(checkoutData: CartCheckoutData) => {
                setCartCheckoutData(checkoutData)
                handleViewTransition("pos")
              }}
              soundEnabled={soundEnabled}
              darkMode={darkMode}
              theme={theme}
              cycleTheme={cycleTheme}
              isViewTransitioning={isViewTransitioning}
              exchangeRate={exchangeRate}
            />
          </div>
        ) : (
          <POS
            ref={posRef}
            apiKey={null} // No API key - uses public invoice creation
            user={{ username, authMode: "public" }}
            displayCurrency={displayCurrency}
            numberFormat={numberFormat}
            bitcoinFormat={bitcoinFormat}
            numpadLayout={numpadLayout}
            currencies={currencies}
            wallets={[]} // No wallets in public mode
            onPaymentReceived={posPaymentReceivedRef}
            connected={false}
            tipsEnabled={false}
            tipPresets={[]}
            tipRecipients={[]}
            soundEnabled={soundEnabled}
            onInvoiceStateChange={setShowingInvoice}
            onInvoiceChange={handleInvoiceChange}
            darkMode={darkMode}
            theme={theme}
            cycleTheme={cycleTheme}
            nfcState={nfcState}
            activeBlinkAccount={{
              id: "public",
              label: "Public",
              username,
              type: "public",
              isActive: true,
            }}
            cartCheckoutData={cartCheckoutData}
            onCartCheckoutProcessed={() => setCartCheckoutData(null)}
            onInternalTransition={handleInternalTransition}
            // Public POS specific props
            isPublicPOS={true}
            publicUsername={username}
          />
        )}
      </main>
    </div>
  )
}
