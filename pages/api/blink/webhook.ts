/**
 * Blink Webhook Handler for BlinkPOS
 *
 * This endpoint receives webhook events from Blink (via Svix) when payments
 * are received on the BlinkPOS wallet. It automatically forwards payments
 * to the appropriate user wallet based on stored forwarding data.
 *
 * This provides reliable payment forwarding even when the client is disconnected.
 *
 * Supported events:
 * - receive.lightning: Lightning payment received
 * - receive.intraledger: Intraledger payment received
 *
 * @see https://dev.blink.sv/api/webhooks
 */

import type { NextApiRequest, NextApiResponse } from "next"
import WebSocket from "ws"
// Polyfill globalThis.WebSocket with the 'ws' package for Node.js server-side
if (typeof global !== "undefined" && typeof global.WebSocket === "undefined") {
  Object.assign(global, { WebSocket })
}

import AuthManager from "../../../lib/auth"
import BlinkAPI from "../../../lib/blink-api"
import * as boltcardLnurlp from "../../../lib/boltcard/lnurlp"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import {
  formatCurrencyServer,
  isBitcoinCurrency,
} from "../../../lib/currency-formatter-server"
import { getInvoiceFromLightningAddress } from "../../../lib/lnurl"
import NWCClient, {
  type NWCResponse,
  type MakeInvoiceResult,
} from "../../../lib/nwc/NWCClient"
import { getHybridStore, type HybridStore } from "../../../lib/storage/hybrid-store"
import { getTracer, withSpan, getActiveTraceId } from "../../../lib/tracing"
import { verifyWebhookSignature } from "../../../lib/webhook-verify"
// Import boltcard LNURL-pay for top-up processing

const tracer = getTracer("bbt-payment")

/** Result of forwarding a payment */
interface ForwardResult {
  type: string
  recipientUsername?: string | null
  recipientAddress?: string | null
  baseAmount?: number
  tipAmount?: number
  tipResult?: TipResult | null
}

interface TipRecipient {
  username: string
  share?: number
  type?: string
}

interface ForwardingData {
  environment?: EnvironmentName
  nwcActive?: boolean
  nwcConnectionUri?: string | null
  blinkLnAddress?: boolean
  blinkLnAddressWalletId?: string | null
  blinkLnAddressUsername?: string | null
  npubCashActive?: boolean
  npubCashLightningAddress?: string | null
  displayCurrency?: string
  tipAmountDisplay?: number | null
  userApiKey?: string
  userWalletId?: string
  baseAmount?: number
  tipAmount?: number
  tipRecipients?: TipRecipient[]
  memo?: string
  metadata?: Record<string, unknown>
}

interface TipResult {
  success: boolean
  partialSuccess?: boolean
  totalAmount: number
  recipients: Array<{
    success: boolean
    skipped?: boolean
    amount?: number
    recipient: string
    error?: string
    reason?: string
    type?: string
  }>
  successCount: number
  totalCount: number
}

/**
 * Generate enhanced memo with tip split information
 * Format: "BlinkPOS: $X + Y% tip = $Z (N sats) | $A (M sat) tip split to recipient1, recipient2"
 */
