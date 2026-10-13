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

import { BlinkAPI } from "./blink-api"
import { getApiUrlForEnvironment, type EnvironmentName } from "./config/api"

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

/** Normalize an untrusted environment value. */
export function toEnvironment(value: unknown): EnvironmentName {
  return value === "staging" ? "staging" : "production"
}

/**
 * The wallets the API key's account currently owns, as walletId → walletCurrency
 * ("BTC" | "USD"), fetched live from Blink. `null` if the key is invalid or the
 * lookup fails (callers must fail closed).
 */
export async function getOwnedWallets(
  apiKey: string,
  environment: EnvironmentName,
): Promise<Map<string, string> | null> {
  try {
    const wallets = await new BlinkAPI(
      apiKey,
      getApiUrlForEnvironment(environment),
    ).getWalletInfo()
    if (!Array.isArray(wallets)) return null
    return new Map(
      wallets.map((wallet: { id: string; walletCurrency: string }) => [
        wallet.id,
        wallet.walletCurrency,
      ]),
    )
  } catch {
    return null
  }
}
