import type { RefObject, KeyboardEvent } from "react"

import type { LocalNWCConnection } from "../lib/hooks/useNWC"
import type { LocalBlinkAccount } from "../lib/hooks/useProfile"

import { getTransactionLabel, type TransactionRecord } from "./TransactionDetail"

// ============================================================================
// Types
// ============================================================================

interface DateRange {
  type: string
  start: Date
  end: Date
  label: string
}

interface FilteredStats {
  totalReceived: number
  totalSent: number
  netAmount: number
  transactionCount: number
  receiveCount: number
  sendCount: number
}

interface MonthData {
  label: string
  transactions: TransactionRecord[]
}

interface TransactionsViewProps {
  // Data
  transactions: TransactionRecord[]
  filteredTransactions: TransactionRecord[]
  activeBlinkAccount: LocalBlinkAccount | null
  activeNpubCashWallet: LocalBlinkAccount | null
  activeNWC: LocalNWCConnection | null
  // Date filter state
  dateFilterActive: boolean
  selectedDateRange: DateRange | null
  pastTransactionsLoaded: boolean
  // Search state
  isSearchingTx: boolean
  isSearchLoading: boolean
  txSearchQuery: string
  txSearchInput: string
  txSearchInputRef: RefObject<HTMLInputElement | null>
  // Pagination
  loadingMore: boolean
  hasMoreTransactions: boolean
  expandedMonths: Set<string>
  // Setters
  setSelectedTransaction: (tx: TransactionRecord) => void
  setShowDateRangeSelector: (show: boolean) => void
  setShowExportOptions: (show: boolean) => void
  setIsSearchingTx: (searching: boolean) => void
  setTxSearchInput: (input: string) => void
  // Handlers
  handleClearDateFilter: () => void
  handleTxSearchClick: () => void
  handleTxSearchClose: () => void
  handleTxSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  handleTxSearchSubmit: () => void
  loadMoreMonths: () => void
  toggleMonth: (monthKey: string) => void
  // Computed
  getFilteredStats: () => FilteredStats
  getDisplayTransactions: () => TransactionRecord[]
  getMonthGroups: () => Record<string, MonthData>
  filterTransactionsBySearch: (
    txs: TransactionRecord[],
    query: string,
  ) => TransactionRecord[]
}

// ============================================================================
// Helper: get label color hex for inline styles
// ============================================================================

const getLabelColorHex = (color: string): string => {
  const colorMap: Record<string, string> = {
    gray: "#6b7280",
    blue: "#3b82f6",
    purple: "#a855f7",
    orange: "#f97316",
    cyan: "#06b6d4",
    green: "#22c55e",
    red: "#ef4444",
    pink: "#ec4899",
    amber: "#f59e0b",
  }
  return colorMap[color] || "#6b7280"
}

// ============================================================================
// Component
// ============================================================================