function generateEnhancedMemo(
  memo: string,
  baseAmount: number,
  tipAmount: number,
  tipRecipients: TipRecipient[],
  displayCurrency: string,
  tipAmountDisplay: number,
): string {
  const recipientNames = tipRecipients.map((r) => r.username || r).join(", ")

  if (memo && tipAmount > 0 && tipRecipients.length > 0) {
    let tipAmountText: string
    if (isBitcoinCurrency(displayCurrency)) {
      tipAmountText = `${tipAmount} sat`
    } else {
      const formattedAmount = formatCurrencyServer(
        tipAmountDisplay || tipAmount,
        displayCurrency,
      )
      tipAmountText = `${formattedAmount} (${tipAmount} sat)`
    }

    // Try to enhance the memo with tip info
    const enhancedMemoContent = memo.replace(
      /([^+]+?)\s*\+\s*([\d.]+)%\s*tip\s*=\s*(.+)/,
      (_match: string, baseAmountStr: string, tipPercent: string, total: string) => {
        const cleanBaseAmount = baseAmountStr.trim()
        const splitText = tipRecipients.length > 1 ? "split to" : "to"
        return `${cleanBaseAmount} + ${tipPercent}% tip = ${total} | ${tipAmountText} tip ${splitText} ${recipientNames}`
      },
    )

    return `BlinkPOS: ${enhancedMemoContent !== memo ? enhancedMemoContent : memo}`
  }

  // Fallback to basic memo
  return memo
    ? memo.startsWith("BlinkPOS:")
      ? memo
      : `BlinkPOS: ${memo}`
    : `BlinkPOS: ${baseAmount} sats`
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  return withSpan(tracer, "webhook.handle", async (rootSpan) => {
    let paymentHash: string | null = null
    let hybridStore: HybridStore | null = null

    // Set trace ID response header for request correlation
    const traceId = getActiveTraceId()
    if (traceId) {
      res.setHeader("X-Trace-Id", traceId)
    }

    try {
      // Step 1: Verify webhook signature (try both production and staging secrets)
      // We don't know which environment the webhook is from until we verify the signature
      const productionSecret = process.env.BLINK_WEBHOOK_SECRET
      const stagingSecret = process.env.BLINK_STAGING_WEBHOOK_SECRET

      let isValid = false
      let _webhookEnvironment: string | null = null

      if (productionSecret || stagingSecret) {
        // Try production secret first
        if (productionSecret && verifyWebhookSignature(req, productionSecret)) {
          isValid = true
          _webhookEnvironment = "production"
          console.log("[Webhook] Signature verified with PRODUCTION secret")
        }
        // Try staging secret if production didn't work
        else if (stagingSecret && verifyWebhookSignature(req, stagingSecret)) {
          isValid = true
          _webhookEnvironment = "staging"
          console.log("[Webhook] Signature verified with STAGING secret")
        }

        if (!isValid) {
          console.error(
            "[Webhook] Invalid signature - tried both production and staging secrets",
          )
          rootSpan.setAttribute("webhook.signature_valid", false)
          return res.status(401).json({ error: "Invalid webhook signature" })
        }
      } else {
        console.error(
          "[Webhook] CRITICAL: No webhook secrets configured - rejecting request",
        )
        return res
          .status(500)
          .json({ error: "Webhook signature verification not configured" })
      }

      rootSpan.setAttribute("webhook.signature_valid", true)

      // Step 2: Parse the webhook payload
      const payload = req.body

      console.log("[Webhook] Received event:", {
        eventType: payload.eventType,
        transactionId: payload.transaction?.id,
        amount: payload.transaction?.settlementAmount,
        status: payload.transaction?.status,
      })

      rootSpan.setAttribute("webhook.event_type", payload.eventType || "unknown")

      // Only process receive events
      if (!payload.eventType?.startsWith("receive.")) {
        console.log("[Webhook] Ignoring non-receive event:", payload.eventType)
        rootSpan.setAttribute("webhook.ignored", true)
        rootSpan.setAttribute("webhook.ignore_reason", "not_receive_event")
        return res.status(200).json({ status: "ignored", reason: "Not a receive event" })
      }

      // Only process successful transactions
      if (payload.transaction?.status !== "success") {
        console.log(
          "[Webhook] Ignoring non-success transaction:",
          payload.transaction?.status,
        )
        rootSpan.setAttribute("webhook.ignored", true)
        rootSpan.setAttribute("webhook.ignore_reason", "not_success_status")
        return res
          .status(200)
          .json({ status: "ignored", reason: "Transaction not successful" })
      }

      // Extract payment hash from the transaction
      const transaction = payload.transaction
      paymentHash = transaction.initiationVia?.paymentHash

      if (!paymentHash) {
        console.log(
          "[Webhook] No payment hash in transaction - may be on-chain or intraledger without hash",
        )
        rootSpan.setAttribute("webhook.ignored", true)
        rootSpan.setAttribute("webhook.ignore_reason", "no_payment_hash")
        return res.status(200).json({ status: "ignored", reason: "No payment hash" })
      }

      rootSpan.setAttribute("payment.hash", paymentHash)
      rootSpan.setAttribute("payment.amount_sats", transaction.settlementAmount)

      console.log("[Webhook] Processing payment:", {
        paymentHash: paymentHash.substring(0, 16) + "...",
        amount: transaction.settlementAmount,
        eventType: payload.eventType,
      })

      // Step 3a: Check if this is a Boltcard top-up payment
      // Boltcard top-ups are tracked separately from BlinkPOS forwarding
      try {
        const boltcardTopUp = await boltcardLnurlp.getPendingTopUp(paymentHash)

        if (boltcardTopUp) {
          rootSpan.setAttribute("webhook.type", "boltcard_topup")
          console.log("[Webhook] Processing Boltcard top-up:", {
            cardId: boltcardTopUp.cardId,
            amount: boltcardTopUp.amount,
            currency: boltcardTopUp.currency,
          })

          const topUpResult = await boltcardLnurlp.processTopUpPayment(paymentHash)

          if (topUpResult.success) {
            console.log("[Webhook] Boltcard top-up processed:", {
              cardId: topUpResult.cardId,
              amount: topUpResult.amount,
              newBalance: topUpResult.balance,
            })

            return res.status(200).json({
              status: "boltcard_topup",
              cardId: topUpResult.cardId,
              amount: topUpResult.amount,
              balance: topUpResult.balance,
            })
          } else {
            console.error("[Webhook] Boltcard top-up failed:", topUpResult.error)
            // Return 500 so Svix will retry
            return res.status(500).json({
              error: "Boltcard top-up failed",
              details: topUpResult.error,
            })
          }
        }
      } catch (boltcardError: unknown) {
        console.error("[Webhook] Error checking boltcard top-up:", boltcardError)
        // Continue to normal forwarding flow - this payment may not be a boltcard top-up
      }

      // Step 3b: Try to claim the payment for BlinkPOS forwarding (atomic deduplication)
      // This prevents duplicate forwarding if both webhook and client try to process
      hybridStore = await getHybridStore()
      const claimResult = await hybridStore!.claimPaymentForProcessing(paymentHash)

      if (!claimResult.claimed) {
        console.log(`[Webhook] Payment not claimed: ${claimResult.reason}`)
        rootSpan.setAttribute("webhook.claim_result", claimResult.reason || "unknown")
        return res.status(200).json({
          status: claimResult.reason === "not_found" ? "ignored" : "already_claimed",
          reason: claimResult.reason,
        })
      }

      const forwardingData = claimResult.paymentData as ForwardingData

      // Extract additional fields from metadata (they're stored in JSONB)
      if (forwardingData.metadata) {
        const md = forwardingData.metadata
        forwardingData.nwcActive = (md.nwcActive as boolean) || false
        forwardingData.nwcConnectionUri = (md.nwcConnectionUri as string) || null
        forwardingData.blinkLnAddress = (md.blinkLnAddress as boolean) || false
        forwardingData.blinkLnAddressWalletId =
          (md.blinkLnAddressWalletId as string) || null
        forwardingData.blinkLnAddressUsername =
          (md.blinkLnAddressUsername as string) || null
        forwardingData.npubCashActive = (md.npubCashActive as boolean) || false
        forwardingData.npubCashLightningAddress =
          (md.npubCashLightningAddress as string) || null
        forwardingData.displayCurrency = (md.displayCurrency as string) || "BTC"
        forwardingData.tipAmountDisplay = (md.tipAmountDisplay as number) || null
        // Environment for staging/production API calls
        forwardingData.environment = (md.environment as EnvironmentName) || "production"
      }

      // Determine forwarding type for span attributes
      const forwardingType = forwardingData.blinkLnAddress
        ? "ln_address"
        : forwardingData.npubCashActive
          ? "npub_cash"
          : forwardingData.nwcActive
            ? "nwc"
            : forwardingData.userApiKey
              ? "user_wallet"
              : "unknown"
      rootSpan.setAttribute("webhook.type", "payment_forward")
      rootSpan.setAttribute("payment.forwarding_type", forwardingType)
      rootSpan.setAttribute("payment.base_amount_sats", forwardingData.baseAmount || 0)
      rootSpan.setAttribute("payment.tip_amount_sats", forwardingData.tipAmount || 0)

      console.log("[Webhook] Forwarding data found:", {
        environment: forwardingData.environment,
        nwcActive: forwardingData.nwcActive,
        hasNwcConnectionUri: !!forwardingData.nwcConnectionUri,
        blinkLnAddress: forwardingData.blinkLnAddress,
        blinkLnAddressUsername: forwardingData.blinkLnAddressUsername,
        npubCashActive: forwardingData.npubCashActive,
        hasUserApiKey: !!forwardingData.userApiKey,
        baseAmount: forwardingData.baseAmount,
        tipAmount: forwardingData.tipAmount,
      })

      console.log("[Webhook] Payment claimed for forwarding")

      // Step 5: Forward the payment based on the forwarding type
      let forwardResult: ForwardResult
      const amount = transaction.settlementAmount

      try {
        if (forwardingData.blinkLnAddress && forwardingData.blinkLnAddressUsername) {
          // Forward to Blink Lightning Address
          console.log(
            "[Webhook] Forwarding to Blink Lightning Address:",
            forwardingData.blinkLnAddressUsername,
          )
          forwardResult = await withSpan(
            tracer,
            "webhook.forward.ln_address",
            async (span) => {
              span.setAttribute(
                "payment.recipient",
                forwardingData.blinkLnAddressUsername || "",
              )
              return forwardToLnAddress(
                paymentHash!,
                amount,
                forwardingData,
                hybridStore!,
              )
            },
          )
        } else if (
          forwardingData.npubCashActive &&
          forwardingData.npubCashLightningAddress
        ) {
          // Forward to npub.cash
          console.log(
            "[Webhook] Forwarding to npub.cash:",
            forwardingData.npubCashLightningAddress,
          )
          forwardResult = await withSpan(
            tracer,
            "webhook.forward.npub_cash",
            async (span) => {
              span.setAttribute(
                "payment.recipient",
                forwardingData.npubCashLightningAddress || "",
              )
              return forwardToNpubCash(paymentHash!, amount, forwardingData, hybridStore!)
            },
          )
        } else if (forwardingData.nwcActive && forwardingData.nwcConnectionUri) {
          // Forward to NWC wallet using stored encrypted connection URI
          console.log("[Webhook] Forwarding to NWC wallet")
          forwardResult = await withSpan(tracer, "webhook.forward.nwc", async () => {
            return forwardToNWCWallet(paymentHash!, amount, forwardingData, hybridStore!)
          })
        } else if (forwardingData.nwcActive) {
          // NWC active but no URI stored (legacy invoice or error)
          console.log("[Webhook] NWC payment but no connection URI - client must handle")
          // Release the claim so client can try
          await hybridStore!.releaseFailedClaim(
            paymentHash,
            "NWC requires client-side forwarding (no URI stored)",
          )
          rootSpan.setAttribute("webhook.result", "nwc_requires_client")
          return res.status(200).json({
            status: "nwc_requires_client",
            reason: "NWC forwarding requires connection URI (not stored with invoice)",
          })
        } else if (forwardingData.userApiKey && forwardingData.userWalletId) {
          // Forward to user's Blink wallet via API key
          console.log("[Webhook] Forwarding to user Blink wallet")
          forwardResult = await withSpan(
            tracer,
            "webhook.forward.user_wallet",
            async () => {
              return forwardToUserWallet(
                paymentHash!,
                amount,
                forwardingData,
                hybridStore!,
              )
            },
          )
        } else {
          console.warn("[Webhook] No valid forwarding destination found")
          await hybridStore!.releaseFailedClaim(
            paymentHash,
            "No valid forwarding destination",
          )
          rootSpan.setAttribute("webhook.result", "no_destination")
          return res
            .status(200)
            .json({ status: "no_destination", reason: "No valid forwarding destination" })
        }

        console.log("[Webhook] Forwarding completed:", forwardResult)

        rootSpan.setAttribute("webhook.result", "forwarded")

        // Log success event
        const traceId = getActiveTraceId()
        await hybridStore!.logEvent(paymentHash, "webhook_forward", "success", {
          forwardType: forwardResult.type,
          amount,
          ...(traceId ? { traceId } : {}),
        })

        return res.status(200).json({
          status: "forwarded",
          ...forwardResult,
        })
      } catch (forwardError: unknown) {
        console.error("[Webhook] Forwarding failed:", forwardError)

        const errorMessage =
          forwardError instanceof Error ? forwardError.message : "Unknown error"

        // Release the claim so it can be retried
        await hybridStore!.releaseFailedClaim(paymentHash, errorMessage)

        // Log failure event
        const traceId = getActiveTraceId()
        await hybridStore!.logEvent(paymentHash, "webhook_forward", "failed", {
          error: errorMessage,
          ...(traceId ? { traceId } : {}),
        })

        rootSpan.setAttribute("webhook.result", "forward_failed")

        // Return 500 so Svix will retry
        return res.status(500).json({
          error: "Forwarding failed",
          details: errorMessage,
        })
      }
    } catch (error: unknown) {
      console.error("[Webhook] Handler error:", error)

      const errorMessage = error instanceof Error ? error.message : "Unknown error"

      // Release claim if we have one
      if (hybridStore && paymentHash) {
        try {
          await hybridStore.releaseFailedClaim(paymentHash, errorMessage)
        } catch (releaseError: unknown) {
          console.error("[Webhook] Failed to release claim:", releaseError)
        }
      }

      rootSpan.setAttribute("webhook.result", "handler_error")

      // Return 500 so Svix will retry
      return res.status(500).json({
        error: "Webhook handler error",
        details: errorMessage,
      })
    }
  })
}

