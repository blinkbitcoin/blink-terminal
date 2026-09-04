/**
 * Helpers shared by the NIP-46 session routes.
 *
 * Not an API route itself — the leading underscore keeps Next from routing it.
 */

import type { NextApiRequest } from "next"

import { NIP46_COOKIE_NAME } from "../../../../lib/auth/cookies"
import { bindingMatches, sha256Hex } from "../../../../lib/nip46-server/sessionStore"

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
