import type { NextApiRequest, NextApiResponse } from "next"

/**
 * API endpoint to forward payment to an npub.cash wallet
 *
 * This endpoint resolves the npub.cash Lightning address via LNURL-pay,
 * gets an invoice from npub.cash, and pays it from BlinkPOS.
 *
 * Since npub.cash uses Blink as their Lightning provider, these payments
 * are intraledger (ZERO FEE).
 *
 * Used when the user's active wallet is connected via npub.cash address.
 */

import BlinkAPI from "../../../lib/blink-api"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import {
  formatCurrencyServer,
  isBitcoinCurrency,
} from "../../../lib/currency-formatter-server"
import {
  getInvoiceFromLightningAddress,
  type LnurlFullInvoiceResponse,
} from "../../../lib/lnurl"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"
import { getHybridStore, type HybridStore } from "../../../lib/storage/hybrid-store"

interface ApiTipRecipient {
  username: string
  share?: number
  type?: string
}

interface TipResultEntry {
  success: boolean
  skipped?: boolean
  amount?: number
  recipient: string
  error?: string
  reason?: string
  status?: string
  type?: string
}

interface TipDistributionResult {
  success: boolean
  partialSuccess?: boolean
  totalAmount?: number
  recipients?: TipResultEntry[]
  successCount?: number
  totalCount?: number
  error?: string
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  let hybridStore: HybridStore | null = null
  let paymentHash: string | null = null
  let claimSucceeded = false