/**
 * Forward payment to a Blink Lightning Address wallet
 */
async function forwardToLnAddress(
  paymentHash: string,
  amount: number,
  forwardingData: ForwardingData,
  hybridStore: HybridStore,
) {
  // Get the environment-specific API URL from stored forwarding data.
  // BlinkPOS credentials are set per-deployment; `environment` only
  // selects which Blink GraphQL URL we talk to.
  const environment = forwardingData.environment || "production"
  const blinkposApiKey = process.env.BLINKPOS_API_KEY
  const blinkposBtcWalletId = process.env.BLINKPOS_BTC_WALLET_ID
  const apiUrl = getApiUrlForEnvironment(environment)

  const blinkposAPI = new BlinkAPI(blinkposApiKey!, apiUrl)

  const recipientUsername = forwardingData.blinkLnAddressUsername
  const baseAmount = forwardingData.baseAmount || amount
  const tipAmount = forwardingData.tipAmount || 0
  const tipRecipients = forwardingData.tipRecipients || []
  const memo = forwardingData.memo || `${baseAmount} sats`
  const displayCurrency = forwardingData.displayCurrency || "BTC"
  const tipAmountDisplay = forwardingData.tipAmountDisplay || tipAmount
  const forwardingMemo = generateEnhancedMemo(
    memo,
    baseAmount,
    tipAmount,
    tipRecipients,
    displayCurrency,
    tipAmountDisplay,
  )

  // Look up recipient's BTC wallet using environment-specific URL
  const walletLookupQuery = `
    query getRecipientBtcWallet($username: Username!) {
      accountDefaultWallet(username: $username, walletCurrency: BTC) {
        id
        walletCurrency
      }
    }
  `

  const walletLookupResponse = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: walletLookupQuery,
      variables: { username: recipientUsername },
    }),
  })

  const walletLookupData = await walletLookupResponse.json()
  const btcWalletId =
    walletLookupData.data?.accountDefaultWallet?.id ||
    forwardingData.blinkLnAddressWalletId

  if (!btcWalletId) {
    throw new Error(`Could not find BTC wallet for ${recipientUsername}`)
  }

  // Create invoice on behalf of recipient using environment-specific URL
  const createInvoiceQuery = `
    mutation lnInvoiceCreateOnBehalfOfRecipient($input: LnInvoiceCreateOnBehalfOfRecipientInput!) {
      lnInvoiceCreateOnBehalfOfRecipient(input: $input) {
        errors { message }
        invoice {
          paymentHash
          paymentRequest
          satoshis
        }
      }
    }
  `

  const invoiceResponse = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: createInvoiceQuery,
      variables: {
        input: {
          recipientWalletId: btcWalletId,
          amount: Math.round(baseAmount),
          memo: forwardingMemo,
        },
      },
    }),
  })

  const invoiceData = await invoiceResponse.json()

  if (
    invoiceData.errors ||
    invoiceData.data?.lnInvoiceCreateOnBehalfOfRecipient?.errors?.length > 0
  ) {
    const errorMsg =
      invoiceData.errors?.[0]?.message ||
      invoiceData.data?.lnInvoiceCreateOnBehalfOfRecipient?.errors?.[0]?.message
    throw new Error(`Failed to create invoice: ${errorMsg}`)
  }

  const recipientInvoice = invoiceData.data?.lnInvoiceCreateOnBehalfOfRecipient?.invoice
  if (!recipientInvoice?.paymentRequest) {
    throw new Error("No invoice returned from recipient wallet")
  }

  // Pay the invoice from BlinkPOS
  const paymentResult = await blinkposAPI.payLnInvoice(
    blinkposBtcWalletId!,
    recipientInvoice.paymentRequest,
    forwardingMemo,
  )

  if (paymentResult.status !== "SUCCESS") {
    throw new Error(`Payment failed: ${paymentResult.status}`)
  }

  // Send tips if applicable
  let tipResult: TipResult | null = null
  if (tipAmount > 0 && tipRecipients.length > 0) {
    tipResult = await sendTips(
      blinkposAPI,
      blinkposBtcWalletId,
      tipAmount,
      tipRecipients,
      forwardingData,
    )
  }

  // Clean up forwarding data
  await hybridStore.removeTipData(paymentHash)

  return {
    type: "ln_address",
    recipientUsername,
    baseAmount,
    tipAmount,
    tipResult,
  }
}

