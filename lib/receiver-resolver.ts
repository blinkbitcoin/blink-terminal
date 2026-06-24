/**
 * Receiver Resolver
 *
 * Resolves a merchant identifier (bare `username` or full `username@domain`)
 * to a receiving strategy, supporting BOTH custodial Blink accounts and
 * self-custodial Blink (Spark) accounts.
 *
 * Resolution rule (custodial-first, LNURL fallback):
 *   1. Custodial probe: Blink `accountDefaultWallet(username)`.
 *      - Returns a wallet id  => CUSTODIAL  (use on-behalf-of invoice flow).
 *   2. Self-custodial fallback: GET `{domain}/.well-known/lnurlp/{username}`.
 *      - Resolves (valid LUD-06 payResponse) => LNURL  (LNURL-pay flow).
 *   3. Neither => NOT FOUND.
 *
 * Why: a self-custodial Spark user has no custodial wallet, so
 * `accountDefaultWallet` returns nothing for them; but their Lightning address
 * (`username@blink.sv`) resolves via the Blink LNURL server, which mints an
 * invoice on behalf of their registered Spark pubkey. A single host (`blink.sv`)
 * serves both account types — the distinction is not encoded in the domain.
 *
 * Notes:
 * - Both input forms are accepted: bare `username` (probed as `username@<domain>`)
 *   and a full `username@domain`.
 * - If an explicit non-Blink domain is supplied, the custodial probe is skipped
 *   and the address is resolved purely as an external LNURL-pay address.
 * - Results are cached per (identifier, apiUrl) for the lifetime of the process
 *   (server-side module cache) to avoid repeated lookups within a session.
 *
 * Phase 1: production / `blink.sv` only. Staging is deferred.
 */

import BlinkAPI from "./blink-api"
import {
  fetchLnurlPayMetadata,
  parseLightningAddress,
  type LnurlPayMetadata,
} from "./lnurl"

// =============================================================================
// Types
// =============================================================================

export type ReceiverType = "custodial" | "lnaddress"

export interface CustodialReceiver {
  type: "custodial"
  /** Normalized Blink username (no domain, no protocol). */
  username: string
  /** Resolved custodial wallet id. */
  walletId: string
  /** Wallet currency (e.g. "BTC"). */
  walletCurrency: string
}

export interface LnAddressReceiver {
  type: "lnaddress"
  /** The full Lightning address used for resolution, e.g. `merchant@blink.sv`. */
  lightningAddress: string
  /** Local part of the address (username). */
  username: string
  /** Domain of the address. */
  domain: string
  /** Whether the domain is a known Blink domain (self-custodial Spark on blink.sv). */
  isBlinkDomain: boolean
  /** LNURL-pay metadata (callback, min/max sendable, etc.). */
  metadata: LnurlPayMetadata
}

export type ResolvedReceiver = CustodialReceiver | LnAddressReceiver

export interface ResolveReceiverOptions {
  /** Environment-specific GraphQL API URL (for the custodial probe). */
  apiUrl?: string | null
  /**
   * Lightning-address domain to use when the identifier is a bare username.
   * Defaults to "blink.sv" (production). Pass per-environment value if needed.
   */
  lnAddressDomain?: string
  /**
   * Known Blink domains; used to decide whether to run the custodial probe.
   * Defaults to ["blink.sv"].
   */
  blinkDomains?: string[]
  /** Preferred wallet currency for the custodial probe ("BTC" forces BTC wallet). */
  walletCurrency?: string
}

