/**
 * Tests for useVoucherWalletState hook
 *
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"

import {
  useVoucherWalletState,
  type VoucherWallet,
  type VoucherExpiry,
} from "@/lib/hooks/useVoucherWalletState"

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
  }
})()

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
})

// Mock voucher wallet data
const mockVoucherWallet: VoucherWallet = {
  id: "voucher-wallet-123",
  label: "My Voucher Wallet",
  apiKey: "api-key-456",
  btcWalletId: "btc-wallet-789",
  usdWalletId: "usd-wallet-012",
}

const mockScopes: string[] = ["RECEIVE", "SEND", "READ"]

describe("useVoucherWalletState", () => {
  beforeEach(() => {
    localStorageMock.clear()
  })

  describe("initial state", () => {
    it("initializes with null voucher wallet", () => {
      const { result } = renderHook(() => useVoucherWalletState())
      expect(result.current.voucherWallet).toBeNull()
    })

    it("initializes with empty form fields", () => {
      const { result } = renderHook(() => useVoucherWalletState())
      expect(result.current.voucherWalletApiKey).toBe("")
      expect(result.current.voucherWalletLabel).toBe("")
    })

    it("initializes with loading/error states as false/null", () => {
      const { result } = renderHook(() => useVoucherWalletState())
      expect(result.current.voucherWalletLoading).toBe(false)
      expect(result.current.voucherWalletError).toBeNull()
      expect(result.current.voucherWalletValidating).toBe(false)
    })

    it("initializes with null wallet details", () => {
      const { result } = renderHook(() => useVoucherWalletState())
      expect(result.current.voucherWalletScopes).toBeNull()
      expect(result.current.voucherWalletBtcId).toBeNull()
      expect(result.current.voucherWalletUsdId).toBeNull()
    })

    it("initializes with null balances", () => {
      const { result } = renderHook(() => useVoucherWalletState())
      expect(result.current.voucherWalletBalance).toBeNull()
      expect(result.current.voucherWalletUsdBalance).toBeNull()
      expect(result.current.voucherWalletBalanceLoading).toBe(false)
      expect(result.current.usdExchangeRate).toBeNull()
    })

    it("initializes with default BTC currency mode", () => {
      const { result } = renderHook(() => useVoucherWalletState())
      expect(result.current.voucherCurrencyMode).toBe("BTC")
    })

    it("initializes with default 24h expiry", () => {
      const { result } = renderHook(() => useVoucherWalletState())
      expect(result.current.voucherExpiry).toBe("24h")
    })

    it("initializes with zero capacity indicator values", () => {
      const { result } = renderHook(() => useVoucherWalletState())
      expect(result.current.currentAmountInSats).toBe(0)
      expect(result.current.currentAmountInUsdCents).toBe(0)
      expect(result.current.currentVoucherCurrencyMode).toBe("BTC")
    })

    it("loads currency mode from localStorage if set", () => {
      localStorageMock.setItem("blinkpos-voucher-currency-mode", "USD")
      const { result } = renderHook(() => useVoucherWalletState())
      expect(result.current.voucherCurrencyMode).toBe("USD")
    })

    it("loads expiry from localStorage if set", () => {
      localStorageMock.setItem("blinkpos-voucher-expiry", "48h")
      const { result } = renderHook(() => useVoucherWalletState())
      expect(result.current.voucherExpiry).toBe("48h")
    })

    it("migrates legacy 7d expiry to 24h", () => {
      localStorageMock.setItem("blinkpos-voucher-expiry", "7d")
      const { result } = renderHook(() => useVoucherWalletState())
      expect(result.current.voucherExpiry).toBe("24h")
    })

    it("preserves short 15m expiry (now a valid UI option)", () => {
      localStorageMock.setItem("blinkpos-voucher-expiry", "15m")
      const { result } = renderHook(() => useVoucherWalletState())
      expect(result.current.voucherExpiry).toBe("15m")
    })
  })

  describe("wallet configuration actions", () => {
    it("setVoucherWallet sets the wallet", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherWallet(mockVoucherWallet)
      })

      expect(result.current.voucherWallet).toEqual(mockVoucherWallet)
    })

    it("setVoucherWalletApiKey updates API key", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherWalletApiKey("new-api-key")
      })

      expect(result.current.voucherWalletApiKey).toBe("new-api-key")
    })

    it("setVoucherWalletLabel updates label", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherWalletLabel("New Label")
      })

      expect(result.current.voucherWalletLabel).toBe("New Label")
    })
  })

  describe("loading and error actions", () => {
    it("setVoucherWalletLoading toggles loading state", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherWalletLoading(true)
      })

      expect(result.current.voucherWalletLoading).toBe(true)
    })

    it("setVoucherWalletError sets error message", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherWalletError("Invalid API key")
      })

      expect(result.current.voucherWalletError).toBe("Invalid API key")
    })

    it("setVoucherWalletValidating toggles validating state", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherWalletValidating(true)
      })

      expect(result.current.voucherWalletValidating).toBe(true)
    })
  })

  describe("wallet details actions", () => {
    it("setVoucherWalletScopes sets scopes", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherWalletScopes(mockScopes)
      })

      expect(result.current.voucherWalletScopes).toEqual(mockScopes)
    })

    it("setVoucherWalletBtcId sets BTC wallet ID", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherWalletBtcId("btc-id-123")
      })

      expect(result.current.voucherWalletBtcId).toBe("btc-id-123")
    })

    it("setVoucherWalletUsdId sets USD wallet ID", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherWalletUsdId("usd-id-456")
      })

      expect(result.current.voucherWalletUsdId).toBe("usd-id-456")
    })
  })

  describe("balance actions", () => {
    it("setVoucherWalletBalance sets BTC balance", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherWalletBalance(100000)
      })

      expect(result.current.voucherWalletBalance).toBe(100000)
    })

    it("setVoucherWalletUsdBalance sets USD balance", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherWalletUsdBalance(5000)
      })

      expect(result.current.voucherWalletUsdBalance).toBe(5000)
    })

    it("setVoucherWalletBalanceLoading toggles balance loading", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherWalletBalanceLoading(true)
      })

      expect(result.current.voucherWalletBalanceLoading).toBe(true)
    })

    it("setUsdExchangeRate sets exchange rate", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setUsdExchangeRate(65000)
      })

      expect(result.current.usdExchangeRate).toBe(65000)
    })
  })

  describe("voucher creation settings actions", () => {
    it("setVoucherCurrencyMode updates mode and persists to localStorage", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherCurrencyMode("USD")
      })

      expect(result.current.voucherCurrencyMode).toBe("USD")
      expect(localStorageMock.getItem("blinkpos-voucher-currency-mode")).toBe("USD")
    })

    it("setVoucherExpiry updates expiry and persists to localStorage", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setVoucherExpiry("72h")
      })

      expect(result.current.voucherExpiry).toBe("72h")
      expect(localStorageMock.getItem("blinkpos-voucher-expiry")).toBe("72h")
    })

    it("supports all valid expiry values", () => {
      const { result } = renderHook(() => useVoucherWalletState())
      const expiryValues: VoucherExpiry[] = ["24h", "48h", "72h", "168h"]

      expiryValues.forEach((expiry) => {
        act(() => {
          result.current.setVoucherExpiry(expiry)
        })
        expect(result.current.voucherExpiry).toBe(expiry)
      })
    })
  })

  describe("capacity indicator actions", () => {
    it("setCurrentAmountInSats updates sats amount", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setCurrentAmountInSats(50000)
      })

      expect(result.current.currentAmountInSats).toBe(50000)
    })

    it("setCurrentAmountInUsdCents updates USD cents amount", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setCurrentAmountInUsdCents(1500)
      })

      expect(result.current.currentAmountInUsdCents).toBe(1500)
    })

    it("setCurrentVoucherCurrencyMode updates current mode", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      act(() => {
        result.current.setCurrentVoucherCurrencyMode("USD")
      })

      expect(result.current.currentVoucherCurrencyMode).toBe("USD")
    })
  })

  describe("resetVoucherWalletForm", () => {
    it("resets form fields and validation state", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      // Set up form state
      act(() => {
        result.current.setVoucherWalletApiKey("test-key")
        result.current.setVoucherWalletLabel("Test Label")
        result.current.setVoucherWalletLoading(true)
        result.current.setVoucherWalletError("Some error")
        result.current.setVoucherWalletValidating(true)
        result.current.setVoucherWalletScopes(mockScopes)
      })

      // Reset form
      act(() => {
        result.current.resetVoucherWalletForm()
      })

      expect(result.current.voucherWalletApiKey).toBe("")
      expect(result.current.voucherWalletLabel).toBe("")
      expect(result.current.voucherWalletLoading).toBe(false)
      expect(result.current.voucherWalletError).toBeNull()
      expect(result.current.voucherWalletValidating).toBe(false)
      expect(result.current.voucherWalletScopes).toBeNull()
    })

    it("does not affect connected wallet state", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      // Set up connected wallet
      act(() => {
        result.current.setVoucherWallet(mockVoucherWallet)
        result.current.setVoucherWalletBtcId("btc-id")
        result.current.setVoucherWalletBalance(100000)
      })

      // Reset form
      act(() => {
        result.current.resetVoucherWalletForm()
      })

      // Wallet should still be connected
      expect(result.current.voucherWallet).toEqual(mockVoucherWallet)
      expect(result.current.voucherWalletBtcId).toBe("btc-id")
      expect(result.current.voucherWalletBalance).toBe(100000)
    })
  })

  describe("clearVoucherWallet", () => {
    it("clears all wallet state", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      // Set up full wallet state
      act(() => {
        result.current.setVoucherWallet(mockVoucherWallet)
        result.current.setVoucherWalletApiKey("test-key")
        result.current.setVoucherWalletLabel("Test Label")
        result.current.setVoucherWalletLoading(true)
        result.current.setVoucherWalletError("Some error")
        result.current.setVoucherWalletValidating(true)
        result.current.setVoucherWalletScopes(mockScopes)
        result.current.setVoucherWalletBtcId("btc-id")
        result.current.setVoucherWalletUsdId("usd-id")
        result.current.setVoucherWalletBalance(100000)
        result.current.setVoucherWalletUsdBalance(5000)
        result.current.setVoucherWalletBalanceLoading(true)
      })

      // Clear wallet
      act(() => {
        result.current.clearVoucherWallet()
      })

      expect(result.current.voucherWallet).toBeNull()
      expect(result.current.voucherWalletApiKey).toBe("")
      expect(result.current.voucherWalletLabel).toBe("")
      expect(result.current.voucherWalletLoading).toBe(false)
      expect(result.current.voucherWalletError).toBeNull()
      expect(result.current.voucherWalletValidating).toBe(false)
      expect(result.current.voucherWalletScopes).toBeNull()
      expect(result.current.voucherWalletBtcId).toBeNull()
      expect(result.current.voucherWalletUsdId).toBeNull()
      expect(result.current.voucherWalletBalance).toBeNull()
      expect(result.current.voucherWalletUsdBalance).toBeNull()
      expect(result.current.voucherWalletBalanceLoading).toBe(false)
    })

    it("does not affect voucher settings preferences", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      // Set preferences
      act(() => {
        result.current.setVoucherCurrencyMode("USD")
        result.current.setVoucherExpiry("72h")
      })

      // Clear wallet
      act(() => {
        result.current.clearVoucherWallet()
      })

      // Preferences should remain
      expect(result.current.voucherCurrencyMode).toBe("USD")
      expect(result.current.voucherExpiry).toBe("72h")
    })
  })

  describe("resetCapacityIndicator", () => {
    it("resets all capacity indicator values", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      // Set capacity values
      act(() => {
        result.current.setCurrentAmountInSats(50000)
        result.current.setCurrentAmountInUsdCents(2500)
        result.current.setCurrentVoucherCurrencyMode("USD")
      })

      // Reset
      act(() => {
        result.current.resetCapacityIndicator()
      })

      expect(result.current.currentAmountInSats).toBe(0)
      expect(result.current.currentAmountInUsdCents).toBe(0)
      expect(result.current.currentVoucherCurrencyMode).toBe("BTC")
    })
  })

  describe("callback stability", () => {
    it("setVoucherCurrencyMode maintains referential equality", () => {
      const { result, rerender } = renderHook(() => useVoucherWalletState())

      const first = result.current.setVoucherCurrencyMode
      rerender()
      const second = result.current.setVoucherCurrencyMode

      expect(first).toBe(second)
    })

    it("setVoucherExpiry maintains referential equality", () => {
      const { result, rerender } = renderHook(() => useVoucherWalletState())

      const first = result.current.setVoucherExpiry
      rerender()
      const second = result.current.setVoucherExpiry

      expect(first).toBe(second)
    })

    it("resetVoucherWalletForm maintains referential equality", () => {
      const { result, rerender } = renderHook(() => useVoucherWalletState())

      const first = result.current.resetVoucherWalletForm
      rerender()
      const second = result.current.resetVoucherWalletForm

      expect(first).toBe(second)
    })

    it("clearVoucherWallet maintains referential equality", () => {
      const { result, rerender } = renderHook(() => useVoucherWalletState())

      const first = result.current.clearVoucherWallet
      rerender()
      const second = result.current.clearVoucherWallet

      expect(first).toBe(second)
    })

    it("resetCapacityIndicator maintains referential equality", () => {
      const { result, rerender } = renderHook(() => useVoucherWalletState())

      const first = result.current.resetCapacityIndicator
      rerender()
      const second = result.current.resetCapacityIndicator

      expect(first).toBe(second)
    })
  })

  describe("typical workflow scenarios", () => {
    it("handles wallet connection workflow", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      // User enters API key
      act(() => {
        result.current.setVoucherWalletApiKey("my-api-key")
        result.current.setVoucherWalletLabel("My Voucher Wallet")
      })

      // Start validation
      act(() => {
        result.current.setVoucherWalletValidating(true)
      })

      expect(result.current.voucherWalletValidating).toBe(true)

      // Validation complete, set wallet details
      act(() => {
        result.current.setVoucherWalletValidating(false)
        result.current.setVoucherWalletScopes(mockScopes)
        result.current.setVoucherWalletBtcId("btc-wallet-id")
        result.current.setVoucherWalletUsdId("usd-wallet-id")
        result.current.setVoucherWallet(mockVoucherWallet)
      })

      expect(result.current.voucherWallet).toEqual(mockVoucherWallet)
      expect(result.current.voucherWalletScopes).toEqual(mockScopes)

      // Clear form
      act(() => {
        result.current.resetVoucherWalletForm()
      })

      // Wallet should still be connected but form cleared
      expect(result.current.voucherWallet).toEqual(mockVoucherWallet)
      expect(result.current.voucherWalletApiKey).toBe("")
    })

    it("handles balance loading workflow", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      // Start loading balance
      act(() => {
        result.current.setVoucherWalletBalanceLoading(true)
      })

      expect(result.current.voucherWalletBalanceLoading).toBe(true)

      // Balance loaded
      act(() => {
        result.current.setVoucherWalletBalance(500000)
        result.current.setVoucherWalletUsdBalance(25000)
        result.current.setUsdExchangeRate(65000)
        result.current.setVoucherWalletBalanceLoading(false)
      })

      expect(result.current.voucherWalletBalance).toBe(500000)
      expect(result.current.voucherWalletUsdBalance).toBe(25000)
      expect(result.current.usdExchangeRate).toBe(65000)
      expect(result.current.voucherWalletBalanceLoading).toBe(false)
    })

    it("handles currency mode switch workflow", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      // Set up wallet with balances
      act(() => {
        result.current.setVoucherWallet(mockVoucherWallet)
        result.current.setVoucherWalletBalance(500000)
        result.current.setVoucherWalletUsdBalance(25000)
      })

      // User switches to USD mode
      act(() => {
        result.current.setVoucherCurrencyMode("USD")
      })

      expect(result.current.voucherCurrencyMode).toBe("USD")
      expect(localStorageMock.getItem("blinkpos-voucher-currency-mode")).toBe("USD")

      // User switches back to BTC
      act(() => {
        result.current.setVoucherCurrencyMode("BTC")
      })

      expect(result.current.voucherCurrencyMode).toBe("BTC")
    })

    it("handles wallet disconnection workflow", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      // Connect wallet
      act(() => {
        result.current.setVoucherWallet(mockVoucherWallet)
        result.current.setVoucherWalletBtcId("btc-id")
        result.current.setVoucherWalletBalance(100000)
        result.current.setVoucherCurrencyMode("USD")
      })

      // Disconnect wallet
      act(() => {
        result.current.clearVoucherWallet()
      })

      expect(result.current.voucherWallet).toBeNull()
      expect(result.current.voucherWalletBalance).toBeNull()
      // Preferences preserved
      expect(result.current.voucherCurrencyMode).toBe("USD")
    })

    it("handles voucher creation amount tracking", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      // User enters amount in BTC mode
      act(() => {
        result.current.setCurrentAmountInSats(10000)
        result.current.setCurrentVoucherCurrencyMode("BTC")
      })

      expect(result.current.currentAmountInSats).toBe(10000)
      expect(result.current.currentVoucherCurrencyMode).toBe("BTC")

      // User switches to USD mode and enters amount
      act(() => {
        result.current.setCurrentVoucherCurrencyMode("USD")
        result.current.setCurrentAmountInUsdCents(500)
      })

      expect(result.current.currentAmountInUsdCents).toBe(500)
      expect(result.current.currentVoucherCurrencyMode).toBe("USD")

      // User completes voucher creation, reset indicator
      act(() => {
        result.current.resetCapacityIndicator()
      })

      expect(result.current.currentAmountInSats).toBe(0)
      expect(result.current.currentAmountInUsdCents).toBe(0)
    })

    it("handles validation error workflow", () => {
      const { result } = renderHook(() => useVoucherWalletState())

      // User enters API key
      act(() => {
        result.current.setVoucherWalletApiKey("invalid-key")
        result.current.setVoucherWalletValidating(true)
      })

      // Validation fails
      act(() => {
        result.current.setVoucherWalletValidating(false)
        result.current.setVoucherWalletError("Invalid API key")
      })

      expect(result.current.voucherWalletError).toBe("Invalid API key")

      // User corrects and retries
      act(() => {
        result.current.setVoucherWalletError(null)
        result.current.setVoucherWalletApiKey("valid-key")
        result.current.setVoucherWalletValidating(true)
      })

      expect(result.current.voucherWalletError).toBeNull()
      expect(result.current.voucherWalletValidating).toBe(true)
    })
  })
})
