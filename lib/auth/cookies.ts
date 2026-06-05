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
