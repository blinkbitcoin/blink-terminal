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

interface NwcTipDataInput {
  tipAmount: number
  tipRecipients: ApiTipRecipient[]
  displayCurrency?: string
  tipAmountDisplay?: number
  environment?: string
}

/**
 * API endpoint for sending NWC tips AFTER base amount has been forwarded
 *
 * This is called AFTER the base amount has been forwarded to NWC wallet,
 * ensuring correct chronology: base amount first, tips second.
 *
 * POST /api/blink/send-nwc-tips
 * Body: { paymentHash: string, tipData: object }
 *
 * Returns: { success: true, tipResult: object }
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  let hybridStore: HybridStore | null = null

  try {
    const {
      paymentHash,
      tipData,
      environment: reqEnvironment,
    } = req.body as {
      paymentHash: string
      tipData: NwcTipDataInput
      environment?: EnvironmentName
    }

    console.log("💡 SEND NWC TIPS REQUEST (after base amount forwarded):", {
      paymentHash: paymentHash?.substring(0, 16) + "...",
      tipAmount: tipData?.tipAmount,
      recipientCount: tipData?.tipRecipients?.length,
      environment: reqEnvironment || tipData?.environment,
      timestamp: new Date().toISOString(),
    })

    // Validate required fields
    if (!paymentHash || !tipData) {
      return res.status(400).json({
        error: "Missing required fields: paymentHash, tipData",
      })
    }

    // Environment can come from request body or from tipData (tipData takes precedence for backwards compatibility)
    const {
      tipAmount,
      tipRecipients,
      displayCurrency = "BTC",
      tipAmountDisplay,
      environment: tipEnv = "production",
    } = tipData
    const environment = tipEnv || reqEnvironment || "production"

    if (!tipAmount || tipAmount <= 0 || !tipRecipients || tipRecipients.length === 0) {
      return res.status(400).json({
        error: "Invalid tip data: no tip amount or recipients",
      })
    }

    // BlinkPOS credentials are set per-deployment; the `environment` value
    // only selects which Blink GraphQL URL we talk to.
    const blinkposApiKey = process.env.BLINKPOS_API_KEY
    const blinkposBtcWalletId = process.env.BLINKPOS_BTC_WALLET_ID
    const apiUrl = getApiUrlForEnvironment(environment as EnvironmentName)

    if (!blinkposApiKey || !blinkposBtcWalletId) {
      console.error("Missing BlinkPOS environment variables")
      return res.status(500).json({ error: "BlinkPOS configuration missing" })
    }

    hybridStore = await getHybridStore()
    if (!hybridStore) {
      return res.status(500).json({ error: "Storage unavailable" })
    }
    const store = hybridStore
    const blinkposAPI = new BlinkAPI(blinkposApiKey, apiUrl)

    // Calculate weighted tip amounts based on share percentages
    const totalTipSats = Math.round(tipAmount)
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

    const tipAmountInDisplayCurrency = Number(tipAmountDisplay) || totalTipSats

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
          `⏭️ [NWC Tips] Skipping tip to ${recipient.username}: amount is ${recipientTipAmount} sats (minimum 1 sat required)`,
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

      // Generate tip memo (matching Blink format)
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

          await store.logEvent(paymentHash, "nwc_tip_sent", "success", {
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
          recipientTipError instanceof Error ? recipientTipError.message : "Unknown error"
        console.error(`❌ Tip payment to ${recipient.username} error:`, recipientTipError)
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
    const tipResult = {
      success: successCount === tipRecipients.length,
      partialSuccess: successCount > 0 && successCount < tipRecipients.length,
      totalAmount: tipAmount,
      recipients: tipResults,
      successCount,
      totalCount: tipRecipients.length,
    }

    console.log("💡 NWC tip distribution complete:", {
      successCount,
      totalCount: tipRecipients.length,
    })

    // Log the NWC forwarding completion and clean up
    await store.logEvent(paymentHash, "nwc_tips_completed", "success", {
      tipAmount,
      tipRecipients: tipRecipients.map((r: ApiTipRecipient) => r.username),
      tipResult,
    })

    // Remove tip data now that everything is done
    await store.removeTipData(paymentHash)

    console.log(`✅ COMPLETED NWC tips for payment ${paymentHash?.substring(0, 16)}...`)

    res.status(200).json({
      success: true,
      tipResult,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Send NWC tips error:", error)
    res.status(500).json({
      error: "Failed to send NWC tips",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE)
