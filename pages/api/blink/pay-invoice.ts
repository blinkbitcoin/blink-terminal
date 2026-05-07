import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI from "../../../lib/blink-api"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"
import { getHybridStore, type HybridStore } from "../../../lib/storage/hybrid-store"

/**
 * API endpoint to pay a lightning invoice from BlinkPOS account
 * Used for forwarding payments to NWC wallets
 *
 * SECURITY: This endpoint requires a valid paymentHash that corresponds to
 * a pending payment in our database. This prevents unauthorized invoice payments.
 *
 * POST /api/blink/pay-invoice
 * Body: { paymentHash: string, invoice: string, memo?: string }
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  let hybridStore: HybridStore | null = null
  let claimSucceeded = false
  let paymentHash: string | null = null

  try {
    // Support both 'invoice' and 'paymentRequest' field names for compatibility
    const {
      paymentHash: reqPaymentHash,
      invoice: invoiceField,
      paymentRequest,
      memo = "",
      environment = "production",
    } = req.body as {
      paymentHash: string
      invoice?: string
      paymentRequest?: string
      memo?: string
      environment?: EnvironmentName
    }
    const invoice = invoiceField || paymentRequest
    paymentHash = reqPaymentHash

    // SECURITY: Require paymentHash to prevent unauthorized payments
    if (!paymentHash) {
      console.error(
        "❌ SECURITY: Missing paymentHash - rejecting unauthenticated request",
      )
      return res.status(401).json({
        error: "Unauthorized: paymentHash is required to verify payment legitimacy",
      })
    }

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

    // SECURITY: Verify this is a legitimate payment by claiming it from the database
    // This ensures only payments created through BlinkPOS can be forwarded
    const store: HybridStore = await getHybridStore()
    hybridStore = store
    const claimResult = await store.claimPaymentForProcessing(paymentHash)

    if (!claimResult.claimed) {
      console.log(
        `🔒 SECURITY: Payment claim failed for ${paymentHash?.substring(0, 16)}... - ${claimResult.reason}`,
      )

      if (claimResult.reason === "already_completed") {
        // Payment already processed - return success (idempotent)
        return res.status(200).json({
          success: true,
          message: "Payment already processed",
          alreadyProcessed: true,
        })
      } else if (claimResult.reason === "already_processing") {
        // Another request is processing this payment
        return res.status(409).json({
          error: "Payment is being processed by another request",
          retryable: false,
        })
      } else {
        // Payment not found - reject to prevent unauthorized payments
        console.error(
          `❌ SECURITY: Payment ${paymentHash?.substring(0, 16)}... not found - rejecting`,
        )
        return res.status(401).json({
          error: "Unauthorized: Payment not found or already processed",
        })
      }
    }

    claimSucceeded = true
    console.log(
      `✅ SECURITY: Claimed payment ${paymentHash?.substring(0, 16)}... for NWC forwarding`,
    )

    // BlinkPOS credentials are set per-deployment; the `environment` value
    // only selects which Blink GraphQL URL we talk to.
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
      paymentHash: paymentHash?.substring(0, 16) + "...",
      invoicePrefix: invoice.substring(0, 50) + "...",
      memo: memo || "NWC forwarding",
      timestamp: new Date().toISOString(),
    })

    // Pay the invoice from BlinkPOS account
    // Pass memo for better transaction history visibility
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
      invoicePrefix: invoice.substring(0, 30),
    })

    // Note: We don't mark as completed here because tips may still need to be sent
    // The /api/blink/send-nwc-tips endpoint or the caller will handle completion

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

    // Release claim if we claimed but failed to complete
    if (claimSucceeded && hybridStore && paymentHash) {
      try {
        await hybridStore.releaseFailedClaim(paymentHash, message)
        console.log(
          `🔓 Released claim for failed payment ${paymentHash?.substring(0, 16)}...`,
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