/**
 * Forward payment to npub.cash via LNURL-pay
 */
async function forwardToNpubCash(
  paymentHash: string,
  amount: number,
  forwardingData: ForwardingData,
  hybridStore: HybridStore,
) {
  // Get the environment-specific API URL from stored forwarding data.
  // BlinkPOS credentials are set per-deployment; `environment` only
  // selects which Blink GraphQL URL we talk to.
  const environment = forwardingData.environment || "production"
  const blinkposApiKey = process.env.BLINKPOS_API_KEY
  const blinkposBtcWalletId = process.env.BLINKPOS_BTC_WALLET_ID
  const apiUrl = getApiUrlForEnvironment(environment)

  const blinkposAPI = new BlinkAPI(blinkposApiKey!, apiUrl)

  const recipientAddress = forwardingData.npubCashLightningAddress
  const baseAmount = forwardingData.baseAmount || amount
  const tipAmount = forwardingData.tipAmount || 0
  const tipRecipients = forwardingData.tipRecipients || []
  const memo = forwardingData.memo || `${baseAmount} sats`
  const displayCurrency = forwardingData.displayCurrency || "BTC"
  const tipAmountDisplay = forwardingData.tipAmountDisplay || tipAmount
  const forwardingMemo = generateEnhancedMemo(
    memo,
    baseAmount,
    tipAmount,
    tipRecipients,
    displayCurrency,
    tipAmountDisplay,
  )

  // Get invoice from npub.cash via LNURL-pay
  // Note: getInvoiceFromLightningAddress takes sats, not millisats
  const invoiceResult = await getInvoiceFromLightningAddress(
    recipientAddress!,
    baseAmount,
    forwardingMemo,
  )

  if (!invoiceResult.paymentRequest) {
    throw new Error(
      `Failed to get invoice from ${recipientAddress}: No payment request returned`,
    )
  }

  console.log("[Webhook] Got invoice from npub.cash:", {
    recipient: recipientAddress,
    amount: baseAmount,
    hasPaymentRequest: !!invoiceResult.paymentRequest,
  })

  // Pay the invoice from BlinkPOS
  const paymentResult = await blinkposAPI.payLnInvoice(
    blinkposBtcWalletId!,
    invoiceResult.paymentRequest,
    forwardingMemo,
  )

  if (paymentResult.status !== "SUCCESS") {
    throw new Error(`Payment failed: ${paymentResult.status}`)
  }

  // Send tips if applicable
  let tipResult: TipResult | null = null
  if (tipAmount > 0 && tipRecipients.length > 0) {
    tipResult = await sendTips(
      blinkposAPI,
      blinkposBtcWalletId,
      tipAmount,
      tipRecipients,
      forwardingData,
    )
  }

  // Clean up forwarding data
  await hybridStore.removeTipData(paymentHash)

  return {
    type: "npub_cash",
    recipientAddress,
    baseAmount,
    tipAmount,
    tipResult,
  }
}

