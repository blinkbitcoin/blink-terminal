import { getApiUrl, isStaging } from "../../lib/config/api"
import type { EditingWalletLabel } from "../../lib/hooks/useAccountManagement"
import type { VoucherWallet } from "../../lib/hooks/useVoucherWalletState"
import { formatNumber, NumberFormatPreference } from "../../lib/number-format"

interface VoucherWalletOverlayProps {
  // State values
  darkMode: boolean
  voucherWallet: VoucherWallet | null
  voucherWalletBalance: number | null
  voucherWalletUsdBalance: number | null
  voucherWalletBalanceLoading: boolean
  voucherWalletApiKey: string
  voucherWalletLabel: string
  voucherWalletLoading: boolean
  voucherWalletValidating: boolean
  voucherWalletScopes: string[] | null
  voucherWalletError: string | null
  editingWalletLabel: EditingWalletLabel | null
  editedWalletLabel: string
  numberFormat: NumberFormatPreference
  publicKey: string | null
  // Setters
  setShowVoucherWalletSettings: (v: boolean) => void
  setVoucherWalletApiKey: (v: string) => void
  setVoucherWalletLabel: (v: string) => void
  setVoucherWalletError: (v: string | null) => void
  setVoucherWalletScopes: (v: string[] | null) => void
  setVoucherWallet: (v: VoucherWallet | null) => void
  setVoucherWalletLoading: (v: boolean) => void
  setVoucherWalletValidating: (v: boolean) => void
  setEditingWalletLabel: (v: EditingWalletLabel | null) => void
  setEditedWalletLabel: (v: string) => void
  // Functions
  getSubmenuBgClasses: () => string
  getSubmenuHeaderClasses: () => string
  fetchVoucherWalletBalance: () => void
  getVoucherWalletKey: (publicKey: string) => string | null
  syncVoucherWalletToServer: (wallet: VoucherWallet | null) => void
}

