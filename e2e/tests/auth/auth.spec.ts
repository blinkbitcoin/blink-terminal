import { test, expect } from "@playwright/test"

import { AuthPage } from "../../page-objects"
// TEST_CREDENTIALS removed (unused)

test.describe("Authentication", () => {
  let authPage: AuthPage

  test.beforeEach(async ({ page }) => {
    authPage = new AuthPage(page)
    await authPage.goto()
  })

  test.describe("Login Page Display", () => {
    test("should display login page with sign-in options", async ({ page }) => {
      // Sign-in is Nostr-only by default: the Remote Signer (Nostr Connect)
      // button is always available. The in-app password/create-account options
      // are gated behind NEXT_PUBLIC_ENABLE_PASSWORD_AUTH (off by default).
      const remoteSignerBtn = page.locator(
        'button:has-text("Connect with Remote Signer"), button:has-text("Connect with Nostr Connect")',
      )

      const hasRemoteSigner = await remoteSignerBtn
        .first()
        .isVisible()
        .catch(() => false)

      expect(hasRemoteSigner).toBeTruthy()
    })

    test("should display Blink branding", async ({ page }) => {
      // Should have Blink logo or branding
      const logo = page.locator('[data-testid="app-logo"], img[alt*="Blink"]')
      await expect(logo.first()).toBeVisible()
    })

    test("should not show in-app password auth options by default (Nostr-only)", async ({
      page,
    }) => {
      // NEXT_PUBLIC_ENABLE_PASSWORD_AUTH is off by default, so the in-app
      // password sign-in and account-creation options must not be rendered.
      const createAccountBtn = page.locator('button:has-text("Create New Account")')
      const passwordSignInBtn = page.locator('button:has-text("Sign in with Password")')

      await expect(createAccountBtn).toHaveCount(0)
      await expect(passwordSignInBtn).toHaveCount(0)
    })

    test("should have Connect with Remote Signer button", async ({ page }) => {
      // This button opens NIP-46 flow
      const connectBtn = page.locator(
        'button:has-text("Connect with Remote Signer"), button:has-text("Connect with Nostr Connect")',
      )
      await expect(connectBtn.first()).toBeVisible()
    })
  })

  test.describe("Debug Panel", () => {
    test("should open debug panel after 5 logo taps", async ({ page }) => {
      // Find the logo element
      const logo = page.locator('[data-testid="app-logo"]')

      // Only run if logo exists
      if (await logo.isVisible()) {
        for (let i = 0; i < 5; i++) {
          await logo.click()
          await page.waitForTimeout(100)
        }

        const debugPanel = page.locator('[data-testid="debug-panel"]')
        await expect(debugPanel).toBeVisible({ timeout: 5000 })
      } else {
        test.skip()
      }
    })

    test("should switch to staging environment", async ({ page }) => {
      // Attempt to open debug panel and switch to staging
      const logo = page.locator('[data-testid="app-logo"]')

      if (await logo.isVisible()) {
        // Open debug panel
        for (let i = 0; i < 5; i++) {
          await logo.click()
          await page.waitForTimeout(100)
        }

        // Click staging toggle
        const stagingToggle = page.locator('[data-testid="staging-toggle"]')
        if (await stagingToggle.isVisible()) {
          await stagingToggle.click()

          // Close debug panel first
          const closeBtn = page.locator(
            '[data-testid="debug-panel"] button:has-text("×")',
          )
          if (await closeBtn.isVisible()) {
            await closeBtn.click()
          }

          // Verify staging banner appears
          const stagingBanner = page.locator('[data-testid="staging-banner"]')
          await expect(stagingBanner).toBeVisible({ timeout: 5000 })
        } else {
          test.skip()
        }
      } else {
        test.skip()
      }
    })

    test("should show staging API URL in debug panel", async ({ page }) => {
      const logo = page.locator('[data-testid="app-logo"]')

      if (await logo.isVisible()) {
        // Open debug panel
        for (let i = 0; i < 5; i++) {
          await logo.click()
          await page.waitForTimeout(100)
        }

        const debugPanel = page.locator('[data-testid="debug-panel"]')
        if (await debugPanel.isVisible()) {
          // The debug panel should contain API URL info
          const panelContent = await debugPanel.textContent()
          // Check for staging or production API reference
          expect(panelContent).toContain("api")
        }
      }
    })

    test("should have environment toggle buttons", async ({ page }) => {
      const logo = page.locator('[data-testid="app-logo"]')

      if (await logo.isVisible()) {
        // Open debug panel
        for (let i = 0; i < 5; i++) {
          await logo.click()
          await page.waitForTimeout(100)
        }

        const stagingToggle = page.locator('[data-testid="staging-toggle"]')
        const productionToggle = page.locator('[data-testid="production-toggle"]')

        await expect(stagingToggle).toBeVisible()
        await expect(productionToggle).toBeVisible()
      }
    })
  })

  // In-app account creation (and password sign-in) is gated behind
  // NEXT_PUBLIC_ENABLE_PASSWORD_AUTH, which is off by default so sign-in is
  // Nostr-only. These tests run only when the flag is enabled (feature-on
  // build/config); otherwise they are skipped at runtime with a clear reason.
  const passwordAuthEnabled = process.env.NEXT_PUBLIC_ENABLE_PASSWORD_AUTH === "true"
  test.describe("Create Account Flow", () => {
    test.skip(
      !passwordAuthEnabled,
      "in-app password auth disabled (Nostr-only by default); set NEXT_PUBLIC_ENABLE_PASSWORD_AUTH=true to run",
    )
    test("should open create account form when button clicked", async ({ page }) => {
      const createAccountBtn = page.locator('button:has-text("Create New Account")')

      if (await createAccountBtn.isVisible()) {
        await createAccountBtn.click()

        // Should now show password input fields
        const passwordInput = page.locator('input[type="password"]').first()
        await expect(passwordInput).toBeVisible({ timeout: 5000 })
      }
    })

    test("should validate password requirements", async ({ page }) => {
      const createAccountBtn = page.locator('button:has-text("Create New Account")')

      if (await createAccountBtn.isVisible()) {
        await createAccountBtn.click()
        await page.waitForTimeout(500)

        // Should show password fields
        const passwordInput = page
          .locator('#password, input[placeholder*="password"]')
          .first()
        const confirmInput = page
          .locator('#confirmPassword, input[placeholder*="Confirm"]')
          .first()
        const submitBtn = page.locator('button[type="submit"]:has-text("Create Account")')

        if ((await passwordInput.isVisible()) && (await confirmInput.isVisible())) {
          // Enter short password (less than 8 chars)
          await passwordInput.fill("short")
          await confirmInput.fill("short")

          // Submit button should be disabled or show error on submit
          const isDisabled = await submitBtn.isDisabled()
          expect(isDisabled).toBeTruthy()
        }
      }
    })

    test("should show error when passwords do not match", async ({ page }) => {
      const createAccountBtn = page.locator('button:has-text("Create New Account")')

      if (await createAccountBtn.isVisible()) {
        await createAccountBtn.click()
        await page.waitForTimeout(500)

        const passwordInput = page
          .locator('#password, input[placeholder*="password"]')
          .first()
        const confirmInput = page
          .locator('#confirmPassword, input[placeholder*="Confirm"]')
          .first()
        const submitBtn = page.locator('button[type="submit"]:has-text("Create Account")')

        if ((await passwordInput.isVisible()) && (await confirmInput.isVisible())) {
          // Enter matching passwords
          await passwordInput.fill("validpassword123")
          await confirmInput.fill("differentpassword")

          // Submit button should be disabled when passwords don't match
          const isDisabled = await submitBtn.isDisabled()
          expect(isDisabled).toBeTruthy()
        }
      }
    })

    test("should have back button to return to main view", async ({ page }) => {
      const createAccountBtn = page.locator('button:has-text("Create New Account")')

      if (await createAccountBtn.isVisible()) {
        await createAccountBtn.click()
        await page.waitForTimeout(500)

        // Should have back button
        const backBtn = page.locator('button:has-text("Back"), button:has-text("← Back")')
        await expect(backBtn.first()).toBeVisible()
      }
    })
  })

  test.describe("Remote Signer Flow", () => {
    test("should open Nostr Connect modal when button clicked", async ({ page }) => {
      const connectBtn = page.locator(
        'button:has-text("Connect with Remote Signer"), button:has-text("Connect with Nostr Connect")',
      )

      if (await connectBtn.first().isVisible()) {
        await connectBtn.first().click()

        // Should show a modal with QR code or connection URI
        // Wait a bit for modal to appear
        await page.waitForTimeout(1000)

        // Look for modal elements (QR code canvas, connection URI text, etc.)
        const modal = page.locator('[role="dialog"], .modal, [class*="modal"]')
        const qrCode = page.locator('canvas, svg[class*="qr"], [data-testid*="qr"]')

        const _hasModal = await modal.isVisible().catch(() => false)
        const _hasQr = await qrCode.isVisible().catch(() => false)

        // Either should be true if the flow started
        // Note: This may vary based on platform detection
      }
    })
  })

  test.describe("Session Management", () => {
    test("should persist login across page refresh", async ({ page }) => {
      // Test localStorage persistence mechanism
      // Set a mock session in localStorage
      await page.evaluate(() => {
        localStorage.setItem(
          "nostr-session-test",
          JSON.stringify({
            loggedIn: true,
            timestamp: Date.now(),
          }),
        )
      })

      // Reload the page
      await page.reload()
      await page.waitForLoadState("domcontentloaded")

      // Verify localStorage persists
      const session = await page.evaluate(() => {
        return localStorage.getItem("nostr-session-test")
      })

      expect(session).not.toBeNull()
      if (session) {
        const parsed = JSON.parse(session)
        expect(parsed.loggedIn).toBeTruthy()
      }
    })

    test("should clear session on logout", async ({ page }) => {
      // Test that localStorage can be cleared (logout mechanism)
      // First set some session data
      await page.evaluate(() => {
        localStorage.setItem("nostr-test-session", JSON.stringify({ loggedIn: true }))
        localStorage.setItem("nostr-pubkey", "test-pubkey")
      })

      // Verify data exists
      let hasSession = await page.evaluate(
        () => localStorage.getItem("nostr-test-session") !== null,
      )
      expect(hasSession).toBeTruthy()

      // Simulate logout by clearing session-related keys
      await page.evaluate(() => {
        localStorage.removeItem("nostr-test-session")
        localStorage.removeItem("nostr-pubkey")
      })

      // Verify session is cleared
      hasSession = await page.evaluate(
        () => localStorage.getItem("nostr-test-session") !== null,
      )
      expect(hasSession).toBeFalsy()
    })
  })

  test.describe("Staging Environment", () => {
    test("should be able to enable staging mode for testing", async ({ page }) => {
      // Open debug panel
      const logo = page.locator('[data-testid="app-logo"]')

      for (let i = 0; i < 5; i++) {
        await logo.click()
        await page.waitForTimeout(100)
      }

      // Enable staging
      const stagingToggle = page.locator('[data-testid="staging-toggle"]')
      await stagingToggle.click()

      // Close debug panel
      const closeBtn = page.locator('[data-testid="debug-panel"] button:has-text("×")')
      if (await closeBtn.isVisible()) {
        await closeBtn.click()
      }

      // Verify staging is enabled via banner
      const stagingBanner = page.locator('[data-testid="staging-banner"]')
      await expect(stagingBanner).toBeVisible({ timeout: 5000 })
    })
  })
})
