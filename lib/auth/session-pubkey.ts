/**
 * Nostr session identity (server-side).
 *
 * Authenticated routes take the caller's Nostr pubkey from the `auth-token`
 * session cookie (username `nostr:<pubkey hex>`) — issued only after the
 * server verified a NIP-98 signature at login. The identity NEVER comes from
 * request headers or bodies (blink-wip#1679: `X-User-Npub` was a bare,
 * unsigned bearer value anyone could set).
 */

import { bech32 } from "bech32"
import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../auth"

const NOSTR_PUBKEY = /^[0-9a-f]{64}$/

/**
 * hex pubkey -> npub. Local bech32 encoding (same as nostr-tools'
 * nip19.npubEncode) because nostr-tools ships ESM that jest's CJS transform
 * cannot load, and this module is pulled into every boltcard/network test.
 */
function npubEncode(hexPubkey: string): string {
  return bech32.encode("npub", bech32.toWords(Buffer.from(hexPubkey, "hex")))
}

/** The Nostr pubkey (hex) of the authenticated session, or null. */
export function getSessionPubkey(req: NextApiRequest): string | null {
  const session = AuthManager.verifySession(req.cookies?.["auth-token"])
  const username = session?.username
  if (typeof username !== "string" || !username.startsWith("nostr:")) return null
  const pubkey = username.slice("nostr:".length).toLowerCase()
  return NOSTR_PUBKEY.test(pubkey) ? pubkey : null
}

/** Session pubkey (hex), or answers 401 and returns null. */
export function requireSessionPubkey(
  req: NextApiRequest,
  res: NextApiResponse,
): string | null {
  const pubkey = getSessionPubkey(req)
  if (!pubkey) {
    res.status(401).json({ error: "Authentication required" })
    return null
  }
  return pubkey
}

/** The session pubkey as npub, or null. Returns null for malformed sessions. */
export function getSessionNpub(req: NextApiRequest): string | null {
  const pubkey = getSessionPubkey(req)
  if (!pubkey) return null
  try {
    return npubEncode(pubkey)
  } catch (_err: unknown) {
    return null
  }
}

/**
 * Session npub, or answers 401 and returns null.
 *
 * Uses the network-route error envelope (`success: false`) so callers get the
 * same shape the old header-based auth produced.
 */
export function requireSessionNpub(
  req: NextApiRequest,
  res: NextApiResponse,
): string | null {
  const npub = getSessionNpub(req)
  if (!npub) {
    res.status(401).json({ success: false, error: "Authentication required" })
    return null
  }
  return npub
}

/**
 * Both session identity forms (hex pubkey + npub), or answers 401 and
 * returns null. For routes that store/need both (e.g. membership apply).
 */
export function requireSessionIdentity(
  req: NextApiRequest,
  res: NextApiResponse,
): { pubkey: string; npub: string } | null {
  const pubkey = getSessionPubkey(req)
  if (!pubkey) {
    res.status(401).json({ success: false, error: "Authentication required" })
    return null
  }
  return { pubkey, npub: npubEncode(pubkey) }
}