export default function TransactionsView({
  // Data
  transactions,
  filteredTransactions,
  activeBlinkAccount,
  activeNpubCashWallet,
  activeNWC,
  // Date filter state
  dateFilterActive,
  selectedDateRange,
  pastTransactionsLoaded,
  // Search state
  isSearchingTx,
  isSearchLoading,
  txSearchQuery,
  txSearchInput,
  txSearchInputRef,
  // Pagination
  loadingMore,
  hasMoreTransactions,
  expandedMonths,
  // Setters
  setSelectedTransaction,
  setShowDateRangeSelector,
  setShowExportOptions,
  setIsSearchingTx,
  setTxSearchInput,
  // Handlers
  handleClearDateFilter,
  handleTxSearchClick,
  handleTxSearchClose,
  handleTxSearchKeyDown,
  handleTxSearchSubmit,
  loadMoreMonths,
  toggleMonth,
  // Computed
  getFilteredStats,
  getDisplayTransactions,
  getMonthGroups,
  filterTransactionsBySearch,
}: TransactionsViewProps) {
  return (
    <>
      {/* Most Recent Transactions */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
          Most Recent Transactions
        </h2>
        {(() => {
          // Check if current wallet type doesn't support transaction history
          const isLnAddressWallet = activeBlinkAccount?.type === "ln-address"
          const isNpubCashWallet =
            activeNpubCashWallet?.type === "npub-cash" && !activeNWC
          const walletDoesNotSupportHistory = isLnAddressWallet || isNpubCashWallet

          if (walletDoesNotSupportHistory && transactions.length === 0) {
            // Show informative message about wallet limitation
            const walletType = isLnAddressWallet ? "Blink Lightning Address" : "npub.cash"
            return (
              <div className="bg-white dark:bg-blink-dark shadow dark:shadow-black rounded-lg p-6">
                <div className="flex flex-col items-center gap-4 text-center">
                  <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                    <svg
                      className="w-6 h-6 text-blue-600 dark:text-blue-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                      Transaction History Not Available
                    </h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400 max-w-md">
                      {walletType} wallets are designed for receiving payments only and do
                      not provide transaction history.
                      {isLnAddressWallet &&
                        " To view transaction history, please use a Blink API Key wallet."}
                    </p>
                  </div>
                </div>
              </div>
            )
          }

          // Show normal transaction list
          return (
            <div className="bg-white dark:bg-blink-dark shadow dark:shadow-black overflow-hidden sm:rounded-md">
              <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                {transactions.slice(0, 5).map((tx) => (
                  <li
                    key={tx.id}
                    className="px-6 py-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    onClick={() => setSelectedTransaction(tx)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center">
                        <div
                          className={`flex-shrink-0 w-2 h-2 rounded-full mr-3 ${
                            tx.direction === "RECEIVE" ? "bg-green-500" : "bg-red-500"
                          }`}
                        ></div>
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {tx.amount}
                          </p>
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            {tx.memo}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <p className="text-sm text-gray-900 dark:text-gray-100">
                            {tx.status}
                          </p>
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            {tx.date}
                          </p>
                        </div>
                        <svg
                          className="w-4 h-4 text-gray-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )
        })()}
      </div>

      {/* Past Transactions - Grouped by Month or Filtered */}
      <div>
        {/* Title Row - Own line */}
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
          {dateFilterActive ? "Filtered Transactions" : "Past Transactions"}
        </h2>

        {/* Date Range Tag - Own line when active */}
        {dateFilterActive && selectedDateRange && (
          <div className="mb-4">
            <button
              onClick={handleClearDateFilter}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded-full hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors"
            >
              <span>{selectedDateRange.label}</span>
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
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        )}

        {/* Top Action Buttons - Only visible when there are transactions */}
        {transactions.length > 0 && (
          <div className="mb-4">
            {isSearchingTx ? (
              /* Expanded Search Input */
              <div className="max-w-sm h-10 bg-white dark:bg-black border-2 border-orange-500 dark:border-orange-500 rounded-lg flex items-center shadow-md">
                {/* Cancel button */}
                <button
                  onClick={() => {
                    setIsSearchingTx(false)
                    setTxSearchInput("")
                  }}
                  className="w-10 h-full flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
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
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
                <input
                  ref={txSearchInputRef}
                  type="text"
                  value={txSearchInput}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setTxSearchInput(e.target.value)
                  }
                  onKeyDown={handleTxSearchKeyDown}
                  placeholder="Search memo, amount, username..."
                  className="flex-1 h-full bg-transparent text-gray-900 dark:text-white focus:outline-none text-sm"
                  autoFocus
                />
                {/* Submit button */}
                <button
                  onClick={handleTxSearchSubmit}
                  disabled={!txSearchInput.trim()}
                  className="w-10 h-full flex items-center justify-center text-orange-500 hover:text-orange-600 dark:text-orange-400 dark:hover:text-orange-300 disabled:text-gray-300 dark:disabled:text-gray-600 transition-colors"
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
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                </button>
              </div>
            ) : (
              /* Filter, Search, Export buttons row */
              <div className="flex gap-2 max-w-sm">
                {/* Filter Button */}
                <button
                  onClick={() => setShowDateRangeSelector(true)}
                  disabled={loadingMore}
                  className="flex-1 h-10 bg-white dark:bg-black border border-blue-500 dark:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900 text-blue-600 dark:text-blue-400 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
                >
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
                      d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                  </svg>
                  Filter
                </button>

                {/* Search Button */}
                <button
                  onClick={txSearchQuery ? handleTxSearchClose : handleTxSearchClick}
                  className={`flex-1 h-10 bg-white dark:bg-black border rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                    txSearchQuery
                      ? "border-orange-500 dark:border-orange-400 bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-300"
                      : "border-orange-500 dark:border-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900 text-orange-500 dark:text-orange-400"
                  }`}
                >
                  {isSearchLoading ? (
                    /* Loading spinner */
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-orange-500 border-t-transparent"></div>
                  ) : txSearchQuery ? (
                    /* Active search - show query with X */
                    <>
                      <span className="truncate max-w-[80px]">
                        &quot;{txSearchQuery}&quot;
                      </span>
                      <svg
                        className="w-3 h-3 flex-shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </>
                  ) : (
                    /* Default search icon */
                    <>
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
                          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                        />
                      </svg>
                      Search
                    </>
                  )}
                </button>

                {/* Export Button */}
                <button
                  onClick={() => setShowExportOptions(true)}
                  className="flex-1 h-10 bg-white dark:bg-black border border-yellow-500 dark:border-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-900 text-yellow-600 dark:text-yellow-400 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
                >
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
                      d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                  Export
                </button>
              </div>
            )}
          </div>
        )}

        {/* Summary Stats - Show when date filter is active */}
        {dateFilterActive &&
          filteredTransactions.length > 0 &&
          (() => {
            const stats = getFilteredStats()
            const currency = filteredTransactions[0]?.settlementCurrency || "BTC"
            const formatStatAmount = (amount: number): string => {
              if (currency === "BTC") {
                return `${Math.abs(amount).toLocaleString()} sats`
              } else if (currency === "USD") {
                return `$${(Math.abs(amount) / 100).toFixed(2)}`
              }
              return `${Math.abs(amount).toLocaleString()} ${currency}`
            }

            return (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <div className="bg-green-50 dark:bg-green-900/30 rounded-lg p-3 text-center">
                  <div className="text-xs text-green-600 dark:text-green-400 font-medium uppercase">
                    Received
                  </div>
                  <div className="text-lg font-bold text-green-700 dark:text-green-300">
                    {formatStatAmount(stats.totalReceived)}
                  </div>
                  <div className="text-xs text-green-500 dark:text-green-500">
                    {stats.receiveCount} transactions
                  </div>
                </div>
                <div className="bg-red-50 dark:bg-red-900/30 rounded-lg p-3 text-center">
                  <div className="text-xs text-red-600 dark:text-red-400 font-medium uppercase">
                    Sent
                  </div>
                  <div className="text-lg font-bold text-red-700 dark:text-red-300">
                    {formatStatAmount(stats.totalSent)}
                  </div>
                  <div className="text-xs text-red-500 dark:text-red-500">
                    {stats.sendCount} transactions
                  </div>
                </div>
                <div
                  className={`rounded-lg p-3 text-center ${stats.netAmount >= 0 ? "bg-blue-50 dark:bg-blue-900/30" : "bg-orange-50 dark:bg-orange-900/30"}`}
                >
                  <div
                    className={`text-xs font-medium uppercase ${stats.netAmount >= 0 ? "text-blue-600 dark:text-blue-400" : "text-orange-600 dark:text-orange-400"}`}
                  >
                    Net
                  </div>
                  <div
                    className={`text-lg font-bold ${stats.netAmount >= 0 ? "text-blue-700 dark:text-blue-300" : "text-orange-700 dark:text-orange-300"}`}
                  >
                    {stats.netAmount >= 0 ? "+" : "-"}
                    {formatStatAmount(stats.netAmount)}
                  </div>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-600 dark:text-gray-400 font-medium uppercase">
                    Total
                  </div>
                  <div className="text-lg font-bold text-gray-700 dark:text-gray-300">
                    {stats.transactionCount}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-500">
                    transactions
                  </div>
                </div>
              </div>
            )
          })()}

        {!pastTransactionsLoaded ? (
          <div className="bg-white dark:bg-blink-dark shadow dark:shadow-black rounded-lg p-6 text-center text-gray-500 dark:text-gray-400">
            <div className="flex flex-col items-center gap-3">
              <svg
                className="w-12 h-12 text-gray-400 dark:text-gray-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              <p>Click &quot;Show&quot; to select a date range and view transactions</p>
            </div>
          </div>
        ) : dateFilterActive && filteredTransactions.length === 0 ? (
          <div className="bg-white dark:bg-blink-dark shadow dark:shadow-black rounded-lg p-6 text-center text-gray-500 dark:text-gray-400">
            <div className="flex flex-col items-center gap-3">
              <svg
                className="w-12 h-12 text-gray-400 dark:text-gray-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p>
                No transactions found for{" "}
                {selectedDateRange?.label || "selected date range"}
              </p>
              <button
                onClick={() => setShowDateRangeSelector(true)}
                className="mt-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Try Different Range
              </button>
            </div>
          </div>
        ) : isSearchLoading ? (
          /* Search Loading State */
          <div className="bg-white dark:bg-blink-dark shadow dark:shadow-black rounded-lg p-8 text-center">
            <div className="flex flex-col items-center gap-3">
              <div className="animate-spin rounded-full h-8 w-8 border-3 border-orange-500 border-t-transparent"></div>
              <p className="text-gray-500 dark:text-gray-400 text-sm">Searching...</p>
            </div>
          </div>
        ) : dateFilterActive && filteredTransactions.length > 0 ? (
          (() => {
            const displayTxs = getDisplayTransactions()

            if (displayTxs.length === 0 && txSearchQuery) {
              // Search returned no results
              return (
                <div className="bg-white dark:bg-blink-dark shadow dark:shadow-black rounded-lg p-6 text-center text-gray-500 dark:text-gray-400">
                  <div className="flex flex-col items-center gap-3">
                    <svg
                      className="w-12 h-12 text-gray-400 dark:text-gray-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                    <p>No transactions match &quot;{txSearchQuery}&quot;</p>
                    <button
                      onClick={handleTxSearchClose}
                      className="mt-2 px-4 py-2 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors"
                    >
                      Clear Search
                    </button>
                  </div>
                </div>
              )
            }

            return (
              <div className="bg-white dark:bg-blink-dark shadow dark:shadow-black rounded-lg overflow-hidden">
                {/* Search Results Count */}
                {txSearchQuery && (
                  <div className="px-4 py-2 bg-orange-50 dark:bg-orange-900/20 border-b border-orange-200 dark:border-orange-800">
                    <span className="text-sm text-orange-700 dark:text-orange-300">
                      Found {displayTxs.length} result
                      {displayTxs.length !== 1 ? "s" : ""} for &quot;{txSearchQuery}&quot;
                    </span>
                  </div>
                )}

                {/* Filtered Transactions List - Mobile */}
                <div className="block sm:hidden">
                  <div className="p-4 space-y-3">
                    {displayTxs.map((tx) => {
                      const txLabel = getTransactionLabel(tx.id)
                      return (
                        <div
                          key={tx.id}
                          className={`bg-white dark:bg-blink-dark rounded-lg p-4 border cursor-pointer hover:border-blue-400 dark:hover:border-blue-500 transition-colors ${
                            txLabel.id !== "none"
                              ? `${txLabel.borderLight} dark:${txLabel.borderDark}`
                              : "border-gray-200 dark:border-gray-700"
                          }`}
                          onClick={() => setSelectedTransaction(tx)}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              {/* Label indicator dot */}
                              {txLabel.id !== "none" && (
                                <div
                                  className={`w-2.5 h-2.5 rounded-full ${txLabel.bgLight} dark:${txLabel.bgDark}`}
                                  style={{
                                    backgroundColor: getLabelColorHex(txLabel.color),
                                  }}
                                />
                              )}
                              <span
                                className={`text-lg font-medium ${
                                  tx.direction === "RECEIVE"
                                    ? "text-green-600 dark:text-green-400"
                                    : "text-red-600 dark:text-red-400"
                                }`}
                              >
                                {tx.amount}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200">
                                {tx.status}
                              </span>
                              <svg
                                className="w-4 h-4 text-gray-400"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth="2"
                                  d="M9 5l7 7-7 7"
                                />
                              </svg>
                            </div>
                          </div>
                          <div className="text-sm text-gray-900 dark:text-gray-100 mb-1">
                            {tx.date}
                          </div>
                          {tx.memo && tx.memo !== "-" && (
                            <div className="text-sm text-gray-500 dark:text-gray-400">
                              {tx.memo}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Filtered Transactions Table - Desktop */}
                <div className="hidden sm:block">
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                      <thead className="bg-gray-50 dark:bg-gray-800">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                            Amount
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                            Status
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                            Date
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                            Memo
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"></th>
                        </tr>
                      </thead>
                      <tbody className="bg-white dark:bg-blink-dark divide-y divide-gray-200 dark:divide-gray-700">
                        {displayTxs.map((tx) => (
                          <tr
                            key={tx.id}
                            className="hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                            onClick={() => setSelectedTransaction(tx)}
                          >
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span
                                className={`text-sm font-medium ${
                                  tx.direction === "RECEIVE"
                                    ? "text-green-600 dark:text-green-400"
                                    : "text-red-600 dark:text-red-400"
                                }`}
                              >
                                {tx.amount}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200">
                                {tx.status}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                              {tx.date}
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
                              {tx.memo && tx.memo !== "-" ? tx.memo : "-"}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-right">
                              <svg
                                className="w-4 h-4 text-gray-400"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth="2"
                                  d="M9 5l7 7-7 7"
                                />
                              </svg>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )
          })()
        ) : isSearchLoading ? (
          /* Search Loading State (for month-grouped view) */
          <div className="bg-white dark:bg-blink-dark shadow dark:shadow-black rounded-lg p-8 text-center">
            <div className="flex flex-col items-center gap-3">
              <div className="animate-spin rounded-full h-8 w-8 border-3 border-orange-500 border-t-transparent"></div>
              <p className="text-gray-500 dark:text-gray-400 text-sm">Searching...</p>
            </div>
          </div>
        ) : (
          (() => {
            const monthGroups = getMonthGroups()

            // Apply search filter to month groups if search is active
            const filteredMonthGroups: Record<string, MonthData> = {}
            Object.entries(monthGroups).forEach(([monthKey, monthData]) => {
              const filteredTxs = filterTransactionsBySearch(
                monthData.transactions,
                txSearchQuery,
              )
              if (filteredTxs.length > 0) {
                filteredMonthGroups[monthKey] = {
                  ...monthData,
                  transactions: filteredTxs,
                }
              }
            })

            const monthKeys = Object.keys(filteredMonthGroups)

            // Show search no results message
            if (monthKeys.length === 0 && txSearchQuery) {
              return (
                <div className="bg-white dark:bg-blink-dark shadow dark:shadow-black rounded-lg p-6 text-center text-gray-500 dark:text-gray-400">
                  <div className="flex flex-col items-center gap-3">
                    <svg
                      className="w-12 h-12 text-gray-400 dark:text-gray-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                    <p>No transactions match &quot;{txSearchQuery}&quot;</p>
                    <button
                      onClick={handleTxSearchClose}
                      className="mt-2 px-4 py-2 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors"
                    >
                      Clear Search
                    </button>
                  </div>
                </div>
              )
            }

            if (monthKeys.length === 0) {
              // Check if current wallet type doesn't support transaction history
              const isLnAddressWallet = activeBlinkAccount?.type === "ln-address"
              const isNpubCashWallet =
                activeNpubCashWallet?.type === "npub-cash" && !activeNWC
              const walletDoesNotSupportHistory = isLnAddressWallet || isNpubCashWallet

              if (walletDoesNotSupportHistory) {
                // Show informative message about wallet limitation
                const walletType = isLnAddressWallet
                  ? "Blink Lightning Address"
                  : "npub.cash"
                return (
                  <div className="bg-white dark:bg-blink-dark shadow dark:shadow-black rounded-lg p-6">
                    <div className="flex flex-col items-center gap-4 text-center">
                      <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                        <svg
                          className="w-6 h-6 text-blue-600 dark:text-blue-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                      </div>
                      <div>
                        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                          Transaction History Not Available
                        </h3>
                        <p className="text-sm text-gray-600 dark:text-gray-400 max-w-md">
                          {walletType} wallets are designed for receiving payments only
                          and do not provide transaction history.
                          {isLnAddressWallet &&
                            " To view transaction history, please use a Blink API Key wallet."}
                        </p>
                      </div>
                    </div>
                  </div>
                )
              }

              return (
                <div className="bg-white dark:bg-blink-dark shadow dark:shadow-black rounded-lg p-6 text-center text-gray-500 dark:text-gray-400">
                  No past transactions available
                </div>
              )
            }

            // Calculate total search results count
            const totalSearchResults = txSearchQuery
              ? Object.values(filteredMonthGroups).reduce(
                  (sum, m) => sum + m.transactions.length,
                  0,
                )
              : 0

            return (
              <div className="space-y-4">
                {/* Search Results Count */}
                {txSearchQuery && (
                  <div className="px-4 py-2 bg-orange-50 dark:bg-orange-900/20 rounded-lg border border-orange-200 dark:border-orange-800">
                    <span className="text-sm text-orange-700 dark:text-orange-300">
                      Found {totalSearchResults} result
                      {totalSearchResults !== 1 ? "s" : ""} for &quot;{txSearchQuery}
                      &quot;
                    </span>
                  </div>
                )}

                {monthKeys.map((monthKey) => {
                  const monthData = filteredMonthGroups[monthKey]
                  const isExpanded = expandedMonths.has(monthKey)
                  const transactionCount = monthData.transactions.length

                  return (
                    <div
                      key={monthKey}
                      className="bg-white dark:bg-blink-dark shadow dark:shadow-black rounded-lg overflow-hidden"
                    >
                      {/* Month Header - Clickable */}
                      <button
                        onClick={() => toggleMonth(monthKey)}
                        className="w-full px-6 py-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:bg-white dark:focus:bg-gray-700 transition-colors month-group-header"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                              {monthData.label}
                            </h3>
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                              {transactionCount} transaction
                              {transactionCount !== 1 ? "s" : ""}
                            </p>
                          </div>
                          <div className="flex items-center">
                            <svg
                              className={`w-5 h-5 text-gray-400 transform transition-transform ${
                                isExpanded ? "rotate-180" : ""
                              }`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M19 9l-7 7-7-7"
                              />
                            </svg>
                          </div>
                        </div>
                      </button>

                      {/* Month Transactions - Expandable */}
                      {isExpanded && (
                        <div className="border-t border-gray-200 dark:border-gray-700 month-group-content">
                          {/* Mobile-friendly card layout for small screens */}
                          <div className="block sm:hidden">
                            <div className="p-4 space-y-3">
                              {monthData.transactions.map((tx) => {
                                const txLabel = getTransactionLabel(tx.id)
                                return (
                                  <div
                                    key={tx.id}
                                    className={`bg-white dark:bg-blink-dark rounded-lg p-4 border transaction-card-mobile cursor-pointer hover:border-blue-400 dark:hover:border-blue-500 transition-colors ${
                                      txLabel.id !== "none"
                                        ? `${txLabel.borderLight} dark:${txLabel.borderDark}`
                                        : "border-gray-200 dark:border-gray-700"
                                    }`}
                                    onClick={() => setSelectedTransaction(tx)}
                                  >
                                    <div className="flex items-center justify-between mb-2">
                                      <div className="flex items-center gap-2">
                                        {/* Label indicator dot */}
                                        {txLabel.id !== "none" && (
                                          <div
                                            className="w-2.5 h-2.5 rounded-full"
                                            style={{
                                              backgroundColor: getLabelColorHex(
                                                txLabel.color,
                                              ),
                                            }}
                                          />
                                        )}
                                        <span
                                          className={`text-lg font-medium ${
                                            tx.direction === "RECEIVE"
                                              ? "text-green-600 dark:text-green-400"
                                              : "text-red-600 dark:text-red-400"
                                          }`}
                                        >
                                          {tx.amount}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200">
                                          {tx.status}
                                        </span>
                                        <svg
                                          className="w-4 h-4 text-gray-400"
                                          fill="none"
                                          stroke="currentColor"
                                          viewBox="0 0 24 24"
                                        >
                                          <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth="2"
                                            d="M9 5l7 7-7 7"
                                          />
                                        </svg>
                                      </div>
                                    </div>
                                    <div className="text-sm text-gray-900 dark:text-gray-100 mb-1">
                                      {tx.date}
                                    </div>
                                    {tx.memo && tx.memo !== "-" && (
                                      <div className="text-sm text-gray-500 dark:text-gray-400">
                                        {tx.memo}
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          </div>

                          {/* Desktop table layout for larger screens */}
                          <div className="hidden sm:block">
                            <div className="overflow-x-auto">
                              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                                <thead className="bg-white dark:bg-blink-dark">
                                  <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                      Amount
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                      Status
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                      Date
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                      Memo
                                    </th>
                                    <th className="px-6 py-3"></th>
                                  </tr>
                                </thead>
                                <tbody className="bg-white dark:bg-blink-dark divide-y divide-gray-200 dark:divide-gray-700">
                                  {monthData.transactions.map((tx) => (
                                    <tr
                                      key={tx.id}
                                      className="hover:bg-gray-50 dark:hover:bg-gray-700 bg-white dark:bg-blink-dark cursor-pointer"
                                      onClick={() => setSelectedTransaction(tx)}
                                    >
                                      <td className="px-6 py-4 whitespace-nowrap">
                                        <span
                                          className={`text-sm font-medium ${
                                            tx.direction === "RECEIVE"
                                              ? "text-green-600 dark:text-green-400"
                                              : "text-red-600 dark:text-red-400"
                                          }`}
                                        >
                                          {tx.amount}
                                        </span>
                                      </td>
                                      <td className="px-6 py-4 whitespace-nowrap">
                                        <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200">
                                          {tx.status}
                                        </span>
                                      </td>
                                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                        {tx.date}
                                      </td>
                                      <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
                                        {tx.memo && tx.memo !== "-" ? tx.memo : "-"}
                                      </td>
                                      <td className="px-6 py-4 whitespace-nowrap">
                                        <svg
                                          className="w-4 h-4 text-gray-400"
                                          fill="none"
                                          stroke="currentColor"
                                          viewBox="0 0 24 24"
                                        >
                                          <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth="2"
                                            d="M9 5l7 7-7 7"
                                          />
                                        </svg>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()
        )}

        {/* Bottom Action Buttons - Show Filter/Export only when > 5 transactions loaded */}
        {(() => {
          const displayTxCount = dateFilterActive
            ? filteredTransactions.length
            : transactions.length
          const showBottomFilterExport = displayTxCount > 5
          const showMoreButton = pastTransactionsLoaded && hasMoreTransactions

          // Don't show section at all if nothing to show
          if (!showBottomFilterExport && !showMoreButton) return null

          return (
            <div className="mt-6 px-4">
              <div
                className={`grid gap-3 max-w-sm mx-auto ${
                  showBottomFilterExport && showMoreButton
                    ? "grid-cols-3"
                    : showMoreButton
                      ? "grid-cols-1"
                      : "grid-cols-2"
                }`}
              >
                {/* Filter Button - Only when > 5 transactions */}
                {showBottomFilterExport && (
                  <button
                    onClick={() => setShowDateRangeSelector(true)}
                    disabled={loadingMore}
                    className="h-16 bg-white dark:bg-black border-2 border-blue-600 dark:border-blue-500 hover:border-blue-700 dark:hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 disabled:border-gray-400 disabled:text-gray-400 disabled:cursor-not-allowed disabled:hover:bg-white dark:disabled:hover:bg-black rounded-lg text-lg font-normal transition-colors shadow-md"
                    style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
                  >
                    <div className="flex items-center justify-center gap-2">
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
                          d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                        />
                      </svg>
                      Filter
                    </div>
                  </button>
                )}

                {/* Show More Button - Only when more data is available */}
                {showMoreButton && (
                  <button
                    onClick={loadMoreMonths}
                    disabled={loadingMore}
                    className="h-16 bg-white dark:bg-black border-2 border-gray-400 dark:border-gray-500 hover:border-gray-500 dark:hover:border-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900 text-gray-600 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 disabled:border-gray-300 disabled:text-gray-300 disabled:cursor-not-allowed rounded-lg text-lg font-normal transition-colors shadow-md"
                    style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
                  >
                    {loadingMore ? (
                      <div className="flex items-center justify-center">
                        <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent mr-2"></div>
                        Loading...
                      </div>
                    ) : (
                      "More"
                    )}
                  </button>
                )}

                {/* Export Button - Only when > 5 transactions */}
                {showBottomFilterExport && (
                  <button
                    onClick={() => setShowExportOptions(true)}
                    className="h-16 bg-white dark:bg-black border-2 border-yellow-500 dark:border-yellow-400 hover:border-yellow-600 dark:hover:border-yellow-300 hover:bg-yellow-50 dark:hover:bg-yellow-900 text-yellow-600 dark:text-yellow-400 hover:text-yellow-700 dark:hover:text-yellow-300 rounded-lg text-lg font-normal transition-colors shadow-md"
                    style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
                  >
                    Export
                  </button>
                )}
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400 text-center mt-2">
                {dateFilterActive && selectedDateRange
                  ? `Showing: ${selectedDateRange.label}`
                  : hasMoreTransactions
                    ? `${transactions.length} transactions loaded · More available`
                    : `All ${transactions.length} transactions loaded`}
              </p>
            </div>
          )
        })()}
      </div>
    </>
  )
}
