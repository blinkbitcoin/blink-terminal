/**
 * Feature flags
 *
 * Centralized, build-time feature toggles. `NEXT_PUBLIC_*` variables are inlined
 * by Next.js at build time, so these helpers work identically on the server and
 * in the browser.
 *
 * @module config/features
 */

/**
 * Whether the Split Payments (tip splitting) feature is enabled.
 *
 * Split Payments currently requires an intermediate ("BlinkPOS" / escrow) account
 * that receives the customer payment and forwards it to the merchant and tip
 * recipients. That intermediate custody is being removed, so the feature is
 * disabled by default. When disabled, the authed POS mints invoices directly on
 * the merchant's own wallet (like the public POS) with no escrow and no tips.
 *
 * Set `NEXT_PUBLIC_SPLIT_PAYMENTS_ENABLED=true` to re-enable the (dormant) escrow
 * + forwarding code path. Any value other than the literal string "true" — including
 * unset — keeps the feature OFF.
 */
export function isSplitPaymentsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SPLIT_PAYMENTS_ENABLED === "true"
}

/**
 * Whether in-app password authentication is enabled on the sign-in screen.
 *
 * Sign-in is Nostr-only by default: users authenticate with an external Nostr
 * signer (remote signer / Nostr Connect, browser extension, or NIP-55). The
 * in-app password paths — "Sign in with Password" for returning users and
 * "Create New Account" (which generates a local Nostr key encrypted by a
 * password) — are hidden unless this flag is enabled.
 *
 * Set `NEXT_PUBLIC_ENABLE_PASSWORD_AUTH=true` to re-enable the (dormant) in-app
 * password sign-in and account-creation UI. Any value other than the literal
 * string "true" — including unset — keeps the feature OFF.
 */
export function isPasswordAuthEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_PASSWORD_AUTH === "true"
}
