import type { NextApiRequest, NextApiResponse } from "next"

/**
 * API endpoint to forward payment to a Blink Lightning Address wallet
 *
 * This endpoint creates an invoice on behalf of the recipient using the
 * public Blink API and pays it from BlinkPOS.
 *
 * Used when the user's active wallet is connected via Lightning Address
 * (no API key required).
 */

import BlinkAPI from "../../../lib/blink-api"
import { getApiUrlForEnvironment, type EnvironmentName } from "../../../lib/config/api"
import {
  formatCurrencyServer,
  isBitcoinCurrency,
} from "../../../lib/currency-formatter-server"
import { getInvoiceFromLightningAddress } from "../../../lib/lnurl"
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
      recipientWalletId,
      recipientUsername,
    } = req.body as {
      paymentHash: string
      totalAmount: number
      memo?: string
      recipientWalletId: string
      recipientUsername: string
    }

    paymentHash = reqPaymentHash

    console.log("📥 Forward to LN Address request:", {
      paymentHash: paymentHash?.substring(0, 16) + "...",
      totalAmount,
      recipientUsername,
      recipientWalletId: recipientWalletId?.substring(0, 16) + "...",
    })

    if (!recipientWalletId || !recipientUsername) {
      return res.status(400).json({ error: "Missing recipient wallet information" })
    }

    if (!totalAmount) {
      return res.status(400).json({ error: "Missing totalAmount" })
    }

    // Get BlinkPOS credentials based on environment from stored tip data
    // For LN Address forwarding, we get environment from the stored tip data
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
          `🔒 [LN Address] DUPLICATE PREVENTION: Payment ${paymentHash?.substring(0, 16)}... ${claimResult.reason}`,
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
            "⚠️ [LN Address] No stored data found - likely already processed, skipping to prevent duplicate",
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
          `✅ [LN Address] CLAIMED payment ${paymentHash?.substring(0, 16)}... for processing`,
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

    console.log("📝 Enhanced LN Address forwarding memo:", {
      originalMemo: storedMemo?.substring(0, 50),
      enhancedMemo: forwardingMemo?.substring(0, 80),
      tipAmount,
      tipRecipients: tipRecipients.length,
    })

    // Step 1: Look up recipient's BTC wallet (required for lnInvoiceCreateOnBehalfOfRecipient)
    // The stored walletId might be a USD wallet, which doesn't support this operation
    console.log("🔍 Looking up BTC wallet for recipient:", recipientUsername)

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
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: walletLookupQuery,
        variables: { username: recipientUsername },
      }),
    })

    const walletLookupData = await walletLookupResponse.json()

    let btcWalletId = recipientWalletId // Fallback to stored wallet

    if (
      walletLookupData.data?.accountDefaultWallet?.id &&
      walletLookupData.data?.accountDefaultWallet?.walletCurrency === "BTC"
    ) {
      btcWalletId = walletLookupData.data.accountDefaultWallet.id
      console.log("✅ Found BTC wallet:", btcWalletId.substring(0, 16) + "...")
    } else {
      console.log(
        "⚠️ Could not find BTC wallet, using stored wallet:",
        recipientWalletId?.substring(0, 16) + "...",
      )
    }

    // Step 2: Create invoice on behalf of recipient using public Blink API
    console.log("📝 Creating invoice on behalf of recipient:", recipientUsername)

    const createInvoiceQuery = `
      mutation lnInvoiceCreateOnBehalfOfRecipient($input: LnInvoiceCreateOnBehalfOfRecipientInput!) {
        lnInvoiceCreateOnBehalfOfRecipient(input: $input) {
          errors {
            message
          }
          invoice {
            paymentHash
            paymentRequest
            paymentSecret
            satoshis
          }
        }
      }
    `

    const invoiceResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
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
        invoiceData.data?.lnInvoiceCreateOnBehalfOfRecipient?.errors?.[0]?.message ||
        "Failed to create invoice on behalf of recipient"
      console.error("❌ Failed to create invoice on behalf:", errorMsg)
      return res.status(400).json({ error: errorMsg })
    }

    const recipientInvoice = invoiceData.data?.lnInvoiceCreateOnBehalfOfRecipient?.invoice
    if (!recipientInvoice?.paymentRequest) {
      return res.status(400).json({ error: "No invoice returned from recipient wallet" })
    }

    console.log("✅ Invoice created on behalf of recipient:", {
      paymentHash: recipientInvoice.paymentHash?.substring(0, 16) + "...",
      satoshis: recipientInvoice.satoshis,
    })

    // Step 2: Pay the invoice from BlinkPOS (base amount FIRST)
    console.log("💸 Paying invoice from BlinkPOS...")

    const paymentResult = await blinkposAPI.payLnInvoice(
      blinkposBtcWalletId,
      recipientInvoice.paymentRequest,
      forwardingMemo,
    )

    if (paymentResult.status !== "SUCCESS") {
      console.error("❌ Payment failed:", paymentResult)
      return res.status(400).json({
        error: "Payment failed",
        status: paymentResult.status,
      })
    }

    console.log("✅ Base amount forwarded successfully to", recipientUsername)

    // Log the forwarding event
    if (paymentHash) {
      await hybridStore.logEvent(paymentHash, "ln_address_forward", "success", {
        recipientUsername,
        baseAmount,
        memo: forwardingMemo,
      })
    }

    // Step 3: Send tips AFTER base amount (TIPS SECOND)
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

      console.log("💡 [LN Address] Processing tips with weighted shares:", {
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
            `⏭️ [LN Address] Skipping tip to ${recipient.username}: amount is ${recipientTipAmount} sats (minimum 1 sat required)`,
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
            console.log(`🥜 [LN Address] Sending tip to npub.cash: ${recipient.username}`)

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
              console.log(
                `💰 [LN Address] Tip successfully sent to ${recipient.username}`,
              )
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
              console.log(
                `💰 [LN Address] Tip successfully sent to ${recipient.username}@blink.sv`,
              )
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
          const recipientDisplay =
            recipientType === "npub_cash"
              ? recipient.username
              : `${recipient.username}@blink.sv`
          tipResults.push({
            success: false,
            recipient: recipientDisplay,
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
      message: "Payment forwarded to Lightning Address wallet",
      baseAmount,
      tipAmount,
      tipResult,
      recipientUsername,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Forward to LN Address error:", error)

    // Release claim if we claimed but failed to complete
    if (claimSucceeded && hybridStore && paymentHash) {
      try {
        await hybridStore.releaseFailedClaim(paymentHash, message)
        console.log(
          `🔓 [LN Address] Released claim for ${paymentHash?.substring(0, 16)}...`,
        )
      } catch (releaseError: unknown) {
        console.error("❌ [LN Address] Failed to release claim:", releaseError)
      }
    }

    res.status(500).json({
      error: "Failed to forward payment",
      details: message,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE)
