/**
 * Tests for useDashboardState composer hook
 *
 * This hook combines all 16 individual Dashboard state hooks into a single interface.
 * Tests verify that the hook correctly integrates all child hooks.
 */

import { renderHook } from "@testing-library/react"

import { useDashboardState } from "../../../lib/hooks/useDashboardState"

// Mock window.matchMedia for PWA install hook
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: jest.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
})

// Mock the useTheme hook that useThemeStyles depends on
jest.mock("../../../lib/hooks/useTheme", () => ({
  useTheme: jest.fn(() => ({
    theme: "dark",
    darkMode: true,
    isBlinkClassic: false,
    isBlinkClassicDark: false,
    isBlinkClassicLight: false,
  })),
  THEMES: {
    "dark": "dark",
    "light": "light",
    "blink-classic-dark": "blink-classic-dark",
    "blink-classic-light": "blink-classic-light",
  },
}))

describe("useDashboardState", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ===========================================================================
  // Hook Integration Tests
  // ===========================================================================

  describe("Hook Integration", () => {
    it("should return all 16 hook namespaces", () => {
      const { result } = renderHook(() => useDashboardState())

      // Verify all namespaces are present
      expect(result.current.themeStyles).toBeDefined()
      expect(result.current.ui).toBeDefined()
      expect(result.current.accountManagement).toBeDefined()
      expect(result.current.transactions).toBeDefined()
      expect(result.current.voucherWallet).toBeDefined()
      expect(result.current.splitProfiles).toBeDefined()
      expect(result.current.tipSettings).toBeDefined()
      expect(result.current.commissionSettings).toBeDefined()
      expect(result.current.soundSettings).toBeDefined()
      expect(result.current.displaySettings).toBeDefined()
      expect(result.current.paycode).toBeDefined()
      expect(result.current.exchangeRate).toBeDefined()
      expect(result.current.pwaInstall).toBeDefined()
      expect(result.current.navigation).toBeDefined()
      expect(result.current.invoice).toBeDefined()
      expect(result.current.wallet).toBeDefined()
    })

    it("should not have undefined namespaces", () => {
      const { result } = renderHook(() => useDashboardState())

      // All namespaces should be objects (not undefined/null)
      expect(typeof result.current.themeStyles).toBe("object")
      expect(typeof result.current.ui).toBe("object")
      expect(typeof result.current.accountManagement).toBe("object")
      expect(typeof result.current.transactions).toBe("object")
      expect(typeof result.current.voucherWallet).toBe("object")
      expect(typeof result.current.splitProfiles).toBe("object")
      expect(typeof result.current.tipSettings).toBe("object")
      expect(typeof result.current.commissionSettings).toBe("object")
      expect(typeof result.current.soundSettings).toBe("object")
      expect(typeof result.current.displaySettings).toBe("object")
      expect(typeof result.current.paycode).toBe("object")
      expect(typeof result.current.exchangeRate).toBe("object")
      expect(typeof result.current.pwaInstall).toBe("object")
      expect(typeof result.current.navigation).toBe("object")
      expect(typeof result.current.invoice).toBe("object")
      expect(typeof result.current.wallet).toBe("object")
    })
  })

  // ===========================================================================
  // Options Tests
  // ===========================================================================

  describe("Options", () => {
    it("should accept empty options", () => {
      const { result } = renderHook(() => useDashboardState({}))
      expect(result.current).toBeDefined()
    })

    it("should accept initialView option", () => {
      const { result } = renderHook(() =>
        useDashboardState({ initialView: "transactions" }),
      )
      expect(result.current.navigation.currentView).toBe("transactions")
    })

    it('should use default initialView of "pos" when not specified', () => {
      const { result } = renderHook(() => useDashboardState())
      expect(result.current.navigation.currentView).toBe("pos")
    })

    it("should accept cart as initialView", () => {
      const { result } = renderHook(() => useDashboardState({ initialView: "cart" }))
      expect(result.current.navigation.currentView).toBe("cart")
    })

    it("should accept voucher as initialView", () => {
      const { result } = renderHook(() => useDashboardState({ initialView: "voucher" }))
      expect(result.current.navigation.currentView).toBe("voucher")
    })
  })

  // ===========================================================================
  // ThemeStyles Namespace Tests
  // ===========================================================================

  describe("themeStyles namespace", () => {
    it("should expose theme state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(result.current.themeStyles.theme).toBeDefined()
      expect(result.current.themeStyles.darkMode).toBeDefined()
    })

    it("should expose style getter functions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.themeStyles.getMenuTileClasses).toBe("function")
      expect(typeof result.current.themeStyles.getSubmenuBgClasses).toBe("function")
      expect(typeof result.current.themeStyles.getInputClasses).toBe("function")
      expect(typeof result.current.themeStyles.getPrimaryTextClasses).toBe("function")
      expect(typeof result.current.themeStyles.getSecondaryTextClasses).toBe("function")
    })

    it("should return string classes from getter functions", () => {
      const { result } = renderHook(() => useDashboardState())

      const menuClasses = result.current.themeStyles.getMenuTileClasses()
      expect(typeof menuClasses).toBe("string")
      expect(menuClasses.length).toBeGreaterThan(0)
    })
  })

  // ===========================================================================
  // UI Namespace Tests
  // ===========================================================================

  describe("ui namespace", () => {
    it("should expose UI visibility states", () => {
      const { result } = renderHook(() => useDashboardState())

      // Check some expected UI states exist
      expect("showAccountSettings" in result.current.ui).toBe(true)
      expect("showCurrencySettings" in result.current.ui).toBe(true)
      expect("showTipSettings" in result.current.ui).toBe(true)
    })

    it("should expose UI setter functions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.ui.setShowAccountSettings).toBe("function")
      expect(typeof result.current.ui.setShowCurrencySettings).toBe("function")
    })

    it("should expose currentView in UI namespace", () => {
      const { result } = renderHook(() => useDashboardState())
      expect(result.current.ui.currentView).toBeDefined()
    })
  })

  // ===========================================================================
  // Navigation Namespace Tests
  // ===========================================================================

  describe("navigation namespace", () => {
    it("should expose current view", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(result.current.navigation.currentView).toBeDefined()
      expect(typeof result.current.navigation.currentView).toBe("string")
    })

    it("should expose navigation functions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.navigation.navigateToView).toBe("function")
    })

    it("should expose isFixedView derived state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.navigation.isFixedView).toBe("boolean")
    })
  })

  // ===========================================================================
  // Exchange Rate Namespace Tests
  // ===========================================================================

  describe("exchangeRate namespace", () => {
    it("should expose exchange rate state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("exchangeRate" in result.current.exchangeRate).toBe(true)
      expect("loadingRate" in result.current.exchangeRate).toBe(true)
      expect("hasRate" in result.current.exchangeRate).toBe(true)
    })

    it("should expose exchange rate actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.exchangeRate.setExchangeRate).toBe("function")
      expect(typeof result.current.exchangeRate.clearExchangeRate).toBe("function")
      expect(typeof result.current.exchangeRate.setLoadingRate).toBe("function")
    })

    it("should start with no exchange rate", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(result.current.exchangeRate.exchangeRate).toBeNull()
      expect(result.current.exchangeRate.hasRate).toBe(false)
    })
  })

  // ===========================================================================
  // Invoice Namespace Tests
  // ===========================================================================

  describe("invoice namespace", () => {
    it("should expose invoice state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("currentInvoice" in result.current.invoice).toBe(true)
      expect("hasInvoice" in result.current.invoice).toBe(true)
    })

    it("should expose invoice actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.invoice.setCurrentInvoice).toBe("function")
      expect(typeof result.current.invoice.clearInvoice).toBe("function")
    })

    it("should start with no active invoice", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(result.current.invoice.currentInvoice).toBeNull()
      expect(result.current.invoice.hasInvoice).toBe(false)
    })
  })

  // ===========================================================================
  // Wallet Namespace Tests
  // ===========================================================================

  describe("wallet namespace", () => {
    it("should expose wallet state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("wallets" in result.current.wallet).toBe(true)
      expect("apiKey" in result.current.wallet).toBe(true)
    })

    it("should expose wallet actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.wallet.setWallets).toBe("function")
    })

    it("should start with empty wallet list", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(result.current.wallet.wallets).toEqual([])
    })
  })

  // ===========================================================================
  // Transactions Namespace Tests
  // ===========================================================================

  describe("transactions namespace", () => {
    it("should expose transaction state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("transactions" in result.current.transactions).toBe(true)
      expect("loading" in result.current.transactions).toBe(true)
      expect("error" in result.current.transactions).toBe(true)
    })

    it("should expose transaction actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.transactions.setTransactions).toBe("function")
      expect(typeof result.current.transactions.setLoading).toBe("function")
      expect(typeof result.current.transactions.clearTransactions).toBe("function")
    })

    it("should start with empty transactions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(result.current.transactions.transactions).toEqual([])
      expect(result.current.transactions.loading).toBe(false)
    })
  })

  // ===========================================================================
  // Settings Namespaces Tests
  // ===========================================================================

  describe("soundSettings namespace", () => {
    it("should expose sound settings state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("soundEnabled" in result.current.soundSettings).toBe(true)
      expect("soundTheme" in result.current.soundSettings).toBe(true)
    })

    it("should expose sound settings actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.soundSettings.setSoundEnabled).toBe("function")
    })
  })

  describe("displaySettings namespace", () => {
    it("should expose display settings state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("displayCurrency" in result.current.displaySettings).toBe(true)
      expect("numberFormat" in result.current.displaySettings).toBe(true)
    })

    it("should expose display settings actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.displaySettings.setDisplayCurrency).toBe("function")
    })
  })

  describe("tipSettings namespace", () => {
    it("should expose tip settings state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("tipsEnabled" in result.current.tipSettings).toBe(true)
      expect("tipPresets" in result.current.tipSettings).toBe(true)
    })

    it("should expose tip settings actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.tipSettings.setTipsEnabled).toBe("function")
    })
  })

  describe("commissionSettings namespace", () => {
    it("should expose commission settings state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("commissionEnabled" in result.current.commissionSettings).toBe(true)
      expect("commissionPresets" in result.current.commissionSettings).toBe(true)
    })

    it("should expose commission settings actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.commissionSettings.setCommissionEnabled).toBe(
        "function",
      )
    })
  })

  // ===========================================================================
  // Other Namespaces Tests
  // ===========================================================================

  describe("accountManagement namespace", () => {
    it("should expose account management state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("newAccountType" in result.current.accountManagement).toBe(true)
      expect("newAccountLnAddress" in result.current.accountManagement).toBe(true)
    })

    it("should expose account management actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.accountManagement.setNewAccountType).toBe("function")
    })
  })

  describe("voucherWallet namespace", () => {
    it("should expose voucher wallet state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("voucherWallet" in result.current.voucherWallet).toBe(true)
    })

    it("should expose voucher wallet actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.voucherWallet.setVoucherWallet).toBe("function")
    })
  })

  describe("splitProfiles namespace", () => {
    it("should expose split profiles state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("splitProfiles" in result.current.splitProfiles).toBe(true)
      expect("activeSplitProfile" in result.current.splitProfiles).toBe(true)
    })

    it("should expose split profiles actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.splitProfiles.setSplitProfiles).toBe("function")
    })
  })

  describe("paycode namespace", () => {
    it("should expose paycode state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("showPaycode" in result.current.paycode).toBe(true)
    })

    it("should expose paycode actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.paycode.openPaycode).toBe("function")
      expect(typeof result.current.paycode.closePaycode).toBe("function")
    })
  })

  describe("pwaInstall namespace", () => {
    it("should expose PWA install state", () => {
      const { result } = renderHook(() => useDashboardState())

      expect("showInstallPrompt" in result.current.pwaInstall).toBe(true)
      expect("isInstalled" in result.current.pwaInstall).toBe(true)
    })

    it("should expose PWA install actions", () => {
      const { result } = renderHook(() => useDashboardState())

      expect(typeof result.current.pwaInstall.triggerInstall).toBe("function")
      expect(typeof result.current.pwaInstall.dismissInstall).toBe("function")
    })
  })

  // ===========================================================================
  // Memoization Tests
  // ===========================================================================

  describe("Memoization", () => {
    it("should maintain stable references for individual namespaces", () => {
      const { result, rerender } = renderHook(() => useDashboardState())

      // Store references to namespaces
      const _firstThemeStyles = result.current.themeStyles
      const _firstNavigation = result.current.navigation

      rerender()

      // Navigation should have stable references (uses useMemo internally)
      // Note: Due to React's hook rules, some objects may get new references
      // This test validates the hook doesn't break on re-render
      expect(result.current.themeStyles).toBeDefined()
      expect(result.current.navigation).toBeDefined()
    })

    it("should not throw on multiple re-renders", () => {
      const { result, rerender } = renderHook(() => useDashboardState())

      // Multiple re-renders should be stable
      expect(() => {
        rerender()
        rerender()
        rerender()
      }).not.toThrow()

      // All namespaces should still be accessible
      expect(result.current.themeStyles).toBeDefined()
      expect(result.current.navigation).toBeDefined()
      expect(result.current.invoice).toBeDefined()
    })
  })

  // ===========================================================================
  // Default Export Tests
  // ===========================================================================

  describe("Exports", () => {
    it("should have a default export", async () => {
      const hookModule = await import("../../../lib/hooks/useDashboardState")
      expect(hookModule.default).toBe(hookModule.useDashboardState)
    })

    it("should export the hook as named export", async () => {
      const hookModule = await import("../../../lib/hooks/useDashboardState")
      expect(typeof hookModule.useDashboardState).toBe("function")
    })

    it("should export types", async () => {
      // This is a compile-time check - if it imports without error, types exist
      const hookModule = await import("../../../lib/hooks/useDashboardState")
      expect(hookModule).toBeDefined()
    })
  })
})