export default function VoucherWalletOverlay({
  // State values
  darkMode,
  voucherWallet,
  voucherWalletBalance,
  voucherWalletUsdBalance,
  voucherWalletBalanceLoading,
  voucherWalletApiKey,
  voucherWalletLabel,
  voucherWalletLoading,
  voucherWalletValidating,
  voucherWalletScopes,
  voucherWalletError,
  editingWalletLabel,
  editedWalletLabel,
  numberFormat,
  publicKey,
  // Setters
  setShowVoucherWalletSettings,
  setVoucherWalletApiKey,
  setVoucherWalletLabel,
  setVoucherWalletError,
  setVoucherWalletScopes,
  setVoucherWallet,
  setVoucherWalletLoading,
  setVoucherWalletValidating,
  setEditingWalletLabel,
  setEditedWalletLabel,
  // Functions
  getSubmenuBgClasses,
  getSubmenuHeaderClasses,
  fetchVoucherWalletBalance,
  getVoucherWalletKey,
  syncVoucherWalletToServer,
}: VoucherWalletOverlayProps) {
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
                  setShowVoucherWalletSettings(false)
                  setVoucherWalletApiKey("")
                  setVoucherWalletLabel("")
                  setVoucherWalletError(null)
                  setVoucherWalletScopes(null)
                }}
                className="flex items-center text-gray-700 dark:text-white hover:text-blink-accent dark:hover:text-blink-accent"
              >
                <span className="text-2xl mr-2">&#8249;</span>
                <span className="text-lg">Back</span>
              </button>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                  Sending Wallet
                </h1>
                <span className="px-2 py-0.5 text-xs font-medium rounded bg-purple-500/20 text-purple-400">
                  Beta
                </span>
              </div>
              <div className="w-16"></div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-md mx-auto px-4 py-6">
          <div className="space-y-4">
            {/* Info Banner */}
            <div
              className={`p-4 rounded-lg ${darkMode ? "bg-purple-900/20 border border-purple-500/30" : "bg-purple-50 border border-purple-200"}`}
            >
              <div className="flex gap-3">
                <svg
                  className="w-5 h-5 text-purple-500 flex-shrink-0 mt-0.5"
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
                <div>
                  <p
                    className={`text-sm font-medium ${darkMode ? "text-purple-300" : "text-purple-800"}`}
                  >
                    Sending Wallet Requirements
                  </p>
                  <p
                    className={`text-xs mt-1 ${darkMode ? "text-purple-400/80" : "text-purple-600"}`}
                  >
                    This wallet is used for sending operations like Vouchers and Batch
                    Payments. It requires a Blink API key with <strong>WRITE</strong>{" "}
                    scope.
                  </p>
                </div>
              </div>
            </div>

            {/* Current Voucher Wallet */}
            {voucherWallet && (
              <div
                className={`rounded-lg p-4 border-2 ${darkMode ? "bg-purple-900/20 border-purple-500" : "bg-purple-50 border-purple-400"}`}
              >
                {/* Wallet Info Section */}
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center bg-purple-500/20">
                    <svg
                      className="w-5 h-5 text-purple-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"
                      />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <h5
                      className={`font-medium truncate ${darkMode ? "text-white" : "text-gray-900"}`}
                    >
                      {voucherWallet.label || "Sending Wallet"}
                    </h5>
                    <p
                      className={`text-sm truncate ${darkMode ? "text-gray-400" : "text-gray-600"}`}
                    >
                      @{String(voucherWallet.username ?? "")}
                    </p>
                    {typeof voucherWallet.walletId === "string" &&
                      voucherWallet.walletId && (
                        <p
                          className={`text-xs truncate ${darkMode ? "text-gray-500" : "text-gray-500"}`}
                        >
                          Wallet: {String(voucherWallet.walletId)}
                        </p>
                      )}
                    <div className="flex flex-wrap gap-1 mt-1">
                      {(voucherWallet.scopes as string[] | undefined)?.map(
                        (scope: string) => (
                          <span
                            key={scope}
                            className={`px-1.5 py-0.5 rounded text-xs ${
                              scope === "WRITE"
                                ? "bg-green-500/20 text-green-400"
                                : "bg-gray-500/20 text-gray-400"
                            }`}
                          >
                            {scope}
                          </span>
                        ),
                      )}
                    </div>
                    {/* Balance Display Section */}
                    <div
                      className={`mt-3 pt-3 border-t ${darkMode ? "border-gray-700" : "border-gray-200"}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs ${darkMode ? "text-gray-500" : "text-gray-500"}`}
                            >
                              BTC Wallet:
                            </span>
                            <span
                              className={`text-sm font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                            >
                              {voucherWalletBalanceLoading ? (
                                <span className="text-gray-400">Loading...</span>
                              ) : voucherWalletBalance !== null ? (
                                `${formatNumber(voucherWalletBalance, numberFormat, 0)} sats`
                              ) : (
                                <span className="text-gray-400">--</span>
                              )}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs ${darkMode ? "text-gray-500" : "text-gray-500"}`}
                            >
                              USD Wallet:
                            </span>
                            <span
                              className={`text-sm font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                            >
                              {voucherWalletBalanceLoading ? (
                                <span className="text-gray-400">Loading...</span>
                              ) : voucherWalletUsdBalance !== null ? (
                                `$${(voucherWalletUsdBalance / 100).toFixed(2)} USD`
                              ) : (
                                <span className="text-gray-400">--</span>
                              )}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={fetchVoucherWalletBalance}
                          disabled={voucherWalletBalanceLoading}
                          className={`p-2 rounded transition-colors ${darkMode ? "text-gray-400 hover:text-purple-400 hover:bg-gray-800" : "text-gray-500 hover:text-purple-500 hover:bg-gray-100"} disabled:opacity-50`}
                          title="Refresh balance"
                        >
                          <svg
                            className={`w-4 h-4 ${voucherWalletBalanceLoading ? "animate-spin" : ""}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="2"
                              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Edit/Delete Actions */}
                <div
                  className={`flex gap-2 mt-3 pt-3 border-t ${darkMode ? "border-purple-700/50" : "border-purple-200"}`}
                >
                  <button
                    onClick={() => {
                      setEditingWalletLabel({ type: "sending" })
                      setEditedWalletLabel(voucherWallet.label || "")
                    }}
                    className={`flex-1 py-2 text-sm rounded-lg transition-colors ${
                      darkMode
                        ? "text-gray-400 hover:text-purple-400 border border-purple-700/50"
                        : "text-gray-600 hover:text-purple-600 border border-purple-300"
                    }`}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm("Delete this sending wallet?")) {
                        if (typeof window !== "undefined" && publicKey) {
                          const storageKey = getVoucherWalletKey(publicKey)
                          if (storageKey) {
                            localStorage.removeItem(storageKey)
                          }
                        }
                        setVoucherWallet(null)
                        // Sync deletion to server
                        syncVoucherWalletToServer(null)
                      }
                    }}
                    className={`flex-1 py-2 text-sm rounded-lg text-red-500 hover:text-red-700 border transition-colors ${
                      darkMode ? "border-purple-700/50" : "border-purple-300"
                    }`}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}

            {/* Edit Sending Wallet Label Modal */}
            {editingWalletLabel?.type === "sending" && (
              <div
                className={`rounded-lg p-4 border-2 ${darkMode ? "bg-purple-900/30 border-purple-400" : "bg-purple-100 border-purple-500"}`}
              >
                <h4
                  className={`text-sm font-medium mb-3 ${darkMode ? "text-white" : "text-gray-900"}`}
                >
                  Edit Wallet Label
                </h4>
                <input
                  type="text"
                  value={editedWalletLabel}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setEditedWalletLabel(e.target.value)
                  }
                  placeholder="Enter wallet label"
                  className={`w-full px-3 py-2 rounded-lg border ${
                    darkMode
                      ? "bg-gray-800 border-gray-700 text-white placeholder-gray-500"
                      : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                  } focus:outline-none focus:ring-2 focus:ring-purple-500`}
                />
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => {
                      // Update the label in voucherWallet
                      const updatedWallet: VoucherWallet = {
                        ...voucherWallet!,
                        label: editedWalletLabel.trim() || "Sending Wallet",
                      }
                      setVoucherWallet(updatedWallet)
                      // Save to localStorage
                      if (typeof window !== "undefined" && publicKey) {
                        const storageKey = getVoucherWalletKey(publicKey)
                        if (storageKey) {
                          localStorage.setItem(storageKey, JSON.stringify(updatedWallet))
                        }
                      }
                      // Sync to server
                      syncVoucherWalletToServer(updatedWallet)
                      // Close the edit form
                      setEditingWalletLabel(null)
                      setEditedWalletLabel("")
                    }}
                    className="flex-1 py-2 text-sm rounded-lg bg-purple-600 text-white hover:bg-purple-700 transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => {
                      setEditingWalletLabel(null)
                      setEditedWalletLabel("")
                    }}
                    className={`flex-1 py-2 text-sm rounded-lg transition-colors ${
                      darkMode
                        ? "bg-gray-700 text-gray-300 hover:bg-gray-600"
                        : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                    }`}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Add Voucher Wallet Form */}
            {!voucherWallet && (
              <div
                className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}
              >
                <h3
                  className={`text-sm font-medium mb-3 ${darkMode ? "text-white" : "text-gray-900"}`}
                >
                  Connect Blink API Key
                </h3>
                <form
                  onSubmit={async (e: React.FormEvent<HTMLFormElement>) => {
                    e.preventDefault()
                    if (!voucherWalletApiKey.trim()) {
                      setVoucherWalletError("Please enter an API key")
                      return
                    }

                    setVoucherWalletLoading(true)
                    setVoucherWalletError(null)
                    setVoucherWalletScopes(null)

                    try {
                      // Step 1: Check scopes using authorization query
                      setVoucherWalletValidating(true)
                      const scopeResponse = await fetch(getApiUrl(), {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          "X-API-KEY": voucherWalletApiKey.trim(),
                        },
                        body: JSON.stringify({
                          query: "{ authorization { scopes } }",
                        }),
                      })

                      if (!scopeResponse.ok) {
                        throw new Error("Invalid API key")
                      }

                      const scopeData = await scopeResponse.json()
                      if (scopeData.errors) {
                        throw new Error(
                          scopeData.errors[0]?.message ||
                            "Failed to check API key scopes",
                        )
                      }

                      const scopes: string[] = scopeData.data?.authorization?.scopes || []
                      setVoucherWalletScopes(scopes)

                      // Step 2: Verify WRITE scope is present
                      if (!scopes.includes("WRITE")) {
                        setVoucherWalletError(
                          `This API key does not have WRITE scope. Found scopes: ${scopes.join(", ") || "none"}. The voucher feature requires WRITE permission.`,
                        )
                        setVoucherWalletLoading(false)
                        setVoucherWalletValidating(false)
                        return
                      }

                      // Step 3: Get user info and wallet ID
                      const userResponse = await fetch(getApiUrl(), {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          "X-API-KEY": voucherWalletApiKey.trim(),
                        },
                        body: JSON.stringify({
                          query:
                            "{ me { id username defaultAccount { displayCurrency wallets { id walletCurrency } } } }",
                        }),
                      })

                      if (!userResponse.ok) {
                        throw new Error("Failed to validate API key")
                      }

                      const userData = await userResponse.json()
                      if (userData.errors || !userData.data?.me?.id) {
                        throw new Error("Invalid API key")
                      }

                      // Get BTC wallet ID
                      const wallets: Array<{ id: string; walletCurrency: string }> =
                        userData.data.me.defaultAccount?.wallets || []
                      const btcWallet = wallets.find((w) => w.walletCurrency === "BTC")

                      if (!btcWallet) {
                        throw new Error(
                          "No BTC wallet found for this account. The voucher feature requires a BTC wallet.",
                        )
                      }

                      // Save voucher wallet
                      const walletData: VoucherWallet = {
                        id: btcWallet.id,
                        apiKey: voucherWalletApiKey.trim(),
                        walletId: btcWallet.id,
                        label: voucherWalletLabel.trim() || "Sending Wallet",
                        username: userData.data.me.username,
                        userId: userData.data.me.id,
                        displayCurrency:
                          userData.data.me.defaultAccount?.displayCurrency || "BTC",
                        scopes: scopes,
                        createdAt: Date.now(),
                      }

                      if (typeof window !== "undefined" && publicKey) {
                        const storageKey = getVoucherWalletKey(publicKey)
                        if (storageKey) {
                          localStorage.setItem(storageKey, JSON.stringify(walletData))
                        }
                      }
                      setVoucherWallet(walletData)

                      // Sync to server for cross-device access
                      syncVoucherWalletToServer(walletData)

                      // Reset form
                      setVoucherWalletApiKey("")
                      setVoucherWalletLabel("")
                      setVoucherWalletScopes(null)
                    } catch (err: unknown) {
                      setVoucherWalletError((err as Error).message)
                    } finally {
                      setVoucherWalletLoading(false)
                      setVoucherWalletValidating(false)
                    }
                  }}
                  className="space-y-3"
                >
                  <div>
                    <label
                      className={`block text-sm mb-1 ${darkMode ? "text-gray-300" : "text-gray-700"}`}
                    >
                      Label (optional)
                    </label>
                    <input
                      type="text"
                      value={voucherWalletLabel}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setVoucherWalletLabel(e.target.value)
                      }
                      placeholder="My Sending Wallet"
                      autoComplete="off"
                      data-1p-ignore="true"
                      data-lpignore="true"
                      className={`w-full px-3 py-2 rounded-md border text-sm ${
                        darkMode
                          ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                          : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                      } focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent`}
                    />
                  </div>
                  <div>
                    <label
                      className={`block text-sm mb-1 ${darkMode ? "text-gray-300" : "text-gray-700"}`}
                    >
                      Blink API Key <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="password"
                      value={voucherWalletApiKey}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setVoucherWalletApiKey(e.target.value)
                        setVoucherWalletError(null)
                        setVoucherWalletScopes(null)
                      }}
                      placeholder={isStaging() ? "galoy_staging_..." : "blink_..."}
                      required
                      autoComplete="off"
                      data-1p-ignore="true"
                      data-lpignore="true"
                      className={`w-full px-3 py-2 rounded-md border text-sm ${
                        darkMode
                          ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                          : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                      } focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent`}
                    />
                    <p
                      className={`text-xs mt-1 ${darkMode ? "text-gray-500" : "text-gray-500"}`}
                    >
                      Get from{" "}
                      <a
                        href="https://dashboard.blink.sv"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-purple-500 hover:underline"
                      >
                        dashboard.blink.sv
                      </a>
                      . Must have <span className="font-semibold">WRITE</span> scope.
                    </p>
                  </div>

                  {/* Scopes Display */}
                  {voucherWalletScopes && (
                    <div
                      className={`p-3 rounded-md ${
                        voucherWalletScopes.includes("WRITE")
                          ? darkMode
                            ? "bg-green-900/20 border border-green-500/30"
                            : "bg-green-50 border border-green-200"
                          : darkMode
                            ? "bg-red-900/20 border border-red-500/30"
                            : "bg-red-50 border border-red-200"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        {voucherWalletScopes.includes("WRITE") ? (
                          <svg
                            className="w-4 h-4 text-green-500"
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
                        ) : (
                          <svg
                            className="w-4 h-4 text-red-500"
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
                        )}
                        <span
                          className={`text-sm font-medium ${
                            voucherWalletScopes.includes("WRITE")
                              ? darkMode
                                ? "text-green-400"
                                : "text-green-700"
                              : darkMode
                                ? "text-red-400"
                                : "text-red-700"
                          }`}
                        >
                          {voucherWalletScopes.includes("WRITE")
                            ? "WRITE scope found"
                            : "Missing WRITE scope"}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {voucherWalletScopes.map((scope) => (
                          <span
                            key={scope}
                            className={`px-2 py-0.5 rounded text-xs ${
                              scope === "WRITE"
                                ? "bg-green-500/20 text-green-400"
                                : darkMode
                                  ? "bg-gray-700 text-gray-400"
                                  : "bg-gray-200 text-gray-600"
                            }`}
                          >
                            {scope}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {voucherWalletError && (
                    <div
                      className={`p-3 rounded-md ${darkMode ? "bg-red-900/20 border border-red-500/30" : "bg-red-50 border border-red-200"}`}
                    >
                      <p className="text-sm text-red-500">{voucherWalletError}</p>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={voucherWalletLoading || !voucherWalletApiKey.trim()}
                    className="w-full py-3 bg-purple-600 text-white text-sm font-medium rounded-md hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {voucherWalletLoading
                      ? voucherWalletValidating
                        ? "Checking scopes..."
                        : "Adding..."
                      : "Add Sending Wallet"}
                  </button>
                </form>
              </div>
            )}

            {/* Help Section */}
            <div className={`text-xs ${darkMode ? "text-gray-500" : "text-gray-500"}`}>
              <p className="font-medium mb-1">About Sending Wallet:</p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>Used for Vouchers and Batch Payments</li>
                <li>Separate from your main receiving wallet</li>
                <li>Requires API key with WRITE permission</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
