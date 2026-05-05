/**
 * Unit Tests for lib/config/api.js
 *
 * Tests the centralized API configuration module.
 */

// We need to test the module with different environments
describe("API Configuration", () => {
  beforeEach(async () => {
    // Clear module cache to ensure fresh imports
    jest.resetModules()
    localStorage.clear()
  })

  afterEach(() => {
    jest.resetModules()
  })

  describe("getEnvironment()", () => {
    it("should default to production when localStorage is empty", async () => {
      const { getEnvironment } = await import("../../lib/config/api")
      expect(getEnvironment()).toBe("production")
    })

    it("should return staging when set in localStorage", async () => {
      localStorage.setItem("blink_environment", "staging")
      const { getEnvironment } = await import("../../lib/config/api")
      expect(getEnvironment()).toBe("staging")
    })

    it("should return production when invalid value in localStorage", async () => {
      localStorage.setItem("blink_environment", "invalid")
      const { getEnvironment } = await import("../../lib/config/api")
      expect(getEnvironment()).toBe("production")
    })
  })

  describe("getApiUrl()", () => {
    it("should return production URL by default", async () => {
      const { getApiUrl } = await import("../../lib/config/api")
      expect(getApiUrl()).toBe("https://api.blink.sv/graphql")
    })

    it("should return staging URL when in staging environment", async () => {
      localStorage.setItem("blink_environment", "staging")
      const { getApiUrl } = await import("../../lib/config/api")
      expect(getApiUrl()).toBe("https://api.staging.blink.sv/graphql")
    })
  })

  describe("getDashboardUrl()", () => {
    it("should return production dashboard URL by default", async () => {
      const { getDashboardUrl } = await import("../../lib/config/api")
      expect(getDashboardUrl()).toBe("https://dashboard.blink.sv")
    })

    it("should return staging dashboard URL when in staging", async () => {
      localStorage.setItem("blink_environment", "staging")
      const { getDashboardUrl } = await import("../../lib/config/api")
      expect(getDashboardUrl()).toBe("https://dashboard.staging.blink.sv")
    })
  })

  describe("getPayUrl()", () => {
    it("should return production pay URL by default", async () => {
      const { getPayUrl } = await import("../../lib/config/api")
      expect(getPayUrl()).toBe("https://pay.blink.sv")
    })

    it("should return staging pay URL when in staging", async () => {
      localStorage.setItem("blink_environment", "staging")
      const { getPayUrl } = await import("../../lib/config/api")
      expect(getPayUrl()).toBe("https://pay.staging.blink.sv")
    })
  })

  describe("isStaging()", () => {
    it("should return false by default", async () => {
      const { isStaging } = await import("../../lib/config/api")
      expect(isStaging()).toBe(false)
    })

    it("should return true when in staging environment", async () => {
      localStorage.setItem("blink_environment", "staging")
      const { isStaging } = await import("../../lib/config/api")
      expect(isStaging()).toBe(true)
    })
  })

  describe("isProduction()", () => {
    it("should return true by default", async () => {
      const { isProduction } = await import("../../lib/config/api")
      expect(isProduction()).toBe(true)
    })

    it("should return false when in staging environment", async () => {
      localStorage.setItem("blink_environment", "staging")
      const { isProduction } = await import("../../lib/config/api")
      expect(isProduction()).toBe(false)
    })
  })

  describe("setEnvironment()", () => {
    it("should update localStorage when switching environments", async () => {
      const { setEnvironment } = await import("../../lib/config/api")

      // Use reload=false to avoid jsdom navigation errors
      setEnvironment("staging", false)

      expect(localStorage.getItem("blink_environment")).toBe("staging")
    })

    it("should not reload when reload=false", async () => {
      const { setEnvironment } = await import("../../lib/config/api")

      // This should not throw since we pass reload=false
      setEnvironment("staging", false)

      expect(localStorage.getItem("blink_environment")).toBe("staging")
    })

    it("should not change anything for invalid environment", async () => {
      const { setEnvironment, getEnvironment } = await import("../../lib/config/api")

      const consoleSpy = jest.spyOn(console, "error").mockImplementation()

      // @ts-expect-error - Testing invalid input
      setEnvironment("invalid")

      expect(getEnvironment()).toBe("production")
      expect(consoleSpy).toHaveBeenCalled()

      consoleSpy.mockRestore()
    })

    it("should preserve auth state when reload=false", async () => {
      // Auth state is only cleared when reload=true (before the actual reload)
      // When reload=false, auth state is preserved
      localStorage.setItem("blinkpos_api_key", "test-key")
      localStorage.setItem("blinkpos_wallet_id", "test-wallet")
      localStorage.setItem("blinkpos_blink_account", "test-account")

      const { setEnvironment } = await import("../../lib/config/api")

      setEnvironment("staging", false)

      // Auth state is preserved when reload=false
      expect(localStorage.getItem("blinkpos_api_key")).toBe("test-key")
      expect(localStorage.getItem("blinkpos_wallet_id")).toBe("test-wallet")
      expect(localStorage.getItem("blinkpos_blink_account")).toBe("test-account")
    })
  })

  describe("getAllEnvironments()", () => {
    it("should return all environment configurations", async () => {
      const { getAllEnvironments } = await import("../../lib/config/api")

      const envs = getAllEnvironments() as Record<
        string,
        { apiUrl: string; name: string }
      >

      expect(envs).toHaveProperty("production")
      expect(envs).toHaveProperty("staging")
      expect(envs.production.apiUrl).toBe("https://api.blink.sv/graphql")
      expect(envs.staging.apiUrl).toBe("https://api.staging.blink.sv/graphql")
    })
  })

  describe("getEnvironmentDisplayInfo()", () => {
    it("should return display info for current environment", async () => {
      const { getEnvironmentDisplayInfo } = await import("../../lib/config/api")

      const info = getEnvironmentDisplayInfo()

      expect(info).toHaveProperty("key", "production")
      expect(info).toHaveProperty("name", "Production")
      expect(info).toHaveProperty("isStaging", false)
      expect(info).toHaveProperty("isProduction", true)
    })

    it("should return staging info when in staging", async () => {
      localStorage.setItem("blink_environment", "staging")
      const { getEnvironmentDisplayInfo } = await import("../../lib/config/api")

      const info = getEnvironmentDisplayInfo()

      expect(info).toHaveProperty("key", "staging")
      expect(info).toHaveProperty("name", "Staging")
      expect(info).toHaveProperty("isStaging", true)
      expect(info).toHaveProperty("isProduction", false)
    })
  })

  describe("isHostnameStaging()", () => {
    // jsdom's window.location is non-configurable, so the hostname-detection
    // logic is extracted into isHostnameStaging() for direct unit testing.

    it("should return true for terminal.staging.blinkbtc.com", async () => {
      const { isHostnameStaging } = await import("../../lib/config/api")
      expect(isHostnameStaging("terminal.staging.blinkbtc.com")).toBe(true)
    })

    it("should return true for staging.terminal.blink.sv", async () => {
      const { isHostnameStaging } = await import("../../lib/config/api")
      expect(isHostnameStaging("staging.terminal.blink.sv")).toBe(true)
    })

    it("should return false for terminal.blinkbtc.com", async () => {
      const { isHostnameStaging } = await import("../../lib/config/api")
      expect(isHostnameStaging("terminal.blinkbtc.com")).toBe(false)
    })

    it("should return false for localhost", async () => {
      const { isHostnameStaging } = await import("../../lib/config/api")
      expect(isHostnameStaging("localhost")).toBe(false)
    })

    it("should return false for terminal.blink.sv", async () => {
      const { isHostnameStaging } = await import("../../lib/config/api")
      expect(isHostnameStaging("terminal.blink.sv")).toBe(false)
    })
  })
})
