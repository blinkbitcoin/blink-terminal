import { test, expect } from "@playwright/test"

import { TIMEOUTS } from "../../fixtures/test-data"
import { AuthPage } from "../../page-objects"

/**
 * NIP-46 modal tests (QR flow + modal chrome).
 *
 * The signer-initiated bunker:// flow and its "Mike Dilger attack" secret validation were
 * removed (nsec.app is discontinued and the flow had no users), so the security-rejection
 * suites that lived here went with them. These remaining tests cover the app-initiated
 * QR/deeplink flow only.
 */

test.describe("NIP-46 Modal", () => {
  let authPage: AuthPage

  test.beforeEach(async ({ page }) => {
    authPage = new AuthPage(page)
    await authPage.goto()
  })

  test.describe("QR Code Flow (App-Initiated)", () => {
    test("should display QR code for scanning by mobile signer", async ({ page }) => {
      // Open Remote Signer flow
      await authPage.connectRemoteSignerButton.click()
      await page.waitForTimeout(1500)

      // The QR is a QRCodeSVG — an <svg>, not a <canvas>. Assert the rendered QR directly
      // (the previous canvas selector never matched, and this test passed vacuously via the
      // always-visible waiting-text fallback).
      const qr = page.getByTestId("nostr-connect-qr").locator("svg")
      await expect(qr).toBeVisible({ timeout: TIMEOUTS.short })
    })

    test("should have option to open in desktop signer", async ({ page }) => {
      // Open Remote Signer flow
      await authPage.connectRemoteSignerButton.click()
      await page.waitForTimeout(1000)

      // Should have "Open in Desktop Signer" button
      const desktopSignerButton = page.locator(
        'button:has-text("Open in Desktop Signer")',
      )
      await expect(desktopSignerButton).toBeVisible({ timeout: TIMEOUTS.short })
    })

    test("should have option to copy connection link", async ({ page }) => {
      // Open Remote Signer flow
      await authPage.connectRemoteSignerButton.click()
      await page.waitForTimeout(1000)

      // Should have "Copy Link" button
      const copyLinkButton = page.locator('button:has-text("Copy Link")')
      await expect(copyLinkButton).toBeVisible({ timeout: TIMEOUTS.short })
    })
  })

  test.describe("Modal UI", () => {
    test("should be able to cancel the connection flow", async ({ page }) => {
      // Open Remote Signer flow
      await authPage.connectRemoteSignerButton.click()
      await page.waitForTimeout(1000)

      // Should have Cancel button
      const cancelButton = page.locator('button:has-text("Cancel")').first()
      await expect(cancelButton).toBeVisible({ timeout: TIMEOUTS.short })

      // Click Cancel
      await cancelButton.click()

      // Modal should close (verify by checking if the main login buttons are visible again)
      await expect(authPage.connectRemoteSignerButton).toBeVisible({
        timeout: TIMEOUTS.short,
      })
    })
  })
})
