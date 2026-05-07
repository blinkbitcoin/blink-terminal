import React from "react"

import type { Wallet } from "../lib/blink-api"
import type { CurrencyMetadata } from "../lib/currency-utils"
import type { PaymentData } from "../lib/hooks/useBlinkWebSocket"
import type { CombinedUser } from "../lib/hooks/useCombinedAuth"
import type {
  NumberFormat,
  BitcoinFormat,
  NumpadLayout,
} from "../lib/hooks/useDisplaySettings"
import type { ExchangeRateData } from "../lib/hooks/useExchangeRate"
import type { InvoiceData } from "../lib/hooks/useInvoiceState"
import type {
  LocalNWCConnection,
  NWCInvoiceResult,
  NWCOperationResult,
} from "../lib/hooks/useNWC"
import type { LocalBlinkAccount } from "../lib/hooks/useProfile"
import type { SplitProfile } from "../lib/hooks/useSplitProfiles"
import type { Theme } from "../lib/hooks/useTheme"
import type { FilteredStats, MonthGroup } from "../lib/hooks/useTransactionActions"
import type { DateRange } from "../lib/hooks/useTransactionState"
import {
  SPINNER_COLORS,
  type DashboardView,
  type CartCheckoutData,
} from "../lib/hooks/useViewNavigation"
import type {
  VoucherWallet,
  VoucherCurrencyMode,
} from "../lib/hooks/useVoucherWalletState"

import ItemCart, { type ItemCartHandle } from "./ItemCart"
import MultiVoucher, { type MultiVoucherHandle } from "./MultiVoucher"
import type { UseNFCReturn } from "./NFCPayment"
import POS, { type POSRef } from "./POS"
import type { TransactionRecord } from "./TransactionDetail"
import TransactionsView from "./TransactionsView"
import Voucher, { type VoucherHandle } from "./Voucher"
import VoucherManager, { type VoucherManagerRef } from "./VoucherManager"

// ============================================================================
// Component Props
// ============================================================================

interface DashboardViewSwitcherProps {
  currentView: DashboardView
  // Shared display props
  displayCurrency: string
  numberFormat: NumberFormat
  bitcoinFormat: BitcoinFormat
  numpadLayout: NumpadLayout
  currencies: CurrencyMetadata[]
  darkMode: boolean
  theme: Theme
  cycleTheme: () => void
  soundEnabled: boolean
  exchangeRate: ExchangeRateData | null
  // View transition
  isViewTransitioning: boolean
  transitionColorIndex: number
  setTransitionColorIndex: (index: number) => void
  setIsViewTransitioning: (transitioning: boolean) => void
  // Cart props
  cartRef: React.RefObject<ItemCartHandle>
  publicKey: string | null
  setCartCheckoutData: (data: CartCheckoutData | null) => void
  handleViewTransition: (view: DashboardView) => void
  // POS props
  posRef: React.RefObject<POSRef>
  apiKey: string | null
  user: CombinedUser | null
  wallets: Wallet[]
  posPaymentReceivedRef: React.MutableRefObject<(() => void) | null>
  connected: boolean
  manualReconnect: () => void
  reconnectAttempts: number
  tipsEnabled: boolean
  tipPresets: number[]
  activeSplitProfile: SplitProfile | null
  setShowingInvoice: (showing: boolean) => void
  setCurrentInvoice: (invoice: InvoiceData | null) => void
  nfcState: UseNFCReturn | null
  activeNWC: LocalNWCConnection | null
  nwcClientReady: boolean
  nwcMakeInvoice: (params: {
    amount: number
    description?: string
    expiry?: number
  }) => Promise<NWCInvoiceResult>
  nwcLookupInvoice: (
    paymentHash: string,
  ) => Promise<NWCOperationResult & { invoice?: unknown }>
  getActiveNWCUri: () => Promise<string | null>
  activeBlinkAccount: LocalBlinkAccount | null
  activeNpubCashWallet: LocalBlinkAccount | null
  cartCheckoutData: CartCheckoutData | null
  triggerPaymentAnimation: (data: PaymentData) => void
  // Voucher shared props
  voucherWallet: VoucherWallet | null
  voucherCurrencyMode: VoucherCurrencyMode
  voucherWalletBalance: number | null
  voucherWalletUsdBalance: number | null
  commissionEnabled: boolean
  commissionPresets: number[]
  voucherWalletUsdId: string | null
  setVoucherCurrencyMode: (mode: VoucherCurrencyMode) => void
  usdExchangeRate: number | null
  voucherExpiry: string
  // Voucher-specific
  voucherRef: React.RefObject<VoucherHandle>
  setShowingVoucherQR: (showing: boolean) => void
  // MultiVoucher-specific
  multiVoucherRef: React.RefObject<MultiVoucherHandle>
  // VoucherManager-specific
  voucherManagerRef: React.RefObject<VoucherManagerRef>
  // Transactions view
  transactions: TransactionRecord[]
  filteredTransactions: TransactionRecord[]
  dateFilterActive: boolean
  selectedDateRange: DateRange | null
  pastTransactionsLoaded: boolean
  isSearchingTx: boolean
  isSearchLoading: boolean
  txSearchQuery: string
  txSearchInput: string
  txSearchInputRef: React.RefObject<HTMLInputElement | null>
  loadingMore: boolean
  hasMoreTransactions: boolean
  expandedMonths: Set<string>
  setSelectedTransaction: (tx: TransactionRecord | null) => void
  setShowDateRangeSelector: (show: boolean) => void
  setShowExportOptions: (show: boolean) => void
  setIsSearchingTx: (searching: boolean) => void
  setTxSearchInput: (input: string) => void
  handleClearDateFilter: () => void
  handleTxSearchClick: () => void
  handleTxSearchClose: () => void
  handleTxSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  handleTxSearchSubmit: () => void
  loadMoreMonths: () => void
  toggleMonth: (monthKey: string) => void
  getFilteredStats: () => FilteredStats
  getDisplayTransactions: () => TransactionRecord[]
  getMonthGroups: () => Record<string, MonthGroup>
  filterTransactionsBySearch: (
    txs: TransactionRecord[],
    query: string,
  ) => TransactionRecord[]
}

