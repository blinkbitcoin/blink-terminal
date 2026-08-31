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
 *   - Must be a string.
 *   - Must start with a single `/` (a same-origin absolute path). This rejects
 *     absolute URLs (`https://…`), protocol-relative URLs (`//host`), and
 *     backslash-relative variants (`/\host`, `/\\host`) that some browsers
 *     normalize to `//host`.
 *   - Must NOT point back at the sign-in route itself. Redirecting an already
 *     authenticated visitor back to `/signin` re-triggers the same redirect
 *     effect and loops forever (perpetual spinner), so `/signin` (with any
 *     query/hash, any case) is rejected.
 *
 * Anything else falls back to the provided fallback (default `/`).
 *
 * @module auth/safe-redirect
 */

/** The sign-in route, excluded to avoid post-auth redirect loops. */
const SIGNIN_ROUTE = "/signin"

/**
 * Whether `value` is a safe same-origin internal path suitable as a redirect
 * target. Narrows to `string` for callers.
 */
export function isSafeInternalPath(value: unknown): value is string {
  if (typeof value !== "string") return false

  // Must be an absolute same-origin path: exactly one leading slash, and the
  // next char must not be `/` or `\` (which would make it protocol-relative).
  if (!/^\/(?![/\\])/.test(value)) return false

  // Reject the sign-in route itself (ignoring query string and hash), since
  // redirecting an authenticated user there loops.
  const pathname = value.split(/[?#]/, 1)[0].toLowerCase()
  if (pathname === SIGNIN_ROUTE) return false

  return true
}

/**
 * Resolve a post-auth redirect target: returns `value` when it is a safe
 * same-origin internal path, otherwise the `fallback` (default `/`).
 */
export function safeInternalRedirect(value: unknown, fallback = "/"): string {
  return isSafeInternalPath(value) ? value : fallback
}
