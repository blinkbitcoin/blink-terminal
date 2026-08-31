/**
 * Safe post-authentication redirect helper.
 *
 * The sign-in page accepts an optional `?redirect=` query param that says where
 * to send the user after they authenticate. Because that value is
 * attacker-controllable (it appears in a URL that can be shared/phished), it
 * must be validated before being handed to the router — otherwise it enables an
 * open redirect (`?redirect=https://evil.example`) usable for phishing.
 *
 * Rules for an accepted destination:
 *   - Must be a non-empty string starting with `/` (a same-origin absolute path).
 *   - Must contain no ASCII control characters. The URL parser strips TAB/LF/CR
 *     during normalization, so a value like `/\t/evil.example` (from an encoded
 *     `?redirect=/%09/evil.example`) would otherwise collapse to `//evil.example`
 *     and resolve cross-origin — an open redirect.
 *   - When resolved against a trusted sentinel origin, the result must stay on
 *     that origin. This is the authoritative same-origin check: it rejects
 *     absolute URLs (`https://…`), protocol-relative (`//host`), backslash
 *     variants (`/\host`), and any other normalization that escapes the origin.
 *   - Must NOT point back at the sign-in route itself (`/signin`, with any
 *     trailing slash / query / hash, any case). Redirecting an already
 *     authenticated visitor to `/signin` re-triggers the redirect effect and
 *     loops forever (perpetual spinner).
 *
 * Anything else falls back to the provided fallback (default `/`).
 *
 * @module auth/safe-redirect
 */

/** The sign-in route, excluded to avoid post-auth redirect loops. */
const SIGNIN_ROUTE = "/signin"

/**
 * Sentinel origin used only to resolve/validate relative paths. It is never
 * navigated to; a value is accepted only if it resolves to exactly this origin.
 */
const TRUSTED_ORIGIN = "https://blink-terminal.invalid"

/** ASCII control characters (C0 range plus DEL). */
// eslint-disable-next-line no-control-regex -- intentionally matching control chars to reject them
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

/**
 * Whether `value` is a safe same-origin internal path suitable as a redirect
 * target. Narrows to `string` for callers.
 */
export function isSafeInternalPath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value[0] !== "/") return false

  // Reject ASCII control chars up front: the URL parser strips TAB/LF/CR, which
  // could turn "/\t/evil" into "//evil" and escape the origin.
  if (CONTROL_CHARS.test(value)) return false

  // Authoritative same-origin check: resolve against a trusted sentinel origin
  // and require the normalized result to stay on it.
  let url: URL
  try {
    url = new URL(value, TRUSTED_ORIGIN)
  } catch {
    return false
  }
  if (url.origin !== TRUSTED_ORIGIN) return false

  // Reject the sign-in route itself (normalized pathname, any trailing slash),
  // since redirecting an authenticated user there loops.
  const pathname = url.pathname.toLowerCase()
  if (pathname === SIGNIN_ROUTE || pathname === `${SIGNIN_ROUTE}/`) return false

  return true
}

/**
 * Resolve a post-auth redirect target: returns `value` when it is a safe
 * same-origin internal path, otherwise the `fallback` (default `/`).
 */
export function safeInternalRedirect(value: unknown, fallback = "/"): string {
  return isSafeInternalPath(value) ? value : fallback
}
