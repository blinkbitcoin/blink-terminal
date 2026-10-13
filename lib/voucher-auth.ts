/**
 * Voucher ownership (server-side).
 *
 * A voucher is owned by the voucher-wallet Blink API key that funded it: the
 * key is sent on create and stored (encrypted) with the voucher. Management
 * routes (list, cancel) require the caller to present that same key; create
 * requires the key to actually own the wallet it is drawn from.
 *
 * The voucher's id (chargeId) doubles as the LNURL-withdraw `k1` redemption
 * secret, so it must never be returned to anyone but the owner.
 */

import crypto from "crypto"

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

const digest = (value: string): Buffer =>
  crypto.createHash("sha256").update(value).digest()

/** Constant-time comparison of a presented key against a voucher's stored key. */
export function apiKeyMatches(
  stored: string | null | undefined,
  presented: string | null | undefined,
): boolean {
  if (!stored || !presented) return false
  return crypto.timingSafeEqual(digest(stored), digest(presented))
}

// Positive results only, short TTL: batch creation calls create N times in a row.
const OWNERSHIP_CACHE_TTL_MS = 5 * 60 * 1000
const OWNERSHIP_CACHE_MAX = 1000
const ownershipCache = new Map<string, number>()

const ownershipCacheKey = (apiKey: string, walletId: string, env: string): string =>
  crypto.createHash("sha256").update(`${env}\0${walletId}\0${apiKey}`).digest("hex")

/**
 * True if `apiKey` is a valid Blink API key whose account owns `walletId`.
 * Fails closed (false) on any API error.
 */
export async function apiKeyOwnsWallet(
  apiKey: string,
  walletId: string,
  environment: EnvironmentName,
): Promise<boolean> {
  const key = ownershipCacheKey(apiKey, walletId, environment)
  const cachedUntil = ownershipCache.get(key)
  if (cachedUntil && cachedUntil > Date.now()) return true

  try {
    const wallets = await new BlinkAPI(
      apiKey,
      getApiUrlForEnvironment(environment),
    ).getWalletInfo()
    const owns = wallets.some((wallet: { id: string }) => wallet.id === walletId)
    if (owns) {
      if (ownershipCache.size >= OWNERSHIP_CACHE_MAX) ownershipCache.clear()
      ownershipCache.set(key, Date.now() + OWNERSHIP_CACHE_TTL_MS)
    }
    return owns
  } catch {
    return false
  }
}

/** Test helper. */
export function clearOwnershipCache(): void {
  ownershipCache.clear()
}
