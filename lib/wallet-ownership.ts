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
  | { ok: true; wallets: Map<string, string> }
  | { ok: false; reason: "invalid" | "unavailable" }

/**
 * The wallets the API key's account currently owns, as walletId → walletCurrency
 * ("BTC" | "USD"), fetched live from Blink.
 * - `invalid`: Blink refused the key (revoked / wrong / insufficient scope).
 * - `unavailable`: ownership could not be checked (network, 5xx, bad response).
 */
export async function getOwnedWallets(
  apiKey: string,
  environment: EnvironmentName,
): Promise<OwnedWalletsResult> {
  try {
    const wallets = await new BlinkAPI(
      apiKey,
      getApiUrlForEnvironment(environment),
    ).getWalletInfo()
    if (!Array.isArray(wallets)) return { ok: false, reason: "unavailable" }
    return {
      ok: true,
      wallets: new Map(
        wallets.map((wallet: { id: string; walletCurrency: string }) => [
          wallet.id,
          wallet.walletCurrency,
        ]),
      ),
    }
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
