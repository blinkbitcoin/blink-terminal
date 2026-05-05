import { getApiUrl, getLnAddressDomain, isStaging } from "../../lib/config/api"
import type {
  AccountType,
  EditingWalletLabel,
  NwcValidation,
  LnAddressValidation,
  NpubCashValidation,
  ConfirmDeleteWallet,
} from "../../lib/hooks/useAccountManagement"
import type { AuthMode, StoreBlinkAccountResult } from "../../lib/hooks/useCombinedAuth"
import type { LocalNWCConnection, NWCOperationResult } from "../../lib/hooks/useNWC"
import type { LocalBlinkAccount } from "../../lib/hooks/useProfile"
import { isNpubCashAddress, probeNpubCashAddress } from "../../lib/lnurl"
import NWCClient from "../../lib/nwc/NWCClient"

interface WalletsOverlayProps {
  // State values
  showAddAccountForm: boolean
  newAccountType: AccountType
  darkMode: boolean
  authMode: AuthMode
  newAccountLabel: string
  newAccountApiKey: string
  newAccountLnAddress: string
  newAccountNwcUri: string
  newNpubCashAddress: string
  addAccountError: string | null
  addAccountLoading: boolean
  lnAddressValidated: LnAddressValidation | null
  lnAddressValidating: boolean
  nwcValidated: NwcValidation | null
  nwcValidating: boolean
  npubCashValidated: NpubCashValidation | null
  npubCashValidating: boolean
  blinkAccounts: LocalBlinkAccount[] | null
  nwcConnections: LocalNWCConnection[] | null
  npubCashWallets: LocalBlinkAccount[] | null
  activeNWC: LocalNWCConnection | null
  activeBlinkAccount: LocalBlinkAccount | null
  editingWalletLabel: EditingWalletLabel | null
  editedWalletLabel: string
  isBlinkClassic: boolean
  isBlinkClassicDark: boolean
  isBlinkClassicLight: boolean
  // State setters
  setShowAccountSettings: (v: boolean) => void
  setShowAddAccountForm: (v: boolean) => void
  setNewAccountApiKey: (v: string) => void
  setNewAccountLabel: (v: string) => void
  setNewAccountNwcUri: (v: string) => void
  setNewAccountLnAddress: (v: string) => void
  setNewAccountType: (v: AccountType) => void
  setAddAccountError: (v: string | null) => void
  setNwcValidated: (v: NwcValidation | null) => void
  setLnAddressValidated: (v: LnAddressValidation | null) => void
  setConfirmDeleteWallet: (v: ConfirmDeleteWallet | null) => void
  setAddAccountLoading: (v: boolean) => void
  setLnAddressValidating: (v: boolean) => void
  setNwcValidating: (v: boolean) => void
  setNpubCashValidated: (v: NpubCashValidation | null) => void
  setNpubCashValidating: (v: boolean) => void
  setNewNpubCashAddress: (v: string) => void
  setActiveBlinkAccount: (accountId: string | null) => void
  setActiveNWC: (
    connectionId: string | null,
    connectionsOverride?: LocalNWCConnection[],
  ) => Promise<NWCOperationResult>
  setEditingWalletLabel: (v: EditingWalletLabel | null) => void
  setEditedWalletLabel: (v: string) => void
  // Theme style functions
  getSubmenuBgClasses: () => string
  getSubmenuHeaderClasses: () => string
  getWalletCardActiveClasses: (accentColor?: "amber" | "purple" | "teal") => string
  getWalletCardClasses: () => string
  getWalletIconClasses: (isActive: boolean) => string
  getWalletActiveBadgeClasses: (accentColor?: "amber" | "purple" | "teal") => string
  getWalletUseButtonClasses: () => string
  getSecondaryTextClasses: () => string
  getInputClasses: () => string
  // Action functions
  addBlinkAccount: (data: {
    label: string
    apiKey: string
    username: string
    defaultCurrency: string
  }) => Promise<{ success: boolean; error?: string }>
  storeBlinkAccountOnServer: (
    apiKey: string,
    preferredCurrency?: string,
    label?: string | null,
  ) => Promise<StoreBlinkAccountResult>
  addBlinkLnAddressWallet: (data: {
    label: string
    username: string
    walletId: string
    walletCurrency: string
    lightningAddress: string
  }) => Promise<{ success: boolean; error?: string }>
  addNWCConnection: (
    uri: string,
    label: string,
  ) => Promise<{ success: boolean; error?: string }>
  addNpubCashWallet: (data: {
    label: string
    lightningAddress: string
  }) => Promise<{ success: boolean; error?: string }>
  removeBlinkAccount: (id: string) => void
  removeNWCConnection: (id: string) => void
  updateBlinkAccount: (
    id: string,
    data: { label: string },
  ) => Promise<{ success: boolean; error?: string } | void>
  updateNWCConnection: (id: string, data: { label: string }) => void
}

