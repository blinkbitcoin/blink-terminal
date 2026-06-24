import type { NextApiRequest, NextApiResponse } from "next"

/**
 * Public Invoice Creation API — Lightning Address (LNURL-pay) path
 *
 * Creates a Lightning invoice for a merchant identified by a Lightning address
 * (or bare username resolved against the Blink LNURL server). This path serves
 * SELF-CUSTODIAL Blink (Spark) accounts — whose funds settle directly to their
 * own wallet — as well as external Lightning addresses. No authentication and
 * no merchant keys are required: the LNURL server mints the invoice on behalf
 * of the merchant's registered Spark pubkey.
 *
 * Custodial Blink users continue to use /api/blink/public-invoice (the
 * accountDefaultWallet + on-behalf-of mutation path). The receiver resolver
 * decides which path applies; this endpoint additionally guards against being
 * called for a custodial account.
 *
 * Returns a LUD-21 `verify` URL alongside the invoice so the POS can poll
 * settlement without an authenticated GraphQL call (see usePublicPOSPayment).
 *
 * Environment: production / blink.sv only for now (staging deferred).
 */

import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import { getInvoiceFromLightningAddress } from "../../../lib/lnurl"
import { withRateLimit, RATE_LIMIT_PUBLIC } from "../../../lib/rate-limit"
import {
  resolveReceiver,
  normalizeIdentifier,
  ReceiverNotFoundError,
} from "../../../lib/receiver-resolver"

// Maximum invoice amount (0.1 BTC), matching public-invoice.ts.
const MAX_SATS = 10000000

// Production Lightning-address domain. Staging is deferred (see spark_term_plan.md).
const LN_ADDRESS_DOMAIN = "blink.sv"

// Allowed Blink Lightning-address domains. Anything else is rejected BEFORE any
// LNURL fetch to prevent this unauthenticated endpoint from being used as an
// SSRF / open LNURL proxy (resolveReceiver skips the custodial probe for
// non-Blink domains and would otherwise fetch attacker-controlled
// `.well-known/lnurlp` metadata and follow its arbitrary `callback` URL).
const ALLOWED_BLINK_DOMAINS = ["blink.sv"]

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { username, amount, memo, environment } = req.body as {
      username: string
      amount: string | number
      memo?: string
      environment?: EnvironmentName
    }

    // Validate and sanitize environment (only production/staging; default production).
    const validEnvironment: EnvironmentName =
      environment === "staging" ? "staging" : "production"
    const apiUrl = getApiUrlForEnvironment(validEnvironment)

    if (!username) {
      return res.status(400).json({ error: "Username is required" })
    }

    // SSRF guard: reject any explicit non-Blink domain before touching the
    // network. Bare usernames and `user@blink.sv` are allowed; `user@evil.com`
    // is not. This endpoint only serves Blink (custodial/Spark) receivers.
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

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: "Valid amount is required (positive number)" })
    }

    const satsAmount = Math.round(parseFloat(String(amount)))
    if (satsAmount < 1) {
      return res.status(400).json({ error: "Minimum amount is 1 sat" })
    }
    if (satsAmount > MAX_SATS) {
      return res
        .status(400)
        .json({ error: `Maximum amount is ${MAX_SATS.toLocaleString()} sats (0.1 BTC)` })
    }

    const ipPrefix =
      ((req.headers["x-forwarded-for"] as string)?.split(",")[0] || "unknown").substring(
        0,
        10,
      ) + "..."

    console.log("📥 Public LN-address invoice request:", {
      username,
      amount: satsAmount,
      memo: memo?.substring(0, 50),
      environment: validEnvironment,
      ip: ipPrefix,
    })

    // Resolve the receiver. For self-custodial Spark users this returns an
    // "lnaddress" receiver; for custodial users it returns "custodial".
    let receiver
    try {
      receiver = await resolveReceiver(username, {
        apiUrl,
        lnAddressDomain: LN_ADDRESS_DOMAIN,
      })
    } catch (resolveError: unknown) {
      if (resolveError instanceof ReceiverNotFoundError) {
        return res.status(404).json({
          error: `'${username}' is not a Blink address that exists.`,
        })
      }
      const message =
        resolveError instanceof Error ? resolveError.message : "Unknown error"
      console.error("❌ Receiver resolution failed:", message)
      return res.status(502).json({ error: "Failed to resolve recipient." })
    }

    // This endpoint only handles the LNURL-pay (self-custodial / external) path.
    // Custodial receivers must use /api/blink/public-invoice.
    if (receiver.type === "custodial") {
      return res.status(409).json({
        error: "Custodial account — use /api/blink/public-invoice instead.",
        receiverType: "custodial",
      })
    }

    // Create the invoice via LNURL-pay against the resolved Lightning address.
    const invoiceMemo = memo || `Payment to ${username}`

    let invoice
    try {
      invoice = await getInvoiceFromLightningAddress(
        receiver.lightningAddress,
        satsAmount,
        invoiceMemo,
      )
    } catch (invoiceError: unknown) {
      const message =
        invoiceError instanceof Error ? invoiceError.message : "Unknown error"
      console.error("❌ LNURL invoice creation failed:", message)
      // Amount-bounds errors from the LNURL server are client-correctable.
      const isBounds = /minimum|maximum|below|exceeds/i.test(message)
      return res.status(isBounds ? 400 : 502).json({
        error: isBounds ? message : "Failed to create invoice. Please try again.",
      })
    }

    if (!invoice?.paymentRequest) {
      return res.status(502).json({ error: "Invoice creation returned empty result" })
    }

    console.log("✅ Public LN-address invoice created:", {
      username,
      lightningAddress: receiver.lightningAddress,
      hasVerify: Boolean(invoice.verify),
      environment: validEnvironment,
      invoicePrefix: invoice.paymentRequest.substring(0, 6),
    })

    return res.status(200).json({
      success: true,
      invoice: {
        paymentRequest: invoice.paymentRequest,
        paymentHash: invoice.paymentHash,
        satoshis: satsAmount,
        username,
        lightningAddress: receiver.lightningAddress,
        walletCurrency: "BTC",
        memo: invoiceMemo,
        // LUD-21 verify URL for settlement polling (may be undefined if the
        // LNURL server did not advertise one).
        verifyUrl: invoice.verify,
        expiresIn: 15 * 60,
        environment: validEnvironment,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Public LN-address invoice error:", error)
    return res.status(500).json({
      error: "Internal server error",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_PUBLIC)
