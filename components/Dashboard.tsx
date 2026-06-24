import { useEffect, useRef } from "react"

import { useAccountManagement } from "../lib/hooks/useAccountManagement"
import { useBlinkWebSocket } from "../lib/hooks/useBlinkWebSocket"
import { useCombinedAuth } from "../lib/hooks/useCombinedAuth"
import { useCommissionSettings } from "../lib/hooks/useCommissionSettings"
import { useCurrencies } from "../lib/hooks/useCurrencies"
import { useDashboardData } from "../lib/hooks/useDashboardData"
import { useDisplaySettings } from "../lib/hooks/useDisplaySettings"
import { useExchangeRate } from "../lib/hooks/useExchangeRate"
import { useExchangeRateFetcher } from "../lib/hooks/useExchangeRateFetcher"
import { useInvoiceState } from "../lib/hooks/useInvoiceState"
import { useNavigationHandlers } from "../lib/hooks/useNavigationHandlers"
import { usePaycodeState } from "../lib/hooks/usePaycodeState"
import { usePaymentPolling } from "../lib/hooks/usePaymentPolling"
import { usePrintReceipt } from "../lib/hooks/usePrintReceipt"
import { usePWAInstall, type BeforeInstallPromptEvent } from "../lib/hooks/usePWAInstall"
import { useReceiverType } from "../lib/hooks/useReceiverType"
import { useServerSync, getVoucherWalletKey } from "../lib/hooks/useServerSync"
import { useSoundSettings } from "../lib/hooks/useSoundSettings"
import { useSplitProfileActions } from "../lib/hooks/useSplitProfileActions"
import { useSplitProfiles } from "../lib/hooks/useSplitProfiles"
import { useTheme } from "../lib/hooks/useTheme"
import { useThemeStyles } from "../lib/hooks/useThemeStyles"
import { useTipRecipientValidation } from "../lib/hooks/useTipRecipientValidation"
import { useTipSettings } from "../lib/hooks/useTipSettings"
import { useTransactionActions } from "../lib/hooks/useTransactionActions"
import { useTransactionState } from "../lib/hooks/useTransactionState"
import { useUIVisibility } from "../lib/hooks/useUIVisibility"
import { useViewNavigation } from "../lib/hooks/useViewNavigation"
import { useVoucherWalletState } from "../lib/hooks/useVoucherWalletState"
import { useWalletState } from "../lib/hooks/useWalletState"

import DashboardViewSwitcher from "./DashboardViewSwitcher"
import MobileHeader from "./MobileHeader"
import OwnerAgentDisplay from "./OwnerAgentDisplay"
import PaymentAnimation from "./PaymentAnimation"
import BatchPaymentsOverlay from "./Settings/BatchPaymentsOverlay"
import BoltcardsOverlay from "./Settings/BoltcardsOverlay"
import CommissionSettingsOverlay from "./Settings/CommissionSettingsOverlay"
import CreateEditSplitProfileOverlay from "./Settings/CreateEditSplitProfileOverlay"
import CurrencySettingsOverlay from "./Settings/CurrencySettingsOverlay"
import DateRangeSelectorOverlay from "./Settings/DateRangeSelectorOverlay"
import ExportOptionsOverlay from "./Settings/ExportOptionsOverlay"
import KeyManagementOverlay from "./Settings/KeyManagementOverlay"
import NetworkOverlay from "./Settings/NetworkOverlay"
import PaycodesOverlay from "./Settings/PaycodesOverlay"
import PercentSettingsOverlay from "./Settings/PercentSettingsOverlay"
import RegionalSettingsOverlay from "./Settings/RegionalSettingsOverlay"
import SoundThemesOverlay from "./Settings/SoundThemesOverlay"
import SplitSettingsOverlay from "./Settings/SplitSettingsOverlay"
import TipProfileSettingsOverlay from "./Settings/TipProfileSettingsOverlay"
import VoucherWalletOverlay from "./Settings/VoucherWalletOverlay"
import WalletsOverlay from "./Settings/WalletsOverlay"
import SideMenuOverlay from "./SideMenuOverlay"
import TransactionDetail from "./TransactionDetail"

// Predefined Tip Profiles for different regions
interface TipProfile {
  id: string
  name: string
  tipOptions: number[]
}

const TIP_PROFILES: TipProfile[] = [
  { id: "na", name: "North America (US/CA)", tipOptions: [18, 20, 25] },
  { id: "eu", name: "Western Europe (Standard)", tipOptions: [5, 10, 15] },
  { id: "africa", name: "Africa (Standard/South)", tipOptions: [10, 12, 15] },
  { id: "africa-low", name: "Africa (Low/Round Up)", tipOptions: [5, 10] },
  { id: "asia", name: "Asia & Oceania (Low)", tipOptions: [2, 5, 10] },
  { id: "latam", name: "Latin America (Included)", tipOptions: [10, 12, 15] },
  { id: "mena", name: "Middle East (Variable)", tipOptions: [5, 10, 15] },
]

