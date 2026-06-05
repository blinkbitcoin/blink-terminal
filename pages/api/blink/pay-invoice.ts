import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI from "../../../lib/blink-api"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import { assertWithinMaxForward, verifyForwardInvoice } from "../../../lib/payout-guard"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"
import { getHybridStore, type HybridStore } from "../../../lib/storage/hybrid-store"
import { paymentHashSchema } from "../../../lib/validation"

/**
 * API endpoint to pay a lightning invoice from BlinkPOS account
 * Used for forwarding the base amount to NWC wallets.
 *
 * SECURITY: This endpoint only pays an invoice that:
 *   1. Corresponds to a stored payment in the `processing` state (claimed by
 *      /api/blink/forward-nwc-with-tips). This binds the payout to a real,
 *      customer-funded payment and prevents arbitrary payouts.
 *   2. Encodes the EXACT stored `baseAmount` (no amountless / inflated invoices).
 *   3. Is destined for a Blink node (NWC forwarding is intraledger / zero-fee),
 *      preventing routing-fee drain and off-network exfiltration.
 *
 * POST /api/blink/pay-invoice
 * Body: { paymentHash: string, invoice: string, memo?: string }
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  let hybridStore: HybridStore | null = null
  let paymentHash: string | null = null

  try {
    // SECURITY: Require a well-formed paymentHash.
    const hashParse = paymentHashSchema.safeParse(req.body?.paymentHash)
    if (!hashParse.success) {
      console.error("❌ SECURITY: Missing/invalid paymentHash - rejecting request")
      return res.status(401).json({
        error: "Unauthorized: a valid paymentHash is required",
      })
    }
    paymentHash = hashParse.data

    // Support both 'invoice' and 'paymentRequest' field names for compatibility
    const {
      invoice: invoiceField,
      paymentRequest,
      memo = "",
      environment: reqEnvironment = "production",
    } = req.body as {
      invoice?: string
      paymentRequest?: string
      memo?: string
      environment?: EnvironmentName
    }
    const invoice = invoiceField || paymentRequest

    // Validate required fields
    if (!invoice) {
      console.error("❌ Missing invoice for payment")
      return res.status(400).json({
        error: "Missing required field: invoice or paymentRequest",
      })
    }

    // Basic invoice validation (should start with lnbc for mainnet or lntbs for signet/staging)
    const invoiceLower = invoice.toLowerCase()
    if (!invoiceLower.startsWith("lnbc") && !invoiceLower.startsWith("lntbs")) {
      console.error("❌ Invalid invoice format")
      return res.status(400).json({
        error: "Invalid invoice format",
      })
    }

    const store: HybridStore = await getHybridStore()
    hybridStore = store

    // SECURITY: Load the authoritative payment record. It must exist and be
    // mid-flow (`processing`) — claimed by the base-amount forward step. We do
    // NOT re-claim here: the claim is owned by forward-nwc-with-tips and released
    // by send-nwc-tips on completion.
    const stored = await store.getTipData(paymentHash)
    if (!stored) {
      console.error(
        `❌ SECURITY: Payment ${paymentHash.substring(0, 16)}... not found - rejecting`,
      )
      return res.status(401).json({
        error: "Unauthorized: Payment not found",
      })
    }

    if (stored.status === "completed") {
      // Idempotent — already forwarded.
      return res.status(200).json({
        success: true,
        message: "Payment already processed",
        alreadyProcessed: true,
      })
    }

    if (stored.status !== "processing") {
      console.error(
        `🔒 SECURITY: Payment ${paymentHash.substring(0, 16)}... in status '${stored.status}' - refusing to pay`,
      )
      return res.status(409).json({
        error: "Payment is not ready for forwarding",
        retryable: false,
      })
    }

    // SECURITY: The invoice we are about to pay must encode EXACTLY the stored
    // base amount and be destined for a Blink node (intraledger / zero-fee).
    const baseAmount = Number(stored.baseAmount)
    const maxGuard = assertWithinMaxForward(baseAmount)
    if (!maxGuard.ok) {
      console.error(`🔒 SECURITY: ${maxGuard.error}`)
      return res.status(400).json({ error: maxGuard.error })
    }

    const invGuard = verifyForwardInvoice({
      invoice,
      expectedSats: baseAmount,
      requireBlinkNode: true,
    })
    if (!invGuard.ok) {
      console.error(
        `🔒 SECURITY: Invoice rejected for ${paymentHash.substring(0, 16)}...: ${invGuard.error}`,
      )
      return res.status(400).json({ error: invGuard.error })
    }

    // BlinkPOS credentials are set per-deployment; the `environment` value
    // only selects which Blink GraphQL URL we talk to. Prefer the stored value.
    const environment = (stored.environment ||
      reqEnvironment ||
      "production") as EnvironmentName
    const blinkposApiKey = process.env.BLINKPOS_API_KEY
    const blinkposBtcWalletId = process.env.BLINKPOS_BTC_WALLET_ID
    const apiUrl = getApiUrlForEnvironment(environment)

    if (!blinkposApiKey || !blinkposBtcWalletId) {
      console.error("Missing BlinkPOS environment variables")
      return res.status(500).json({
        error: "BlinkPOS configuration missing",
      })
    }

    console.log("⚡ Paying invoice from BlinkPOS:", {
      paymentHash: paymentHash.substring(0, 16) + "...",
      baseAmount,
      invoicePrefix: invoice.substring(0, 50) + "...",
      memo: memo || "NWC forwarding",
      timestamp: new Date().toISOString(),
    })

    // Pay the invoice from BlinkPOS account
    const blinkposAPI = new BlinkAPI(blinkposApiKey, apiUrl)

    const paymentResult = await blinkposAPI.payLnInvoice(
      blinkposBtcWalletId,
      invoice,
      memo || "BlinkPOS: Payment forwarded",
    )

    if (paymentResult.status !== "SUCCESS") {
      throw new Error(`Payment failed: ${paymentResult.status}`)
    }

    console.log("✅ Invoice paid successfully from BlinkPOS")

    // Log the successful forwarding
    await store.logEvent(paymentHash, "nwc_invoice_paid", "success", {
      memo,
      baseAmount,
      invoicePrefix: invoice.substring(0, 30),
    })

    // Note: We don't mark as completed here because tips may still need to be sent.
    // The /api/blink/send-nwc-tips endpoint handles completion (and replay safety).

    res.status(200).json({
      success: true,
      message: "Invoice paid successfully",
      details: {
        status: paymentResult.status,
        preimage: (paymentResult as unknown as Record<string, unknown>).preimage,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Pay invoice error:", error)

    // Release the claim back to `pending` so a genuine retry can re-run the flow.
    if (hybridStore && paymentHash) {
      try {
        await hybridStore.releaseFailedClaim(paymentHash, message)
        console.log(
          `🔓 Released claim for failed payment ${paymentHash.substring(0, 16)}...`,
        )
      } catch (releaseError: unknown) {
        console.error("❌ Failed to release claim:", releaseError)
      }
    }

    let errorMessage = "Failed to pay invoice"
    if (message.includes("balance")) {
      errorMessage = "Insufficient balance in BlinkPOS account"
    } else if (message.includes("expired")) {
      errorMessage = "Invoice has expired"
    } else if (message.includes("already paid")) {
      errorMessage = "Invoice has already been paid"
    }

    res.status(500).json({
      error: errorMessage,
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE)