export class ReceiverNotFoundError extends Error {
  constructor(identifier: string) {
    super(`'${identifier}' is not a Blink address that exists.`)
    this.name = "ReceiverNotFoundError"
  }
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_LN_ADDRESS_DOMAIN = "blink.sv"
const DEFAULT_BLINK_DOMAINS = ["blink.sv"]

// Module-level resolution cache. Key: `${identifier}::${apiUrl}`.
const resolutionCache = new Map<string, ResolvedReceiver>()

// =============================================================================
// Helpers
// =============================================================================

/**
 * Normalize a raw identifier into `{ username, domain? }`.
 * Strips a `lightning:` prefix, trims, and lowercases the domain.
 */
export function normalizeIdentifier(raw: string): {
  username: string
  domain?: string
} {
  if (!raw || typeof raw !== "string") {
    throw new Error("Identifier is required")
  }

  let value = raw.trim()
  if (value.toLowerCase().startsWith("lightning:")) {
    value = value.slice("lightning:".length).trim()
  }

  // Strip a leading "₿" or "lnurlp://"-style noise is out of scope here; we only
  // accept username or username@domain forms for the POS receiver.
  if (value.includes("@")) {
    const parts = value.split("@")
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid Lightning address format: ${raw}`)
    }
    return { username: parts[0], domain: parts[1].toLowerCase() }
  }

  return { username: value }
}

function cacheKey(identifier: string, apiUrl: string | null | undefined): string {
  return `${identifier}::${apiUrl ?? ""}`
}

// =============================================================================
// Resolver
// =============================================================================

/**
 * Resolve a merchant identifier to a receiving strategy.
 *
 * @throws ReceiverNotFoundError when neither custodial nor LNURL resolution succeeds.
 */
export async function resolveReceiver(
  identifier: string,
  options: ResolveReceiverOptions = {},
): Promise<ResolvedReceiver> {
  const {
    apiUrl = null,
    lnAddressDomain = DEFAULT_LN_ADDRESS_DOMAIN,
    blinkDomains = DEFAULT_BLINK_DOMAINS,
    walletCurrency,
  } = options

  const { username, domain } = normalizeIdentifier(identifier)

  const key = cacheKey(
    `${username}@${domain ?? lnAddressDomain}:${walletCurrency ?? ""}`,
    apiUrl,
  )
  const cached = resolutionCache.get(key)
  if (cached) {
    return cached
  }

  const effectiveDomain = domain ?? lnAddressDomain
  const isBlinkDomain = blinkDomains.includes(effectiveDomain)

  // Step 1: custodial probe — only meaningful for Blink domains / bare usernames.
  if (isBlinkDomain) {
    try {
      const wallet =
        walletCurrency === "BTC"
          ? await BlinkAPI.getBtcWalletByUsername(username, apiUrl)
          : await BlinkAPI.getWalletByUsername(username, apiUrl)

      if (wallet?.id) {
        const resolved: CustodialReceiver = {
          type: "custodial",
          username,
          walletId: wallet.id,
          walletCurrency: wallet.currency,
        }
        resolutionCache.set(key, resolved)
        return resolved
      }
    } catch {
      // No custodial wallet (e.g. self-custodial Spark user, or unknown
      // username). Fall through to the LNURL probe.
    }
  }

  // Step 2: LNURL-pay fallback — resolves self-custodial Spark addresses on
  // blink.sv, as well as external Lightning addresses.
  const lightningAddress = `${username}@${effectiveDomain}`
  try {
    const { lnurlEndpoint } = parseLightningAddress(lightningAddress)
    const metadata = await fetchLnurlPayMetadata(lnurlEndpoint)

    const resolved: LnAddressReceiver = {
      type: "lnaddress",
      lightningAddress,
      username,
      domain: effectiveDomain,
      isBlinkDomain,
      metadata,
    }
    resolutionCache.set(key, resolved)
    return resolved
  } catch (lnurlErr) {
    console.warn(
      `[resolveReceiver] LNURL probe failed for ${lightningAddress}:`,
      lnurlErr instanceof Error ? lnurlErr.message : lnurlErr,
    )
    // Neither path resolved.
  }

  throw new ReceiverNotFoundError(identifier)
}

/** Clear the resolution cache (primarily for tests). */
export function clearReceiverResolutionCache(): void {
  resolutionCache.clear()
}

export default {
  resolveReceiver,
  normalizeIdentifier,
  clearReceiverResolutionCache,
  ReceiverNotFoundError,
}