export default function Dashboard() {
  const {
    user,
    logout,
    authMode,
    getApiKey,
    hasServerSession,
    publicKey,
    activeBlinkAccount,
    blinkAccounts,
    addBlinkAccount,
    addBlinkLnAddressWallet,
    removeBlinkAccount,
    updateBlinkAccount,
    setActiveBlinkAccount,
    storeBlinkAccountOnServer,
    tippingSettings: _profileTippingSettings,
    updateTippingSettings: _updateProfileTippingSettings,
    nostrProfile,
    // NWC data from useCombinedAuth (user-scoped)
    nwcConnections,
    activeNWC,
    addNWCConnection,
    removeNWCConnection,
    updateNWCConnection,
    setActiveNWC,
    nwcMakeInvoice,
    nwcLookupInvoice,
    nwcListTransactions,
    nwcHasCapability,
    nwcClientReady,
    getActiveNWCUri, // For server-side NWC forwarding via webhook
    // npub.cash wallet data
    activeNpubCashWallet,
    npubCashWallets,
    addNpubCashWallet,
  } = useCombinedAuth()
  const {
    currencies,
    loading: currenciesLoading,
    getAllCurrencies,
    popularCurrencyIds: _popularCurrencyIds,
    addToPopular,
    removeFromPopular,
    isPopularCurrency,
  } = useCurrencies()
  const { cycleTheme } = useTheme()

  // Theme styling utilities - extracted to useThemeStyles hook
  const {
    theme,
    darkMode,
    isBlinkClassic,
    isBlinkClassicDark,
    isBlinkClassicLight,
    getMenuTileClasses,
    getSubmenuBgClasses,
    getSubmenuHeaderClasses,
    getSelectionTileClasses,
    getSelectionTileActiveClasses,
    getInputClasses,
    getWalletCardClasses,
    getWalletCardActiveClasses,
    getWalletIconClasses,
    getWalletUseButtonClasses,
    getWalletActiveBadgeClasses,
    getWalletDeleteButtonClasses: _getWalletDeleteButtonClasses,
    getSubmenuOptionClasses,
    getSubmenuOptionActiveClasses,
    getPreviewBoxClasses,
    getSectionLabelClasses,
    getPrimaryTextClasses,
    getSecondaryTextClasses,
    getCheckmarkClasses,
  } = useThemeStyles()

  // View navigation state - extracted to useViewNavigation hook
  const {
    currentView,
    setCurrentView,
    isViewTransitioning,
    setIsViewTransitioning,
    transitionColorIndex,
    setTransitionColorIndex,
    cartCheckoutData,
    setCartCheckoutData,
    sideMenuOpen,
    setSideMenuOpen,
    toggleSideMenu: _toggleSideMenu,
    navigateToView: _navigateToView,
    currentSpinnerColor,
    isVoucherRelatedView: _isVoucherRelatedView,
  } = useViewNavigation()

  // Display and regional settings - extracted to useDisplaySettings hook
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
    orangePillMode,
    setOrangePillMode,
    orangePillStaticUrl,
    setOrangePillStaticUrl,
    currencyFilter,
    setCurrencyFilter,
    currencyFilterDebounced,
    clearCurrencyFilter,
  } = useDisplaySettings()

  // UI visibility states - extracted to useUIVisibility hook
  const {
    showAccountSettings,
    setShowAccountSettings,
    showVoucherWalletSettings,
    setShowVoucherWalletSettings,
    showCurrencySettings,
    setShowCurrencySettings,
    showRegionalSettings,
    setShowRegionalSettings,
    showTipSettings,
    setShowTipSettings,
    showTipProfileSettings,
    setShowTipProfileSettings,
    showPercentSettings,
    setShowPercentSettings,
    showKeyManagement,
    setShowKeyManagement,
    showBoltcards,
    setShowBoltcards,
    showBatchPayments,
    setShowBatchPayments,
    showNetworkOverlay,
    setShowNetworkOverlay,
    showAddAccountForm,
    setShowAddAccountForm,
    showDateRangeSelector,
    setShowDateRangeSelector,
    showExportOptions,
    setShowExportOptions,
    showTimeInputs,
    setShowTimeInputs,
    showingInvoice,
    setShowingInvoice,
    showingVoucherQR,
    setShowingVoucherQR,
    closeAllOverlays: _closeAllOverlays,
    closeAllSettings: _closeAllSettings,
  } = useUIVisibility()

  // Wallet state (API key and wallet list) managed by useWalletState hook
  const { apiKey, setApiKey, wallets, setWallets } = useWalletState()

  // Transaction state - extracted to useTransactionState hook
  const {
    transactions,
    setTransactions,
    loading,
    setLoading,
    error,
    setError,
    expandedMonths,
    setExpandedMonths,
    toggleExpandedMonth: _toggleExpandedMonth,
    monthlyTransactions: _monthlyTransactions,
    setMonthlyTransactions: _setMonthlyTransactions,
    hasMoreTransactions,
    setHasMoreTransactions,
    loadingMore,
    setLoadingMore,
    pastTransactionsLoaded,
    setPastTransactionsLoaded,
    exportingData,
    setExportingData,
    selectedDateRange,
    setSelectedDateRange,
    customDateStart,
    setCustomDateStart,
    customDateEnd,
    setCustomDateEnd,
    customTimeStart,
    setCustomTimeStart,
    customTimeEnd,
    setCustomTimeEnd,
    filteredTransactions,
    setFilteredTransactions,
    dateFilterActive,
    setDateFilterActive,
    selectedTransaction,
    setSelectedTransaction,
    labelUpdateTrigger: _labelUpdateTrigger,
    triggerLabelUpdate,
    isSearchingTx,
    setIsSearchingTx,
    txSearchInput,
    setTxSearchInput,
    txSearchQuery,
    setTxSearchQuery,
    isSearchLoading,
    setIsSearchLoading,
    clearTransactions: _clearTransactions,
    clearDateFilter,
    clearSearch: _clearSearch,
  } = useTransactionState()

  // PWA install state - extracted to usePWAInstall hook
  const {
    deferredPrompt: _deferredPrompt,
    setDeferredPrompt,
    showInstallPrompt,
    setShowInstallPrompt,
    triggerInstall,
  } = usePWAInstall()

  // Sound settings - extracted to useSoundSettings hook
  const {
    soundEnabled,
    setSoundEnabled,
    soundTheme,
    setSoundTheme,
    showSoundThemes,
    setShowSoundThemes,
    toggleSoundEnabled: _toggleSoundEnabled,
  } = useSoundSettings()

  // Tip functionality state - extracted to useTipSettings hook
  const {
    tipsEnabled,
    setTipsEnabled,
    tipPresets,
    setTipPresets,
    tipRecipient,
    setTipRecipient,
    usernameValidation,
    setUsernameValidation,
    activeTipProfile,
    setActiveTipProfile,
    clearUsernameValidation: _clearUsernameValidation,
    resetTipRecipient,
    toggleTipsEnabled: _toggleTipsEnabled,
  } = useTipSettings()

  // Tip recipient validation - extracted to useTipRecipientValidation hook
  const { validateBlinkUsername: _validateBlinkUsername } = useTipRecipientValidation({
    tipRecipient,
    setUsernameValidation,
    setTipsEnabled,
    usernameValidation,
  })

  // Account management state - extracted to useAccountManagement hook
  const {
    newAccountApiKey,
    setNewAccountApiKey,
    newAccountLabel,
    setNewAccountLabel,
    newAccountNwcUri,
    setNewAccountNwcUri,
    newAccountType,
    setNewAccountType,
    newAccountLnAddress,
    setNewAccountLnAddress,
    newNpubCashAddress,
    setNewNpubCashAddress,
    addAccountLoading,
    setAddAccountLoading,
    addAccountError,
    setAddAccountError,
    nwcValidating,
    setNwcValidating,
    nwcValidated,
    setNwcValidated,
    lnAddressValidating,
    setLnAddressValidating,
    lnAddressValidated,
    setLnAddressValidated,
    npubCashValidating,
    setNpubCashValidating,
    npubCashValidated,
    setNpubCashValidated,
    confirmDeleteWallet: _confirmDeleteWallet,
    setConfirmDeleteWallet,
    editingWalletLabel,
    setEditingWalletLabel,
    editedWalletLabel,
    setEditedWalletLabel,
    resetNewAccountForm: _resetNewAccountForm,
  } = useAccountManagement()

  // Voucher Wallet state - extracted to useVoucherWalletState hook
  // NOTE: Initial state is null - we load ONLY after authentication to ensure user-scoped storage
  const {
    voucherWallet,
    setVoucherWallet,
    voucherWalletApiKey,
    setVoucherWalletApiKey,
    voucherWalletLabel,
    setVoucherWalletLabel,
    voucherWalletLoading,
    setVoucherWalletLoading,
    voucherWalletError,
    setVoucherWalletError,
    voucherWalletValidating,
    setVoucherWalletValidating,
    voucherWalletScopes,
    setVoucherWalletScopes,
    voucherWalletBalance,
    setVoucherWalletBalance,
    voucherWalletUsdBalance,
    setVoucherWalletUsdBalance,
    voucherWalletBalanceLoading,
    setVoucherWalletBalanceLoading,
    voucherWalletBtcId,
    setVoucherWalletBtcId,
    voucherWalletUsdId,
    setVoucherWalletUsdId,
    voucherCurrencyMode,
    setVoucherCurrencyMode,
    voucherExpiry,
    setVoucherExpiry,
    usdExchangeRate,
    setUsdExchangeRate,
    currentAmountInSats,
    setCurrentAmountInSats,
    currentAmountInUsdCents,
    setCurrentAmountInUsdCents,
    currentVoucherCurrencyMode,
    setCurrentVoucherCurrencyMode,
  } = useVoucherWalletState()

  // Commission settings - extracted to useCommissionSettings hook
  const {
    commissionEnabled,
    setCommissionEnabled,
    commissionPresets,
    setCommissionPresets,
    showCommissionSettings,
    setShowCommissionSettings,
    toggleCommissionEnabled: _toggleCommissionEnabled,
  } = useCommissionSettings()

  // Paycode state - extracted to usePaycodeState hook
  const {
    showPaycode,
    setShowPaycode,
    paycodeAmount,
    setPaycodeAmount,
    paycodeGeneratingPdf,
    setPaycodeGeneratingPdf,
  } = usePaycodeState()

  // NOTE: activeTipProfile is now managed by useTipSettings hook above

  // Split Profiles state - extracted to useSplitProfiles hook
  const {
    splitProfiles,
    setSplitProfiles,
    activeSplitProfile,
    setActiveSplitProfile,
    splitProfilesLoading,
    setSplitProfilesLoading,
    showCreateSplitProfile,
    setShowCreateSplitProfile,
    editingSplitProfile,
    setEditingSplitProfile,
    newSplitProfileLabel,
    setNewSplitProfileLabel,
    newSplitProfileRecipients,
    setNewSplitProfileRecipients,
    newRecipientInput,
    setNewRecipientInput,
    splitProfileError,
    setSplitProfileError,
    recipientValidation,
    setRecipientValidation,
    useCustomWeights,
    setUseCustomWeights,
    resetSplitProfileForm: _resetSplitProfileForm,
  } = useSplitProfiles()

  // Exchange rate state for sats equivalent display in ItemCart (managed by useExchangeRate hook)
  const {
    exchangeRate,
    setExchangeRate,
    loadingRate: _loadingRate,
    setLoadingRate,
  } = useExchangeRate()

  // Exchange rate fetching & tip sync - extracted to useExchangeRateFetcher hook
  useExchangeRateFetcher({
    displayCurrency,
    apiKey,
    setExchangeRate,
    setLoadingRate,
    voucherWallet,
    setUsdExchangeRate,
    activeTipProfile,
    setTipPresets,
    resetTipRecipient,
    user,
  })

  // Server sync for preferences & voucher wallet - extracted to useServerSync hook
  const { syncVoucherWalletToServer } = useServerSync({
    publicKey,
    soundEnabled,
    setSoundEnabled,
    soundTheme,
    setSoundTheme,
    tipsEnabled,
    setTipsEnabled,
    tipPresets,
    setTipPresets,
    displayCurrency,
    setDisplayCurrency,
    numberFormat,
    setNumberFormat,
    numpadLayout,
    setNumpadLayout,
    voucherCurrencyMode,
    setVoucherCurrencyMode,
    voucherExpiry,
    setVoucherExpiry,
    voucherWallet,
    setVoucherWallet,
    setVoucherWalletBalance,
    setVoucherWalletUsdBalance,
  })

  // Split profile CRUD & recipient validation - extracted to useSplitProfileActions hook
  const {
    fetchSplitProfiles: _fetchSplitProfiles,
    saveSplitProfile,
    deleteSplitProfile,
    setActiveSplitProfileById,
    validateRecipientUsername: _validateRecipientUsername,
    addRecipientToProfile,
    removeRecipientFromProfile,
  } = useSplitProfileActions({
    publicKey,
    authMode,
    splitProfiles,
    setSplitProfiles,
    setActiveSplitProfile,
    setSplitProfilesLoading,
    setSplitProfileError,
    setTipsEnabled,
    setTipRecipient,
    setRecipientValidation,
    recipientValidation,
    newRecipientInput,
    setNewRecipientInput,
    newSplitProfileRecipients,
    setNewSplitProfileRecipients,
    useCustomWeights,
  })

  // Self-custodial (Spark) detection. Spark receivers have no escrow account, so
  // tip forwarding and payment splits are impossible — suppress those UIs.
  const { isSparkLnAddress } = useReceiverType(activeBlinkAccount)

  // If the active receive wallet is (or becomes) a self-custodial Spark LN
  // address while a split profile is active, force-deactivate it so no
  // un-forwardable tip is added to the invoice. This also clears tipsEnabled and
  // tipRecipient (handled inside setActiveSplitProfileById).
  useEffect(() => {
    if (isSparkLnAddress && activeSplitProfile) {
      setActiveSplitProfileById(null)
    }
  }, [isSparkLnAddress, activeSplitProfile, setActiveSplitProfileById])

  // Transaction search ref (state is in useTransactionState hook)
  const txSearchInputRef = useRef<HTMLInputElement>(null)

  // Refs for keyboard navigation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- refs are passed to multiple consumers with incompatible handle types
  const posRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- refs are passed to multiple consumers with incompatible handle types
  const voucherRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- refs are passed to multiple consumers with incompatible handle types
  const multiVoucherRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- refs are passed to multiple consumers with incompatible handle types
  const voucherManagerRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- refs are passed to multiple consumers with incompatible handle types
  const cartRef = useRef<any>(null)

  // NOTE: Sound settings persistence is now handled by useSoundSettings hook

  // Reset currency filter when closing the currency settings overlay
  useEffect(() => {
    if (!showCurrencySettings) {
      clearCurrencyFilter()
    }
  }, [showCurrencySettings, clearCurrencyFilter])

  // NOTE: Tip settings persistence (tipsEnabled, tipPresets) is now handled by useTipSettings hook

  // NOTE: Commission settings persistence is now handled by useCommissionSettings hook
  // NOTE: Number format, Bitcoin format, and Numpad layout persistence
  // are now handled by useDisplaySettings hook

  // NOTE: voucherCurrencyMode and voucherExpiry persistence is now handled by useVoucherWalletState hook

  // Use direct Blink WebSocket connection for user account (balance updates)
  // NOTE: Only needed for non-POS payments. Currently disabled for POS-only mode.
  // To enable: pass apiKey and user?.username instead of null
  const {
    connected,
    lastPayment,
    showAnimation,
    hideAnimation,
    triggerPaymentAnimation,
    manualReconnect,
    reconnectAttempts,
  } = useBlinkWebSocket(null, null)

  // Track current invoice for NFC payments and payment hash for polling
  // Stores { paymentRequest, paymentHash, satoshis, memo } object
  const {
    currentInvoice,
    setCurrentInvoice,
    clearInvoice: _clearInvoice,
    hasInvoice: _hasInvoice,
  } = useInvoiceState()

  // NOTE: transactions, loading, error state now provided by useTransactionState hook

  // Ref for POS payment received callback
  const posPaymentReceivedRef = useRef<(() => void) | null>(null)

  // Dashboard data fetching - extracted to useDashboardData hook
  const { fetchData, fetchVoucherWalletBalance, getCapacityColor } = useDashboardData({
    // From useCombinedAuth
    user,
    getApiKey,
    hasServerSession,
    activeBlinkAccount,
    blinkAccounts,
    activeNWC,
    nwcClientReady,
    nwcListTransactions,
    nwcHasCapability,
    activeNpubCashWallet,
    // From useViewNavigation
    currentView,
    // From useDisplaySettings
    setDisplayCurrency,
    // From useUIVisibility
    showVoucherWalletSettings,
    showBoltcards,
    // From useWalletState
    apiKey,
    setApiKey,
    setWallets,
    // From useTransactionState
    setTransactions,
    setLoading,
    setError,
    setHasMoreTransactions,
    setPastTransactionsLoaded,
    setFilteredTransactions,
    setDateFilterActive,
    // From useVoucherWalletState
    voucherWallet,
    setVoucherWalletBalance,
    setVoucherWalletUsdBalance,
    setVoucherWalletBalanceLoading,
    setVoucherWalletBtcId,
    setVoucherWalletUsdId,
    setCurrentAmountInSats,
    setCurrentAmountInUsdCents,
    setCurrentVoucherCurrencyMode,
    // From useBlinkWebSocket
    lastPayment,
    // Refs
    posPaymentReceivedRef,
    voucherRef,
    multiVoucherRef,
  })

  // Transaction operations - extracted to useTransactionActions hook
  const {
    handleViewTransition,
    loadMoreMonths,
    loadPastTransactions: _loadPastTransactions,
    getDateRangePresets,
    loadTransactionsForDateRange,
    handleCustomDateRange,
    handleClearDateFilter,
    getFilteredStats,
    getDisplayTransactions,
    filterTransactionsBySearch,
    handleTxSearchClick,
    handleTxSearchSubmit,
    handleTxSearchKeyDown,
    handleTxSearchClose,
    convertTransactionsToBasicCSV,
    downloadCSV,
    exportBasicTransactions,
    exportFullTransactions,
    exportFullFilteredTransactions,
    groupTransactionsByMonth: _groupTransactionsByMonth,
    getMonthGroups,
    toggleMonth,
    loadMoreTransactionsForMonth: _loadMoreTransactionsForMonth,
    handleRefresh: _handleRefresh,
  } = useTransactionActions({
    apiKey,
    wallets,
    user,
    transactions,
    setTransactions,
    loadingMore,
    setLoadingMore,
    hasMoreTransactions,
    setHasMoreTransactions,
    setPastTransactionsLoaded,
    setDateFilterActive,
    setSelectedDateRange,
    setFilteredTransactions,
    setExportingData,
    dateFilterActive,
    filteredTransactions,
    clearDateFilter,
    txSearchQuery,
    txSearchInput,
    setIsSearchingTx,
    setTxSearchInput,
    setIsSearchLoading,
    setTxSearchQuery,
    expandedMonths,
    setExpandedMonths,
    showTimeInputs,
    setShowTimeInputs,
    setShowDateRangeSelector,
    setShowExportOptions,
    currentView,
    setCurrentView,
    transitionColorIndex,
    setTransitionColorIndex,
    setIsViewTransitioning,
    customDateStart,
    customDateEnd,
    customTimeStart,
    customTimeEnd,
    fetchData,
    txSearchInputRef,
    cartRef,
  })

  // PWA Install prompt
  useEffect(() => {
    const handler = (e: Event) => {
      // Prevent the mini-infobar from appearing on mobile
      e.preventDefault()
      // Stash the event so it can be triggered later
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      setShowInstallPrompt(true)
    }

    window.addEventListener("beforeinstallprompt", handler)

    return () => window.removeEventListener("beforeinstallprompt", handler)
  }, [])

  // Payment status polling & NFC - extracted to usePaymentPolling hook
  const { nfcState } = usePaymentPolling({
    currentInvoice,
    triggerPaymentAnimation,
    posPaymentReceivedRef,
    fetchData,
    soundEnabled,
    soundTheme,
    merchant: user?.username ?? undefined,
  })

  // Receipt printing for the payment-success screen (manual, button-triggered)
  const { printReceipt, printAvailable } = usePrintReceipt({
    amountDisplay,
    numberFormat,
    bitcoinFormat,
    currencies,
    orangePillMode,
    staticQRUrl: orangePillStaticUrl,
  })

  // Navigation handlers (touch swipe + keyboard) - extracted to useNavigationHandlers hook
  const { handleTouchStart, handleTouchMove, handleTouchEnd } = useNavigationHandlers({
    currentView,
    handleViewTransition,
    showingInvoice,
    showingVoucherQR,
    isViewTransitioning,
    voucherWallet,
    sideMenuOpen,
    showAnimation,
    hideAnimation,
    posRef,
    voucherRef,
    multiVoucherRef,
    cartRef,
  })

  const handleLogout = () => {
    logout()
  }

  // PWA install handler - delegates to usePWAInstall hook
  const handleInstallApp = async () => {
    await triggerInstall()
  }

  if (loading && transactions.length === 0 && !isViewTransitioning) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-blink-accent border-t-transparent mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading transactions...</p>
        </div>
      </div>
    )
  }

  // Determine if current view should prevent scrolling (POS-style fixed views)
  const isFixedView =
    currentView === "pos" ||
    currentView === "cart" ||
    currentView === "voucher" ||
    currentView === "multivoucher" ||
    currentView === "vouchermanager"

  return (
    <div
      className={`bg-white dark:bg-black ${isFixedView ? "h-screen overflow-hidden fixed inset-0" : "min-h-screen"}`}
    >
      {/* Payment Animation Overlay */}
      <PaymentAnimation
        show={showAnimation}
        payment={lastPayment}
        onHide={hideAnimation}
        soundEnabled={soundEnabled}
        soundTheme={soundTheme}
        amountDisplay={amountDisplay}
        numberFormat={numberFormat}
        bitcoinFormat={bitcoinFormat}
        currencies={currencies}
        onPrintReceipt={printReceipt}
        printAvailable={printAvailable}
      />

      {/* Mobile Header - Hidden when showing invoice or voucher QR */}
      {!showingInvoice && !showingVoucherQR && (
        <MobileHeader
          theme={theme}
          cycleTheme={cycleTheme}
          currentView={currentView}
          handleViewTransition={handleViewTransition}
          isViewTransitioning={isViewTransitioning}
          voucherWallet={voucherWallet}
          sideMenuOpen={sideMenuOpen}
          setSideMenuOpen={setSideMenuOpen}
        />
      )}

      {/* Full Screen Menu */}
      {sideMenuOpen && (
        <SideMenuOverlay
          authMode={authMode}
          nostrProfile={nostrProfile}
          user={user}
          activeNWC={activeNWC}
          activeNpubCashWallet={activeNpubCashWallet}
          activeBlinkAccount={activeBlinkAccount}
          voucherWallet={voucherWallet}
          theme={theme}
          displayCurrency={displayCurrency}
          numberFormat={numberFormat}
          activeSplitProfile={activeSplitProfile}
          activeTipProfile={activeTipProfile}
          isSparkLnAddress={isSparkLnAddress}
          soundEnabled={soundEnabled}
          soundTheme={soundTheme}
          showInstallPrompt={showInstallPrompt}
          setSideMenuOpen={setSideMenuOpen}
          setShowKeyManagement={setShowKeyManagement}
          setShowAccountSettings={setShowAccountSettings}
          setShowVoucherWalletSettings={setShowVoucherWalletSettings}
          cycleTheme={cycleTheme}
          setShowCurrencySettings={setShowCurrencySettings}
          setShowRegionalSettings={setShowRegionalSettings}
          setShowTipSettings={setShowTipSettings}
          setShowPercentSettings={setShowPercentSettings}
          setShowTipProfileSettings={setShowTipProfileSettings}
          setShowSoundThemes={setShowSoundThemes}
          setShowPaycode={setShowPaycode}
          setShowBatchPayments={setShowBatchPayments}
          setShowBoltcards={setShowBoltcards}
          handleInstallApp={handleInstallApp}
          handleLogout={handleLogout}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
          getMenuTileClasses={getMenuTileClasses}
        />
      )}

      {/* Key Management Overlay */}
      {showKeyManagement && (
        <KeyManagementOverlay
          setShowKeyManagement={setShowKeyManagement}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
        />
      )}

      {/* Boltcards Overlay */}
      {showBoltcards && (
        <BoltcardsOverlay
          voucherWallet={voucherWallet}
          voucherWalletBtcId={voucherWalletBtcId}
          voucherWalletUsdId={voucherWalletUsdId}
          voucherWalletBalance={voucherWalletBalance}
          voucherWalletUsdBalance={voucherWalletUsdBalance}
          exchangeRate={exchangeRate}
          bitcoinFormat={bitcoinFormat}
          setShowBoltcards={setShowBoltcards}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
        />
      )}

      {/* Batch Payments Overlay */}
      {showBatchPayments && voucherWallet?.apiKey && (
        <BatchPaymentsOverlay
          voucherWallet={voucherWallet}
          darkMode={darkMode}
          setShowBatchPayments={setShowBatchPayments}
          setSideMenuOpen={setSideMenuOpen}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
        />
      )}

      {/* Circular Economy Network Overlay */}
      {showNetworkOverlay && (
        <NetworkOverlay
          publicKey={publicKey}
          nostrProfile={nostrProfile}
          darkMode={darkMode}
          theme={theme}
          cycleTheme={cycleTheme}
          setShowNetworkOverlay={setShowNetworkOverlay}
          setSideMenuOpen={setSideMenuOpen}
          transitionColorIndex={transitionColorIndex}
          setTransitionColorIndex={setTransitionColorIndex}
          setIsViewTransitioning={setIsViewTransitioning}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
        />
      )}

      {/* Paycodes Overlay */}
      {showPaycode && activeBlinkAccount?.username && (
        <PaycodesOverlay
          activeBlinkAccount={activeBlinkAccount}
          paycodeAmount={paycodeAmount}
          paycodeGeneratingPdf={paycodeGeneratingPdf}
          darkMode={darkMode}
          setShowPaycode={setShowPaycode}
          setPaycodeAmount={setPaycodeAmount}
          setPaycodeGeneratingPdf={setPaycodeGeneratingPdf}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
        />
      )}

      {/* Themes Overlay */}
      {showSoundThemes && (
        <SoundThemesOverlay
          soundEnabled={soundEnabled}
          soundTheme={soundTheme}
          setSoundEnabled={setSoundEnabled}
          setSoundTheme={setSoundTheme}
          setShowSoundThemes={setShowSoundThemes}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
          getSelectionTileClasses={getSelectionTileClasses}
          getSelectionTileActiveClasses={getSelectionTileActiveClasses}
        />
      )}

      {/* % Settings Submenu Overlay (Tip % and Commission % when voucher wallet connected) */}
      {showPercentSettings && (
        <PercentSettingsOverlay
          activeTipProfile={activeTipProfile}
          commissionEnabled={commissionEnabled}
          commissionPresets={commissionPresets}
          isSparkLnAddress={isSparkLnAddress}
          setShowPercentSettings={setShowPercentSettings}
          setShowTipProfileSettings={setShowTipProfileSettings}
          setShowCommissionSettings={setShowCommissionSettings}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
          getSelectionTileClasses={getSelectionTileClasses}
        />
      )}

      {/* Commission % Settings Overlay */}
      {showCommissionSettings && (
        <CommissionSettingsOverlay
          commissionEnabled={commissionEnabled}
          commissionPresets={commissionPresets}
          setCommissionEnabled={setCommissionEnabled}
          setCommissionPresets={setCommissionPresets}
          setShowCommissionSettings={setShowCommissionSettings}
          setShowPercentSettings={setShowPercentSettings}
          isBlinkClassic={isBlinkClassic}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
          getSelectionTileClasses={getSelectionTileClasses}
        />
      )}

      {/* Tip Profile Settings Overlay */}
      {showTipProfileSettings && (
        <TipProfileSettingsOverlay
          tipPresets={tipPresets}
          activeTipProfile={activeTipProfile}
          voucherWallet={voucherWallet}
          setTipPresets={setTipPresets}
          setActiveTipProfile={setActiveTipProfile}
          setShowTipProfileSettings={setShowTipProfileSettings}
          setShowPercentSettings={setShowPercentSettings}
          TIP_PROFILES={TIP_PROFILES}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
          getSelectionTileClasses={getSelectionTileClasses}
          getSelectionTileActiveClasses={getSelectionTileActiveClasses}
        />
      )}

      {/* Split Settings Overlay - hidden for self-custodial (Spark) wallets,
          which have no escrow and cannot forward/split tips. */}
      {showTipSettings && !showCreateSplitProfile && !isSparkLnAddress && (
        <SplitSettingsOverlay
          authMode={authMode}
          activeSplitProfile={activeSplitProfile}
          splitProfiles={splitProfiles}
          splitProfilesLoading={splitProfilesLoading}
          isBlinkClassic={isBlinkClassic}
          isBlinkClassicDark={isBlinkClassicDark}
          isBlinkClassicLight={isBlinkClassicLight}
          setShowTipSettings={setShowTipSettings}
          setShowCreateSplitProfile={setShowCreateSplitProfile}
          setActiveSplitProfileById={setActiveSplitProfileById}
          setEditingSplitProfile={setEditingSplitProfile}
          setNewSplitProfileLabel={setNewSplitProfileLabel}
          setNewSplitProfileRecipients={setNewSplitProfileRecipients}
          setNewRecipientInput={setNewRecipientInput}
          setRecipientValidation={setRecipientValidation}
          setSplitProfileError={setSplitProfileError}
          setUseCustomWeights={setUseCustomWeights}
          deleteSplitProfile={deleteSplitProfile}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
          getSubmenuOptionClasses={getSubmenuOptionClasses}
          getSubmenuOptionActiveClasses={getSubmenuOptionActiveClasses}
          getPrimaryTextClasses={getPrimaryTextClasses}
          getSecondaryTextClasses={getSecondaryTextClasses}
          getCheckmarkClasses={getCheckmarkClasses}
          getPreviewBoxClasses={getPreviewBoxClasses}
        />
      )}

      {/* Create/Edit Split Profile Overlay */}
      {showCreateSplitProfile && (
        <CreateEditSplitProfileOverlay
          darkMode={darkMode}
          editingSplitProfile={editingSplitProfile}
          newSplitProfileLabel={newSplitProfileLabel}
          newSplitProfileRecipients={newSplitProfileRecipients}
          newRecipientInput={newRecipientInput}
          recipientValidation={recipientValidation}
          splitProfileError={splitProfileError}
          useCustomWeights={useCustomWeights}
          setShowCreateSplitProfile={setShowCreateSplitProfile}
          setShowTipSettings={setShowTipSettings}
          setEditingSplitProfile={setEditingSplitProfile}
          setNewSplitProfileLabel={setNewSplitProfileLabel}
          setNewSplitProfileRecipients={setNewSplitProfileRecipients}
          setNewRecipientInput={setNewRecipientInput}
          setRecipientValidation={setRecipientValidation}
          setSplitProfileError={setSplitProfileError}
          setUseCustomWeights={setUseCustomWeights}
          addRecipientToProfile={addRecipientToProfile}
          removeRecipientFromProfile={removeRecipientFromProfile}
          saveSplitProfile={saveSplitProfile}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
        />
      )}

      {/* Currency Settings Overlay */}
      {showCurrencySettings && (
        <CurrencySettingsOverlay
          displayCurrency={displayCurrency}
          currencyFilter={currencyFilter}
          currencyFilterDebounced={currencyFilterDebounced}
          currenciesLoading={currenciesLoading}
          darkMode={darkMode}
          isBlinkClassic={isBlinkClassic}
          isBlinkClassicDark={isBlinkClassicDark}
          isBlinkClassicLight={isBlinkClassicLight}
          setDisplayCurrency={setDisplayCurrency}
          setShowCurrencySettings={setShowCurrencySettings}
          setCurrencyFilter={setCurrencyFilter}
          getAllCurrencies={getAllCurrencies}
          isPopularCurrency={isPopularCurrency}
          addToPopular={addToPopular}
          removeFromPopular={removeFromPopular}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
          getSubmenuOptionClasses={getSubmenuOptionClasses}
          getSubmenuOptionActiveClasses={getSubmenuOptionActiveClasses}
          getPrimaryTextClasses={getPrimaryTextClasses}
          getSecondaryTextClasses={getSecondaryTextClasses}
          getCheckmarkClasses={getCheckmarkClasses}
        />
      )}

      {/* Regional Settings Overlay */}
      {showRegionalSettings && (
        <RegionalSettingsOverlay
          numberFormat={numberFormat}
          bitcoinFormat={bitcoinFormat}
          numpadLayout={numpadLayout}
          amountDisplay={amountDisplay}
          orangePillMode={orangePillMode}
          orangePillStaticUrl={orangePillStaticUrl}
          setNumberFormat={setNumberFormat}
          setBitcoinFormat={setBitcoinFormat}
          setNumpadLayout={setNumpadLayout}
          setAmountDisplay={setAmountDisplay}
          setOrangePillMode={setOrangePillMode}
          setOrangePillStaticUrl={setOrangePillStaticUrl}
          setShowRegionalSettings={setShowRegionalSettings}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
          getSubmenuOptionClasses={getSubmenuOptionClasses}
          getSubmenuOptionActiveClasses={getSubmenuOptionActiveClasses}
          getPrimaryTextClasses={getPrimaryTextClasses}
          getSecondaryTextClasses={getSecondaryTextClasses}
          getSectionLabelClasses={getSectionLabelClasses}
          getCheckmarkClasses={getCheckmarkClasses}
          getPreviewBoxClasses={getPreviewBoxClasses}
        />
      )}

      {/* Wallets Overlay */}
      {showAccountSettings && (
        <WalletsOverlay
          showAddAccountForm={showAddAccountForm}
          newAccountType={newAccountType}
          darkMode={darkMode}
          authMode={authMode}
          newAccountLabel={newAccountLabel}
          newAccountApiKey={newAccountApiKey}
          newAccountLnAddress={newAccountLnAddress}
          newAccountNwcUri={newAccountNwcUri}
          newNpubCashAddress={newNpubCashAddress}
          addAccountError={addAccountError}
          addAccountLoading={addAccountLoading}
          lnAddressValidated={lnAddressValidated}
          lnAddressValidating={lnAddressValidating}
          nwcValidated={nwcValidated}
          nwcValidating={nwcValidating}
          npubCashValidated={npubCashValidated}
          npubCashValidating={npubCashValidating}
          blinkAccounts={blinkAccounts}
          nwcConnections={nwcConnections}
          npubCashWallets={npubCashWallets}
          activeNWC={activeNWC}
          activeBlinkAccount={activeBlinkAccount}
          editingWalletLabel={editingWalletLabel}
          editedWalletLabel={editedWalletLabel}
          isBlinkClassic={isBlinkClassic}
          isBlinkClassicDark={isBlinkClassicDark}
          isBlinkClassicLight={isBlinkClassicLight}
          setShowAccountSettings={setShowAccountSettings}
          setShowAddAccountForm={setShowAddAccountForm}
          setNewAccountApiKey={setNewAccountApiKey}
          setNewAccountLabel={setNewAccountLabel}
          setNewAccountNwcUri={setNewAccountNwcUri}
          setNewAccountLnAddress={setNewAccountLnAddress}
          setNewAccountType={setNewAccountType}
          setAddAccountError={setAddAccountError}
          setNwcValidated={setNwcValidated}
          setLnAddressValidated={setLnAddressValidated}
          setConfirmDeleteWallet={setConfirmDeleteWallet}
          setAddAccountLoading={setAddAccountLoading}
          setLnAddressValidating={setLnAddressValidating}
          setNwcValidating={setNwcValidating}
          setNpubCashValidated={setNpubCashValidated}
          setNpubCashValidating={setNpubCashValidating}
          setNewNpubCashAddress={setNewNpubCashAddress}
          setActiveBlinkAccount={(accountId) => {
            if (accountId !== null) setActiveBlinkAccount(accountId)
          }}
          setActiveNWC={setActiveNWC}
          setEditingWalletLabel={setEditingWalletLabel}
          setEditedWalletLabel={setEditedWalletLabel}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
          getWalletCardActiveClasses={getWalletCardActiveClasses}
          getWalletCardClasses={getWalletCardClasses}
          getWalletIconClasses={getWalletIconClasses}
          getWalletActiveBadgeClasses={getWalletActiveBadgeClasses}
          getWalletUseButtonClasses={getWalletUseButtonClasses}
          getSecondaryTextClasses={getSecondaryTextClasses}
          getInputClasses={getInputClasses}
          addBlinkAccount={addBlinkAccount}
          storeBlinkAccountOnServer={storeBlinkAccountOnServer}
          addBlinkLnAddressWallet={addBlinkLnAddressWallet}
          addNWCConnection={addNWCConnection}
          addNpubCashWallet={addNpubCashWallet}
          removeBlinkAccount={removeBlinkAccount}
          removeNWCConnection={removeNWCConnection}
          updateBlinkAccount={updateBlinkAccount}
          updateNWCConnection={updateNWCConnection}
        />
      )}

      {/* Voucher Wallet Overlay */}
      {showVoucherWalletSettings && (
        <VoucherWalletOverlay
          darkMode={darkMode}
          voucherWallet={voucherWallet}
          voucherWalletBalance={voucherWalletBalance}
          voucherWalletUsdBalance={voucherWalletUsdBalance}
          voucherWalletBalanceLoading={voucherWalletBalanceLoading}
          voucherWalletApiKey={voucherWalletApiKey}
          voucherWalletLabel={voucherWalletLabel}
          voucherWalletLoading={voucherWalletLoading}
          voucherWalletValidating={voucherWalletValidating}
          voucherWalletScopes={voucherWalletScopes}
          voucherWalletError={voucherWalletError}
          editingWalletLabel={editingWalletLabel}
          editedWalletLabel={editedWalletLabel}
          numberFormat={numberFormat}
          publicKey={publicKey}
          setShowVoucherWalletSettings={setShowVoucherWalletSettings}
          setVoucherWalletApiKey={setVoucherWalletApiKey}
          setVoucherWalletLabel={setVoucherWalletLabel}
          setVoucherWalletError={setVoucherWalletError}
          setVoucherWalletScopes={setVoucherWalletScopes}
          setVoucherWallet={setVoucherWallet}
          setVoucherWalletLoading={setVoucherWalletLoading}
          setVoucherWalletValidating={setVoucherWalletValidating}
          setEditingWalletLabel={setEditingWalletLabel}
          setEditedWalletLabel={setEditedWalletLabel}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
          fetchVoucherWalletBalance={fetchVoucherWalletBalance}
          getVoucherWalletKey={getVoucherWalletKey}
          syncVoucherWalletToServer={syncVoucherWalletToServer}
        />
      )}

      {/* Export Options Overlay */}
      {showExportOptions && (
        <ExportOptionsOverlay
          exportingData={exportingData}
          dateFilterActive={dateFilterActive}
          filteredTransactions={filteredTransactions}
          selectedDateRange={selectedDateRange}
          user={user}
          setShowExportOptions={setShowExportOptions}
          convertTransactionsToBasicCSV={convertTransactionsToBasicCSV}
          downloadCSV={downloadCSV}
          exportBasicTransactions={exportBasicTransactions}
          exportFullTransactions={exportFullTransactions}
          exportFullFilteredTransactions={exportFullFilteredTransactions}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
        />
      )}

      {/* Date Range Selector Modal */}
      {showDateRangeSelector && (
        <DateRangeSelectorOverlay
          customDateStart={customDateStart}
          customDateEnd={customDateEnd}
          customTimeStart={customTimeStart}
          customTimeEnd={customTimeEnd}
          showTimeInputs={showTimeInputs}
          loadingMore={loadingMore}
          setShowDateRangeSelector={setShowDateRangeSelector}
          setCustomDateStart={setCustomDateStart}
          setCustomDateEnd={setCustomDateEnd}
          setCustomTimeStart={setCustomTimeStart}
          setCustomTimeEnd={setCustomTimeEnd}
          setShowTimeInputs={setShowTimeInputs}
          getDateRangePresets={getDateRangePresets}
          loadTransactionsForDateRange={loadTransactionsForDateRange}
          handleCustomDateRange={handleCustomDateRange}
          getSubmenuBgClasses={getSubmenuBgClasses}
          getSubmenuHeaderClasses={getSubmenuHeaderClasses}
        />
      )}

      <main
        className={`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mobile-content ${isFixedView ? "h-[calc(100vh-80px)] overflow-hidden py-2" : "py-6"}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {error && (
          <div className="mb-4 bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-200 px-4 py-3 rounded">
            {error}
          </div>
        )}

        {/* Owner/Agent Display */}
        <OwnerAgentDisplay
          currentView={currentView}
          showingInvoice={showingInvoice}
          showingVoucherQR={showingVoucherQR}
          voucherWallet={voucherWallet}
          activeNWC={activeNWC}
          activeNpubCashWallet={activeNpubCashWallet}
          activeBlinkAccount={activeBlinkAccount}
          voucherExpiry={voucherExpiry}
          activeSplitProfile={activeSplitProfile}
          isSparkLnAddress={isSparkLnAddress}
          voucherWalletBalanceLoading={voucherWalletBalanceLoading}
          isBlinkClassic={isBlinkClassic}
          currentVoucherCurrencyMode={currentVoucherCurrencyMode}
          currentAmountInUsdCents={currentAmountInUsdCents}
          currentAmountInSats={currentAmountInSats}
          voucherWalletUsdBalance={voucherWalletUsdBalance}
          voucherWalletBalance={voucherWalletBalance}
          setShowVoucherWalletSettings={setShowVoucherWalletSettings}
          setShowAccountSettings={setShowAccountSettings}
          setVoucherExpiry={setVoucherExpiry}
          voucherRef={voucherRef}
          multiVoucherRef={multiVoucherRef}
          getCapacityColor={getCapacityColor}
        />

        {/* View Transition Loading Overlay */}
        {isViewTransitioning && (
          <div className="fixed inset-0 z-40 bg-white/80 dark:bg-black/80 flex items-center justify-center backdrop-blur-sm">
            <div
              className={`animate-spin rounded-full h-12 w-12 border-4 ${currentSpinnerColor} border-t-transparent`}
            ></div>
          </div>
        )}

        {/* Conditional Content Based on Current View */}
        <DashboardViewSwitcher
          currentView={currentView}
          displayCurrency={displayCurrency}
          numberFormat={numberFormat}
          bitcoinFormat={bitcoinFormat}
          numpadLayout={numpadLayout}
          currencies={currencies}
          darkMode={darkMode}
          theme={theme}
          cycleTheme={cycleTheme}
          soundEnabled={soundEnabled}
          exchangeRate={exchangeRate}
          isViewTransitioning={isViewTransitioning}
          transitionColorIndex={transitionColorIndex}
          setTransitionColorIndex={setTransitionColorIndex}
          setIsViewTransitioning={setIsViewTransitioning}
          cartRef={cartRef}
          publicKey={publicKey}
          setCartCheckoutData={setCartCheckoutData}
          handleViewTransition={handleViewTransition}
          posRef={posRef}
          apiKey={apiKey}
          user={user}
          wallets={wallets}
          posPaymentReceivedRef={posPaymentReceivedRef}
          connected={connected}
          manualReconnect={manualReconnect}
          reconnectAttempts={reconnectAttempts}
          tipsEnabled={tipsEnabled}
          tipPresets={tipPresets}
          activeSplitProfile={activeSplitProfile}
          isSparkLnAddress={isSparkLnAddress}
          setShowingInvoice={setShowingInvoice}
          setCurrentInvoice={setCurrentInvoice}
          nfcState={nfcState}
          activeNWC={activeNWC}
          nwcClientReady={nwcClientReady}
          nwcMakeInvoice={nwcMakeInvoice}
          nwcLookupInvoice={nwcLookupInvoice}
          getActiveNWCUri={getActiveNWCUri}
          activeBlinkAccount={activeBlinkAccount}
          activeNpubCashWallet={activeNpubCashWallet}
          cartCheckoutData={cartCheckoutData}
          triggerPaymentAnimation={triggerPaymentAnimation}
          voucherWallet={voucherWallet}
          voucherCurrencyMode={voucherCurrencyMode}
          voucherWalletBalance={voucherWalletBalance}
          voucherWalletUsdBalance={voucherWalletUsdBalance}
          commissionEnabled={commissionEnabled}
          commissionPresets={commissionPresets}
          voucherWalletUsdId={voucherWalletUsdId}
          setVoucherCurrencyMode={setVoucherCurrencyMode}
          usdExchangeRate={usdExchangeRate}
          voucherExpiry={voucherExpiry}
          voucherRef={voucherRef}
          setShowingVoucherQR={setShowingVoucherQR}
          multiVoucherRef={multiVoucherRef}
          voucherManagerRef={voucherManagerRef}
          transactions={transactions}
          filteredTransactions={filteredTransactions}
          dateFilterActive={dateFilterActive}
          selectedDateRange={selectedDateRange}
          pastTransactionsLoaded={pastTransactionsLoaded}
          isSearchingTx={isSearchingTx}
          isSearchLoading={isSearchLoading}
          txSearchQuery={txSearchQuery}
          txSearchInput={txSearchInput}
          txSearchInputRef={txSearchInputRef}
          loadingMore={loadingMore}
          hasMoreTransactions={hasMoreTransactions}
          expandedMonths={expandedMonths}
          setSelectedTransaction={setSelectedTransaction}
          setShowDateRangeSelector={setShowDateRangeSelector}
          setShowExportOptions={setShowExportOptions}
          setIsSearchingTx={setIsSearchingTx}
          setTxSearchInput={setTxSearchInput}
          handleClearDateFilter={handleClearDateFilter}
          handleTxSearchClick={handleTxSearchClick}
          handleTxSearchClose={handleTxSearchClose}
          handleTxSearchKeyDown={handleTxSearchKeyDown}
          handleTxSearchSubmit={handleTxSearchSubmit}
          loadMoreMonths={loadMoreMonths}
          toggleMonth={toggleMonth}
          getFilteredStats={getFilteredStats}
          getDisplayTransactions={getDisplayTransactions}
          getMonthGroups={getMonthGroups}
          filterTransactionsBySearch={filterTransactionsBySearch}
        />
      </main>

      {/* Transaction Detail Modal */}
      {selectedTransaction && (
        <TransactionDetail
          transaction={selectedTransaction}
          onClose={() => setSelectedTransaction(null)}
          darkMode={darkMode}
          onLabelChange={triggerLabelUpdate}
        />
      )}

      {/* Settings Modal */}
    </div>
  )
}
