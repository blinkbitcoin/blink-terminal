import { Page, Locator, expect } from "@playwright/test"

import { SELECTORS, TIMEOUTS, TEST_CREDENTIALS } from "../fixtures/test-data"

import { BasePage } from "./BasePage"

/**
 * Page object for the authentication/login page
 *
 * The modern BBT login page uses multiple Nostr authentication methods:
 * - NIP-46 Remote Signer (Nostr Connect)
 * - Browser Extension (keys.band, Alby)
 * - NIP-55 external signer (Amber)
 *
 * In-app account creation and password sign-in are gated behind
 * NEXT_PUBLIC_ENABLE_PASSWORD_AUTH (off by default), so those locators/helpers
 * only resolve when that flag is enabled.
 */
export class AuthPage extends BasePage {
  // Main auth buttons
  readonly connectRemoteSignerButton: Locator
  readonly createAccountButton: Locator
  readonly signInWithPasswordButton: Locator
  readonly extensionSignInButton: Locator

  // Debug panel elements
  readonly debugPanel: Locator
  readonly stagingToggle: Locator
  readonly productionToggle: Locator

  // Logo for debug panel access (tap 5 times)
  readonly logo: Locator

  // Create account form
  readonly passwordInput: Locator
  readonly confirmPasswordInput: Locator
  readonly createAccountSubmitButton: Locator
  readonly backButton: Locator

  // Legacy selectors (for backwards compatibility)
  readonly nsecInput: Locator
  readonly loginButton: Locator

  constructor(page: Page) {
    super(page)

    // Main authentication buttons
    this.connectRemoteSignerButton = page
      .locator(
        'button:has-text("Connect with Remote Signer"), button:has-text("Connect with Nostr Connect")',
      )
      .first()
    this.createAccountButton = page.locator('button:has-text("Create New Account")')
    this.signInWithPasswordButton = page.locator(
      'button:has-text("Sign in with Password")',
    )
    this.extensionSignInButton = page.locator('button:has-text("Sign in with Extension")')

    // Debug panel
    this.debugPanel = page.locator('[data-testid="debug-panel"]')
    this.stagingToggle = page.locator('[data-testid="staging-toggle"]')
    this.productionToggle = page.locator('[data-testid="production-toggle"]')
    this.logo = page.locator('[data-testid="app-logo"]')

    // Create account form elements
    this.passwordInput = page.locator(
      '#password, input[placeholder*="Enter a strong password"]',
    )
    this.confirmPasswordInput = page.locator(
      '#confirmPassword, input[placeholder*="Confirm"]',
    )
    this.createAccountSubmitButton = page.locator(
      'button[type="submit"]:has-text("Create Account")',
    )
    this.backButton = page.locator('button:has-text("← Back"), button:has-text("Back")')

    // Legacy - these may not exist in modern UI but kept for compatibility
    this.nsecInput = page.locator(SELECTORS.auth.nsecInput)
    this.loginButton = page.locator(SELECTORS.auth.loginButton)
  }

  /**
   * Navigate to the login page
   */
  async goto() {
    await super.goto("/")
    await this.waitForLoad()
  }

  /**
   * Open debug panel by tapping logo 5 times
   */
  async openDebugPanel() {
    for (let i = 0; i < 5; i++) {
      await this.logo.click()
      await this.page.waitForTimeout(100) // Small delay between taps
    }
    await this.debugPanel.waitFor({ state: "visible", timeout: TIMEOUTS.short })
  }

  /**
   * Close debug panel
   */
  async closeDebugPanel() {
    const closeBtn = this.page.locator('[data-testid="debug-panel"] button:has-text("×")')
    if (await closeBtn.isVisible()) {
      await closeBtn.click()
      await this.page.waitForTimeout(300)
    }
  }

