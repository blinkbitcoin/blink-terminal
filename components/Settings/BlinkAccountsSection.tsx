/**
 * BlinkAccountsSection - Manage Blink accounts
 * Supports both API key and Lightning Address wallet types
 */

import { useState } from "react"

import { getApiUrl, isStaging } from "../../lib/config/api"
import { useCombinedAuth } from "../../lib/hooks/useCombinedAuth"
import type { LocalBlinkAccount } from "../../lib/hooks/useProfile"
import { useTheme } from "../../lib/hooks/useTheme"
import { isNpubCashAddress, probeNpubCashAddress } from "../../lib/lnurl"

interface WalletInfo {
  username: string
  walletId: string
  walletCurrency: string
  lightningAddress: string
}

interface NpubCashInfo {
  lightningAddress: string
  minSendable?: number
  maxSendable?: number
}

export default function BlinkAccountsSection() {
  const {
    authMode,
    blinkAccounts,
    addBlinkAccount,
    addBlinkLnAddressWallet,
    addNpubCashWallet,
    setActiveBlinkAccount,
    hasServerSession: _hasServerSession,
    storeBlinkAccountOnServer,
    publicKey: _publicKey,
    npubCashWallets,
  } = useCombinedAuth()

  const { darkMode } = useTheme()
  const [showAddForm, setShowAddForm] = useState<boolean>(false)
  const [addMethod, setAddMethod] = useState<
    "api-key" | "ln-address" | "npub-cash" | null
  >(null)
  const [apiKey, setApiKey] = useState<string>("")
  const [lnAddress, setLnAddress] = useState<string>("")
  const [npubCashAddress, setNpubCashAddress] = useState<string>("")
  const [label, setLabel] = useState<string>("")
  const [loading, setLoading] = useState<boolean>(false)
  const [validating, setValidating] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null)
  const [npubCashInfo, setNpubCashInfo] = useState<NpubCashInfo | null>(null)

  const resetForm = (): void => {
    setShowAddForm(false)
    setAddMethod(null)
    setApiKey("")
    setLnAddress("")
    setNpubCashAddress("")
    setLabel("")
    setError(null)
    setWalletInfo(null)
    setNpubCashInfo(null)
  }

  const handleValidateLnAddress = async (): Promise<void> => {
    if (!lnAddress.trim()) {
      setError("Please enter a username or lightning address")
      return
    }

    setValidating(true)
    setError(null)
    setWalletInfo(null)

    try {
      const response = await fetch("/api/blink/validate-ln-address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lnAddress: lnAddress.trim() }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || "Failed to validate")
        setValidating(false)
        return
      }

      setWalletInfo(data)
      setValidating(false)
    } catch (err: unknown) {
      setError((err as Error).message || "Validation failed")
      setValidating(false)
    }
  }

  const handleValidateNpubCash = async (): Promise<void> => {
    if (!npubCashAddress.trim()) {
      setError("Please enter an npub.cash Lightning Address")
      return
    }

    if (!isNpubCashAddress(npubCashAddress.trim())) {
      setError(
        "Invalid npub.cash address format. Must be npub1...@npub.cash or username@npub.cash",
      )
      return
    }

    setValidating(true)
    setError(null)
    setNpubCashInfo(null)

    try {
      const lnurlInfo = await probeNpubCashAddress(npubCashAddress.trim())
      setNpubCashInfo({
        lightningAddress: npubCashAddress.trim(),
        minSendable: lnurlInfo.minSats,
        maxSendable: lnurlInfo.maxSats,
      })
      setValidating(false)
    } catch (err: unknown) {
      setError((err as Error).message || "Failed to validate npub.cash address")
      setValidating(false)
    }
  }

  const handleAddNpubCash = async (
    e: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    e.preventDefault()

    if (!npubCashInfo) {
      await handleValidateNpubCash()
      return
    }

    setLoading(true)
    setError(null)

    try {
      const result = await addNpubCashWallet({
        label: label.trim() || npubCashInfo.lightningAddress,
        lightningAddress: npubCashInfo.lightningAddress,
      })

      if (!result.success) {
        throw new Error(result.error || "Failed to add npub.cash wallet")
      }

      resetForm()
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleAddLnAddress = async (
    e: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    e.preventDefault()

    if (!walletInfo) {
      await handleValidateLnAddress()
      return
    }

    setLoading(true)
    setError(null)

    try {
      const result = await addBlinkLnAddressWallet({
        label: label.trim() || `${walletInfo.username}@blink.sv`,
        username: walletInfo.username,
        walletId: walletInfo.walletId,
        walletCurrency: walletInfo.walletCurrency,
        lightningAddress: walletInfo.lightningAddress,
      })

      if (!result.success) {
        throw new Error(result.error || "Failed to add wallet")
      }

      resetForm()
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleAddApiKey = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    if (!apiKey.trim()) {
      setError("Enter an API key")
      return
    }

    setLoading(true)
    setError(null)

    try {
      const response = await fetch(getApiUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": apiKey.trim(),
        },
        body: JSON.stringify({
          query: "query { me { id username defaultAccount { displayCurrency } } }",
        }),
      })

      if (!response.ok) {
        throw new Error("Invalid API key")
      }

      const data = await response.json()
      if (data.errors || !data.data?.me?.id) {
        throw new Error("Invalid API key")
      }

      const result = await addBlinkAccount({
        label: label.trim() || "Blink Account",
        apiKey: apiKey.trim(),
        username: data.data.me.username,
        defaultCurrency: data.data.me.defaultAccount?.displayCurrency || "BTC",
      })

      if (!result.success) {
        throw new Error(result.error || "Failed to add account")
      }

      // Store on server for cross-device sync
      if (authMode === "nostr") {
        await storeBlinkAccountOnServer(
          apiKey.trim(),
          data.data.me.defaultAccount?.displayCurrency || "BTC",
          label || data.data.me.username,
        )
      }

      resetForm()
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleSetActive = (accountId: string): void => {
    try {
      setActiveBlinkAccount(accountId)
    } catch (err: unknown) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header with Add button */}
      {authMode === "nostr" && !showAddForm && (
        <button
          onClick={() => setShowAddForm(true)}
          className="w-full py-2 text-sm font-medium bg-blink-accent text-black rounded-md hover:bg-blink-accent/90 transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 4v16m8-8H4"
            />
          </svg>
          Add Wallet
        </button>
      )}

      {/* Add Wallet Form - Method Selection */}
      {showAddForm && !addMethod && (
        <div
          className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"} space-y-3`}
        >
          <h4 className={`font-medium ${darkMode ? "text-white" : "text-gray-900"}`}>
            Choose connection method:
          </h4>

          <button
            onClick={() => setAddMethod("ln-address")}
            className={`w-full p-3 rounded-lg border text-left transition-colors ${
              darkMode
                ? "border-gray-700 bg-gray-800 hover:bg-gray-700"
                : "border-gray-200 bg-white hover:bg-gray-50"
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="text-xl">⚡</span>
              <div>
                <div
                  className={`font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                >
                  Lightning Address
                </div>
                <div
                  className={`text-xs ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                >
                  Simple - just enter your username
                </div>
              </div>
            </div>
          </button>

          <button
            onClick={() => setAddMethod("api-key")}
            className={`w-full p-3 rounded-lg border text-left transition-colors ${
              darkMode
                ? "border-gray-700 bg-gray-800 hover:bg-gray-700"
                : "border-gray-200 bg-white hover:bg-gray-50"
            }`}
          >
            <div className="flex items-center gap-3">
              <svg
                className={`w-5 h-5 ${darkMode ? "text-gray-400" : "text-gray-500"}`}
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
              <div>
                <div
                  className={`font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                >
                  API Key
                </div>
                <div
                  className={`text-xs ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                >
                  Full features including transaction history
                </div>
              </div>
            </div>
          </button>

          <button
            onClick={() => setAddMethod("npub-cash")}
            className={`w-full p-3 rounded-lg border text-left transition-colors ${
              darkMode
                ? "border-gray-700 bg-gray-800 hover:bg-gray-700"
                : "border-gray-200 bg-white hover:bg-gray-50"
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="text-xl">🥜</span>
              <div>
                <div
                  className={`font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                >
                  npub.cash (Cashu)
                </div>
                <div
                  className={`text-xs ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                >
                  Receive payments as Cashu ecash - zero fees!
                </div>
              </div>
            </div>
          </button>

          <button
            onClick={resetForm}
            className={`w-full py-2 text-sm font-medium rounded-md transition-colors ${
              darkMode
                ? "bg-gray-800 text-gray-300 hover:bg-gray-700"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Add Lightning Address Form */}
      {showAddForm && addMethod === "ln-address" && (
        <div className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}>
          <form onSubmit={handleAddLnAddress} className="space-y-3">
            <div>
              <label
                className={`block text-sm mb-1 ${darkMode ? "text-gray-300" : "text-gray-700"}`}
              >
                Blink Username
              </label>
              <input
                type="text"
                value={lnAddress}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setLnAddress(e.target.value)
                  setWalletInfo(null)
                  setError(null)
                }}
                placeholder="username or username@blink.sv"
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                className={`w-full px-3 py-2 rounded-md border text-sm ${
                  darkMode
                    ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                    : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                } focus:outline-none focus:ring-2 focus:ring-blink-accent focus:border-transparent`}
              />
            </div>

            <div>
              <label
                className={`block text-sm mb-1 ${darkMode ? "text-gray-300" : "text-gray-700"}`}
              >
                Label (optional)
              </label>
              <input
                type="text"
                value={label}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setLabel(e.target.value)
                }
                placeholder="My Blink Wallet"
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                className={`w-full px-3 py-2 rounded-md border text-sm ${
                  darkMode
                    ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                    : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                } focus:outline-none focus:ring-2 focus:ring-blink-accent focus:border-transparent`}
              />
            </div>

            {/* Wallet Info */}
            {walletInfo && (
              <div
                className={`p-3 rounded-md ${darkMode ? "bg-green-900/20 border-green-500/30" : "bg-green-50 border-green-200"} border`}
              >
                <div className="flex items-center gap-2 mb-1">
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
                  <span
                    className={`text-sm font-medium ${darkMode ? "text-green-400" : "text-green-700"}`}
                  >
                    {walletInfo.lightningAddress}
                  </span>
                </div>
                <p className={`text-xs ${darkMode ? "text-gray-400" : "text-gray-500"}`}>
                  Note: Transaction history not available with this method
                </p>
              </div>
            )}

            {error && <p className="text-sm text-red-500">{error}</p>}

            {/* Validate button */}
            {!walletInfo && lnAddress.trim() && (
              <button
                type="button"
                onClick={handleValidateLnAddress}
                disabled={validating}
                className="w-full py-2 bg-blink-accent text-black text-sm font-medium rounded-md hover:bg-blink-accent/90 disabled:opacity-50 transition-colors"
              >
                {validating ? "Validating..." : "Validate"}
              </button>
            )}

            <div className="flex gap-2">
              {walletInfo && (
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 py-2 bg-blink-accent text-black text-sm font-medium rounded-md hover:bg-blink-accent/90 disabled:opacity-50 transition-colors"
                >
                  {loading ? "Adding..." : "Add Wallet"}
                </button>
              )}
              <button
                type="button"
                onClick={resetForm}
                className={`${walletInfo ? "flex-1" : "w-full"} py-2 text-sm font-medium rounded-md transition-colors ${
                  darkMode
                    ? "bg-gray-800 text-gray-300 hover:bg-gray-700"
                    : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                }`}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Add npub.cash Form */}
      {showAddForm && addMethod === "npub-cash" && (
        <div className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}>
          <form onSubmit={handleAddNpubCash} className="space-y-3">
            <div>
              <label
                className={`block text-sm mb-1 ${darkMode ? "text-gray-300" : "text-gray-700"}`}
              >
                npub.cash Lightning Address
              </label>
              <input
                type="text"
                value={npubCashAddress}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setNpubCashAddress(e.target.value)
                  setNpubCashInfo(null)
                  setError(null)
                }}
                placeholder="npub1...@npub.cash or username@npub.cash"
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                className={`w-full px-3 py-2 rounded-md border text-sm ${
                  darkMode
                    ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                    : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                } focus:outline-none focus:ring-2 focus:ring-blink-accent focus:border-transparent`}
              />
            </div>

            <div>
              <label
                className={`block text-sm mb-1 ${darkMode ? "text-gray-300" : "text-gray-700"}`}
              >
                Label (optional)
              </label>
              <input
                type="text"
                value={label}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setLabel(e.target.value)
                }
                placeholder="My npub.cash Wallet"
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                className={`w-full px-3 py-2 rounded-md border text-sm ${
                  darkMode
                    ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                    : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                } focus:outline-none focus:ring-2 focus:ring-blink-accent focus:border-transparent`}
              />
            </div>

            {/* npub.cash Info */}
            {npubCashInfo && (
              <div
                className={`p-3 rounded-md ${darkMode ? "bg-green-900/20 border-green-500/30" : "bg-green-50 border-green-200"} border`}
              >
                <div className="flex items-center gap-2 mb-1">
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
                  <span
                    className={`text-sm font-medium ${darkMode ? "text-green-400" : "text-green-700"}`}
                  >
                    {npubCashInfo.lightningAddress}
                  </span>
                </div>
                <p className={`text-xs ${darkMode ? "text-gray-400" : "text-gray-500"}`}>
                  Payments will be converted to Cashu ecash tokens
                </p>
              </div>
            )}

            {error && <p className="text-sm text-red-500">{error}</p>}

            {/* Validate button */}
            {!npubCashInfo && npubCashAddress.trim() && (
              <button
                type="button"
                onClick={handleValidateNpubCash}
                disabled={validating}
                className="w-full py-2 bg-blink-accent text-black text-sm font-medium rounded-md hover:bg-blink-accent/90 disabled:opacity-50 transition-colors"
              >
                {validating ? "Validating..." : "Validate"}
              </button>
            )}

            <div className="flex gap-2">
              {npubCashInfo && (
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 py-2 bg-blink-accent text-black text-sm font-medium rounded-md hover:bg-blink-accent/90 disabled:opacity-50 transition-colors"
                >
                  {loading ? "Adding..." : "Add Wallet"}
                </button>
              )}
              <button
                type="button"
                onClick={resetForm}
                className={`${npubCashInfo ? "flex-1" : "w-full"} py-2 text-sm font-medium rounded-md transition-colors ${
                  darkMode
                    ? "bg-gray-800 text-gray-300 hover:bg-gray-700"
                    : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                }`}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Add API Key Form */}
      {showAddForm && addMethod === "api-key" && (
        <div className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}>
          <form onSubmit={handleAddApiKey} className="space-y-3">
            <div>
              <label
                className={`block text-sm mb-1 ${darkMode ? "text-gray-300" : "text-gray-700"}`}
              >
                Label
              </label>
              <input
                type="text"
                value={label}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setLabel(e.target.value)
                }
                placeholder="My Account"
                className={`w-full px-3 py-2 rounded-md border text-sm ${
                  darkMode
                    ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                    : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                } focus:outline-none focus:ring-2 focus:ring-blink-accent focus:border-transparent`}
              />
            </div>
            <div>
              <label
                className={`block text-sm mb-1 ${darkMode ? "text-gray-300" : "text-gray-700"}`}
              >
                API Key
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setApiKey(e.target.value)
                }
                placeholder={isStaging() ? "galoy_staging_..." : "blink_..."}
                required
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                className={`w-full px-3 py-2 rounded-md border text-sm ${
                  darkMode
                    ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                    : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                } focus:outline-none focus:ring-2 focus:ring-blink-accent focus:border-transparent`}
              />
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2 bg-blink-accent text-black text-sm font-medium rounded-md hover:bg-blink-accent/90 disabled:opacity-50 transition-colors"
              >
                {loading ? "Validating..." : "Add"}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                  darkMode
                    ? "bg-gray-800 text-gray-300 hover:bg-gray-700"
                    : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                }`}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Accounts List */}
      <div className="space-y-2">
        {blinkAccounts && blinkAccounts.length > 0 ? (
          blinkAccounts.map((account: LocalBlinkAccount) => (
            <div
              key={account.id}
              className={`rounded-lg p-3 border transition-colors ${
                account.isActive
                  ? darkMode
                    ? "bg-blink-accent/10 border-blink-accent"
                    : "bg-blink-accent/5 border-blink-accent"
                  : darkMode
                    ? "bg-gray-900 border-gray-700"
                    : "bg-gray-50 border-gray-200"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${
                      account.isActive
                        ? "bg-blink-accent/20"
                        : darkMode
                          ? "bg-gray-800"
                          : "bg-gray-200"
                    }`}
                  >
                    {account.type === "ln-address" ? (
                      <span className="text-lg">⚡</span>
                    ) : (
                      <svg
                        className={`w-5 h-5 ${account.isActive ? "text-blink-accent" : darkMode ? "text-gray-400" : "text-gray-600"}`}
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
                    )}
                  </div>
                  <div className="min-w-0">
                    <h5
                      className={`font-medium truncate ${darkMode ? "text-white" : "text-gray-900"}`}
                    >
                      {account.label || "Blink Account"}
                    </h5>
                    <p
                      className={`text-sm truncate ${darkMode ? "text-gray-400" : "text-gray-600"}`}
                    >
                      {account.type === "ln-address"
                        ? account.lightningAddress
                        : `@${account.username || "Unknown"}`}
                    </p>
                    {account.type === "ln-address" && (
                      <p
                        className={`text-xs ${darkMode ? "text-gray-500" : "text-gray-400"}`}
                      >
                        Lightning Address
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex-shrink-0 ml-2">
                  {account.isActive ? (
                    <span className="px-2 py-1 text-xs font-medium bg-blink-accent/20 text-blink-accent rounded">
                      Active
                    </span>
                  ) : (
                    <button
                      onClick={() => handleSetActive(account.id)}
                      className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
                        darkMode
                          ? "bg-gray-800 text-gray-300 hover:bg-gray-700"
                          : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                      }`}
                    >
                      Use
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div
            className={`rounded-lg p-6 text-center ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}
          >
            <svg
              className={`w-10 h-10 mx-auto mb-2 ${darkMode ? "text-gray-600" : "text-gray-400"}`}
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
            <p className={`text-sm ${darkMode ? "text-gray-400" : "text-gray-600"}`}>
              No wallets connected
            </p>
          </div>
        )}

        {/* npub.cash Wallets */}
        {npubCashWallets && npubCashWallets.length > 0 && (
          <>
            <div
              className={`mt-4 pt-4 border-t ${darkMode ? "border-gray-700" : "border-gray-200"}`}
            >
              <h4
                className={`text-sm font-medium mb-2 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
              >
                npub.cash Wallets (Cashu)
              </h4>
            </div>
            {npubCashWallets.map((wallet: LocalBlinkAccount) => (
              <div
                key={wallet.id}
                className={`rounded-lg p-3 border transition-colors ${
                  wallet.isActive
                    ? darkMode
                      ? "bg-purple-900/20 border-purple-500"
                      : "bg-purple-50 border-purple-500"
                    : darkMode
                      ? "bg-gray-900 border-gray-700"
                      : "bg-gray-50 border-gray-200"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${
                        wallet.isActive
                          ? "bg-purple-500/20"
                          : darkMode
                            ? "bg-gray-800"
                            : "bg-gray-200"
                      }`}
                    >
                      <span className="text-lg">🥜</span>
                    </div>
                    <div className="min-w-0">
                      <h5
                        className={`font-medium truncate ${darkMode ? "text-white" : "text-gray-900"}`}
                      >
                        {wallet.label || "npub.cash Wallet"}
                      </h5>
                      <p
                        className={`text-sm truncate ${darkMode ? "text-gray-400" : "text-gray-600"}`}
                      >
                        {wallet.lightningAddress}
                      </p>
                      <p
                        className={`text-xs ${darkMode ? "text-gray-500" : "text-gray-400"}`}
                      >
                        Zero-fee Cashu ecash
                      </p>
                    </div>
                  </div>
                  <div className="flex-shrink-0 ml-2">
                    {wallet.isActive ? (
                      <span className="px-2 py-1 text-xs font-medium bg-purple-500/20 text-purple-400 rounded">
                        Active
                      </span>
                    ) : (
                      <span
                        className={`px-2 py-1 text-xs font-medium rounded ${
                          darkMode
                            ? "bg-gray-800 text-gray-400"
                            : "bg-gray-200 text-gray-500"
                        }`}
                      >
                        Connected
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Help links */}
      <div
        className={`text-xs space-y-1 ${darkMode ? "text-gray-500" : "text-gray-500"}`}
      >
        <p>
          <span className="font-medium">Blink:</span>{" "}
          <a
            href="https://dashboard.blink.sv"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blink-accent hover:underline"
          >
            dashboard.blink.sv
          </a>
        </p>
        <p>
          <span className="font-medium">NWC:</span> Alby, Coinos, Zeus, minibits.cash etc.
        </p>
        <p>
          <span className="font-medium">Cashu:</span>{" "}
          <a
            href="https://npub.cash"
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-500 hover:underline"
          >
            npub.cash
          </a>
        </p>
      </div>
    </div>
  )
}
