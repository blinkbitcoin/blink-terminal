/**
 * Live Blink wallet ownership (server-side).
 *
 * "Does this API key's account currently own wallet X?" — checked against
 * Blink on every call (no cache), so a revoked key stops working at once.
 * Shared by voucher and Bolt Card management.
 */

import { BlinkAPI, BlinkAuthError } from "./blink-api"
import { getApiUrlForEnvironment, type EnvironmentName } from "./config/api"

/** Normalize an untrusted environment value. */
export function toEnvironment(value: unknown): EnvironmentName {
  return value === "staging" ? "staging" : "production"
}

/** Outcome of a live ownership lookup. Callers must fail closed on `ok: false`. */
export type OwnedWalletsResult =
  | { ok: true; wallets: Map<string, OwnedWallet> }
  | { ok: false; reason: "invalid" | "unavailable" }

/** A wallet owned by the API key's account. */
export interface OwnedWallet {
  walletCurrency: string
  /**
   * Wallet balance in minor units (sats for BTC, cents for USD). Always a
   * finite number: a Blink response without one fails closed as
   * "unavailable", so a schema change can't bypass balance checks.
   */
  balance: number
}

/**
 * The wallets the API key's account currently owns, as
 * walletId → { walletCurrency, balance }, fetched live from Blink.
 * - `invalid`: Blink refused the key (revoked / wrong / insufficient scope).
 * - `unavailable`: ownership could not be checked (network, 5xx, bad response,
 *   or a wallet row without a finite balance — fail closed).
 */
export async function getOwnedWallets(
  apiKey: string,
  environment: EnvironmentName,
  signal?: AbortSignal,
): Promise<OwnedWalletsResult> {
  try {
    const wallets = await new BlinkAPI(
      apiKey,
      getApiUrlForEnvironment(environment),
    ).getWalletInfo(signal)
    if (!Array.isArray(wallets)) return { ok: false, reason: "unavailable" }
    const owned = new Map<string, OwnedWallet>()
    for (const wallet of wallets as {
      id: string
      walletCurrency: string
      balance: unknown
    }[]) {
      if (
        typeof wallet?.id !== "string" ||
        typeof wallet.walletCurrency !== "string" ||
        typeof wallet.balance !== "number" ||
        !Number.isFinite(wallet.balance)
      ) {
        return { ok: false, reason: "unavailable" }
      }
      owned.set(wallet.id, {
        walletCurrency: wallet.walletCurrency,
        balance: wallet.balance,
      })
    }
    return { ok: true, wallets: owned }
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof BlinkAuthError ? "invalid" : "unavailable",
    }
  }
}

/** Response for an ownership lookup that could not be completed. */
export const OWNERSHIP_UNAVAILABLE = {
  status: 503,
  body: { error: "Could not verify the wallet right now, please retry" },
} as const
