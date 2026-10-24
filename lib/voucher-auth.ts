/**
 * Voucher ownership (server-side).
 *
 * Authorization rule for every voucher management route: the presented Blink
 * API key, checked live against Blink, must currently own the voucher's wallet
 * (in the voucher's environment). Consequences:
 * - a revoked / rotated key stops working immediately (no cache);
 * - a replacement key that owns the same wallet can manage older vouchers.
 *
 * The voucher's id (chargeId) doubles as the LNURL-withdraw `k1` redemption
 * secret, so it must never be returned to anyone but the current owner.
 */

import type { NextApiRequest } from "next"

/** Request header carrying the voucher wallet's API key. */
export const VOUCHER_API_KEY_HEADER = "x-voucher-api-key"

const MAX_API_KEY_LENGTH = 512

/** Read the voucher API key from the request header (never from the query string). */
export function getVoucherApiKey(req: NextApiRequest): string | null {
  const raw = req.headers[VOUCHER_API_KEY_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_API_KEY_LENGTH) return null
  return trimmed
}

export {
  getOwnedWallets,
  OWNERSHIP_UNAVAILABLE,
  toEnvironment,
  type OwnedWalletsResult,
} from "./wallet-ownership"
