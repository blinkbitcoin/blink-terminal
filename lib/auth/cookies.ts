/**
 * Centralized session-cookie helpers.
 *
 * Single source of truth for the `auth-token` cookie attributes so every auth
 * route (legacy login, Nostr login, challenge verify, logout) stays consistent.
 *
 * Attributes:
 *   - HttpOnly             — not readable from JS (XSS exfiltration defense).
 *   - Secure (prod only)   — only sent over HTTPS in production. Left off in
 *                            development so local HTTP testing works.
 *   - SameSite=Lax         — blocks cookie attachment on cross-site POSTs (CSRF
 *                            defense) while still being delivered on the
 *                            top-level redirect back from external signer apps
 *                            (Amber/Nostash). SameSite=Strict would drop the
 *                            cookie on that cross-site redirect and break the
 *                            external-signer login flow.
 *   - Path=/               — valid for the whole app.
 *   - Max-Age=24h          — session lifetime (mirrors the JWT `expiresIn`).
 */

export const AUTH_COOKIE_NAME = "auth-token"
export const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 // 24 hours

/**
 * Short-lived, HttpOnly cookie carrying the challenge redemption secret.
 *
 * Issued by GET /api/auth/challenge and required by POST
 * /api/auth/verify-ownership. It binds the external-signer login to the browser
 * that requested the challenge: a signed challenge event phished from a victim
 * cannot be redeemed from a different browser because that browser lacks the
 * matching secret. SameSite=Lax so it survives the top-level redirect to/from
 * the external signer app (Amber), same as the session cookie.
 */
export const CHALLENGE_COOKIE_NAME = "blinkpos-challenge"
export const CHALLENGE_COOKIE_MAX_AGE_SECONDS = 300 // 5 minutes (matches TTL)

/**
 * Short-lived, HttpOnly cookie binding a server-held NIP-46 sign-in session to
 * the browser that created it.
 *
 * The status URL of a NIP-46 session is otherwise a bearer artifact: anyone who
 * obtained it (screenshot, pasted link, shared log) could poll it and consume
 * the approval. Every read/consume/cancel on a session requires this cookie, and
 * only its SHA-256 is stored server-side.
 *
 * SameSite=Strict (unlike the session and challenge cookies): this flow has no
 * cross-site redirect. Returning from Amber is an app switch back to the same
 * tab, not a navigation, and polling/consume are same-site fetches — so Strict
 * costs nothing here and removes cross-site delivery entirely.
 *
 * Path is scoped to the NIP-46 endpoints so it is not attached to unrelated
 * requests.
 */
export const NIP46_COOKIE_NAME = "blinkpos-nip46"
export const NIP46_COOKIE_PATH = "/api/nostr-connect"
export const NIP46_COOKIE_MAX_AGE_SECONDS = 300 // 5 minutes (matches session TTL)

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

/**
 * Build the Set-Cookie header value that establishes a session.
 */
export function buildSessionCookie(token: string): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`,
  ]
  if (isProduction()) {
    parts.push("Secure")
  }
  return parts.join("; ")
}

/**
 * Build the Set-Cookie header value that clears the session.
 * Attributes (except Max-Age) must match `buildSessionCookie` so browsers
 * reliably overwrite/expire the existing cookie.
 */
export function buildClearSessionCookie(): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
  ]
  if (isProduction()) {
    parts.push("Secure")
  }
  return parts.join("; ")
}

/**
 * Build the Set-Cookie header value that carries the challenge redemption
 * secret to the requesting browser.
 */
export function buildChallengeCookie(secret: string): string {
  const parts = [
    `${CHALLENGE_COOKIE_NAME}=${encodeURIComponent(secret)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${CHALLENGE_COOKIE_MAX_AGE_SECONDS}`,
  ]
  if (isProduction()) {
    parts.push("Secure")
  }
  return parts.join("; ")
}

/**
 * Build the Set-Cookie header value that clears the challenge cookie. Called on
 * successful redemption so the secret cannot be reused.
 */
export function buildClearChallengeCookie(): string {
  const parts = [
    `${CHALLENGE_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
  ]
  if (isProduction()) {
    parts.push("Secure")
  }
  return parts.join("; ")
}

/**
 * Build the Set-Cookie header value that binds a NIP-46 sign-in session to this
 * browser.
 */
export function buildNip46BindingCookie(secret: string): string {
  const parts = [
    `${NIP46_COOKIE_NAME}=${encodeURIComponent(secret)}`,
    "HttpOnly",
    `Path=${NIP46_COOKIE_PATH}`,
    "SameSite=Strict",
    `Max-Age=${NIP46_COOKIE_MAX_AGE_SECONDS}`,
  ]
  if (isProduction()) {
    parts.push("Secure")
  }
  return parts.join("; ")
}

/**
 * Build the Set-Cookie header value that clears the NIP-46 binding cookie.
 * Called once the session has been consumed or cancelled.
 */
export function buildClearNip46BindingCookie(): string {
  const parts = [
    `${NIP46_COOKIE_NAME}=`,
    "HttpOnly",
    `Path=${NIP46_COOKIE_PATH}`,
    "SameSite=Strict",
    "Max-Age=0",
  ]
  if (isProduction()) {
    parts.push("Secure")
  }
  return parts.join("; ")
}
