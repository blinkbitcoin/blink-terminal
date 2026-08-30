import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import BlinkAPI from "../../../lib/blink-api"
import { getApiUrlForEnvironment } from "../../../lib/config/api"
import { isSplitPaymentsEnabled } from "../../../lib/config/features"
import { getInvoiceFromLightningAddress } from "../../../lib/lnurl"
import NWCClient from "../../../lib/nwc/NWCClient"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"
import { getHybridStore } from "../../../lib/storage/hybrid-store"
import { getTracer, withSpan, getActiveTraceId } from "../../../lib/tracing"
import { createInvoiceSchema, validateBody } from "../../../lib/validation"

const tracer = getTracer("bbt-payment")

/**
 * Direct (non-escrow) invoice creation for the authed POS.
 *
 * With the intermediate BlinkPOS account removed, the authed POS mints invoices
 * directly on the merchant's own wallet — exactly like the public POS. There is
 * no escrow and no forwarding, so tips/splits are not applied here (the feature
 * is disabled while `isSplitPaymentsEnabled()` is false).
 *
 * Returns the invoice plus, where the destination is an LNURL-pay endpoint
 * (Blink Lightning address / npub.cash), a LUD-21 `verifyUrl` so the client can
 * poll settlement without our escrow record.
 */
async function createDirectMerchantInvoice(params: {
  amountSats: number
  memo: string
  apiUrl: string
  apiKey?: string
  userWalletId?: string
  blinkLnAddress?: boolean
  blinkLnAddressUsername?: string | null
  npubCashActive?: boolean
  npubCashLightningAddress?: string | null
  nwcActive?: boolean
  nwcConnectionUri?: string | null
}): Promise<{
  paymentRequest: string
  paymentHash?: string
  satoshis?: number
  verifyUrl?: string
}> {
  const {
    amountSats,
    memo,
    apiUrl,
    apiKey,
    userWalletId,
    blinkLnAddress,
    blinkLnAddressUsername,
    npubCashActive,
    npubCashLightningAddress,
    nwcActive,
    nwcConnectionUri,
  } = params

  // 1) Blink Lightning-address merchant (custodial or self-custodial/Spark) —
  //    mint via LNURL-pay directly on the merchant's address. Returns a LUD-21
  //    verify URL for settlement polling.
  if (blinkLnAddress && blinkLnAddressUsername) {
    const invoice = await getInvoiceFromLightningAddress(
      `${blinkLnAddressUsername}@blink.sv`,
      amountSats,
      memo,
    )
    return {
      paymentRequest: invoice.paymentRequest,
      paymentHash: invoice.paymentHash,
      satoshis: amountSats,
      verifyUrl: invoice.verify,
    }
  }

  // 2) npub.cash merchant — LNURL-pay against their lightning address.
  if (npubCashActive && npubCashLightningAddress) {
    const invoice = await getInvoiceFromLightningAddress(
      npubCashLightningAddress,
      amountSats,
      memo,
    )
    return {
      paymentRequest: invoice.paymentRequest,
      paymentHash: invoice.paymentHash,
      satoshis: amountSats,
      verifyUrl: invoice.verify,
    }
  }

  // 3) NWC merchant — make the invoice on the merchant's own wallet.
  if (nwcActive && nwcConnectionUri) {
    const nwcClient = new NWCClient(nwcConnectionUri)
    try {
      const result = await nwcClient.makeInvoice({
        amount: amountSats * 1000, // NWC uses millisats
        description: memo,
        expiry: 3600,
      })
      if (result.error || !result.result?.invoice) {
        throw new Error(result.error?.message || "NWC make_invoice failed")
      }
      return {
        paymentRequest: result.result.invoice,
        paymentHash: result.result.payment_hash,
        satoshis: amountSats,
      }
    } finally {
      nwcClient.close()
    }
  }

  // 4) Blink API-key merchant — mint directly on the merchant's own BTC wallet.
  if (apiKey && userWalletId) {
    const merchantApi = new BlinkAPI(apiKey, apiUrl)
    const invoice = await merchantApi.createLnInvoice(userWalletId, amountSats, memo)
    if (!invoice?.paymentRequest) {
      throw new Error("Failed to create invoice on merchant wallet")
    }
    return {
      paymentRequest: invoice.paymentRequest,
      paymentHash: invoice.paymentHash,
      satoshis: invoice.satoshis ?? amountSats,
    }
  }

  throw new Error(
    "No usable merchant destination (api key + wallet, NWC, Blink LN address, or npub.cash) provided",
  )
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  return withSpan(tracer, "invoice.create", async (rootSpan) => {
    // Set trace ID response header for request correlation
    const traceId = getActiveTraceId()
    if (traceId) {
      res.setHeader("X-Trace-Id", traceId)
    }

    try {
      // Validate + coerce the request body against the shared Zod schema.
      const parsed = validateBody(req, res, createInvoiceSchema)
      if (!parsed) return // 400 already sent

      const {
        amount,
        currency,
        memo,
        walletId,
        apiKey,
        userWalletId,
        displayCurrency,
        baseAmount,
        tipAmount,
        tipPercent,
        baseAmountDisplay,
        tipAmountDisplay,
        nwcActive,
        nwcConnectionUri, // NWC connection string for server-side forwarding
        // Blink Lightning Address wallet fields (no API key required)
        blinkLnAddress,
        blinkLnAddressWalletId,
        blinkLnAddressUsername,
        // npub.cash wallet fields (intraledger via LNURL-pay)
        npubCashActive,
        npubCashLightningAddress,
        // Environment for staging/production switching
        environment = "production",
      } = parsed
      const tipRecipients = (parsed.tipRecipients || []) as Array<{
        username: string
        share?: number
      }>

      // Get the API URL for the specified environment
      const apiUrl = getApiUrlForEnvironment(environment)

      rootSpan.setAttribute("invoice.amount", parseFloat(String(amount)) || 0)
      rootSpan.setAttribute("invoice.currency", currency || "unknown")
      rootSpan.setAttribute("invoice.environment", environment)
      rootSpan.setAttribute("invoice.has_tip", (tipAmount ?? 0) > 0)
      rootSpan.setAttribute("invoice.tip_recipients_count", tipRecipients?.length || 0)
      rootSpan.setAttribute(
        "invoice.forwarding_type",
        blinkLnAddress
          ? "ln_address"
          : npubCashActive
            ? "npub_cash"
            : nwcActive
              ? "nwc"
              : apiKey
                ? "api_key"
                : "unknown",
      )

      console.log("📥 Create invoice request received:", {
        amount,
        currency,
        displayCurrency,
        tipAmount,
        tipRecipients: tipRecipients?.length || 0,
        hasBaseAmountDisplay: !!baseAmountDisplay,
        hasTipAmountDisplay: !!tipAmountDisplay,
        nwcActive: !!nwcActive,
        hasNwcConnectionUri: !!nwcConnectionUri,
        hasApiKey: !!apiKey,
        blinkLnAddress: !!blinkLnAddress,
        blinkLnAddressUsername,
        npubCashActive: !!npubCashActive,
        npubCashLightningAddress: npubCashLightningAddress || undefined,
        environment,
        apiUrl,
      })

      // Validate required fields
      // For NWC-only, LN Address, or npub.cash users, apiKey is not required
      if (!amount || !currency) {
        return res.status(400).json({
          error: "Missing required fields: amount, currency",
        })
      }

      // Either apiKey OR nwcActive OR blinkLnAddress OR npubCashActive must be present for payment forwarding
      if (!apiKey && !nwcActive && !blinkLnAddress && !npubCashActive) {
        return res.status(400).json({
          error:
            "Missing payment forwarding: either apiKey, nwcActive, blinkLnAddress, or npubCashAddress required",
        })
      }

      // Validate amount: whole sats, bounded like public-invoice (0.1 BTC max).
      // Shared by both the direct (no-escrow) and legacy escrow paths below.
      const numericAmount = parseFloat(String(amount))
      if (isNaN(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({
          error: "Invalid amount: must be a positive number",
        })
      }
      if (!Number.isInteger(numericAmount)) {
        return res.status(400).json({
          error: "Invalid amount: must be a whole number of sats",
        })
      }
      if (numericAmount > 10000000) {
        return res.status(400).json({
          error: "Maximum amount is 10,000,000 sats (0.1 BTC)",
        })
      }

      if (currency !== "BTC" && currency !== "USD") {
        return res.status(400).json({
          error: "Unsupported currency. Only BTC or USD is supported.",
        })
      }

      // ─── DIRECT (no-escrow) PATH ──────────────────────────────────────────
      // The intermediate BlinkPOS account has been removed for compliance. While
      // Split Payments is disabled, the authed POS mints invoices directly on the
      // merchant's own wallet (like the public POS): no escrow, no forwarding, no
      // tips. The escrow path below is retained but dormant behind the flag.
      if (!isSplitPaymentsEnabled()) {
        rootSpan.setAttribute("invoice.mode", "direct")
        try {
          const direct = await createDirectMerchantInvoice({
            amountSats: Math.round(numericAmount),
            memo: memo || "",
            apiUrl,
            apiKey,
            userWalletId: userWalletId || walletId || undefined,
            blinkLnAddress,
            blinkLnAddressUsername,
            npubCashActive,
            npubCashLightningAddress,
            nwcActive,
            nwcConnectionUri,
          })

          rootSpan.setAttribute("invoice.payment_hash", direct.paymentHash || "")
          rootSpan.setAttribute("invoice.satoshis", direct.satoshis || 0)

          return res.status(200).json({
            success: true,
            invoice: {
              paymentRequest: direct.paymentRequest,
              paymentHash: direct.paymentHash,
              satoshis: direct.satoshis ?? Math.round(numericAmount),
              amount: Math.round(numericAmount),
              currency,
              memo: memo || "",
              // Direct-receive settlement detection: LUD-21 verify URL when the
              // destination is an LNURL-pay address; otherwise the client polls
              // the public lnInvoicePaymentStatus query by payment request.
              ...(direct.verifyUrl && { verifyUrl: direct.verifyUrl }),
            },
          })
        } catch (directError: unknown) {
          const message =
            directError instanceof Error ? directError.message : "Unknown error"
          console.error("❌ Direct invoice creation failed:", message)
          return res.status(502).json({
            error: "Failed to create invoice on merchant wallet.",
            details: process.env.NODE_ENV === "development" ? message : undefined,
          })
        }
      }
      // ─── LEGACY ESCROW PATH (dormant while Split Payments disabled) ────────

      // Get BlinkPOS credentials from environment.
      // A single pair of env vars is used across staging and production; each
      // deployment is responsible for setting these to the credentials that
      // match its target Blink instance. The `environment` value still selects
      // the Blink GraphQL URL via `getApiUrlForEnvironment`.
      const blinkposApiKey = process.env.BLINKPOS_API_KEY
      const blinkposBtcWalletId = process.env.BLINKPOS_BTC_WALLET_ID

      console.log("🔐 BlinkPOS credentials check:", {
        environment,
        hasApiKey: !!blinkposApiKey,
        apiKeyLength: blinkposApiKey ? blinkposApiKey.length : 0,
        hasWalletId: !!blinkposBtcWalletId,
        walletIdLength: blinkposBtcWalletId ? blinkposBtcWalletId.length : 0,
      })

      if (!blinkposApiKey || !blinkposBtcWalletId) {
        console.error("Missing BlinkPOS environment variables")
        return res.status(500).json({
          error: "BlinkPOS configuration missing",
        })
      }

      console.log("Creating invoice with BlinkPOS credentials:", {
        amount: numericAmount,
        currency,
        blinkposWallet: blinkposBtcWalletId,
        userWallet: userWalletId,
        hasTip: (tipAmount ?? 0) > 0,
        tipRecipientsCount: tipRecipients?.length || 0,
        blinkLnAddress: !!blinkLnAddress,
        blinkLnAddressUsername,
        npubCashActive: !!npubCashActive,
        npubCashLightningAddress: npubCashLightningAddress || undefined,
      })

      // Always use BlinkPOS API and BTC wallet for invoice creation
      // Pass the environment-specific API URL
      const blinkAPI = new BlinkAPI(blinkposApiKey, apiUrl)

      let invoice

      try {
        // Always create BTC invoice from BlinkPOS wallet (even for USD payments)
        if (currency === "BTC" || currency === "USD") {
          invoice = await blinkAPI.createLnInvoice(
            blinkposBtcWalletId,
            Math.round(numericAmount),
            memo,
          )
        } else {
          return res.status(400).json({
            error: "Unsupported currency. Only BTC or USD is supported through BlinkPOS.",
          })
        }

        if (!invoice) {
          throw new Error("Failed to create invoice")
        }

        rootSpan.setAttribute("invoice.payment_hash", invoice.paymentHash || "")
        rootSpan.setAttribute("invoice.satoshis", invoice.satoshis || 0)

        // Store payment metadata (using hybrid storage)
        // ALWAYS store forwarding data so webhook-based forwarding can work even if client disconnects
        // This enables reliable payment forwarding regardless of client connection state
        const hasForwardingDestination =
          apiKey || nwcActive || blinkLnAddress || npubCashActive
        const hasTips = (tipAmount ?? 0) > 0 && tipRecipients && tipRecipients.length > 0
        const shouldStorePaymentData = hasForwardingDestination || hasTips

        if (shouldStorePaymentData) {
          const hybridStore = await getHybridStore()

          // Encrypt NWC URI if present (contains sensitive private key)
          const encryptedNwcUri = nwcConnectionUri
            ? AuthManager.encryptApiKey(nwcConnectionUri)
            : null

          // Encrypt user API key if present (sensitive credential)
          const encryptedApiKey = apiKey ? AuthManager.encryptApiKey(apiKey) : undefined

          await hybridStore.storeTipData(invoice.paymentHash, {
            baseAmount: baseAmount || numericAmount,
            tipAmount: tipAmount || 0,
            tipPercent: tipPercent || 0,
            tipRecipients: (tipRecipients || []).map((r) => ({
              username: r.username,
              share: r.share ?? 100,
            })),
            userApiKey: encryptedApiKey, // Encrypted — decrypted on read by hybrid-store
            userWalletId: userWalletId || walletId || undefined, // May be undefined for NWC-only, LN Address, or npub.cash users
            displayCurrency: displayCurrency || "BTC", // Store display currency for tip memo
            baseAmountDisplay:
              baseAmountDisplay != null ? String(baseAmountDisplay) : undefined,
            tipAmountDisplay:
              tipAmountDisplay != null ? String(tipAmountDisplay) : undefined,
            memo: memo,
            nwcActive: !!nwcActive, // Flag for NWC forwarding
            nwcConnectionUri: encryptedNwcUri, // Encrypted NWC connection string for server-side forwarding
            // Lightning Address wallet info
            blinkLnAddress: !!blinkLnAddress,
            blinkLnAddressWalletId: blinkLnAddressWalletId || null,
            blinkLnAddressUsername: blinkLnAddressUsername || null,
            // npub.cash wallet info (intraledger via LNURL-pay)
            npubCashActive: !!npubCashActive,
            npubCashLightningAddress: npubCashLightningAddress || null,
            // Environment for staging/production (used by webhook forwarding)
            environment: environment || "production",
            // Metadata for webhook processing
            createdAt: Date.now(),
            forwardingType: blinkLnAddress
              ? "ln_address"
              : npubCashActive
                ? "npub_cash"
                : nwcActive
                  ? "nwc"
                  : apiKey
                    ? "api_key"
                    : "unknown",
          })
          console.log(
            `✅ Stored forwarding data for ${invoice.paymentHash?.substring(0, 16)}... (type: ${blinkLnAddress ? "ln_address" : npubCashActive ? "npub_cash" : nwcActive ? "nwc" : "api_key"}, hasTip: ${(tipAmount ?? 0) > 0}, hasNwcUri: ${!!encryptedNwcUri})`,
          )
        }

        // Return invoice details with additional metadata for payment forwarding
        res.status(200).json({
          success: true,
          invoice: {
            paymentRequest: invoice.paymentRequest,
            paymentHash: invoice.paymentHash,
            satoshis: invoice.satoshis,
            amount: numericAmount,
            currency: currency,
            memo: memo || "",
            walletId: blinkposBtcWalletId, // This is now the BlinkPOS wallet
            userApiKey: apiKey || null, // May be null for NWC-only, LN Address, or npub.cash users
            userWalletId: userWalletId || walletId || null, // May be null for NWC-only, LN Address, or npub.cash users
            hasTip: (tipAmount ?? 0) > 0,
            tipAmount: tipAmount || 0,
            tipRecipients: tipRecipients || [],
            nwcActive: !!nwcActive, // Flag for NWC forwarding
            // Lightning Address wallet info
            blinkLnAddress: !!blinkLnAddress,
            blinkLnAddressWalletId: blinkLnAddressWalletId || null,
            blinkLnAddressUsername: blinkLnAddressUsername || null,
            // npub.cash wallet info
            npubCashActive: !!npubCashActive,
            npubCashLightningAddress: npubCashLightningAddress || null,
          },
        })
      } catch (blinkError: unknown) {
        const blinkMessage =
          blinkError instanceof Error ? blinkError.message : "Unknown error"
        console.error("Blink API error:", blinkError)

        // Handle specific Blink API errors
        let errorMessage = "Failed to create invoice"
        if (blinkMessage.includes("amount")) {
          errorMessage = "Invalid amount for invoice creation"
        } else if (blinkMessage.includes("wallet")) {
          errorMessage = "Invalid wallet selected"
        } else if (blinkMessage.includes("balance")) {
          errorMessage = "Insufficient balance or wallet issue"
        }

        return res.status(400).json({
          error: errorMessage,
          details: blinkMessage,
        })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("Invoice creation error:", error)
      res.status(500).json({
        error: "Internal server error",
        details: process.env.NODE_ENV === "development" ? message : undefined,
      })
    }
  })
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "blink/create-invoice")