export default function WalletsOverlay({
  // State values
  showAddAccountForm,
  newAccountType,
  darkMode,
  authMode,
  newAccountLabel,
  newAccountApiKey,
  newAccountLnAddress,
  newAccountNwcUri,
  newNpubCashAddress,
  addAccountError,
  addAccountLoading,
  lnAddressValidated,
  lnAddressValidating,
  nwcValidated,
  nwcValidating,
  npubCashValidated,
  npubCashValidating,
  blinkAccounts,
  nwcConnections,
  npubCashWallets,
  activeNWC,
  activeBlinkAccount,
  editingWalletLabel,
  editedWalletLabel,
  isBlinkClassic,
  isBlinkClassicDark,
  isBlinkClassicLight,
  // State setters
  setShowAccountSettings,
  setShowAddAccountForm,
  setNewAccountApiKey,
  setNewAccountLabel,
  setNewAccountNwcUri,
  setNewAccountLnAddress,
  setNewAccountType,
  setAddAccountError,
  setNwcValidated,
  setLnAddressValidated,
  setConfirmDeleteWallet,
  setAddAccountLoading,
  setLnAddressValidating,
  setNwcValidating,
  setNpubCashValidated,
  setNpubCashValidating,
  setNewNpubCashAddress,
  setActiveBlinkAccount,
  setActiveNWC,
  setEditingWalletLabel,
  setEditedWalletLabel,
  // Theme style functions
  getSubmenuBgClasses,
  getSubmenuHeaderClasses,
  getWalletCardActiveClasses,
  getWalletCardClasses,
  getWalletIconClasses,
  getWalletActiveBadgeClasses,
  getWalletUseButtonClasses,
  getSecondaryTextClasses,
  getInputClasses,
  // Action functions
  addBlinkAccount,
  storeBlinkAccountOnServer,
  addBlinkLnAddressWallet,
  addNWCConnection,
  addNpubCashWallet,
  removeBlinkAccount,
  removeNWCConnection,
  updateBlinkAccount,
  updateNWCConnection,
}: WalletsOverlayProps) {
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
                  setShowAccountSettings(false)
                  setShowAddAccountForm(false)
                  setNewAccountApiKey("")
                  setNewAccountLabel("")
                  setNewAccountNwcUri("")
                  setNewAccountLnAddress("")
                  setNewAccountType(null)
                  setAddAccountError(null)
                  setNwcValidated(null)
                  setLnAddressValidated(null)
                  setConfirmDeleteWallet(null)
                }}
                className="flex items-center text-gray-700 dark:text-white hover:text-blink-accent dark:hover:text-blink-accent"
              >
                <span className="text-2xl mr-2">&#8249;</span>
                <span className="text-lg">Back</span>
              </button>
              <h1
                className={`text-xl font-bold ${isBlinkClassicDark ? "text-white" : isBlinkClassicLight ? "text-black" : "text-gray-900 dark:text-white"}`}
              >
                Wallets
              </h1>
              <div className="w-16"></div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-md mx-auto px-4 py-6">
          <div className="space-y-4">
            {/* Add Wallet Button */}
            {authMode === "nostr" && !showAddAccountForm && (
              <button
                onClick={() => setShowAddAccountForm(true)}
                className={`w-full py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  isBlinkClassic
                    ? "bg-transparent border border-blink-classic-amber text-blink-classic-amber hover:bg-blink-classic-amber hover:text-black rounded-xl"
                    : "bg-blink-accent text-black rounded-lg hover:bg-blink-accent/90"
                }`}
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
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                Add Wallet
              </button>
            )}

            {/* Add Wallet Form - Step 1: Label */}
            {showAddAccountForm && !newAccountType && (
              <div
                className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}
              >
                <h3
                  className={`text-sm font-medium mb-3 ${darkMode ? "text-white" : "text-gray-900"}`}
                >
                  Step 1: Name Your Wallet
                </h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                      Label
                    </label>
                    <input
                      type="text"
                      value={newAccountLabel}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setNewAccountLabel(e.target.value)
                      }
                      placeholder="My Wallet"
                      className={`w-full px-3 py-2 rounded-md border text-sm ${
                        darkMode
                          ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                          : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                      } focus:outline-none focus:ring-2 focus:ring-blink-accent focus:border-transparent`}
                    />
                  </div>

                  <h3
                    className={`text-sm font-medium pt-2 ${darkMode ? "text-white" : "text-gray-900"}`}
                  >
                    Step 2: Choose Wallet Type
                  </h3>

                  {/* Wallet Type Selection */}
                  <div className="space-y-2">
                    {/* Blink Lightning Address - Recommended, first option */}
                    <button
                      type="button"
                      onClick={() => setNewAccountType("blink-ln-address")}
                      className={`w-full p-3 rounded-lg border-2 text-left transition-all hover:scale-[1.01] ${
                        darkMode
                          ? "border-amber-500/40 bg-amber-900/20 hover:border-amber-500/60"
                          : "border-amber-300 bg-amber-50 hover:border-amber-400"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">⚡</span>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={`font-medium text-sm ${darkMode ? "text-white" : "text-gray-900"}`}
                            >
                              Blink Lightning Address
                            </span>
                            <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-amber-500 text-black">
                              Recommended
                            </span>
                          </div>
                          <p
                            className={`text-xs mt-0.5 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
                          >
                            Simple setup with username
                          </p>
                        </div>
                      </div>
                    </button>

                    <div className="grid grid-cols-2 gap-2">
                      {/* Blink API Key */}
                      <button
                        type="button"
                        onClick={() => setNewAccountType("blink")}
                        className={`p-3 rounded-lg border-2 text-center transition-all hover:scale-[1.02] ${
                          darkMode
                            ? "border-gray-600 bg-gray-800 hover:border-gray-500"
                            : "border-gray-200 bg-gray-50 hover:border-gray-300"
                        }`}
                      >
                        <svg
                          className={`w-6 h-6 mx-auto mb-1 ${darkMode ? "text-gray-400" : "text-gray-500"}`}
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
                        <span
                          className={`font-medium text-sm ${darkMode ? "text-white" : "text-gray-900"}`}
                        >
                          Blink API
                        </span>
                        <p
                          className={`text-xs mt-0.5 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
                        >
                          Full features
                        </p>
                      </button>

                      {/* NWC */}
                      <button
                        type="button"
                        onClick={() => setNewAccountType("nwc")}
                        className={`p-3 rounded-lg border-2 text-center transition-all hover:scale-[1.02] ${
                          darkMode
                            ? "border-purple-500/30 bg-purple-900/10 hover:border-purple-500/50"
                            : "border-purple-200 bg-purple-50 hover:border-purple-300"
                        }`}
                      >
                        <svg
                          className="w-6 h-6 mx-auto mb-1 text-purple-500"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M13 10V3L4 14h7v7l9-11h-7z"
                          />
                        </svg>
                        <span
                          className={`font-medium text-sm ${darkMode ? "text-white" : "text-gray-900"}`}
                        >
                          NWC
                        </span>
                        <p
                          className={`text-xs mt-0.5 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
                        >
                          Any wallet
                        </p>
                      </button>
                    </div>

                    {/* npub.cash - Full width below the 2-column grid */}
                    <button
                      type="button"
                      onClick={() => setNewAccountType("npub-cash")}
                      className={`w-full p-3 rounded-lg border-2 text-left transition-all hover:scale-[1.01] ${
                        darkMode
                          ? "border-teal-500/40 bg-teal-900/20 hover:border-teal-500/60"
                          : "border-teal-300 bg-teal-50 hover:border-teal-400"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">🥜</span>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={`font-medium text-sm ${darkMode ? "text-white" : "text-gray-900"}`}
                            >
                              npub.cash (Cashu)
                            </span>
                            <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-teal-500 text-white">
                              Zero Fees
                            </span>
                          </div>
                          <p
                            className={`text-xs mt-0.5 ${darkMode ? "text-gray-400" : "text-gray-600"}`}
                          >
                            Receive payments as Cashu ecash tokens
                          </p>
                        </div>
                      </div>
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setShowAddAccountForm(false)
                      setNewAccountLabel("")
                      setAddAccountError(null)
                    }}
                    className={`w-full py-2 text-sm font-medium rounded-md transition-colors ${
                      darkMode
                        ? "bg-gray-800 text-gray-300 hover:bg-gray-700"
                        : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                    }`}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Add Wallet Form - Step 2: Blink API Key */}
            {showAddAccountForm && newAccountType === "blink" && (
              <div
                className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}
              >
                <div className="flex items-center gap-2 mb-3">
                  <button
                    onClick={() => {
                      setNewAccountType(null)
                      setAddAccountError(null)
                    }}
                    className={`p-1 rounded ${darkMode ? "hover:bg-gray-800" : "hover:bg-gray-200"}`}
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
                        d="M15 19l-7-7 7-7"
                      />
                    </svg>
                  </button>
                  <h3
                    className={`text-sm font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                  >
                    Add Blink Wallet
                  </h3>
                </div>
                <form
                  onSubmit={async (e: React.FormEvent<HTMLFormElement>) => {
                    e.preventDefault()
                    if (!newAccountApiKey.trim()) {
                      setAddAccountError("Enter an API key")
                      return
                    }
                    setAddAccountLoading(true)
                    setAddAccountError(null)
                    try {
                      const response = await fetch(getApiUrl(), {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          "X-API-KEY": newAccountApiKey.trim(),
                        },
                        body: JSON.stringify({
                          query:
                            "query { me { id username defaultAccount { displayCurrency } } }",
                        }),
                      })
                      if (!response.ok) throw new Error("Invalid API key")
                      const data = await response.json()
                      if (data.errors || !data.data?.me?.id)
                        throw new Error("Invalid API key")
                      const result = await addBlinkAccount({
                        label: newAccountLabel.trim() || "Blink Wallet",
                        apiKey: newAccountApiKey.trim(),
                        username: data.data.me.username,
                        defaultCurrency:
                          data.data.me.defaultAccount?.displayCurrency || "BTC",
                      })
                      if (!result.success)
                        throw new Error(result.error || "Failed to add wallet")
                      if (authMode === "nostr") {
                        await storeBlinkAccountOnServer(
                          newAccountApiKey.trim(),
                          data.data.me.defaultAccount?.displayCurrency || "BTC",
                          newAccountLabel || data.data.me.username,
                        )
                      }
                      // Reset form
                      setNewAccountApiKey("")
                      setNewAccountLabel("")
                      setNewAccountType(null)
                      setShowAddAccountForm(false)
                    } catch (err: unknown) {
                      setAddAccountError((err as Error).message)
                    } finally {
                      setAddAccountLoading(false)
                    }
                  }}
                  className="space-y-3"
                >
                  <div
                    className={`p-2 rounded text-xs ${darkMode ? "bg-gray-800 text-gray-400" : "bg-gray-100 text-gray-600"}`}
                  >
                    Label:{" "}
                    <span className="font-medium">
                      {newAccountLabel || "Blink Wallet"}
                    </span>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                      Blink API Key
                    </label>
                    <input
                      type="password"
                      value={newAccountApiKey}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setNewAccountApiKey(e.target.value)
                      }
                      placeholder={isStaging() ? "galoy_staging_..." : "blink_..."}
                      required
                      autoFocus
                      autoComplete="off"
                      data-1p-ignore="true"
                      data-lpignore="true"
                      className={`w-full px-3 py-2 rounded-md border text-sm ${
                        darkMode
                          ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                          : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                      } focus:outline-none focus:ring-2 focus:ring-blink-accent focus:border-transparent`}
                    />
                    <p
                      className={`text-xs mt-1 ${darkMode ? "text-gray-500" : "text-gray-500"}`}
                    >
                      Get from{" "}
                      <a
                        href="https://dashboard.blink.sv"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blink-accent hover:underline"
                      >
                        dashboard.blink.sv
                      </a>
                    </p>
                  </div>
                  {addAccountError && (
                    <p className="text-sm text-red-500">{addAccountError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={addAccountLoading}
                      className="flex-1 py-2 bg-blink-accent text-black text-sm font-medium rounded-md hover:bg-blink-accent/90 disabled:opacity-50 transition-colors"
                    >
                      {addAccountLoading ? "Validating..." : "Add Wallet"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddAccountForm(false)
                        setNewAccountApiKey("")
                        setNewAccountLabel("")
                        setNewAccountType(null)
                        setAddAccountError(null)
                      }}
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

            {/* Add Wallet Form - Step 2: Blink Lightning Address */}
            {showAddAccountForm && newAccountType === "blink-ln-address" && (
              <div
                className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}
              >
                <div className="flex items-center gap-2 mb-3">
                  <button
                    onClick={() => {
                      setNewAccountType(null)
                      setAddAccountError(null)
                      setLnAddressValidated(null)
                      setNewAccountLnAddress("")
                    }}
                    className={`p-1 rounded ${darkMode ? "hover:bg-gray-800" : "hover:bg-gray-200"}`}
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
                        d="M15 19l-7-7 7-7"
                      />
                    </svg>
                  </button>
                  <h3
                    className={`text-sm font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                  >
                    Add Blink Lightning Address
                  </h3>
                </div>
                <form
                  onSubmit={async (e: React.FormEvent<HTMLFormElement>) => {
                    e.preventDefault()
                    if (!lnAddressValidated) {
                      // Validate first
                      if (!newAccountLnAddress.trim()) {
                        setAddAccountError("Enter a username or lightning address")
                        return
                      }
                      setLnAddressValidating(true)
                      setAddAccountError(null)
                      try {
                        const response = await fetch("/api/blink/validate-ln-address", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ lnAddress: newAccountLnAddress.trim() }),
                        })
                        const data = await response.json()
                        if (!response.ok) {
                          setAddAccountError(data.error || "Failed to validate")
                          setLnAddressValidating(false)
                          return
                        }
                        setLnAddressValidated(data)
                      } catch (err: unknown) {
                        setAddAccountError((err as Error).message || "Validation failed")
                      } finally {
                        setLnAddressValidating(false)
                      }
                      return
                    }
                    // Add the wallet
                    setAddAccountLoading(true)
                    setAddAccountError(null)
                    try {
                      const result = await addBlinkLnAddressWallet({
                        label:
                          newAccountLabel.trim() ||
                          `${lnAddressValidated.username}@${getLnAddressDomain()}`,
                        username: lnAddressValidated.username,
                        walletId: lnAddressValidated.walletId,
                        walletCurrency: lnAddressValidated.walletCurrency,
                        lightningAddress: lnAddressValidated.lightningAddress,
                      })
                      if (!result.success)
                        throw new Error(result.error || "Failed to add wallet")
                      // Reset form
                      setNewAccountLnAddress("")
                      setNewAccountLabel("")
                      setNewAccountType(null)
                      setShowAddAccountForm(false)
                      setLnAddressValidated(null)
                    } catch (err: unknown) {
                      setAddAccountError((err as Error).message)
                    } finally {
                      setAddAccountLoading(false)
                    }
                  }}
                  className="space-y-3"
                >
                  <div
                    className={`p-2 rounded text-xs ${darkMode ? "bg-gray-800 text-gray-400" : "bg-gray-100 text-gray-600"}`}
                  >
                    Label:{" "}
                    <span className="font-medium">
                      {newAccountLabel || "Blink Wallet"}
                    </span>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                      Blink Username
                    </label>
                    <input
                      type="text"
                      value={newAccountLnAddress}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setNewAccountLnAddress(e.target.value)
                        setLnAddressValidated(null)
                        setAddAccountError(null)
                      }}
                      placeholder="username or username@blink.sv"
                      required
                      autoFocus
                      autoComplete="off"
                      data-1p-ignore="true"
                      data-lpignore="true"
                      className={`w-full px-3 py-2 rounded-md border text-sm ${
                        darkMode
                          ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                          : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                      } focus:outline-none focus:ring-2 focus:ring-blink-accent focus:border-transparent`}
                    />
                    <p
                      className={`text-xs mt-1 ${darkMode ? "text-gray-500" : "text-gray-500"}`}
                    >
                      Your Blink wallet username
                    </p>
                  </div>

                  {/* Validated Info */}
                  {lnAddressValidated && (
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
                          {lnAddressValidated.lightningAddress}
                        </span>
                      </div>
                      <p
                        className={`text-xs ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                      >
                        Note: Transaction history not available with this method
                      </p>
                    </div>
                  )}

                  {addAccountError && (
                    <p className="text-sm text-red-500">{addAccountError}</p>
                  )}

                  {/* Validate button */}
                  {!lnAddressValidated && newAccountLnAddress.trim() && (
                    <button
                      type="submit"
                      disabled={lnAddressValidating}
                      className="w-full py-2 bg-blink-accent text-black text-sm font-medium rounded-md hover:bg-blink-accent/90 disabled:opacity-50 transition-colors"
                    >
                      {lnAddressValidating ? "Validating..." : "Validate"}
                    </button>
                  )}

                  <div className="flex gap-2">
                    {lnAddressValidated && (
                      <button
                        type="submit"
                        disabled={addAccountLoading}
                        className="flex-1 py-2 bg-blink-accent text-black text-sm font-medium rounded-md hover:bg-blink-accent/90 disabled:opacity-50 transition-colors"
                      >
                        {addAccountLoading ? "Adding..." : "Add Wallet"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddAccountForm(false)
                        setNewAccountLnAddress("")
                        setNewAccountLabel("")
                        setNewAccountType(null)
                        setAddAccountError(null)
                        setLnAddressValidated(null)
                      }}
                      className={`${lnAddressValidated ? "flex-1" : "w-full"} py-2 text-sm font-medium rounded-md transition-colors ${
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

            {/* Add Wallet Form - Step 2: NWC Connection */}
            {showAddAccountForm && newAccountType === "nwc" && (
              <div
                className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}
              >
                <div className="flex items-center gap-2 mb-3">
                  <button
                    onClick={() => {
                      setNewAccountType(null)
                      setAddAccountError(null)
                      setNwcValidated(null)
                      setNewAccountNwcUri("")
                    }}
                    className={`p-1 rounded ${darkMode ? "hover:bg-gray-800" : "hover:bg-gray-200"}`}
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
                        d="M15 19l-7-7 7-7"
                      />
                    </svg>
                  </button>
                  <h3
                    className={`text-sm font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                  >
                    Add NWC Wallet
                  </h3>
                </div>
                <form
                  onSubmit={async (e: React.FormEvent<HTMLFormElement>) => {
                    e.preventDefault()
                    if (!nwcValidated) {
                      // Validate first
                      if (!newAccountNwcUri.trim()) {
                        setAddAccountError("Enter a connection string")
                        return
                      }
                      setNwcValidating(true)
                      setAddAccountError(null)
                      try {
                        const validation = await NWCClient.validate(
                          newAccountNwcUri.trim(),
                        )
                        if (!validation.valid) {
                          setAddAccountError(
                            validation.error || "Invalid connection string",
                          )
                          setNwcValidating(false)
                          return
                        }
                        const tempClient = new NWCClient(newAccountNwcUri.trim())
                        setNwcValidated({
                          walletPubkey: tempClient.getWalletPubkey(),
                          relays: tempClient.getRelays(),
                          capabilities: validation.info?.methods || [],
                        })
                        tempClient.close()
                      } catch (err: unknown) {
                        setAddAccountError(
                          (err as Error).message || "Invalid connection string",
                        )
                      } finally {
                        setNwcValidating(false)
                      }
                      return
                    }
                    // Add the wallet
                    setAddAccountLoading(true)
                    setAddAccountError(null)
                    try {
                      const result = await addNWCConnection(
                        newAccountNwcUri.trim(),
                        newAccountLabel.trim() || "NWC Wallet",
                      )
                      if (!result.success)
                        throw new Error(result.error || "Failed to add wallet")
                      // Reset form
                      setNewAccountNwcUri("")
                      setNewAccountLabel("")
                      setNewAccountType(null)
                      setNwcValidated(null)
                      setShowAddAccountForm(false)
                    } catch (err: unknown) {
                      setAddAccountError((err as Error).message)
                    } finally {
                      setAddAccountLoading(false)
                    }
                  }}
                  className="space-y-3"
                >
                  <div
                    className={`p-2 rounded text-xs ${darkMode ? "bg-gray-800 text-gray-400" : "bg-gray-100 text-gray-600"}`}
                  >
                    Label:{" "}
                    <span className="font-medium">{newAccountLabel || "NWC Wallet"}</span>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                      NWC Connection String
                    </label>
                    <textarea
                      value={newAccountNwcUri}
                      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                        setNewAccountNwcUri(e.target.value)
                        setNwcValidated(null)
                      }}
                      placeholder="nostr+walletconnect://..."
                      rows={3}
                      autoFocus
                      autoComplete="off"
                      data-1p-ignore="true"
                      data-lpignore="true"
                      className={`w-full px-3 py-2 rounded-md border text-sm font-mono resize-none ${
                        darkMode
                          ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                          : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                      } focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent`}
                    />
                    <p
                      className={`text-xs mt-1 ${darkMode ? "text-gray-500" : "text-gray-500"}`}
                    >
                      Get from your wallet app (Alby, Coinos, Zeus, minibits.cash, etc.)
                    </p>
                  </div>

                  {/* NWC Validation Result */}
                  {nwcValidated && (
                    <div
                      className={`p-3 rounded-lg ${darkMode ? "bg-green-900/20 border border-green-500/30" : "bg-green-50 border border-green-200"}`}
                    >
                      <div className="flex items-center gap-2 mb-2">
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
                          Valid Connection
                        </span>
                      </div>
                      <p
                        className={`text-xs ${darkMode ? "text-gray-400" : "text-gray-600"}`}
                      >
                        Wallet: {nwcValidated.walletPubkey.slice(0, 8)}...
                        {nwcValidated.walletPubkey.slice(-8)}
                      </p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {nwcValidated.capabilities.slice(0, 4).map((cap, i) => (
                          <span
                            key={i}
                            className={`px-2 py-0.5 rounded text-xs ${darkMode ? "bg-gray-700 text-gray-400" : "bg-gray-200 text-gray-600"}`}
                          >
                            {cap}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {addAccountError && (
                    <p className="text-sm text-red-500">{addAccountError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={addAccountLoading || nwcValidating}
                      className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors disabled:opacity-50 ${
                        nwcValidated
                          ? "bg-purple-600 text-white hover:bg-purple-700"
                          : "bg-purple-600 text-white hover:bg-purple-700"
                      }`}
                    >
                      {nwcValidating
                        ? "Validating..."
                        : addAccountLoading
                          ? "Adding..."
                          : nwcValidated
                            ? "Add Wallet"
                            : "Validate"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddAccountForm(false)
                        setNewAccountNwcUri("")
                        setNewAccountLabel("")
                        setNewAccountType(null)
                        setNwcValidated(null)
                        setAddAccountError(null)
                      }}
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

            {/* Add Wallet Form - Step 2: npub.cash */}
            {showAddAccountForm && newAccountType === "npub-cash" && (
              <div
                className={`rounded-lg p-4 ${darkMode ? "bg-gray-900" : "bg-gray-50"}`}
              >
                <div className="flex items-center gap-2 mb-3">
                  <button
                    onClick={() => {
                      setNewAccountType(null)
                      setAddAccountError(null)
                      setNpubCashValidated(null)
                      setNewNpubCashAddress("")
                    }}
                    className={`p-1 rounded ${darkMode ? "hover:bg-gray-800" : "hover:bg-gray-200"}`}
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
                        d="M15 19l-7-7 7-7"
                      />
                    </svg>
                  </button>
                  <h3
                    className={`text-sm font-medium ${darkMode ? "text-white" : "text-gray-900"}`}
                  >
                    Add npub.cash Wallet
                  </h3>
                </div>
                <form
                  onSubmit={async (e: React.FormEvent<HTMLFormElement>) => {
                    e.preventDefault()
                    if (!npubCashValidated) {
                      // Validate first
                      if (!newNpubCashAddress.trim()) {
                        setAddAccountError("Enter an npub.cash address")
                        return
                      }
                      if (!isNpubCashAddress(newNpubCashAddress.trim())) {
                        setAddAccountError(
                          "Invalid npub.cash address format. Must be npub1...@npub.cash or username@npub.cash",
                        )
                        return
                      }
                      setNpubCashValidating(true)
                      setAddAccountError(null)
                      try {
                        const probeResult = await probeNpubCashAddress(
                          newNpubCashAddress.trim(),
                        )
                        if (probeResult.valid) {
                          setNpubCashValidated({
                            lightningAddress: newNpubCashAddress.trim(),
                            minSendable: probeResult.minSats ?? 0,
                            maxSendable: probeResult.maxSats ?? 0,
                          })
                        } else {
                          setAddAccountError(
                            probeResult.error || "Could not validate npub.cash address",
                          )
                        }
                      } catch (err: unknown) {
                        setAddAccountError((err as Error).message || "Validation failed")
                      } finally {
                        setNpubCashValidating(false)
                      }
                      return
                    }
                    // Add the wallet
                    setAddAccountLoading(true)
                    setAddAccountError(null)
                    try {
                      const result = await addNpubCashWallet({
                        label:
                          newAccountLabel.trim() || npubCashValidated.lightningAddress,
                        lightningAddress: npubCashValidated.lightningAddress,
                      })
                      if (!result.success)
                        throw new Error(result.error || "Failed to add wallet")
                      // Reset form
                      setNewNpubCashAddress("")
                      setNewAccountLabel("")
                      setNewAccountType(null)
                      setShowAddAccountForm(false)
                      setNpubCashValidated(null)
                    } catch (err: unknown) {
                      setAddAccountError((err as Error).message)
                    } finally {
                      setAddAccountLoading(false)
                    }
                  }}
                  className="space-y-3"
                >
                  <div
                    className={`p-2 rounded text-xs ${darkMode ? "bg-gray-800 text-gray-400" : "bg-gray-100 text-gray-600"}`}
                  >
                    Label:{" "}
                    <span className="font-medium">
                      {newAccountLabel || "npub.cash Wallet"}
                    </span>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                      npub.cash Lightning Address
                    </label>
                    <input
                      type="text"
                      value={newNpubCashAddress}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setNewNpubCashAddress(e.target.value)
                        setNpubCashValidated(null)
                      }}
                      placeholder="npub1...@npub.cash or username@npub.cash"
                      autoFocus
                      autoComplete="off"
                      data-1p-ignore="true"
                      data-lpignore="true"
                      className={`w-full px-3 py-2 rounded-md border text-sm ${
                        npubCashValidated
                          ? "border-green-500"
                          : darkMode
                            ? "bg-gray-800 border-gray-600 text-white placeholder-gray-500"
                            : "bg-white border-gray-300 text-gray-900 placeholder-gray-400"
                      } focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent`}
                    />
                    <p
                      className={`text-xs mt-1 ${darkMode ? "text-gray-500" : "text-gray-500"}`}
                    >
                      Your full npub.cash Lightning Address
                    </p>
                  </div>

                  {/* Validation result */}
                  {npubCashValidated && (
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
                          {npubCashValidated.lightningAddress}
                        </span>
                      </div>
                      <p
                        className={`text-xs ${darkMode ? "text-gray-400" : "text-gray-500"}`}
                      >
                        Min: {npubCashValidated.minSendable} sats • Max:{" "}
                        {npubCashValidated.maxSendable?.toLocaleString()} sats
                      </p>
                      <p
                        className={`text-xs mt-1 ${darkMode ? "text-teal-400" : "text-teal-600"}`}
                      >
                        Payments will be converted to Cashu ecash tokens
                      </p>
                    </div>
                  )}

                  {addAccountError && (
                    <p className="text-sm text-red-500">{addAccountError}</p>
                  )}

                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={npubCashValidating || addAccountLoading}
                      className="flex-1 py-2 bg-teal-500 text-white text-sm font-medium rounded-md hover:bg-teal-600 disabled:opacity-50 transition-colors"
                    >
                      {npubCashValidating
                        ? "Validating..."
                        : addAccountLoading
                          ? "Adding..."
                          : npubCashValidated
                            ? "Add Wallet"
                            : "Validate"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddAccountForm(false)
                        setNewNpubCashAddress("")
                        setNewAccountLabel("")
                        setNewAccountType(null)
                        setNpubCashValidated(null)
                        setAddAccountError(null)
                      }}
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

            {/* Wallets List */}
            <div className="space-y-2">
              {/* Blink Accounts (exclude npub.cash which is shown separately) */}
              {blinkAccounts &&
                blinkAccounts
                  .filter((a: LocalBlinkAccount) => a.type !== "npub-cash")
                  .map((account: LocalBlinkAccount) => (
                    <div
                      key={`blink-${account.id}`}
                      className={`p-4 transition-colors ${
                        account.isActive && !activeNWC
                          ? getWalletCardActiveClasses("amber")
                          : getWalletCardClasses()
                      }`}
                    >
                      {/* Wallet Info Section */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${getWalletIconClasses(
                              account.isActive && !activeNWC,
                            )}`}
                          >
                            <span className="text-lg">⚡</span>
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <h5
                                className={`font-medium truncate ${isBlinkClassicDark ? "text-white" : isBlinkClassicLight ? "text-black" : darkMode ? "text-white" : "text-gray-900"}`}
                              >
                                {account.label || "Blink Wallet"}
                              </h5>
                              <span
                                className={`px-1.5 py-0.5 text-xs rounded ${isBlinkClassic ? "bg-blink-classic-amber/20 text-blink-classic-amber" : darkMode ? "bg-amber-900/30 text-amber-400" : "bg-amber-100 text-amber-700"}`}
                              >
                                {account.type === "ln-address"
                                  ? "Blink Lightning Address"
                                  : "Blink API Key"}
                              </span>
                            </div>
                            <p
                              className={`text-sm truncate ${isBlinkClassic ? "text-gray-400" : darkMode ? "text-gray-400" : "text-gray-600"}`}
                            >
                              @{account.username || "Unknown"}
                            </p>
                          </div>
                        </div>
                        <div className="flex-shrink-0 ml-2 flex items-center gap-2">
                          {account.isActive && !activeNWC ? (
                            <span
                              className={`px-3 py-1 text-xs font-medium rounded ${getWalletActiveBadgeClasses("amber")}`}
                            >
                              Active
                            </span>
                          ) : (
                            <button
                              onClick={async () => {
                                // Deactivate any active NWC first
                                if (activeNWC) {
                                  await setActiveNWC(null)
                                }
                                setActiveBlinkAccount(account.id)
                              }}
                              className={`px-3 py-1 text-xs font-medium rounded transition-colors ${getWalletUseButtonClasses()}`}
                            >
                              Use
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Edit/Delete Actions */}
                      <div
                        className={`flex gap-2 mt-3 pt-3 border-t ${isBlinkClassic ? (isBlinkClassicDark ? "border-blink-classic-border" : "border-blink-classic-border-light") : "border-gray-200 dark:border-gray-700"}`}
                      >
                        <button
                          onClick={() => {
                            setEditingWalletLabel({ type: "blink", id: account.id })
                            setEditedWalletLabel(account.label || "")
                          }}
                          className={`flex-1 py-2 text-sm rounded-lg transition-colors ${
                            isBlinkClassic
                              ? `${getSecondaryTextClasses()} hover:text-blink-classic-amber border ${isBlinkClassicDark ? "border-blink-classic-border" : "border-blink-classic-border-light"}`
                              : "text-gray-600 dark:text-gray-400 hover:text-blink-accent border border-gray-300 dark:border-gray-600"
                          }`}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => {
                            if (confirm("Delete this wallet?")) {
                              removeBlinkAccount(account.id)
                            }
                          }}
                          className={`flex-1 py-2 text-sm rounded-lg text-red-500 hover:text-red-700 border transition-colors ${
                            isBlinkClassic
                              ? isBlinkClassicDark
                                ? "border-blink-classic-border"
                                : "border-blink-classic-border-light"
                              : "border-gray-300 dark:border-gray-600"
                          }`}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}

              {/* Edit Blink Account Label Modal */}
              {editingWalletLabel?.type === "blink" && (
                <div
                  className={`p-4 rounded-lg ${isBlinkClassic ? (isBlinkClassicDark ? "bg-blink-classic-bg border border-blink-classic-amber" : "bg-blink-classic-hover-light border border-blink-classic-amber") : darkMode ? "bg-amber-900/30 border border-amber-500" : "bg-amber-100 border border-amber-500"}`}
                >
                  <h4
                    className={`text-sm font-medium mb-3 ${isBlinkClassicDark ? "text-white" : isBlinkClassicLight ? "text-black" : darkMode ? "text-white" : "text-gray-900"}`}
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
                    className={`w-full px-3 py-2 rounded-lg border ${getInputClasses()} focus:outline-none focus:ring-2 ${isBlinkClassic ? "focus:ring-blink-classic-amber" : "focus:ring-amber-500"}`}
                  />
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={async () => {
                        // Update the label using updateBlinkAccount
                        await updateBlinkAccount(editingWalletLabel.id!, {
                          label: editedWalletLabel.trim() || "Blink Wallet",
                        })
                        // Close the edit form
                        setEditingWalletLabel(null)
                        setEditedWalletLabel("")
                      }}
                      className={`flex-1 py-2 text-sm rounded-lg transition-colors ${isBlinkClassic ? "bg-blink-classic-amber text-black hover:bg-blink-classic-amber/80" : "bg-amber-600 text-white hover:bg-amber-700"}`}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditingWalletLabel(null)
                        setEditedWalletLabel("")
                      }}
                      className={`flex-1 py-2 text-sm rounded-lg transition-colors ${
                        isBlinkClassic
                          ? "bg-blink-classic-bg text-gray-300 hover:text-white border border-blink-classic-border"
                          : darkMode
                            ? "bg-gray-700 text-gray-300 hover:bg-gray-600"
                            : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                      }`}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* npub.cash Wallets */}
              {npubCashWallets &&
                npubCashWallets.map((wallet: LocalBlinkAccount) => (
                  <div
                    key={`npubcash-${wallet.id}`}
                    className={`p-4 transition-colors ${
                      wallet.isActive && !activeNWC
                        ? getWalletCardActiveClasses("teal")
                        : getWalletCardClasses()
                    }`}
                  >
                    {/* Wallet Info Section */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${getWalletIconClasses(
                            wallet.isActive && !activeNWC,
                          )}`}
                        >
                          <span className="text-lg">🥜</span>
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h5
                              className={`font-medium truncate ${isBlinkClassicDark ? "text-white" : isBlinkClassicLight ? "text-black" : darkMode ? "text-white" : "text-gray-900"}`}
                            >
                              {wallet.label || "npub.cash Wallet"}
                            </h5>
                            <span
                              className={`px-1.5 py-0.5 text-xs rounded ${isBlinkClassic ? "bg-blink-classic-amber/20 text-blink-classic-amber" : darkMode ? "bg-teal-900/30 text-teal-400" : "bg-teal-100 text-teal-700"}`}
                            >
                              Cashu
                            </span>
                          </div>
                          <p
                            className={`text-sm truncate ${isBlinkClassic ? "text-gray-400" : darkMode ? "text-gray-400" : "text-gray-600"}`}
                          >
                            {wallet.lightningAddress}
                          </p>
                        </div>
                      </div>
                      <div className="flex-shrink-0 ml-2 flex items-center gap-2">
                        {wallet.isActive && !activeNWC ? (
                          <span
                            className={`px-3 py-1 text-xs font-medium rounded ${getWalletActiveBadgeClasses("teal")}`}
                          >
                            Active
                          </span>
                        ) : (
                          <button
                            onClick={async () => {
                              // Deactivate NWC if active
                              if (activeNWC) {
                                await setActiveNWC(null)
                              }
                              // Deactivate any other Blink account
                              if (activeBlinkAccount) {
                                await setActiveBlinkAccount(null)
                              }
                              // Activate this npub.cash wallet
                              await setActiveBlinkAccount(wallet.id)
                            }}
                            className={`px-3 py-1 text-xs font-medium rounded transition-colors ${getWalletUseButtonClasses()}`}
                          >
                            Use
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Edit/Delete Actions */}
                    <div
                      className={`flex gap-2 mt-3 pt-3 border-t ${isBlinkClassic ? (isBlinkClassicDark ? "border-blink-classic-border" : "border-blink-classic-border-light") : "border-gray-200 dark:border-gray-700"}`}
                    >
                      <button
                        onClick={() => {
                          setEditingWalletLabel({ type: "npub-cash", id: wallet.id })
                          setEditedWalletLabel(wallet.label || "")
                        }}
                        className={`flex-1 py-2 text-sm rounded-lg transition-colors ${
                          isBlinkClassic
                            ? `${getSecondaryTextClasses()} hover:text-blink-classic-amber border ${isBlinkClassicDark ? "border-blink-classic-border" : "border-blink-classic-border-light"}`
                            : "text-gray-600 dark:text-gray-400 hover:text-teal-500 border border-gray-300 dark:border-gray-600"
                        }`}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          if (confirm("Delete this wallet?")) {
                            removeBlinkAccount(wallet.id)
                          }
                        }}
                        className={`flex-1 py-2 text-sm rounded-lg text-red-500 hover:text-red-700 border transition-colors ${
                          isBlinkClassic
                            ? isBlinkClassicDark
                              ? "border-blink-classic-border"
                              : "border-blink-classic-border-light"
                            : "border-gray-300 dark:border-gray-600"
                        }`}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}

              {/* Edit npub.cash Wallet Label Modal */}
              {editingWalletLabel?.type === "npub-cash" && (
                <div
                  className={`p-4 rounded-lg ${isBlinkClassic ? (isBlinkClassicDark ? "bg-blink-classic-bg border border-blink-classic-amber" : "bg-blink-classic-hover-light border border-blink-classic-amber") : darkMode ? "bg-teal-900/30 border border-teal-500" : "bg-teal-100 border border-teal-500"}`}
                >
                  <h4
                    className={`text-sm font-medium mb-3 ${isBlinkClassicDark ? "text-white" : isBlinkClassicLight ? "text-black" : darkMode ? "text-white" : "text-gray-900"}`}
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
                    className={`w-full px-3 py-2 rounded-lg border ${getInputClasses()} focus:outline-none focus:ring-2 ${isBlinkClassic ? "focus:ring-blink-classic-amber" : "focus:ring-teal-500"}`}
                  />
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={async () => {
                        // Update the label using updateBlinkAccount (npub.cash wallets are stored as Blink accounts)
                        await updateBlinkAccount(editingWalletLabel.id!, {
                          label: editedWalletLabel.trim() || "npub.cash Wallet",
                        })
                        // Close the edit form
                        setEditingWalletLabel(null)
                        setEditedWalletLabel("")
                      }}
                      className={`flex-1 py-2 text-sm rounded-lg transition-colors ${isBlinkClassic ? "bg-blink-classic-amber text-black hover:bg-blink-classic-amber/80" : "bg-teal-600 text-white hover:bg-teal-700"}`}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditingWalletLabel(null)
                        setEditedWalletLabel("")
                      }}
                      className={`flex-1 py-2 text-sm rounded-lg transition-colors ${
                        isBlinkClassic
                          ? "bg-blink-classic-bg text-gray-300 hover:text-white border border-blink-classic-border"
                          : darkMode
                            ? "bg-gray-700 text-gray-300 hover:bg-gray-600"
                            : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                      }`}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* NWC Connections */}
              {nwcConnections &&
                nwcConnections.map((conn: LocalNWCConnection) => (
                  <div
                    key={`nwc-${conn.id}`}
                    className={`p-4 transition-colors ${
                      activeNWC?.id === conn.id
                        ? getWalletCardActiveClasses("purple")
                        : getWalletCardClasses()
                    }`}
                  >
                    {/* Wallet Info Section */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${getWalletIconClasses(
                            activeNWC?.id === conn.id,
                          )}`}
                        >
                          <svg
                            className={`w-5 h-5 ${activeNWC?.id === conn.id ? (isBlinkClassic ? "text-blink-classic-amber" : "text-purple-400") : isBlinkClassic ? "text-gray-400" : darkMode ? "text-gray-400" : "text-gray-600"}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="2"
                              d="M13 10V3L4 14h7v7l9-11h-7z"
                            />
                          </svg>
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h5
                              className={`font-medium truncate ${isBlinkClassicDark ? "text-white" : isBlinkClassicLight ? "text-black" : darkMode ? "text-white" : "text-gray-900"}`}
                            >
                              {conn.label || "NWC Wallet"}
                            </h5>
                            <span
                              className={`px-1.5 py-0.5 text-xs rounded ${isBlinkClassic ? "bg-blink-classic-amber/20 text-blink-classic-amber" : darkMode ? "bg-purple-900/30 text-purple-400" : "bg-purple-100 text-purple-700"}`}
                            >
                              NWC
                            </span>
                          </div>
                          <p
                            className={`text-xs font-mono truncate ${isBlinkClassic ? "text-gray-500" : darkMode ? "text-gray-500" : "text-gray-500"}`}
                          >
                            {conn.walletPubkey?.slice(0, 8)}...
                            {conn.walletPubkey?.slice(-8)}
                          </p>
                        </div>
                      </div>
                      <div className="flex-shrink-0 ml-2 flex items-center gap-2">
                        {activeNWC?.id === conn.id ? (
                          <span
                            className={`px-3 py-1 text-xs font-medium rounded ${getWalletActiveBadgeClasses("purple")}`}
                          >
                            Active
                          </span>
                        ) : (
                          <button
                            onClick={async () => {
                              // Deactivate any active Blink account first
                              if (activeBlinkAccount) {
                                // Note: We can't easily deactivate Blink accounts, but we set NWC as active
                              }
                              await setActiveNWC(conn.id)
                            }}
                            className={`px-3 py-1 text-xs font-medium rounded transition-colors ${getWalletUseButtonClasses()}`}
                          >
                            Use
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Edit/Delete Actions */}
                    <div
                      className={`flex gap-2 mt-3 pt-3 border-t ${isBlinkClassic ? (isBlinkClassicDark ? "border-blink-classic-border" : "border-blink-classic-border-light") : "border-gray-200 dark:border-gray-700"}`}
                    >
                      <button
                        onClick={() => {
                          setEditingWalletLabel({ type: "nwc", id: conn.id })
                          setEditedWalletLabel(conn.label || "")
                        }}
                        className={`flex-1 py-2 text-sm rounded-lg transition-colors ${
                          isBlinkClassic
                            ? `${getSecondaryTextClasses()} hover:text-blink-classic-amber border ${isBlinkClassicDark ? "border-blink-classic-border" : "border-blink-classic-border-light"}`
                            : "text-gray-600 dark:text-gray-400 hover:text-purple-500 border border-gray-300 dark:border-gray-600"
                        }`}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          if (confirm("Delete this NWC connection?")) {
                            removeNWCConnection(conn.id)
                          }
                        }}
                        className={`flex-1 py-2 text-sm rounded-lg text-red-500 hover:text-red-700 border transition-colors ${
                          isBlinkClassic
                            ? isBlinkClassicDark
                              ? "border-blink-classic-border"
                              : "border-blink-classic-border-light"
                            : "border-gray-300 dark:border-gray-600"
                        }`}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}

              {/* Edit NWC Connection Label Modal */}
              {editingWalletLabel?.type === "nwc" && (
                <div
                  className={`p-4 rounded-lg ${isBlinkClassic ? (isBlinkClassicDark ? "bg-blink-classic-bg border border-blink-classic-amber" : "bg-blink-classic-hover-light border border-blink-classic-amber") : darkMode ? "bg-purple-900/30 border border-purple-500" : "bg-purple-100 border border-purple-500"}`}
                >
                  <h4
                    className={`text-sm font-medium mb-3 ${isBlinkClassicDark ? "text-white" : isBlinkClassicLight ? "text-black" : darkMode ? "text-white" : "text-gray-900"}`}
                  >
                    Edit NWC Connection Label
                  </h4>
                  <input
                    type="text"
                    value={editedWalletLabel}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setEditedWalletLabel(e.target.value)
                    }
                    placeholder="Enter connection label"
                    className={`w-full px-3 py-2 rounded-lg border ${getInputClasses()} focus:outline-none focus:ring-2 ${isBlinkClassic ? "focus:ring-blink-classic-amber" : "focus:ring-purple-500"}`}
                  />
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => {
                        // Update the label using updateNWCConnection
                        updateNWCConnection(editingWalletLabel.id!, {
                          label: editedWalletLabel.trim() || "NWC Wallet",
                        })
                        // Close the edit form
                        setEditingWalletLabel(null)
                        setEditedWalletLabel("")
                      }}
                      className={`flex-1 py-2 text-sm rounded-lg transition-colors ${isBlinkClassic ? "bg-blink-classic-amber text-black hover:bg-blink-classic-amber/80" : "bg-purple-600 text-white hover:bg-purple-700"}`}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditingWalletLabel(null)
                        setEditedWalletLabel("")
                      }}
                      className={`flex-1 py-2 text-sm rounded-lg transition-colors ${
                        isBlinkClassic
                          ? "bg-blink-classic-bg text-gray-300 hover:text-white border border-blink-classic-border"
                          : darkMode
                            ? "bg-gray-700 text-gray-300 hover:bg-gray-600"
                            : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                      }`}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Empty state */}
              {(!blinkAccounts || blinkAccounts.length === 0) &&
                (!nwcConnections || nwcConnections.length === 0) && (
                  <div
                    className={`p-8 text-center ${isBlinkClassicDark ? "bg-transparent border border-blink-classic-border rounded-xl" : isBlinkClassicLight ? "bg-transparent border border-blink-classic-border-light rounded-xl" : darkMode ? "bg-gray-900 rounded-lg" : "bg-gray-50 rounded-lg"}`}
                  >
                    <svg
                      className={`w-12 h-12 mx-auto mb-3 ${isBlinkClassic ? "text-gray-600" : darkMode ? "text-gray-600" : "text-gray-400"}`}
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
                    <p
                      className={`text-sm ${isBlinkClassic ? "text-gray-400" : darkMode ? "text-gray-400" : "text-gray-600"}`}
                    >
                      No wallets connected
                    </p>
                    <p
                      className={`text-xs mt-1 ${isBlinkClassic ? "text-gray-500" : darkMode ? "text-gray-500" : "text-gray-500"}`}
                    >
                      Add a Blink, NWC, or npub.cash wallet to get started
                    </p>
                  </div>
                )}
            </div>

            {/* Help links */}
            <div
              className={`text-xs text-center space-y-1 ${darkMode ? "text-gray-500" : "text-gray-500"}`}
            >
              <p>
                <span className="text-amber-500">Blink:</span>{" "}
                <a
                  href="https://dashboard.blink.sv"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  dashboard.blink.sv
                </a>
              </p>
              <p>
                <span className="text-purple-500">NWC:</span> Alby, Coinos, Zeus,
                minibits.cash etc.
              </p>
              <p>
                <span className="text-emerald-500">Cashu:</span>{" "}
                <a
                  href="https://npub.cash"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  npub.cash
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