/**
 * Forward payment to NWC (Nostr Wallet Connect) wallet
 * This creates an invoice on the user's NWC wallet and pays it from BlinkPOS
 */
async function forwardToNWCWallet(
  paymentHash: string,
  amount: number,
  forwardingData: ForwardingData,
  hybridStore: HybridStore,
) {
  // Get the environment-specific API URL from stored forwarding data.
  // BlinkPOS credentials are set per-deployment; `environment` only
  // selects which Blink GraphQL URL we talk to.
  const environment = forwardingData.environment || "production"
  const blinkposApiKey = process.env.BLINKPOS_API_KEY
  const blinkposBtcWalletId = process.env.BLINKPOS_BTC_WALLET_ID
  const apiUrl = getApiUrlForEnvironment(environment)

  const blinkposAPI = new BlinkAPI(blinkposApiKey!, apiUrl)

  // Decrypt the NWC connection URI
  const encryptedNwcUri = forwardingData.nwcConnectionUri
  if (!encryptedNwcUri) {
    throw new Error("No NWC connection URI available")
  }

  const nwcUri = AuthManager.decryptApiKey(encryptedNwcUri)
  if (!nwcUri) {
    throw new Error("Failed to decrypt NWC connection URI")
  }

  const baseAmount = forwardingData.baseAmount || amount
  const tipAmount = forwardingData.tipAmount || 0
  const tipRecipients = forwardingData.tipRecipients || []
  const memo = forwardingData.memo || `${baseAmount} sats`
  const displayCurrency = forwardingData.displayCurrency || "BTC"
  const tipAmountDisplay = forwardingData.tipAmountDisplay || tipAmount
  const forwardingMemo = generateEnhancedMemo(
    memo,
    baseAmount,
    tipAmount,
    tipRecipients,
    displayCurrency,
    tipAmountDisplay,
  )

  console.log("[Webhook] Creating NWC invoice for forwarding:", {
    baseAmount,
    tipAmount,
    hasTipRecipients: tipRecipients.length > 0,
  })

  // Create NWC client and invoice
  const nwcClient = new NWCClient(nwcUri)

  let invoiceResult: NWCResponse<MakeInvoiceResult>
  try {
    invoiceResult = await nwcClient.makeInvoice({
      amount: baseAmount * 1000, // NWC uses millisats
      description: forwardingMemo,
      expiry: 3600,
    })
  } catch (nwcError: unknown) {
    console.error("[Webhook] NWC makeInvoice threw error:", nwcError)
    nwcClient.close()
    const errorMessage = nwcError instanceof Error ? nwcError.message : "Unknown error"
    throw new Error(`NWC invoice creation error: ${errorMessage}`)
  }

  if (invoiceResult.error || !invoiceResult.result?.invoice) {
    const errorMsg = invoiceResult.error?.message || "No invoice returned from NWC wallet"
    console.error("[Webhook] NWC invoice creation failed:", errorMsg, invoiceResult)
    nwcClient.close()
    throw new Error(`NWC invoice creation failed: ${errorMsg}`)
  }

  console.log("[Webhook] NWC invoice created:", {
    paymentHash: invoiceResult.result.payment_hash?.substring(0, 16) + "...",
    hasInvoice: !!invoiceResult.result.invoice,
  })

  // Close NWC client - we have the invoice
  nwcClient.close()

  // Pay the invoice from BlinkPOS
  const paymentResult = await blinkposAPI.payLnInvoice(
    blinkposBtcWalletId!,
    invoiceResult.result.invoice,
    forwardingMemo,
  )

  if (paymentResult.status !== "SUCCESS") {
    throw new Error(`Payment to NWC wallet failed: ${paymentResult.status}`)
  }

  console.log("[Webhook] NWC base amount forwarded successfully")

  // Send tips if applicable
  let tipResult: TipResult | null = null
  if (tipAmount > 0 && tipRecipients.length > 0) {
    tipResult = await sendTips(
      blinkposAPI,
      blinkposBtcWalletId,
      tipAmount,
      tipRecipients,
      forwardingData,
    )
  }

  // Clean up forwarding data
  await hybridStore.removeTipData(paymentHash)

  return {
    type: "nwc",
    baseAmount,
    tipAmount,
    tipResult,
  }
}