export default function DashboardViewSwitcher({
  currentView,
  // Shared display props
  displayCurrency,
  numberFormat,
  bitcoinFormat,
  numpadLayout,
  currencies,
  darkMode,
  theme,
  cycleTheme,
  soundEnabled,
  exchangeRate,
  // View transition
  isViewTransitioning,
  transitionColorIndex,
  setTransitionColorIndex,
  setIsViewTransitioning,
  // Cart props
  cartRef,
  publicKey,
  setCartCheckoutData,
  handleViewTransition,
  // POS props
  posRef,
  apiKey,
  user,
  wallets,
  posPaymentReceivedRef,
  connected,
  manualReconnect,
  reconnectAttempts,
  tipsEnabled,
  tipPresets,
  activeSplitProfile,
  setShowingInvoice,
  setCurrentInvoice,
  nfcState,
  activeNWC,
  nwcClientReady,
  nwcMakeInvoice,
  nwcLookupInvoice,
  getActiveNWCUri,
  activeBlinkAccount,
  activeNpubCashWallet,
  cartCheckoutData,
  triggerPaymentAnimation,
  // Voucher shared props
  voucherWallet,
  voucherCurrencyMode,
  voucherWalletBalance,
  voucherWalletUsdBalance,
  commissionEnabled,
  commissionPresets,
  voucherWalletUsdId,
  setVoucherCurrencyMode,
  usdExchangeRate,
  voucherExpiry,
  // Voucher-specific
  voucherRef,
  setShowingVoucherQR,
  // MultiVoucher-specific
  multiVoucherRef,
  // VoucherManager-specific
  voucherManagerRef,
  // Transactions view
  transactions,
  filteredTransactions,
  dateFilterActive,
  selectedDateRange,
  pastTransactionsLoaded,
  isSearchingTx,
  isSearchLoading,
  txSearchQuery,
  txSearchInput,
  txSearchInputRef,
  loadingMore,
  hasMoreTransactions,
  expandedMonths,
  setSelectedTransaction,
  setShowDateRangeSelector,
  setShowExportOptions,
  setIsSearchingTx,
  setTxSearchInput,
  handleClearDateFilter,
  handleTxSearchClick,
  handleTxSearchClose,
  handleTxSearchKeyDown,
  handleTxSearchSubmit,
  loadMoreMonths,
  toggleMonth,
  getFilteredStats,
  getDisplayTransactions,
  getMonthGroups,
  filterTransactionsBySearch,
}: DashboardViewSwitcherProps) {
  // Shared transition handler for views that support internal transitions
  const onInternalTransition = () => {
    setTransitionColorIndex((transitionColorIndex + 1) % SPINNER_COLORS.length)
    setIsViewTransitioning(true)
    setTimeout(() => setIsViewTransitioning(false), 120)
  }

  const voucherCurrencyToggle = voucherWalletUsdId
    ? () => setVoucherCurrencyMode(voucherCurrencyMode === "BTC" ? "USD" : "BTC")
    : undefined

  const walletBalance =
    voucherCurrencyMode === "USD" ? voucherWalletUsdBalance : voucherWalletBalance

  // Convert numeric usdExchangeRate to ExchangeRateData for child components
  const usdExchangeRateData: ExchangeRateData | null =
    usdExchangeRate != null
      ? { satPriceInCurrency: usdExchangeRate, currency: "USD" }
      : null

  if (currentView === "cart") {
    return (
      <div className="h-[calc(100vh-180px)] min-h-[400px]">
        <ItemCart
          ref={cartRef}
          displayCurrency={displayCurrency}
          numberFormat={numberFormat}
          bitcoinFormat={bitcoinFormat}
          currencies={currencies}
          publicKey={publicKey}
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
    )
  }

  if (currentView === "pos") {
    return (
      <POS
        ref={posRef}
        apiKey={apiKey}
        user={user}
        displayCurrency={displayCurrency}
        numberFormat={numberFormat}
        bitcoinFormat={bitcoinFormat}
        numpadLayout={numpadLayout}
        currencies={currencies}
        wallets={wallets}
        onPaymentReceived={posPaymentReceivedRef}
        connected={connected}
        manualReconnect={manualReconnect}
        reconnectAttempts={reconnectAttempts}
        tipsEnabled={tipsEnabled}
        tipPresets={tipPresets}
        tipRecipients={activeSplitProfile?.recipients || []}
        soundEnabled={soundEnabled}
        onInvoiceStateChange={setShowingInvoice}
        onInvoiceChange={(invoiceData: unknown) => {
          setCurrentInvoice(invoiceData as InvoiceData | null)
        }}
        darkMode={darkMode}
        theme={theme}
        cycleTheme={cycleTheme}
        nfcState={nfcState}
        activeNWC={activeNWC}
        nwcClientReady={nwcClientReady}
        nwcMakeInvoice={nwcMakeInvoice}
        nwcLookupInvoice={nwcLookupInvoice}
        getActiveNWCUri={getActiveNWCUri}
        activeBlinkAccount={activeBlinkAccount}
        activeNpubCashWallet={activeNpubCashWallet}
        cartCheckoutData={cartCheckoutData}
        onCartCheckoutProcessed={() => setCartCheckoutData(null)}
        onInternalTransition={onInternalTransition}
        triggerPaymentAnimation={triggerPaymentAnimation}
      />
    )
  }

  if (currentView === "multivoucher") {
    return (
      <div className="h-[calc(100vh-180px)] min-h-[400px]">
        <MultiVoucher
          ref={multiVoucherRef}
          voucherWallet={voucherWallet}
          walletBalance={walletBalance}
          displayCurrency={displayCurrency}
          numberFormat={numberFormat}
          bitcoinFormat={bitcoinFormat}
          numpadLayout={numpadLayout}
          currencies={currencies}
          darkMode={darkMode}
          theme={theme}
          cycleTheme={cycleTheme}
          soundEnabled={soundEnabled}
          commissionEnabled={commissionEnabled}
          commissionPresets={commissionPresets}
          voucherCurrencyMode={voucherCurrencyMode}
          onVoucherCurrencyToggle={voucherCurrencyToggle}
          usdExchangeRate={usdExchangeRateData}
          usdWalletId={voucherWalletUsdId}
          initialExpiry={voucherExpiry}
          onInternalTransition={onInternalTransition}
        />
      </div>
    )
  }

  if (currentView === "voucher") {
    return (
      <Voucher
        ref={voucherRef}
        voucherWallet={voucherWallet}
        walletBalance={walletBalance}
        displayCurrency={displayCurrency}
        numberFormat={numberFormat}
        bitcoinFormat={bitcoinFormat}
        numpadLayout={numpadLayout}
        currencies={currencies}
        darkMode={darkMode}
        theme={theme}
        cycleTheme={cycleTheme}
        soundEnabled={soundEnabled}
        onVoucherStateChange={setShowingVoucherQR}
        commissionEnabled={commissionEnabled}
        commissionPresets={commissionPresets}
        voucherCurrencyMode={voucherCurrencyMode}
        onVoucherCurrencyToggle={voucherCurrencyToggle}
        usdExchangeRate={usdExchangeRateData}
        usdWalletId={voucherWalletUsdId}
        initialExpiry={voucherExpiry}
        onInternalTransition={onInternalTransition}
      />
    )
  }

  if (currentView === "vouchermanager") {
    return (
      <div className="h-[calc(100vh-180px)] min-h-[400px]">
        <VoucherManager
          ref={voucherManagerRef}
          voucherWallet={voucherWallet}
          displayCurrency={displayCurrency}
          currencies={currencies}
          darkMode={darkMode}
          theme={theme}
          cycleTheme={cycleTheme}
          soundEnabled={soundEnabled}
          onInternalTransition={onInternalTransition}
        />
      </div>
    )
  }

  // Default: transactions view
  return (
    <TransactionsView
      transactions={transactions}
      filteredTransactions={filteredTransactions}
      activeBlinkAccount={activeBlinkAccount}
      activeNpubCashWallet={activeNpubCashWallet}
      activeNWC={activeNWC}
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
  )
}