  /**
   * Switch to staging environment via debug panel
   */
  async switchToStaging() {
    await this.openDebugPanel()
    await this.stagingToggle.click()
    await this.page.waitForTimeout(500) // Wait for localStorage update
    await this.closeDebugPanel()

    // Verify staging banner appears
    await expect(this.stagingBanner).toBeVisible({ timeout: TIMEOUTS.short })
  }

  /**
   * Switch to production environment via debug panel
   */
  async switchToProduction() {
    await this.openDebugPanel()
    await this.productionToggle.click()
    await this.page.waitForTimeout(500)
    await this.closeDebugPanel()

    // Verify staging banner is hidden
    await expect(this.stagingBanner).not.toBeVisible({ timeout: TIMEOUTS.short })
  }

  /**
   * Start the create account flow
   */
  async startCreateAccount() {
    await this.createAccountButton.click()
    await this.passwordInput.waitFor({ state: "visible", timeout: TIMEOUTS.medium })
  }

  /**
   * Create a new account with password
   */
  async createAccountWithPassword(password: string) {
    await this.startCreateAccount()
    await this.passwordInput.fill(password)
    await this.confirmPasswordInput.fill(password)
    await this.createAccountSubmitButton.click()

    // Wait for account creation to complete
    await this.page.waitForTimeout(3000)
  }

  /**
   * Start the Nostr Connect (remote signer) flow
   */
  async startNostrConnect() {
    await this.connectRemoteSignerButton.click()
    // Modal should appear
    await this.page.waitForTimeout(1000)
  }

  /**
   * Check if login form/page is displayed
   * In the modern UI, this means sign-in method buttons are visible
   */
  async isLoginFormVisible(): Promise<boolean> {
    try {
      // Check for any of the main authentication buttons
      const hasRemoteSigner = await this.connectRemoteSignerButton
        .isVisible()
        .catch(() => false)
      const hasCreateAccount = await this.createAccountButton
        .isVisible()
        .catch(() => false)
      const hasPasswordSignIn = await this.signInWithPasswordButton
        .isVisible()
        .catch(() => false)

      return hasRemoteSigner || hasCreateAccount || hasPasswordSignIn
    } catch {
      return false
    }
  }

  /**
   * Check if the create account form is visible
   */
  async isCreateAccountFormVisible(): Promise<boolean> {
    try {
      await this.passwordInput.waitFor({ state: "visible", timeout: TIMEOUTS.short })
      return true
    } catch {
      return false
    }
  }

  /**
   * Go back from create account form to main view
   */
  async goBackToMain() {
    if (await this.backButton.isVisible()) {
      await this.backButton.click()
      await this.page.waitForTimeout(500)
    }
  }

  /**
   * Legacy: Login with Nostr nsec key
   * Note: The modern UI doesn't have direct nsec input,
   * this is kept for backwards compatibility
   */
  async loginWithNsec(nsec: string = TEST_CREDENTIALS.nostr.nsec) {
    // First switch to staging if needed
    if (!(await this.isStagingMode())) {
      await this.switchToStaging()
    }

    // In modern UI, we'd need to use external signer
    // This method may not work with the new UI
    if (await this.nsecInput.isVisible()) {
      await this.nsecInput.fill(nsec)
      await this.loginButton.click()
      await this.page.waitForURL(/.*(?<!\/login)$/, { timeout: TIMEOUTS.long })
    }
  }

  /**
   * Check for login errors
   */
  async hasLoginError(): Promise<boolean> {
    const errorLocator = this.page.locator(
      '[data-testid="login-error"], .text-red-600, .text-red-400, [role="alert"]',
    )
    return errorLocator.isVisible().catch(() => false)
  }

  /**
   * Get login error message
   */
  async getLoginErrorMessage(): Promise<string> {
    const errorEl = this.page
      .locator('[data-testid="login-error"], .text-red-600, .text-red-400')
      .first()
    if (await errorEl.isVisible()) {
      return (await errorEl.textContent()) || ""
    }
    return ""
  }
}