/**
 * Forward payment to user's Blink wallet via their API key
 */
async function forwardToUserWallet(
  paymentHash: string,
  amount: number,
  forwardingData: ForwardingData,
  hybridStore: HybridStore,
) {
  // Get the environment-specific API URL from stored forwarding data.
  // BlinkPOS credentials are set per-deployment; `environment` only
  // selects which Blink GraphQL URL we talk to.
  const environment = forwardingData.environment || "production"
  const blinkposApiKey = process.env.BLINKPOS_API_KEY
  const blinkposBtcWalletId = process.env.BLINKPOS_BTC_WALLET_ID
  const apiUrl = getApiUrlForEnvironment(environment)

  const blinkposAPI = new BlinkAPI(blinkposApiKey!, apiUrl)

  const userApiKey = forwardingData.userApiKey
  const userWalletId = forwardingData.userWalletId
  const baseAmount = forwardingData.baseAmount || amount
  const tipAmount = forwardingData.tipAmount || 0
  const tipRecipients = forwardingData.tipRecipients || []
  const memo = forwardingData.memo || `${baseAmount} sats`
  const displayCurrency = forwardingData.displayCurrency || "BTC"
  const tipAmountDisplay = forwardingData.tipAmountDisplay || tipAmount
  const forwardingMemo = generateEnhancedMemo(
    memo,
    baseAmount,
    tipAmount,
    tipRecipients,
    displayCurrency,
    tipAmountDisplay,
  )

  // Create invoice on user's wallet with environment-specific URL
  const userAPI = new BlinkAPI(userApiKey!, apiUrl)
  const userInvoice = await userAPI.createLnInvoice(
    userWalletId!,
    Math.round(baseAmount),
    forwardingMemo,
  )

  if (!userInvoice?.paymentRequest) {
    throw new Error("Failed to create invoice on user wallet")
  }

  // Pay the invoice from BlinkPOS
  const paymentResult = await blinkposAPI.payLnInvoice(
    blinkposBtcWalletId!,
    userInvoice.paymentRequest,
    forwardingMemo,
  )

  if (paymentResult.status !== "SUCCESS") {
    throw new Error(`Payment failed: ${paymentResult.status}`)
  }

  // Send tips if applicable
  let tipResult: TipResult | null = null
  if (tipAmount > 0 && tipRecipients.length > 0) {
    tipResult = await sendTips(
      blinkposAPI,
      blinkposBtcWalletId,
      tipAmount,
      tipRecipients,
      forwardingData,
    )
  }

  // Clean up forwarding data
  await hybridStore.removeTipData(paymentHash)

  return {
    type: "user_wallet",
    baseAmount,
    tipAmount,
    tipResult,
  }
}

