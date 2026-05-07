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
import { getTracer, withSpan, getActiveTraceId } from "../../../lib/tracing"

const tracer = getTracer("bbt-payment")

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

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  return withSpan(tracer, "payment.forward-with-tips", async (rootSpan) => {
    // Set trace ID response header for request correlation
    const traceId = getActiveTraceId()
    if (traceId) {
      res.setHeader("X-Trace-Id", traceId)
    }

    let hybridStore: HybridStore | null = null
    let paymentHash: string | null = null
    let claimSucceeded = false

    try {
      const {
        paymentHash: reqPaymentHash,
        totalAmount,
        memo = "",
      } = req.body as {
        paymentHash: string
        totalAmount: number
        memo?: string
      }
      paymentHash = reqPaymentHash

      rootSpan.setAttribute("payment.hash", paymentHash || "")
      rootSpan.setAttribute("payment.total_amount_sats", totalAmount || 0)

      // CRITICAL: Log all tip forwarding attempts for security audit
      console.log("🎯 TIP FORWARDING REQUEST:", {
        paymentHash: paymentHash?.substring(0, 16) + "...",
        totalAmount,
        timestamp: new Date().toISOString(),
        memo: memo?.substring(0, 50) + "...",
      })

      // Validate required fields
      if (!paymentHash || !totalAmount) {
        return res.status(400).json({
          error: "Missing required fields: paymentHash, totalAmount",
        })
      }

      // CRITICAL FIX: Use atomic claim to prevent duplicate payouts
      // This ensures only ONE request can process this payment
      hybridStore = await getHybridStore()
      if (!hybridStore) {
        return res.status(500).json({ error: "Storage unavailable" })
      }
      const claimResult = await hybridStore.claimPaymentForProcessing(paymentHash)

      if (!claimResult.claimed) {
        // Payment already being processed or completed - this is NOT an error
        // Return success to prevent client retries (idempotent behavior)
        console.log(
          `🔒 DUPLICATE PREVENTION: Payment ${paymentHash?.substring(0, 16)}... ${claimResult.reason}`,
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
          // Another request is processing - client should wait
          return res.status(409).json({
            error: "Payment is being processed by another request",
            retryable: false,
            details: { paymentHash, status: "processing" },
          })
        } else {
          // Not found
          const stats = await hybridStore.getStats()
          console.log("📊 Current storage stats:", stats)
          return res.status(400).json({
            error: "No tip data found for this payment",
            paymentHash: paymentHash,
            storageStats: stats,
          })
        }
      }

      // Successfully claimed - we are the only process handling this payment
      claimSucceeded = true
      const tipData = claimResult.paymentData

      if (!tipData) {
        await hybridStore.releaseFailedClaim(paymentHash, "No payment data in claim")
        claimSucceeded = false
        return res.status(400).json({ error: "No payment data found in claim" })
      }

      console.log(`✅ CLAIMED payment ${paymentHash?.substring(0, 16)}... for processing`)

      rootSpan.setAttribute("payment.base_amount_sats", tipData.baseAmount || 0)
      rootSpan.setAttribute("payment.tip_amount_sats", tipData.tipAmount || 0)

      // CRITICAL: Validate tip data contains proper user credentials
      if (!tipData.userApiKey || !tipData.userWalletId) {
        console.error("❌ CRITICAL: Tip data missing user credentials:", {
          paymentHash: paymentHash?.substring(0, 16) + "...",
          hasUserApiKey: !!tipData.userApiKey,
          hasUserWalletId: !!tipData.userWalletId,
          userWalletId: tipData.userWalletId,
          timestamp: new Date().toISOString(),
        })
        // Release the claim so it can be retried after fixing data
        await hybridStore.releaseFailedClaim(paymentHash, "Missing user credentials")
        claimSucceeded = false
        return res.status(400).json({
          error: "Invalid tip data: missing user credentials",
        })
      }

      // CRITICAL: Log the user wallet being used for payment forwarding
      // Support both old single tipRecipient and new tipRecipients array
      const tipRecipients: ApiTipRecipient[] =
        (tipData.tipRecipients as ApiTipRecipient[]) ||
        (tipData.tipRecipient ? [{ username: tipData.tipRecipient, share: 100 }] : [])

      rootSpan.setAttribute("payment.tip_recipients_count", tipRecipients.length)

      console.log("🔍 TIP FORWARDING USER CONTEXT:", {
        paymentHash: paymentHash?.substring(0, 16) + "...",
        userWalletId: tipData.userWalletId,
        apiKeyPrefix: tipData.userApiKey?.substring(0, 10) + "...",
        tipAmount: tipData.tipAmount,
        tipRecipientsCount: tipRecipients.length,
        tipRecipients: tipRecipients.map((r: ApiTipRecipient) => r.username),
        timestamp: new Date().toISOString(),
      })

      // Resolve environment from tip data (stored when invoice was created).
      // BlinkPOS credentials are set per-deployment; `environment` only
      // selects which Blink GraphQL URL we talk to.
      const environment: EnvironmentName = (tipData.environment ||
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

      console.log("🎯 Processing payment with tip splitting:", {
        paymentHash: paymentHash.substring(0, 8) + "...",
        totalAmount,
        baseAmount: tipData.baseAmount,
        tipAmount: tipData.tipAmount,
        tipRecipientsCount: tipRecipients.length,
        tipRecipients: tipRecipients.map(
          (r: ApiTipRecipient) => `${r.username} (${r.share}%)`,
        ),
      })

      // Calculate the amount to forward to user (total - tip)
      const userAmount = totalAmount - (tipData.tipAmount || 0)

      // Step 1: Forward base amount to user
      const userBlinkAPI = new BlinkAPI(tipData.userApiKey, apiUrl)

      // Enhanced memo with tip information
      let forwardingMemo: string
      const recipientNames = tipRecipients
        .map((r: ApiTipRecipient) => r.username)
        .join(", ")

      if (memo && tipData.tipAmount > 0 && tipRecipients.length > 0) {
        // Extract the base amount and tip details for enhanced memo
        const displayCurrency = tipData.displayCurrency || "BTC"
        const tipAmountDisplay = tipData.tipAmountDisplay || tipData.tipAmount

        let tipAmountText: string
        if (isBitcoinCurrency(displayCurrency)) {
          tipAmountText = `${tipData.tipAmount} sat`
        } else {
          // Format the amount with dynamic currency formatting
          const formattedAmount = formatCurrencyServer(tipAmountDisplay, displayCurrency)
          tipAmountText = `${formattedAmount} (${tipData.tipAmount} sat)`
        }

        // Convert original memo format to enhanced format
        // From: "$0.80 + 10% tip = $0.88 (757 sats)"
        // To: "BlinkPOS: $0.80 + 10% tip = $0.88 (757 sats) | $0.08 (69 sat) tip split to user1, user2"
        const enhancedMemo = memo.replace(
          /([^+]+?)\s*\+\s*([\d.]+)%\s*tip\s*=\s*(.+)/,
          (match: string, baseAmount: string, tipPercent: string, total: string) => {
            // Clean up baseAmount - remove extra spaces and ensure proper formatting
            const cleanBaseAmount = baseAmount.trim()
            const splitText = tipRecipients.length > 1 ? "split to" : "to"
            return `${cleanBaseAmount} + ${tipPercent}% tip = ${total} | ${tipAmountText} tip ${splitText} ${recipientNames}`
          },
        )

        forwardingMemo = `BlinkPOS: ${enhancedMemo !== memo ? enhancedMemo : memo}`
      } else if (memo && tipRecipients.length > 0 && tipData.tipAmount === 0) {
        // Tips enabled but customer chose "No Tip" - still show proper memo with recipient info
        forwardingMemo = `BlinkPOS: ${memo} | No tip (recipients: ${recipientNames})`
      } else {
        // Standard payment without tip system or no memo provided
        forwardingMemo = memo ? `BlinkPOS: ${memo}` : "BlinkPOS: Payment forwarded"
      }

      console.log("📝 Enhanced forwarding memo:", {
        originalMemo: memo,
        enhancedMemo: forwardingMemo,
        tipAmount: tipData.tipAmount,
        tipRecipient: tipData.tipRecipient,
      })

      console.log("💳 Creating invoice from user account for base amount...")
      const userInvoice = await userBlinkAPI.createLnInvoice(
        tipData.userWalletId,
        Math.round(userAmount),
        forwardingMemo,
      )

      if (!userInvoice || !userInvoice.paymentRequest) {
        throw new Error("Failed to create user invoice for forwarding")
      }

      console.log("📄 User invoice created:", { paymentHash: userInvoice.paymentHash })

      // Step 2: Pay the user's invoice from BlinkPOS
      const blinkposAPI = new BlinkAPI(blinkposApiKey, apiUrl)

      console.log("💰 Paying user invoice from BlinkPOS...")
      // Pass the memo to the payment so it shows in the receiver's Blink wallet
      const paymentResult = await blinkposAPI.payLnInvoice(
        blinkposBtcWalletId,
        userInvoice.paymentRequest,
        forwardingMemo,
      )

      if (paymentResult.status !== "SUCCESS") {
        throw new Error(`Payment forwarding failed: ${paymentResult.status}`)
      }

      console.log("✅ Base amount successfully forwarded to user account")

      // Step 3: Send tip to tip recipients if there's a tip
      let tipResult: TipDistributionResult | null = null
      // Ensure tipAmount is a proper number for comparison
      const tipAmountNum = Number(tipData.tipAmount) || 0
      console.log("🎯 TIP CHECK:", {
        tipAmount: tipData.tipAmount,
        tipAmountNum,
        tipAmountType: typeof tipData.tipAmount,
        tipRecipientsCount: tipRecipients.length,
        condition: tipAmountNum > 0 && tipRecipients.length > 0,
      })

      if (tipAmountNum > 0 && tipRecipients.length > 0) {
        try {
          // Calculate tip amount per recipient based on their share percentage
          const totalTipSats = Math.round(Number(tipData.tipAmount))

          // Calculate weighted tip amounts, ensuring we handle rounding properly
          // Each recipient has a 'share' percentage (e.g., 70 for 70%)
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

          console.log("💡 Processing tip payment with weighted shares:", {
            totalTipSats,
            recipientCount: tipRecipients.length,
            distribution: tipRecipients.map(
              (r: ApiTipRecipient, i: number) =>
                `${r.username}: ${r.share || 100 / tipRecipients.length}% = ${recipientAmounts[i]} sats`,
            ),
          })

          // Generate tip memo based on display currency and amounts
          const generateTipMemo = (
            tipAmountInDisplayCurrency: number,
            tipAmountSats: number,
            displayCurrency: string,
            isMultiple: boolean,
            recipientIndex: number,
            totalRecipients: number,
          ) => {
            const splitInfo = isMultiple
              ? ` (${recipientIndex + 1}/${totalRecipients})`
              : ""
            if (isBitcoinCurrency(displayCurrency)) {
              return `BlinkPOS Tip${splitInfo}: ${tipAmountSats} sats`
            } else {
              const formattedAmount = formatCurrencyServer(
                tipAmountInDisplayCurrency,
                displayCurrency,
              )
              return `BlinkPOS Tip${splitInfo}: ${formattedAmount} (${tipAmountSats} sats)`
            }
          }

          const displayCurrency = tipData.displayCurrency || "BTC"
          const tipAmountInDisplayCurrency =
            Number(tipData.tipAmountDisplay) || totalTipSats

          // Send tips to all recipients
          const tipResults: TipResultEntry[] = []
          const isMultiple = tipRecipients.length > 1

          for (let i = 0; i < tipRecipients.length; i++) {
            const recipient = tipRecipients[i]
            // Use the pre-calculated weighted amount for this recipient
            const recipientTipAmount = recipientAmounts[i]
            const sharePercent = recipient.share || 100 / tipRecipients.length
            const recipientDisplayAmount =
              (tipAmountInDisplayCurrency * sharePercent) / 100

            // Skip recipients who would receive 0 sats (cannot create 0-sat invoice)
            if (recipientTipAmount <= 0) {
              console.log(
                `⏭️ Skipping tip to ${recipient.username}: amount is ${recipientTipAmount} sats (minimum 1 sat required)`,
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

            const tipMemo = generateTipMemo(
              recipientDisplayAmount,
              recipientTipAmount,
              displayCurrency,
              isMultiple,
              i,
              tipRecipients.length,
            )

            try {
              // Check if recipient is npub.cash address
              const recipientType =
                recipient.type ||
                (isNpubCashAddress(recipient.username) ? "npub_cash" : "blink")
              let tipPaymentResult: TipPaymentResult

              if (recipientType === "npub_cash") {
                // Send tip to npub.cash address via LNURL-pay
                console.log(`🥜 Sending tip to npub.cash: ${recipient.username}`)

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
                // Log successful tip event
                await hybridStore.logEvent(paymentHash, "tip_sent", "success", {
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
                // Log failed tip event
                await hybridStore.logEvent(paymentHash, "tip_sent", "failure", {
                  tipAmount: recipientTipAmount,
                  tipRecipient: recipient.username,
                  status: tipPaymentResult.status,
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
              // Log tip error event
              await hybridStore.logEvent(
                paymentHash,
                "tip_sent",
                "failure",
                {
                  tipAmount: recipientTipAmount,
                  tipRecipient: recipient.username,
                  type: recipientType,
                },
                recipientTipMessage,
              )
            }
          }

          // Summarize results
          const successCount = tipResults.filter((r: TipResultEntry) => r.success).length
          tipResult = {
            success: successCount === tipRecipients.length,
            partialSuccess: successCount > 0 && successCount < tipRecipients.length,
            totalAmount: tipData.tipAmount,
            recipients: tipResults,
            successCount,
            totalCount: tipRecipients.length,
          }

          console.log("💡 Tip distribution complete:", {
            successCount,
            totalCount: tipRecipients.length,
            partialSuccess: tipResult.partialSuccess,
          })
        } catch (tipError: unknown) {
          const tipMessage =
            tipError instanceof Error ? tipError.message : "Unknown error"
          console.error("❌ Tip payment error:", tipError)
          tipResult = {
            success: false,
            error: tipMessage,
          }
          // Log tip error event
          await hybridStore.logEvent(
            paymentHash,
            "tip_sent",
            "failure",
            {
              tipAmount: tipData.tipAmount,
              tipRecipients: tipRecipients.map((r: ApiTipRecipient) => r.username),
            },
            tipMessage,
          )
        }
      } else {
        console.log("ℹ️ No tip to process:", {
          tipAmount: tipData.tipAmount,
          tipRecipientsCount: tipRecipients.length,
          reason: !tipData.tipAmount
            ? "no tip amount"
            : tipRecipients.length === 0
              ? "no tip recipients"
              : "unknown",
        })
      }

      // Step 4: Log forwarding event and mark as completed
      // Note: Status was already set to 'processing' by claimPaymentForProcessing()
      await hybridStore.logEvent(paymentHash, "forwarded", "success", {
        forwardedAmount: userAmount,
        tipAmount: tipData.tipAmount,
        tipRecipients: tipRecipients.map((r: ApiTipRecipient) => r.username),
      })

      // Mark as completed (removes from hot storage)
      await hybridStore.removeTipData(paymentHash)
      claimSucceeded = false // Payment completed, no need to release on error

      console.log(`✅ COMPLETED payment ${paymentHash?.substring(0, 16)}... forwarding`)

      rootSpan.setAttribute("payment.result", "success")
      rootSpan.setAttribute("payment.forwarded_amount_sats", userAmount)

      // Return success response
      res.status(200).json({
        success: true,
        message: "Payment successfully processed with tip splitting",
        details: {
          paymentHash,
          totalAmount,
          forwardedAmount: userAmount,
          userWalletId: tipData.userWalletId,
          paymentStatus: paymentResult.status,
          invoiceHash: userInvoice.paymentHash,
          tipResult: tipResult,
          tipSplitting: {
            baseAmount: tipData.baseAmount,
            tipAmount: tipData.tipAmount,
            tipPercent: tipData.tipPercent,
            tipRecipients: tipRecipients,
          },
        },
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("❌ Payment forwarding with tips error:", error)

      // CRITICAL: Release the claim if we claimed but failed before completing
      // This allows the payment to be retried
      if (claimSucceeded && hybridStore && paymentHash) {
        console.log(
          `🔓 Releasing claim for failed payment ${paymentHash?.substring(0, 16)}...`,
        )
        await hybridStore.releaseFailedClaim(paymentHash, message)
      }

      // Handle specific error cases
      let errorMessage = "Failed to forward payment with tips"
      if (message.includes("invoice")) {
        errorMessage = "Failed to create invoice for payment forwarding"
      } else if (message.includes("payment")) {
        errorMessage = "Payment forwarding transaction failed"
      } else if (message.includes("balance")) {
        errorMessage = "Insufficient balance in BlinkPOS account"
      }

      res.status(500).json({
        error: errorMessage,
        retryable: claimSucceeded, // If we had the claim, it's now released and retryable
        details: process.env.NODE_ENV === "development" ? message : undefined,
      })
    }
  })
}

export default withRateLimit(handler, RATE_LIMIT_WRITE)
