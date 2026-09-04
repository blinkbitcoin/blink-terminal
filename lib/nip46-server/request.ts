/**
 * Request helpers shared by the NIP-46 session routes.
 *
 * These live in lib/, not under pages/api. Next's Pages Router special-cases
 * only _app, _document and _error — every other file under pages/api becomes a
 * real route, so this module was being built and served as
 * /api/nostr-connect/sessions/_shared. It exports no default handler, so a
 * request to it would have thrown at runtime (PR #71 review).
 */

import type { NextApiRequest, NextApiResponse } from "next"

import { NIP46_COOKIE_NAME } from "../auth/cookies"

import { Nip46StorageError } from "./errors"
import { bindingMatches, sha256Hex } from "./sessionStore"

/**
 * Absolute origin of this request, used to derive the canonical NIP-98 `u`
 * value that the signer must sign. Mirrors the header handling in
 * /api/auth/nostr-login; trusting x-forwarded-* is only sound behind our own
 * proxy, which is how the app is deployed.
 */
export function getRequestOrigin(req: NextApiRequest): string {
  const protocol = req.headers["x-forwarded-proto"] || "http"
  const host = req.headers["x-forwarded-host"] || req.headers.host
  return `${protocol}://${host}`
}

/** Logged at most once per process, so a misconfigured deployment is not a log flood. */
let warnedInsecureOrigin = false

/**
 * Warn when this app is served over plain HTTP on a non-localhost origin.
 *
 * The NIP-46 binding cookie is `Secure`, so on such an origin the browser
 * silently DISCARDS it. Sign-in then fails in a way that looks like anything
 * but a cookie problem: the poll 404s (the caller is unbound), and because the
 * cookie never comes back, a retry cannot supersede the previous attempt
 * either, so sessions stack until the per-IP cap answers 429 instead.
 *
 * Browsers treat localhost/127.0.0.1 as a secure context, which is why this is
 * invisible in local development and on an HTTPS deployment — but a
 * self-hosted terminal reached over a LAN IP hits it every time. The client
 * shows the actionable message; this line makes it visible server-side too.
 */
export function warnIfInsecureOrigin(origin: string): void {
  if (warnedInsecureOrigin || !origin.startsWith("http://")) return

  // Strip the port without mangling a bracketed IPv6 literal, whose address
  // itself contains colons ("[::1]:3000" splits on ":" into "[").
  const authority = origin.slice("http://".length)
  const host = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : authority.split(":")[0]

  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return

  warnedInsecureOrigin = true
  console.warn(
    `[nip46] served over plain HTTP on a non-localhost origin (${origin}). ` +
      "The Secure sign-in cookie will be dropped by browsers and sign-in cannot " +
      "complete. Serve the terminal over HTTPS.",
  )
}

/** Test-only: forget that the insecure-origin warning was already emitted. */
export function __resetInsecureOriginWarningForTests(): void {
  warnedInsecureOrigin = false
}

export function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"]
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim()
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].split(",")[0].trim()
  }
  const realIp = req.headers["x-real-ip"]
  if (typeof realIp === "string" && realIp.length > 0) return realIp
  return req.socket?.remoteAddress || "unknown"
}

export function getBindingSecret(req: NextApiRequest): string | undefined {
  return req.cookies[NIP46_COOKIE_NAME]
}

/**
 * Whether the caller presented the binding cookie that created this session.
 *
 * Callers must treat a false result exactly like "session not found" — never
 * reveal that the id exists.
 */
export function isBoundCaller(req: NextApiRequest, bindingHash: string): boolean {
  const secret = getBindingSecret(req)
  return bindingMatches(bindingHash, secret ? sha256Hex(secret) : undefined)
}

export function getSessionId(req: NextApiRequest): string | null {
  const { id } = req.query
  const value = Array.isArray(id) ? id[0] : id
  if (!value || !/^[0-9a-f]{32}$/.test(value)) return null
  return value
}

/**
 * Turn a session-store outage into a retryable 503 rather than a 500 or, worse,
 * a 404 that tells the browser to throw away a session whose relay worker is
 * still running server-side.
 *
 * Returns true when it handled the error; the caller should rethrow otherwise.
 */
export function respondToStorageError(res: NextApiResponse, error: unknown): boolean {
  if (!(error instanceof Nip46StorageError)) return false
  console.error("[nip46] session store unavailable:", error.message)
  res.status(503).json({
    error: "Sign-in is temporarily unavailable. Please try again.",
    reason: "storage_unavailable",
  })
  return true
}