  try {
    const {
      paymentHash: reqPaymentHash,
      totalAmount,
      memo,
      recipientAddress, // Full npub.cash address (e.g., "npub1xxx@npub.cash")
    } = req.body as {
      paymentHash: string
      totalAmount: number
      memo?: string
      recipientAddress: string
    }

    paymentHash = reqPaymentHash

    console.log("🥜 Forward to npub.cash request:", {
      paymentHash: paymentHash?.substring(0, 16) + "...",
      totalAmount,
      recipientAddress,
    })

    if (!recipientAddress) {
      return res.status(400).json({ error: "Missing recipient npub.cash address" })
    }

    if (!recipientAddress.endsWith("@npub.cash")) {
      return res.status(400).json({ error: "Invalid npub.cash address format" })
    }

    if (!totalAmount) {
      return res.status(400).json({ error: "Missing totalAmount" })
    }

    // Get BlinkPOS credentials based on environment from stored tip data
    // For npub.cash forwarding, we get environment from the stored tip data
    let environment: EnvironmentName = "production"

    // Check stored tip data for environment
    hybridStore = await getHybridStore()
    if (!hybridStore) {
      return res.status(500).json({ error: "Storage unavailable" })
    }
    if (paymentHash) {
      const tipData = await hybridStore.getTipData(paymentHash)
      if (tipData?.environment) {
        environment = tipData.environment as EnvironmentName
      }
    }

    // BlinkPOS credentials are set per-deployment; the `environment` value
    // only selects which Blink GraphQL URL we talk to.
    const blinkposApiKey = process.env.BLINKPOS_API_KEY
    const blinkposBtcWalletId = process.env.BLINKPOS_BTC_WALLET_ID
    const apiUrl = getApiUrlForEnvironment(environment)

    if (!blinkposApiKey || !blinkposBtcWalletId) {
      return res.status(500).json({ error: "BlinkPOS configuration missing" })
    }

    const blinkposAPI = new BlinkAPI(blinkposApiKey, apiUrl)

    // CRITICAL: Use atomic claim to prevent duplicate payouts
    // This ensures only ONE request (client or webhook) can process this payment
    if (paymentHash) {
      const claimResult = await hybridStore.claimPaymentForProcessing(paymentHash)

      if (!claimResult.claimed) {
        // Payment already being processed or completed - return appropriate response
        console.log(
          `🔒 [npub.cash] DUPLICATE PREVENTION: Payment ${paymentHash?.substring(0, 16)}... ${claimResult.reason}`,
        )

        if (claimResult.reason === "already_completed") {
          // Already successfully processed - return success (idempotent)
          return res.status(200).json({
            success: true,
            message: "Payment already processed",
            alreadyProcessed: true,
            details: { paymentHash, status: "completed" },
          })
        } else if (claimResult.reason === "already_processing") {
          // Another request (likely webhook) is processing - return 409
          return res.status(409).json({
            error: "Payment is being processed by another request",
            retryable: false,
            details: { paymentHash, status: "processing" },
          })
        } else {
          // Not found - payment was likely already processed and cleaned up
          // CRITICAL FIX: Do NOT continue - this could cause duplicate payments
          console.log(
            "⚠️ [npub.cash] No stored data found - likely already processed, skipping to prevent duplicate",
          )
          return res.status(200).json({
            success: true,
            message: "Payment data not found - likely already processed",
            alreadyProcessed: true,
            skipForwarding: true,
            details: { paymentHash, status: "not_found" },
          })
        }
      } else {
        claimSucceeded = true
        console.log(
          `✅ [npub.cash] CLAIMED payment ${paymentHash?.substring(0, 16)}... for processing`,
        )
      }
    }

    // Check for tip data if we have a payment hash
    let baseAmount = totalAmount
    let tipAmount = 0
    let tipRecipients: ApiTipRecipient[] = []
    let displayCurrency = "BTC"
    let _baseAmountDisplay = totalAmount
    let tipAmountDisplay = 0
    let storedMemo = memo

    if (paymentHash) {
      const tipData = await hybridStore.getTipData(paymentHash)
      if (tipData) {
        baseAmount = tipData.baseAmount || totalAmount
        tipAmount = tipData.tipAmount || 0
        tipRecipients = tipData.tipRecipients || []
        displayCurrency = tipData.displayCurrency || "BTC"
        _baseAmountDisplay = Number(tipData.baseAmountDisplay) || baseAmount
        tipAmountDisplay = Number(tipData.tipAmountDisplay) || tipAmount
        storedMemo = tipData.memo || memo

        console.log("📄 Tip data found:", {
          baseAmount,
          tipAmount,
          tipRecipients: tipRecipients.length,
          displayCurrency,
        })
      }
    }

    // Format the forwarding memo with tip recipient information
    let forwardingMemo: string
    const recipientNames = tipRecipients
      .map((r: ApiTipRecipient) => r.username)
      .join(", ")

    if (storedMemo && tipAmount > 0 && tipRecipients.length > 0) {
      // Generate enhanced memo with tip info
      let tipAmountText: string
      if (isBitcoinCurrency(displayCurrency)) {
        tipAmountText = `${tipAmount} sat`
      } else {
        const formattedTipAmount = formatCurrencyServer(
          tipAmountDisplay || tipAmount,
          displayCurrency,
        )
        tipAmountText = `${formattedTipAmount} (${tipAmount} sat)`
      }

      // Convert original memo format to enhanced format
      // From: "$0.80 + 10% tip = $0.88 (757 sats)"
      // To: "BlinkPOS: $0.80 + 10% tip = $0.88 (757 sats) | $0.08 (69 sat) tip split to user1, user2"
      const enhancedMemoContent = storedMemo.replace(
        /([^+]+?)\s*\+\s*([\d.]+)%\s*tip\s*=\s*(.+)/,
        (match: string, baseAmountStr: string, tipPercent: string, total: string) => {
          const cleanBaseAmount = baseAmountStr.trim()
          const splitText = tipRecipients.length > 1 ? "split to" : "to"
          return `${cleanBaseAmount} + ${tipPercent}% tip = ${total} | ${tipAmountText} tip ${splitText} ${recipientNames}`
        },
      )

      forwardingMemo = `BlinkPOS: ${enhancedMemoContent !== storedMemo ? enhancedMemoContent : storedMemo}`
    } else if (storedMemo && storedMemo.startsWith("BlinkPOS:")) {
      forwardingMemo = storedMemo
    } else if (storedMemo) {
      forwardingMemo = `BlinkPOS: ${storedMemo}`
    } else {
      forwardingMemo = `BlinkPOS: ${baseAmount} sats`
    }

    console.log("📝 Enhanced npub.cash forwarding memo:", {
      originalMemo: storedMemo?.substring(0, 50),
      enhancedMemo: forwardingMemo?.substring(0, 80),
      tipAmount,
      tipRecipients: tipRecipients.length,
    })

    // Step 1: Get invoice from npub.cash via LNURL-pay
    console.log("🔍 Resolving npub.cash LNURL for:", recipientAddress)

    let invoiceData: LnurlFullInvoiceResponse
    try {
      invoiceData = await getInvoiceFromLightningAddress(
        recipientAddress,
        Math.round(baseAmount),
        forwardingMemo,
      )
    } catch (lnurlError: unknown) {
      const lnurlMessage =
        lnurlError instanceof Error ? lnurlError.message : "Unknown error"
      console.error("❌ LNURL resolution failed:", lnurlError)
      return res.status(400).json({
        error: "Failed to get invoice from npub.cash",
        details: lnurlMessage,
      })
    }

    if (!invoiceData?.paymentRequest) {
      return res.status(400).json({ error: "No invoice returned from npub.cash" })
    }

    console.log("✅ Invoice received from npub.cash:", {
      hasPaymentRequest: !!invoiceData.paymentRequest,
      minSats: invoiceData.metadata?.minSendable / 1000,
      maxSats: invoiceData.metadata?.maxSendable / 1000,
    })

    // Step 2: Pay the invoice from BlinkPOS (this will be intraledger since npub.cash uses Blink)
    console.log("💸 Paying npub.cash invoice from BlinkPOS (intraledger)...")

    const paymentResult = await blinkposAPI.payLnInvoice(
      blinkposBtcWalletId,
      invoiceData.paymentRequest,
      forwardingMemo,
    )

    if (paymentResult.status !== "SUCCESS") {
      console.error("❌ Payment failed:", paymentResult)
      return res.status(400).json({
        error: "Payment failed",
        status: paymentResult.status,
      })
    }

    console.log("✅ Base amount forwarded successfully to npub.cash:", recipientAddress)

    // Log the forwarding event
    if (paymentHash) {
      await hybridStore.logEvent(paymentHash, "npubcash_forward", "success", {
        recipientAddress,
        baseAmount,
        memo: forwardingMemo,
        intraledger: true, // Mark as intraledger (zero fee)
      })
    }

    // Step 3: Send tips AFTER base amount
    let tipResult: TipDistributionResult | null = null
    if (tipAmount > 0 && tipRecipients.length > 0) {
      console.log("💡 Sending tips to recipients...")

      // Calculate weighted tip amounts based on share percentages
      let distributedSats = 0
      const recipientAmounts = tipRecipients.map(
        (recipient: ApiTipRecipient, index: number) => {
          const sharePercent = recipient.share || 100 / tipRecipients.length
          // For the last recipient, give them whatever is left to avoid rounding issues
          if (index === tipRecipients.length - 1) {
            return tipAmount - distributedSats
          }
          const amount = Math.floor((tipAmount * sharePercent) / 100)
          distributedSats += amount
          return amount
        },
      )

      console.log("💡 [npub.cash] Processing tips with weighted shares:", {
        totalTipSats: tipAmount,
        recipientCount: tipRecipients.length,
        distribution: tipRecipients.map(
          (r: ApiTipRecipient, i: number) =>
            `${r.username}: ${r.share || 100 / tipRecipients.length}% = ${recipientAmounts[i]} sats`,
        ),
      })

      const tipResults: TipResultEntry[] = []
      const isMultiple = tipRecipients.length > 1

      for (let i = 0; i < tipRecipients.length; i++) {
        const recipient = tipRecipients[i]
        // Use the pre-calculated weighted amount for this recipient
        const recipientTipAmount = recipientAmounts[i]
        const sharePercent = recipient.share || 100 / tipRecipients.length
        const recipientDisplayAmount = (tipAmountDisplay * sharePercent) / 100

        // Skip recipients who would receive 0 sats (cannot create 0-sat invoice)
        if (recipientTipAmount <= 0) {
          console.log(
            `⏭️ [npub.cash] Skipping tip to ${recipient.username}: amount is ${recipientTipAmount} sats (minimum 1 sat required)`,
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
            console.log(`🥜 Sending tip to npub.cash: ${recipient.username}`)

            const tipInvoiceData = await getInvoiceFromLightningAddress(
              recipient.username,
              recipientTipAmount,
              tipMemo,
            )

            const tipPaymentResult = await blinkposAPI.payLnInvoice(
              blinkposBtcWalletId,
              tipInvoiceData.paymentRequest,
              tipMemo,
            )

            if (tipPaymentResult.status === "SUCCESS") {
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
              blinkposBtcWalletId,
              recipient.username,
              recipientTipAmount,
              tipMemo,
            )

            if (tipPaymentResult.status === "SUCCESS") {
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
          const tipMessage =
            tipError instanceof Error ? tipError.message : "Unknown error"
          console.error(`❌ Tip payment error for ${recipient.username}:`, tipError)
          tipResults.push({
            success: false,
            recipient: recipient.username,
            error: tipMessage,
            type: recipientType,
          })
        }
      }

      const successCount = tipResults.filter((r: TipResultEntry) => r.success).length
      tipResult = {
        success: successCount === tipRecipients.length,
        partialSuccess: successCount > 0 && successCount < tipRecipients.length,
        totalAmount: tipAmount,
        recipients: tipResults,
        successCount,
        totalCount: tipRecipients.length,
      }

      console.log("✅ Tips sent:", tipResult)

      // Remove tip data after processing (marks as completed)
      if (paymentHash) {
        await hybridStore.removeTipData(paymentHash)
        claimSucceeded = false // Payment completed, no need to release on error
      }
    } else if (paymentHash && claimSucceeded) {
      // No tips, but we claimed - mark as completed
      await hybridStore.removeTipData(paymentHash)
      claimSucceeded = false
    }

    res.status(200).json({
      success: true,
      message: "Payment forwarded to npub.cash wallet",
      baseAmount,
      tipAmount,
      tipResult,
      recipientAddress,
      intraledger: true, // Confirm zero-fee intraledger payment
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Forward to npub.cash error:", error)

    // Release claim if we claimed but failed to complete
    if (claimSucceeded && hybridStore && paymentHash) {
      try {
        await hybridStore.releaseFailedClaim(paymentHash, message)
        console.log(
          `🔓 [npub.cash] Released claim for ${paymentHash?.substring(0, 16)}...`,
        )
      } catch (releaseError: unknown) {
        console.error("❌ [npub.cash] Failed to release claim:", releaseError)
      }
    }

    res.status(500).json({
      error: "Failed to forward payment to npub.cash",
      details: message,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE)
