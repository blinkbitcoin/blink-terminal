import type { NextApiRequest, NextApiResponse } from "next"

import BlinkAPI from "../../../lib/blink-api"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import {
  formatCurrencyServer,
  isBitcoinCurrency,
} from "../../../lib/currency-formatter-server"
import { getInvoiceFromLightningAddress, isNpubCashAddress } from "../../../lib/lnurl"
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

interface TipPaymentResult {
  status: string
  paymentHash?: string
  errors?: Array<{ message: string; code?: string; path?: string[] }>
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

/**
 * API endpoint for NWC tip-aware forwarding
 *
 * This endpoint:
 * 1. Looks up tip data for the payment
 * 2. If deferTips=true: Returns tip data WITHOUT sending tips (for correct chronology)
 * 3. If deferTips=false (default): Sends tips to recipients, then returns base amount info
 *
 * Correct NWC forwarding chronology (matches Blink):
 * 1. Call this endpoint with deferTips=true to get baseAmount and memo
 * 2. Forward baseAmount to NWC wallet FIRST
 * 3. Call /api/blink/send-nwc-tips to send tips SECOND
 *
 * POST /api/blink/forward-nwc-with-tips
 * Body: { paymentHash: string, totalAmount: number, memo?: string, deferTips?: boolean }
 *
 * Returns: { success: true, baseAmount: number, tipAmount: number, enhancedMemo: string, tipData?: object }
 */
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
      memo = "",
      deferTips = false,
      environment: reqEnvironment,
    } = req.body as {
      paymentHash: string
      totalAmount: number
      memo?: string
      deferTips?: boolean
      environment?: EnvironmentName
    }
    paymentHash = reqPaymentHash

    console.log("🎯 NWC TIP FORWARDING REQUEST:", {
      paymentHash: paymentHash?.substring(0, 16) + "...",
      totalAmount,
      environment: reqEnvironment,
      timestamp: new Date().toISOString(),
      memo: memo?.substring(0, 50) + "...",
    })

    // Validate required fields
    if (!paymentHash || !totalAmount) {
      return res.status(400).json({
        error: "Missing required fields: paymentHash, totalAmount",
      })
    }

    // Try to claim the payment for processing
    hybridStore = await getHybridStore()
    if (!hybridStore) {
      return res.status(500).json({ error: "Storage unavailable" })
    }
    const claimResult = await hybridStore.claimPaymentForProcessing(paymentHash)

    if (!claimResult.claimed) {
      // Payment claim failed - check reason
      console.log(
        `ℹ️ No payment data for NWC payment: ${paymentHash?.substring(0, 16)}... - ${claimResult.reason}`,
      )

      if (claimResult.reason === "already_completed") {
        // Payment already forwarded - tell client not to forward again
        console.log(
          `✅ Payment ${paymentHash?.substring(0, 16)}... already completed - skipping duplicate forwarding`,
        )
        return res.status(200).json({
          success: true,
          alreadyProcessed: true,
          skipForwarding: true, // Client should NOT forward
          message: "Payment already forwarded",
        })
      }

      if (claimResult.reason === "already_processing") {
        // Payment being processed by another request (webhook or other client call)
        // Tell client NOT to forward to prevent duplicate payment
        console.log(
          `⏳ Payment ${paymentHash?.substring(0, 16)}... already being processed - skipping duplicate forwarding`,
        )
        return res.status(200).json({
          success: true,
          alreadyProcessing: true,
          skipForwarding: true, // Client should NOT forward
          message: "Payment already being processed",
        })
      }

      // No payment data found (not_found) - payment was either:
      // 1. Already processed and cleaned up (most common) - should NOT forward again
      // 2. Never created through our system - should NOT forward
      // CRITICAL FIX: Always skip forwarding when data not found to prevent double-spend
      console.log(
        `⚠️ Payment data not found for ${paymentHash?.substring(0, 16)}... - skipping forwarding to prevent duplicate`,
      )
      return res.status(200).json({
        success: true,
        skipForwarding: true, // CRITICAL: Prevent forwarding when data not found
        alreadyProcessed: true, // Assume it was already processed
        message: "Payment data not found - likely already processed",
        noPaymentData: true,
      })
    }

    claimSucceeded = true
    const tipData = claimResult.paymentData

    if (!tipData) {
      await hybridStore.releaseFailedClaim(paymentHash, "No payment data in claim")
      claimSucceeded = false
      return res.status(400).json({ error: "No payment data found in claim" })
    }

    console.log(
      `✅ CLAIMED payment ${paymentHash?.substring(0, 16)}... for NWC tip processing`,
    )

    // Support both old single tipRecipient and new tipRecipients array
    const tipRecipients: ApiTipRecipient[] =
      (tipData.tipRecipients as ApiTipRecipient[]) ||
      (tipData.tipRecipient ? [{ username: tipData.tipRecipient, share: 100 }] : [])

    console.log("🔍 NWC TIP FORWARDING CONTEXT:", {
      paymentHash: paymentHash?.substring(0, 16) + "...",
      tipAmount: tipData.tipAmount,
      tipRecipientsCount: tipRecipients.length,
      tipRecipients: tipRecipients.map((r: ApiTipRecipient) => r.username),
      timestamp: new Date().toISOString(),
    })

    // Resolve environment from tip data (stored when invoice was created)
    // or from the request body. BlinkPOS credentials are set per-deployment;
    // `environment` only selects which Blink GraphQL URL we talk to.
    const environment = (tipData.environment ||
      reqEnvironment ||
      "production") as EnvironmentName
    const blinkposApiKey = process.env.BLINKPOS_API_KEY
    const blinkposBtcWalletId = process.env.BLINKPOS_BTC_WALLET_ID
    const apiUrl = getApiUrlForEnvironment(environment)

    if (!blinkposApiKey || !blinkposBtcWalletId) {
      console.error("Missing BlinkPOS environment variables")
      await hybridStore.releaseFailedClaim(paymentHash, "Missing BlinkPOS config")
      claimSucceeded = false
      return res.status(500).json({ error: "BlinkPOS configuration missing" })
    }

    // Calculate base amount (total - tip)
    const tipAmountNum = Number(tipData.tipAmount) || 0
    const baseAmount = totalAmount - tipAmountNum

    // Generate enhanced memo
    let enhancedMemo: string
    const recipientNames = tipRecipients
      .map((r: ApiTipRecipient) => r.username)
      .join(", ")

    if (memo && tipAmountNum > 0 && tipRecipients.length > 0) {
      const displayCurrency = tipData.displayCurrency || "BTC"
      const tipAmountDisplay = tipData.tipAmountDisplay || tipAmountNum

      let tipAmountText: string
      if (isBitcoinCurrency(displayCurrency)) {
        tipAmountText = `${tipAmountNum} sat`
      } else {
        const formattedAmount = formatCurrencyServer(tipAmountDisplay, displayCurrency)
        tipAmountText = `${formattedAmount} (${tipAmountNum} sat)`
      }

      // Convert memo to enhanced format with tip info
      const enhancedMemoContent = memo.replace(
        /([^+]+?)\s*\+\s*([\d.]+)%\s*tip\s*=\s*(.+)/,
        (match: string, baseAmountStr: string, tipPercent: string, total: string) => {
          const cleanBaseAmount = baseAmountStr.trim()
          const splitText = tipRecipients.length > 1 ? "split to" : "to"
          return `${cleanBaseAmount} + ${tipPercent}% tip = ${total} | ${tipAmountText} tip ${splitText} ${recipientNames}`
        },
      )

      enhancedMemo = `BlinkPOS: ${enhancedMemoContent !== memo ? enhancedMemoContent : memo}`
    } else if (memo && tipRecipients.length > 0 && tipAmountNum === 0) {
      enhancedMemo = `BlinkPOS: ${memo} | No tip (recipients: ${recipientNames})`
    } else {
      enhancedMemo = memo ? `BlinkPOS: ${memo}` : `BlinkPOS: ${totalAmount} sats`
    }

    console.log("📝 Enhanced NWC memo:", {
      originalMemo: memo,
      enhancedMemo,
      baseAmount,
      tipAmount: tipAmountNum,
      deferTips,
    })

    // If deferTips=true, return data without processing
    // This allows the caller to forward base amount FIRST, then send tips SECOND
    if (deferTips) {
      // For payments WITH tips - return tip data for later processing
      if (tipAmountNum > 0 && tipRecipients.length > 0) {
        console.log(
          "⏸️ Deferring tip sending (deferTips=true) - base amount will be forwarded first",
        )

        return res.status(200).json({
          success: true,
          baseAmount,
          tipAmount: tipAmountNum,
          enhancedMemo,
          tipsDeferred: true,
          tipData: {
            paymentHash,
            tipAmount: tipAmountNum,
            tipRecipients: tipRecipients.map((r: ApiTipRecipient) => ({
              username: r.username,
              share: r.share,
            })),
            displayCurrency: tipData.displayCurrency || "BTC",
            tipAmountDisplay: tipData.tipAmountDisplay,
          },
        })
      } else {
        // For payments WITHOUT tips - just return base amount info
        // Mark as completed since there's nothing more to process
        console.log("⏸️ No tips to defer, returning base amount for NWC forwarding")

        await hybridStore.logEvent(paymentHash, "nwc_no_tips", "success", { baseAmount })
        await hybridStore.removeTipData(paymentHash)
        claimSucceeded = false

        return res.status(200).json({
          success: true,
          baseAmount,
          tipAmount: 0,
          enhancedMemo,
          tipsDeferred: false,
          noTips: true,
        })
      }
    }

    // Send tips to recipients if there are any (when deferTips=false)
    let tipResult: TipDistributionResult | null = null

    if (tipAmountNum > 0 && tipRecipients.length > 0) {
      const blinkposAPI = new BlinkAPI(blinkposApiKey, apiUrl)

      try {
        const totalTipSats = Math.round(tipAmountNum)

        // Calculate weighted tip amounts based on share percentages
        let distributedSats = 0
        const recipientAmounts = tipRecipients.map(
          (recipient: ApiTipRecipient, index: number) => {
            const sharePercent = recipient.share || 100 / tipRecipients.length
            // For the last recipient, give them whatever is left to avoid rounding issues
            if (index === tipRecipients.length - 1) {
              return totalTipSats - distributedSats
            }
            const amount = Math.floor((totalTipSats * sharePercent) / 100)
            distributedSats += amount
            return amount
          },
        )

        console.log("💡 Processing tips for NWC payment with weighted shares:", {
          totalTipSats,
          recipientCount: tipRecipients.length,
          distribution: tipRecipients.map(
            (r: ApiTipRecipient, i: number) =>
              `${r.username}: ${r.share || 100 / tipRecipients.length}% = ${recipientAmounts[i]} sats`,
          ),
        })

        const displayCurrency = tipData.displayCurrency || "BTC"
        const tipAmountInDisplayCurrency =
          Number(tipData.tipAmountDisplay) || totalTipSats

        const tipResults: TipResultEntry[] = []
        const isMultiple = tipRecipients.length > 1

        for (let i = 0; i < tipRecipients.length; i++) {
          const recipient = tipRecipients[i]
          // Use the pre-calculated weighted amount for this recipient
          const recipientTipAmount = recipientAmounts[i]
          const sharePercent = recipient.share || 100 / tipRecipients.length
          const recipientDisplayAmount = (tipAmountInDisplayCurrency * sharePercent) / 100

          // Skip recipients who would receive 0 sats (cannot create 0-sat invoice)
          if (recipientTipAmount <= 0) {
            console.log(
              `⏭️ [NWC] Skipping tip to ${recipient.username}: amount is ${recipientTipAmount} sats (minimum 1 sat required)`,
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

          console.log(`💡 Sending tip to ${recipient.username}:`, {
            amount: recipientTipAmount,
            share: `${sharePercent}%`,
            index: i + 1,
            total: tipRecipients.length,
          })

          // Generate tip memo
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
            // Check if recipient is npub.cash address
            const recipientType =
              recipient.type ||
              (isNpubCashAddress(recipient.username) ? "npub_cash" : "blink")
            let tipPaymentResult: TipPaymentResult

            if (recipientType === "npub_cash") {
              // Send tip to npub.cash address via LNURL-pay
              console.log(`🥜 Sending NWC tip to npub.cash: ${recipient.username}`)

              const tipInvoiceData = await getInvoiceFromLightningAddress(
                recipient.username,
                recipientTipAmount,
                tipMemo,
              )

              tipPaymentResult = await blinkposAPI.payLnInvoice(
                blinkposBtcWalletId,
                tipInvoiceData.paymentRequest,
                tipMemo,
              )
            } else {
              // Send tip to Blink user (existing method)
              tipPaymentResult = await blinkposAPI.sendTipViaInvoice(
                blinkposBtcWalletId,
                recipient.username,
                recipientTipAmount,
                tipMemo,
              )
            }

            const recipientDisplay =
              recipientType === "npub_cash"
                ? recipient.username
                : `${recipient.username}@blink.sv`

            if (tipPaymentResult.status === "SUCCESS") {
              console.log(`💰 Tip successfully sent to ${recipient.username}`)
              tipResults.push({
                success: true,
                amount: recipientTipAmount,
                recipient: recipientDisplay,
                status: tipPaymentResult.status,
                type: recipientType,
              })

              await hybridStore.logEvent(paymentHash, "nwc_tip_sent", "success", {
                tipAmount: recipientTipAmount,
                tipRecipient: recipient.username,
                paymentHash: tipPaymentResult.paymentHash,
                recipientIndex: i + 1,
                totalRecipients: tipRecipients.length,
                type: recipientType,
              })
            } else {
              console.error(
                `❌ Tip payment to ${recipient.username} failed:`,
                tipPaymentResult.status,
              )
              tipResults.push({
                success: false,
                recipient: recipientDisplay,
                error: `Tip payment failed: ${tipPaymentResult.status}`,
                type: recipientType,
              })
            }
          } catch (recipientTipError: unknown) {
            const recipientTipMessage =
              recipientTipError instanceof Error
                ? recipientTipError.message
                : "Unknown error"
            console.error(
              `❌ Tip payment to ${recipient.username} error:`,
              recipientTipError,
            )
            const recipientType = recipient.type || "blink"
            tipResults.push({
              success: false,
              recipient:
                recipientType === "npub_cash"
                  ? recipient.username
                  : `${recipient.username}@blink.sv`,
              error: recipientTipMessage,
              type: recipientType,
            })
          }
        }

        const successCount = tipResults.filter((r: TipResultEntry) => r.success).length
        tipResult = {
          success: successCount === tipRecipients.length,
          partialSuccess: successCount > 0 && successCount < tipRecipients.length,
          totalAmount: tipAmountNum,
          recipients: tipResults,
          successCount,
          totalCount: tipRecipients.length,
        }

        console.log("💡 NWC tip distribution complete:", {
          successCount,
          totalCount: tipRecipients.length,
        })
      } catch (tipError: unknown) {
        const tipMessage = tipError instanceof Error ? tipError.message : "Unknown error"
        console.error("❌ NWC tip payment error:", tipError)
        tipResult = {
          success: false,
          error: tipMessage,
        }
      }
    }

    // Log forwarding event and mark as completed
    await hybridStore.logEvent(paymentHash, "nwc_forwarded", "success", {
      baseAmount,
      tipAmount: tipAmountNum,
      tipRecipients: tipRecipients.map((r: ApiTipRecipient) => r.username),
    })

    // Mark as completed
    await hybridStore.removeTipData(paymentHash)
    claimSucceeded = false

    console.log(
      `✅ COMPLETED NWC payment ${paymentHash?.substring(0, 16)}... tip processing`,
    )

    // Return success with base amount for NWC forwarding
    res.status(200).json({
      success: true,
      baseAmount,
      tipAmount: tipAmountNum,
      enhancedMemo,
      tipResult,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ NWC tip forwarding error:", error)

    if (claimSucceeded && hybridStore && paymentHash) {
      console.log(
        `🔓 Releasing claim for failed NWC payment ${paymentHash?.substring(0, 16)}...`,
      )
      await hybridStore.releaseFailedClaim(paymentHash, message)
    }

    res.status(500).json({
      error: "Failed to process NWC tips",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE)