/**
 * Send tips to recipients
 * Supports both Blink usernames and npub.cash addresses
 */
async function sendTips(
  blinkposAPI: BlinkAPI,
  blinkposBtcWalletId: string | undefined,
  tipAmount: number,
  tipRecipients: TipRecipient[],
  forwardingData: ForwardingData,
): Promise<TipResult> {
  const displayCurrency = forwardingData.displayCurrency || "BTC"
  const tipAmountDisplay = forwardingData.tipAmountDisplay || tipAmount

  // Calculate weighted tip amounts based on share percentages
  let distributedSats = 0
  const recipientAmounts = tipRecipients.map((recipient, index) => {
    const sharePercent = recipient.share || 100 / tipRecipients.length
    // For the last recipient, give them whatever is left to avoid rounding issues
    if (index === tipRecipients.length - 1) {
      return tipAmount - distributedSats
    }
    const amt = Math.floor((tipAmount * sharePercent) / 100)
    distributedSats += amt
    return amt
  })

  console.log("[Webhook] Processing tips with weighted shares:", {
    totalTipSats: tipAmount,
    recipientCount: tipRecipients.length,
    distribution: tipRecipients.map(
      (r, i) =>
        `${r.username}: ${r.share || 100 / tipRecipients.length}% = ${recipientAmounts[i]} sats`,
    ),
  })

  const tipResults: TipResult["recipients"] = []
  const isMultiple = tipRecipients.length > 1

  for (let i = 0; i < tipRecipients.length; i++) {
    const recipient = tipRecipients[i]
    // Use the pre-calculated weighted amount for this recipient
    const recipientTipAmount = recipientAmounts[i]
    const sharePercent = recipient.share || 100 / tipRecipients.length
    const recipientDisplayAmount = ((tipAmountDisplay as number) * sharePercent) / 100

    // Skip recipients who would receive 0 sats (cannot create 0-sat invoice)
    if (recipientTipAmount <= 0) {
      console.log(
        `[Webhook] Skipping tip to ${recipient.username}: amount is ${recipientTipAmount} sats (minimum 1 sat required)`,
      )
      tipResults.push({
        success: false,
        skipped: true,
        amount: 0,
        recipient: recipient.username,
        reason: "Tip amount too small (0 sats)",
      })
      continue
    }

    // Auto-detect npub.cash addresses by checking if username ends with @npub.cash
    const isNpubCash =
      recipient.username?.endsWith("@npub.cash") || recipient.type === "npub_cash"
    const recipientType = isNpubCash ? "npub_cash" : recipient.type || "blink"

    const splitInfo = isMultiple ? ` (${i + 1}/${tipRecipients.length})` : ""
    let tipMemo: string
    if (isBitcoinCurrency(displayCurrency)) {
      tipMemo = `BlinkPOS Tip${splitInfo}: ${recipientTipAmount} sats`
    } else {
      const formattedAmount = formatCurrencyServer(
        recipientDisplayAmount,
        displayCurrency,
      )
      tipMemo = `BlinkPOS Tip${splitInfo}: ${formattedAmount} (${recipientTipAmount} sats)`
    }

    try {
      if (recipientType === "npub_cash") {
        // Send tip to npub.cash address via LNURL-pay
        console.log(`[Webhook] Sending tip to npub.cash: ${recipient.username}`)

        const tipInvoiceData = await getInvoiceFromLightningAddress(
          recipient.username,
          recipientTipAmount,
          tipMemo,
        )

        const tipPaymentResult = await blinkposAPI.payLnInvoice(
          blinkposBtcWalletId!,
          tipInvoiceData.paymentRequest,
          tipMemo,
        )

        if (tipPaymentResult.status === "SUCCESS") {
          console.log(`[Webhook] Tip successfully sent to ${recipient.username}`)
          tipResults.push({
            success: true,
            amount: recipientTipAmount,
            recipient: recipient.username,
            type: "npub_cash",
          })
        } else {
          tipResults.push({
            success: false,
            recipient: recipient.username,
            error: `Failed: ${tipPaymentResult.status}`,
            type: "npub_cash",
          })
        }
      } else {
        // Send tip to Blink user (existing method)
        const tipPaymentResult = await blinkposAPI.sendTipViaInvoice(
          blinkposBtcWalletId!,
          recipient.username,
          recipientTipAmount,
          tipMemo,
        )

        if (tipPaymentResult.status === "SUCCESS") {
          console.log(`[Webhook] Tip successfully sent to ${recipient.username}@blink.sv`)
          tipResults.push({
            success: true,
            amount: recipientTipAmount,
            recipient: `${recipient.username}@blink.sv`,
            type: "blink",
          })
        } else {
          tipResults.push({
            success: false,
            recipient: `${recipient.username}@blink.sv`,
            error: `Failed: ${tipPaymentResult.status}`,
            type: "blink",
          })
        }
      }
    } catch (tipError: unknown) {
      const recipientDisplay =
        recipientType === "npub_cash"
          ? recipient.username
          : `${recipient.username}@blink.sv`
      tipResults.push({
        success: false,
        recipient: recipientDisplay,
        error: tipError instanceof Error ? tipError.message : "Unknown error",
        type: recipientType,
      })
    }
  }

  const successCount = tipResults.filter((r) => r.success).length
  return {
    success: successCount === tipRecipients.length,
    partialSuccess: successCount > 0 && successCount < tipRecipients.length,
    totalAmount: tipAmount,
    recipients: tipResults,
    successCount,
    totalCount: tipRecipients.length,
  }
}

// Disable body parsing so we can access raw body for signature verification
export const config = {
  api: {
    bodyParser: true,
  },
}
