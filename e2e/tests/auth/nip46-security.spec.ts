import { test, expect, type Page } from "@playwright/test"

import { TIMEOUTS } from "../../fixtures/test-data"
import { AuthPage } from "../../page-objects"

/**
 * NIP-46 modal tests (QR flow + modal chrome).
 *
 * The signer-initiated bunker:// flow and its "Mike Dilger attack" secret validation were
 * removed (nsec.app is discontinued and the flow had no users), so the security-rejection
 * suites that lived here went with them. These remaining tests cover the app-initiated
 * QR/deeplink flow only.
 *
 * Since issue #70 the nostrconnect:// URI is minted by the SERVER, which subscribes to the
 * signer's one-shot reply before handing the URI back. So there is deliberately no URI to
 * render until a relay is listening — which means these tests must stub the session endpoint
 * rather than depend on public relay reachability from CI.
 */

const SESSION_ID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
const FAKE_URI = `nostrconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.example&secret=deadbeef`

/** Stub a session that is created successfully and stays pending. */
async function stubReadySession(page: Page): Promise<void> {
  await page.route("**/api/nostr-connect/sessions", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: SESSION_ID,
        uri: FAKE_URI,
        expiresAt: Date.now() + 300_000,
      }),
    })
  })

  await page.route(`**/api/nostr-connect/sessions/${SESSION_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessionId: SESSION_ID, status: "pending" }),
    })
  })
}

/** Stub the fail-closed path: no relay could be reached. */
async function stubUnavailableRelays(page: Page): Promise<void> {
  await page.route("**/api/nostr-connect/sessions", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "No Nostr relay is reachable right now. Please try again.",
        reason: "relays_unavailable",
      }),
    })
  })
}

test.describe("NIP-46 Modal", () => {
  let authPage: AuthPage

  test.beforeEach(async ({ page }) => {
    authPage = new AuthPage(page)
    await authPage.goto()
  })

  test.describe("QR Code Flow (App-Initiated)", () => {
    test.beforeEach(async ({ page }) => {
      await stubReadySession(page)
    })

    test("should display QR code for scanning by mobile signer", async ({ page }) => {
      // Open Remote Signer flow
      await authPage.connectRemoteSignerButton.click()

      // The QR is a QRCodeSVG — an <svg>, not a <canvas>. Assert the rendered QR directly
      // (the previous canvas selector never matched, and this test passed vacuously via the
      // always-visible waiting-text fallback).
      const qr = page.getByTestId("nostr-connect-qr").locator("svg")
      await expect(qr).toBeVisible({ timeout: TIMEOUTS.medium })
    })

    test("should have option to open in desktop signer", async ({ page }) => {
      await authPage.connectRemoteSignerButton.click()

      const desktopSignerButton = page.locator(
        'button:has-text("Open in Desktop Signer")',
      )
      await expect(desktopSignerButton).toBeVisible({ timeout: TIMEOUTS.medium })
    })

    test("should have option to copy connection link", async ({ page }) => {
      await authPage.connectRemoteSignerButton.click()

      const copyLinkButton = page.locator('button:has-text("Copy Link")')
      await expect(copyLinkButton).toBeVisible({ timeout: TIMEOUTS.medium })
    })
  })

  test.describe("Relay availability", () => {
    /**
     * The URI is only useful if the server is already listening for the signer's
     * one-shot reply. When no relay is reachable there must be NO URI to scan or
     * copy — showing one would produce a sign-in that silently cannot complete.
     */
    test("shows an error and no QR when no relay is reachable", async ({ page }) => {
      await stubUnavailableRelays(page)

      await authPage.connectRemoteSignerButton.click()

      // The server's own message is shown when it supplies one; the client falls
      // back to its mapped copy for the reason code otherwise.
      await expect(page.locator("text=/no nostr relay is reachable/i")).toBeVisible({
        timeout: TIMEOUTS.medium,
      })
      await expect(page.getByTestId("nostr-connect-qr")).toHaveCount(0)
      await expect(page.locator('button:has-text("Copy Link")')).toHaveCount(0)
      await expect(page.locator('button:has-text("Try Again")')).toBeVisible()
    })
  })

  test.describe("Modal UI", () => {
    test("should be able to cancel the connection flow", async ({ page }) => {
      await stubReadySession(page)

      // Open Remote Signer flow
      await authPage.connectRemoteSignerButton.click()

      // Should have Cancel button
      const cancelButton = page.locator('button:has-text("Cancel")').first()
      await expect(cancelButton).toBeVisible({ timeout: TIMEOUTS.medium })

      // Click Cancel
      await cancelButton.click()

      // Modal should close (verify by checking if the main login buttons are visible again)
      await expect(authPage.connectRemoteSignerButton).toBeVisible({
        timeout: TIMEOUTS.short,
      })
    })
  })
})
