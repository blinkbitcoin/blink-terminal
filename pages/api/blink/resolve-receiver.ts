import type { NextApiRequest, NextApiResponse } from "next"

/**
 * Receiver resolution API
 *
 * Resolves a Blink identifier (bare `username` or `username@domain`) to a
 * receiving strategy, supporting BOTH custodial Blink accounts and
 * self-custodial Blink (Spark) accounts via the shared `resolveReceiver` rule
 * (custodial probe → LNURL-pay fallback).
 *
 * Used by the username-validation gates (Public POS entry form, Public POS page
 * mount, and the authed "add LN address" flow) so that a self-custodial user —
 * who has no custodial `accountDefaultWallet` — is still recognized as a valid,
 * payable recipient because their Lightning address resolves on the Blink LNURL
 * server.
 *
 * Running the LNURL probe server-side avoids browser CORS/COEP issues fetching
 * `https://blink.sv/.well-known/lnurlp/{username}` from the client.
 *
 * Response:
 *   200 { exists: true,  type: "custodial" | "lnaddress",
 *         username, lightningAddress?, walletCurrency? }
 *   404 { exists: false, error }
 *
 * Environment: production / blink.sv only for now (staging deferred).
 */

import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_PUBLIC } from "../../../lib/rate-limit"
import {
  resolveReceiver,
  normalizeIdentifier,
  ReceiverNotFoundError,
} from "../../../lib/receiver-resolver"

// Production Lightning-address domain. Staging is deferred (see spark_term_plan.md).
const LN_ADDRESS_DOMAIN = "blink.sv"

// Allowed Blink Lightning-address domains. Any explicit non-Blink domain is
// rejected before any LNURL fetch to prevent this unauthenticated endpoint from
// being used as an SSRF / open LNURL proxy (resolveReceiver skips the custodial
// probe for non-Blink domains and would otherwise fetch attacker-controlled
// `.well-known/lnurlp` metadata).
const ALLOWED_BLINK_DOMAINS = ["blink.sv"]

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { username, walletCurrency, environment } = req.body as {
      username: string
      walletCurrency?: string
      environment?: EnvironmentName
    }

    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Username is required" })
    }

    // SSRF guard: reject any explicit non-Blink domain before touching the
    // network. Bare usernames and `user@blink.sv` are allowed; `user@evil.com`
    // is not.
    let parsedIdentifier
    try {
      parsedIdentifier = normalizeIdentifier(username)
    } catch {
      return res.status(400).json({ error: "Invalid username or Lightning address" })
    }
    if (
      parsedIdentifier.domain &&
      !ALLOWED_BLINK_DOMAINS.includes(parsedIdentifier.domain)
    ) {
      return res.status(400).json({
        error: `'${username}' is not a Blink address. Only ${LN_ADDRESS_DOMAIN} addresses are supported.`,
      })
    }

    const validEnvironment: EnvironmentName =
      environment === "staging" ? "staging" : "production"
    const apiUrl = getApiUrlForEnvironment(validEnvironment)

    let receiver
    try {
      receiver = await resolveReceiver(username, {
        apiUrl,
        lnAddressDomain: LN_ADDRESS_DOMAIN,
        walletCurrency,
      })
    } catch (resolveError: unknown) {
      if (resolveError instanceof ReceiverNotFoundError) {
        return res.status(404).json({
          exists: false,
          error: `'${username}' is not a Blink address that exists.`,
        })
      }
      const message =
        resolveError instanceof Error ? resolveError.message : "Unknown error"
      console.error("❌ Receiver resolution failed:", message)
      return res.status(502).json({ error: "Failed to resolve recipient." })
    }

    if (receiver.type === "custodial") {
      return res.status(200).json({
        exists: true,
        type: "custodial",
        username: receiver.username,
        walletCurrency: receiver.walletCurrency,
      })
    }

    return res.status(200).json({
      exists: true,
      type: "lnaddress",
      username: receiver.username,
      lightningAddress: receiver.lightningAddress,
      // Self-custodial Spark recipients receive in BTC/sats via the LN address.
      walletCurrency: "BTC",
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ resolve-receiver error:", error)
    return res.status(500).json({
      error: "Internal server error",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_PUBLIC)
