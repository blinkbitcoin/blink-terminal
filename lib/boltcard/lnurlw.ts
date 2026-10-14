/**
 * Boltcard LNURL-withdraw - Handle card tap payments
 *
 * Implements LNURL-withdraw (LUD-03) for Boltcard spending:
 * - Card tap generates LNURL-withdraw URL with encrypted PICCData + SunMAC
 * - Server verifies card authentication
 * - Server checks balance and spending limits
 * - Server pays the invoice from the card's wallet
 *
 * Flow:
 * 1. Card tap -> NFC reader gets LNURL from card
 * 2. Wallet scans -> GET request to our /api/boltcard/lnurlw/{cardId}?p=...&c=...
 * 3. We verify and return LNURL-withdraw response
 * 4. Wallet sends invoice -> POST to callback URL
 * 5. We pay invoice from card's Blink wallet
 *
 * References:
 * - LUD-03: https://github.com/lnurl/luds/blob/luds/03.md
 * - BTCPay Boltcards Plugin
 */

import { bech32 } from "bech32"

import BlinkAPI from "../blink-api"
import type { EnvironmentName } from "../config/api"
import { decodeInvoice } from "../invoice-decoder"

import * as boltcardCrypto from "./crypto"
import boltcardStore, { CardStatus, TxType } from "./store"

// ============================================================================
// Types
// ============================================================================

/** Represents a Boltcard as returned by the store */
interface BoltcardCard {
  id: string
  cardUid: string
  cardIdHash: string
  name: string | null
  ownerPubkey: string
  walletId: string
  walletCurrency: string
  version: number
  lastCounter: number
  balance: number
  maxTxAmount: number | null
  dailyLimit: number | null
  dailySpent: number
  dailyResetAt: number | null
  status: string
  createdAt: number
  activatedAt: number | null
  lastUsedAt: number | null
  disabledAt: number | null
  environment: string
  // Keys (only present when includeKeys=true)
  apiKey?: string
  k0?: string
  k1?: string
  k2?: string
  k3?: string
  k4?: string
}

interface ExchangeRate {
  satPriceInCurrency: number
  currency?: string
}

interface VerifyResult {
  valid: boolean
  error?: string
  counter?: number
  cardUid?: string
}

interface DeductResult {
  success: boolean
  balance?: number
  error?: string
}

interface PayInvoiceResult {
  success: boolean
  paymentHash?: string
  error?: string
  /** For failures: true if the payment definitely was not sent. */
  definite?: boolean
}

type PayInvoiceFn = (
  amount: number,
  invoice: string,
  apiKey: string,
  environment: EnvironmentName,
  walletCurrency: string,
) => Promise<PayInvoiceResult>

interface LnurlWithdrawResponse {
  tag?: string
  callback?: string
  k1?: string
  defaultDescription?: string
  minWithdrawable?: number
  maxWithdrawable?: number
  balanceCheck?: string
  payLink?: string
  status?: string
  reason?: string
}

interface WithdrawCallbackResult {
  status: string
  reason?: string
  paymentHash?: string
}

interface InvoiceAmount {
  msats: number
  sats: number
}

interface BalanceInfo {
  balance?: number
  unit?: string
  currency?: string
  dailyLimit?: number | null
  dailySpent?: number
  dailyRemaining?: number | null
  maxTxAmount?: number | null
  error?: string
}

// ============================================================================
// Exchange Rate Helpers
// ============================================================================

/**
 * Convert sats to cents using real-time exchange rate
 * Following Blink Mobile's approach: satPriceInCurrency is cents per sat
 * Uses Math.round() as per Blink Mobile standard
 *
 * @param sats - Amount in satoshis
 * @returns Amount in cents (Math.round)
 */
async function convertSatsToCents(sats: number): Promise<number> {
  try {
    const rate: ExchangeRate = await BlinkAPI.getExchangeRatePublic("USD")
    // rate.satPriceInCurrency = cents per sat (e.g., 0.0686)
    const cents = Math.round(sats * rate.satPriceInCurrency)
    return Math.max(1, cents) // Minimum 1 cent
  } catch (err: unknown) {
    console.error(
      "[LNURLW] Failed to fetch exchange rate for sats->cents:",
      (err as Error).message,
    )
    throw new Error("Exchange rate unavailable")
  }
}

/**
 * Convert cents to sats using real-time exchange rate
 * Uses Math.round() as per Blink Mobile standard
 *
 * @param cents - Amount in cents
 * @returns Amount in sats (Math.round)
 */
async function convertCentsToSats(cents: number): Promise<number> {
  try {
    const rate: ExchangeRate = await BlinkAPI.getExchangeRatePublic("USD")
    // rate.satPriceInCurrency = cents per sat (e.g., 0.0686)
    const sats = Math.round(cents / rate.satPriceInCurrency)
    return Math.max(1, sats) // Minimum 1 sat
  } catch (err: unknown) {
    console.error(
      "[LNURLW] Failed to fetch exchange rate for cents->sats:",
      (err as Error).message,
    )
    throw new Error("Exchange rate unavailable")
  }
}

// ============================================================================
// LNURL Encoding
// ============================================================================

/**
 * Generate LNURL-bech32 encoding for a URL
 * @param url - URL to encode
 * @returns LNURL-bech32 encoded string
 */
function encodeLnurl(url: string): string {
  const words = bech32.toWords(Buffer.from(url, "utf8"))
  return bech32.encode("lnurl", words, 2000)
}

/**
 * Decode LNURL-bech32 to URL
 * @param lnurl - LNURL-bech32 encoded string
 * @returns Decoded URL
 */
function decodeLnurl(lnurl: string): string {
  const { words } = bech32.decode(lnurl, 2000)
  return Buffer.from(bech32.fromWords(words)).toString("utf8")
}

// ============================================================================
// URL Generation
// ============================================================================

/**
 * Generate the base LNURL-withdraw URL for a card
 * This URL is programmed into the card's NDEF record
 *
 * @param serverUrl - BlinkPOS server URL (e.g., https://pos.example.com)
 * @param cardId - Card ID from database
 * @returns Base URL (without p/c params, those are added by the card)
 */
function generateCardUrl(serverUrl: string, cardId: string): string {
  // Remove trailing slash
  const baseUrl = serverUrl.replace(/\/$/, "")

  // The card will append ?p=...&c=... when tapped
  // The URL stored in the card's NDEF record
  return `${baseUrl}/api/boltcard/lnurlw/${cardId}`
}

/**
 * Generate LNURL for card programming
 * @param serverUrl - BlinkPOS server URL
 * @param cardId - Card ID
 * @returns LNURL-bech32 encoded URL
 */
function generateCardLnurl(serverUrl: string, cardId: string): string {
  const url = generateCardUrl(serverUrl, cardId)
  return encodeLnurl(url)
}

// ============================================================================
// LNURL-withdraw Request
// ============================================================================

/**
 * Process LNURL-withdraw GET request (card tap)
 * Returns the LNURL-withdraw response or error
 *
 * @param cardId - Card ID from URL path
 * @param piccDataHex - 'p' query parameter (encrypted PICCData)
 * @param sunMacHex - 'c' query parameter (SunMAC)
 * @param callbackUrl - Callback URL for invoice submission
 * @returns LNURL-withdraw response or error
 */
async function handleWithdrawRequest(
  cardId: string,
  piccDataHex: string,
  sunMacHex: string,
  callbackUrl: string,
): Promise<LnurlWithdrawResponse> {
  // Get card with keys
  const card = (await boltcardStore.getCard(cardId, true)) as BoltcardCard | null

  if (!card) {
    return {
      status: "ERROR",
      reason: "Card not found",
    }
  }

  if (card.status !== CardStatus.ACTIVE) {
    return {
      status: "ERROR",
      reason: `Card is ${card.status.toLowerCase()}`,
    }
  }

  // Verify card tap (SunMAC + PICCData decryption + counter)
  const verifyResult: VerifyResult = boltcardCrypto.verifyCardTap(
    piccDataHex,
    sunMacHex,
    card.k1 as string,
    card.k2 as string,
    card.cardUid,
    card.lastCounter,
  )

  if (!verifyResult.valid) {
    console.log(`[LNURLW] Card verification failed for ${cardId}: ${verifyResult.error}`)
    return {
      status: "ERROR",
      reason: verifyResult.error,
    }
  }

  // Check balance
  if (card.balance <= 0) {
    return {
      status: "ERROR",
      reason: "Card has no balance",
    }
  }

  // Calculate available amount (considering limits)
  let maxWithdrawable = card.balance

  // Apply per-transaction limit
  if (card.maxTxAmount && card.maxTxAmount < maxWithdrawable) {
    maxWithdrawable = card.maxTxAmount
  }

  // Apply daily limit
  if (card.dailyLimit) {
    const remainingDaily = card.dailyLimit - card.dailySpent
    if (remainingDaily < maxWithdrawable) {
      maxWithdrawable = remainingDaily
    }
  }

  if (maxWithdrawable <= 0) {
    return {
      status: "ERROR",
      reason: "Daily spending limit reached",
    }
  }

  // Convert to millisats for LNURL response
  // For USD cards: maxWithdrawable is in cents, need to convert to sats
  // For BTC cards: maxWithdrawable is already in sats
  const unit = card.walletCurrency === "USD" ? "cents" : "sats"
  let maxWithdrawableSats: number

  if (card.walletCurrency === "USD") {
    try {
      maxWithdrawableSats = await convertCentsToSats(maxWithdrawable)
      console.log(
        `[LNURLW] USD card: converted ${maxWithdrawable} cents to ${maxWithdrawableSats} sats for LNURL`,
      )
    } catch (_error: unknown) {
      return {
        status: "ERROR",
        reason: "Failed to get exchange rate",
      }
    }
  } else {
    maxWithdrawableSats = maxWithdrawable
  }

  const maxWithdrawableMsats = maxWithdrawableSats * 1000
  const minWithdrawableMsats = 1000 // Minimum 1 sat

  if (maxWithdrawableMsats < minWithdrawableMsats) {
    return { status: "ERROR", reason: "Card has no balance" }
  }

  // Advance the replay counter AND create a single-use, tap-bound session in
  // one atomic write. A replayed / concurrent tap gets no session (no k1).
  const k1 = await boltcardStore.startWithdrawSession(
    cardId,
    verifyResult.counter as number,
    maxWithdrawableMsats,
  )
  if (!k1) {
    return { status: "ERROR", reason: "Card tap already used - tap again" }
  }

  console.log(
    `[LNURLW] Card ${cardId} tap verified. Max withdrawable: ${maxWithdrawable} ${unit} (${maxWithdrawableSats} sats)`,
  )

  // Return LNURL-withdraw response
  return {
    tag: "withdrawRequest",
    callback: callbackUrl,
    k1, // Random, single-use, bound to this tap (never the cardId)
    defaultDescription: `Boltcard payment (${card.name || "Card"})`,
    minWithdrawable: minWithdrawableMsats,
    maxWithdrawable: maxWithdrawableMsats,
    // Extension fields
    balanceCheck: `${callbackUrl.replace("/callback", "/balance")}`,
    payLink: `${callbackUrl.replace("/lnurlw/", "/lnurlp/")}`, // For top-up
  }
}

// ============================================================================
// LNURL-withdraw Callback
// ============================================================================

/**
 * Process LNURL-withdraw callback (invoice submission)
 * Pays the invoice from the card's Blink wallet
 *
 * @param cardId - Card ID (from the URL path)
 * @param k1 - Single-use session from the verified tap (required)
 * @param invoice - BOLT11 invoice to pay
 * @param payInvoice - Function to pay invoice (amount, invoice, apiKey, environment, walletCurrency) -> { success, paymentHash, error }
 * @returns Result { status, paymentHash? }
 */
async function handleWithdrawCallback(
  cardId: string,
  k1: string | undefined,
  invoice: string,
  payInvoice: PayInvoiceFn = payCardInvoice,
): Promise<WithdrawCallbackResult> {
  // The tap-bound session is the only authorizer. Required, single-use.
  if (!k1) {
    return { status: "ERROR", reason: "Missing k1 - tap the card again" }
  }

  // Decode invoice to get amount (no side effects yet)
  const invoiceAmount = parseInvoiceAmount(invoice)
  if (!invoiceAmount || invoiceAmount.sats <= 0) {
    return {
      status: "ERROR",
      reason: "Invalid invoice amount",
    }
  }

  const maxMsats = await boltcardStore.consumeWithdrawSession(k1, cardId)
  if (maxMsats === null) {
    return { status: "ERROR", reason: "Invalid or expired k1 - tap the card again" }
  }
  if (invoiceAmount.msats > maxMsats) {
    return {
      status: "ERROR",
      reason: "Invoice amount exceeds the amount allowed for this tap",
    }
  }

  // Get card with keys
  const card = (await boltcardStore.getCard(cardId, true)) as BoltcardCard | null

  if (!card) {
    return {
      status: "ERROR",
      reason: "Card not found",
    }
  }

  if (card.status !== CardStatus.ACTIVE) {
    return {
      status: "ERROR",
      reason: `Card is ${card.status.toLowerCase()}`,
    }
  }

  // Calculate amount to deduct from card balance
  let amount: number
  if (card.walletCurrency === "USD") {
    // For USD cards: convert invoice sats to cents using real-time exchange rate
    try {
      amount = await convertSatsToCents(invoiceAmount.sats)
      console.log(
        `[LNURLW] USD card: converted ${invoiceAmount.sats} sats to ${amount} cents`,
      )
    } catch (_error: unknown) {
      return {
        status: "ERROR",
        reason: "Failed to get exchange rate",
      }
    }
  } else {
    // For BTC cards: use sats directly
    amount = invoiceAmount.sats
  }

  // Try to deduct from card balance (atomic operation with limit checks)
  const deductResult = (await boltcardStore.incrementDailySpent(
    cardId,
    amount,
  )) as DeductResult

  if (!deductResult.success) {
    return {
      status: "ERROR",
      reason: deductResult.error || "Failed to process payment",
    }
  }

  // Pay the invoice from the card's wallet (BTC or USD)
  const payResult: PayInvoiceResult = await payInvoice(
    invoiceAmount.sats,
    invoice,
    card.apiKey as string,
    card.environment as EnvironmentName,
    card.walletCurrency,
  )

  if (!payResult.success) {
    if (payResult.definite) {
      // Nothing was sent: restore the card balance
      await boltcardStore.rollbackSpend(cardId, amount)
      console.log(`[LNURLW] Payment failed for card ${cardId}, rolled back ${amount}`)
    } else {
      // Outcome unknown (transport error): the payment may have gone out.
      // Keep the deduction so the card can't overspend; flag for review.
      await boltcardStore.recordTransaction(cardId, {
        type: TxType.WITHDRAW,
        amount: amount,
        balanceAfter: deductResult.balance as number,
        description: "Card payment - outcome unknown, pending review",
      })
      console.error(
        `[LNURLW] Payment outcome unknown for card ${cardId}; deduction of ${amount} kept for review`,
      )
    }

    return {
      status: "ERROR",
      reason: payResult.error || "Payment failed",
    }
  }

  // Record the transaction
  await boltcardStore.recordTransaction(cardId, {
    type: TxType.WITHDRAW,
    amount: amount,
    balanceAfter: deductResult.balance as number,
    paymentHash: payResult.paymentHash,
    description: "Card payment",
  })

  console.log(
    `[LNURLW] Card ${cardId} payment successful: ${amount} ${card.walletCurrency === "USD" ? "cents" : "sats"}`,
  )

  return {
    status: "OK",
    paymentHash: payResult.paymentHash,
  }
}

// ============================================================================
// Paying the invoice from the card's wallet
// ============================================================================

/**
 * Pay `invoice` from the card owner's wallet of the card's currency.
 * SUCCESS and PENDING count as paid (the payment is executed / in flight).
 * A rejected payment (mutation errors, FAILURE status, key refused, no such
 * wallet) is a definite failure; a transport error is an unknown outcome.
 */
async function payCardInvoice(
  _amountSats: number,
  invoice: string,
  apiKey: string,
  environment: EnvironmentName,
  walletCurrency: string = "BTC",
): Promise<PayInvoiceResult> {
  const { getApiUrlForEnvironment } = await import("../config/api")
  const { PaymentRejectedError, BlinkAuthError } = await import("../blink-api")
  const blinkAPI = new BlinkAPI(apiKey, getApiUrlForEnvironment(environment))

  let walletId: string | undefined
  try {
    const wallets = await blinkAPI.getWalletInfo()
    walletId = wallets.find(
      (w: { walletCurrency: string; id: string }) => w.walletCurrency === walletCurrency,
    )?.id
  } catch (error: unknown) {
    // Nothing has been sent yet
    return { success: false, definite: true, error: (error as Error).message }
  }
  if (!walletId) {
    return { success: false, definite: true, error: `No ${walletCurrency} wallet found` }
  }

  try {
    const result = await blinkAPI.payLnInvoice(walletId, invoice, "Boltcard payment")
    if (result.status === "SUCCESS" || result.status === "PENDING") {
      return { success: true, paymentHash: extractPaymentHash(invoice) ?? undefined }
    }
    if (result.status === "FAILURE") {
      return { success: false, definite: true, error: "Payment failed" }
    }
    return {
      success: false,
      definite: false,
      error: `Payment status: ${String(result.status)}`,
    }
  } catch (error: unknown) {
    const definite =
      error instanceof PaymentRejectedError || error instanceof BlinkAuthError
    return { success: false, definite, error: (error as Error).message }
  }
}

function extractPaymentHash(invoice: string): string | null {
  const decoded = decodeInvoice(invoice)
  return decoded.success && decoded.data.paymentHash
    ? String(decoded.data.paymentHash)
    : null
}

// ============================================================================
// Invoice Parsing
// ============================================================================

/**
 * Parse invoice amount from BOLT11 invoice
 * @param invoice - BOLT11 invoice string
 * @returns { sats, msats } or null
 */
function parseInvoiceAmount(invoice: string): InvoiceAmount | null {
  try {
    // BOLT11 invoice amount is encoded in the human-readable part
    // Format: ln{network}{amount}{multiplier}...
    const lower = invoice.toLowerCase()

    // Find the amount part after 'ln' prefix
    // Extract network and amount
    const match = lower.match(/^ln(bc|tb|tbs)(\d+)([munp])?/)
    if (!match) {
      // No amount in invoice (amountless invoice)
      return null
    }

    const amountStr = match[2]
    const mult = match[3]

    let msats = BigInt(amountStr)

    // Apply multiplier
    // BOLT11 amount encoding: amount is in the unit specified by multiplier
    // 1 BTC = 100,000,000 sats = 100,000,000,000 msats
    // m = milli (10^-3): 1 mBTC = 0.001 BTC = 100,000 sats = 100,000,000 msats
    // u = micro (10^-6): 1 uBTC = 0.000001 BTC = 100 sats = 100,000 msats
    // n = nano (10^-9): 1 nBTC = 0.000000001 BTC = 0.1 sats = 100 msats
    // p = pico (10^-12): 1 pBTC = 0.000000000001 BTC = 0.0001 sats = 0.1 msats
    switch (mult) {
      case "m": // milli-bitcoin (0.001 BTC = 100,000 sats)
        msats = msats * BigInt(100000000) // 1 mBTC = 100,000,000 msats
        break
      case "u": // micro-bitcoin (0.000001 BTC = 100 sats)
        msats = msats * BigInt(100000) // 1 uBTC = 100,000 msats
        break
      case "n": // nano-bitcoin (0.000000001 BTC = 0.1 sats)
        msats = msats * BigInt(100) // 1 nBTC = 100 msats
        break
      case "p": // pico-bitcoin (0.000000000001 BTC = 0.0001 sats)
        // 1 pBTC = 0.1 msats, but we can't represent fractional msats
        // So we divide by 10 after multiplying
        msats = msats / BigInt(10) // 1 pBTC = 0.1 msats
        break
      default:
        // No multiplier means BTC
        msats = msats * BigInt(100000000000) // 1 BTC = 100,000,000,000 msats
    }

    const sats = Number(msats / BigInt(1000))

    return {
      msats: Number(msats),
      sats,
    }
  } catch (err: unknown) {
    console.error("[LNURLW] parseInvoiceAmount error:", (err as Error).message)
    return null
  }
}

// ============================================================================
// Balance Check
// ============================================================================

/**
 * Get card balance for LNURL balance check
 * @param cardId - Card ID
 * @returns Balance info
 */
async function getCardBalance(cardId: string): Promise<BalanceInfo> {
  const card = (await boltcardStore.getCard(cardId)) as BoltcardCard | null

  if (!card) {
    return { error: "Card not found" }
  }

  const unit = card.walletCurrency === "USD" ? "cents" : "sats"

  return {
    balance: card.balance,
    unit,
    currency: card.walletCurrency,
    dailyLimit: card.dailyLimit,
    dailySpent: card.dailySpent,
    dailyRemaining: card.dailyLimit ? card.dailyLimit - card.dailySpent : null,
    maxTxAmount: card.maxTxAmount,
  }
}

// ============================================================================
// Exports
// ============================================================================

export {
  encodeLnurl,
  decodeLnurl,
  generateCardUrl,
  generateCardLnurl,
  handleWithdrawRequest,
  handleWithdrawCallback,
  payCardInvoice,
  parseInvoiceAmount,
  getCardBalance,
}

export type {
  BoltcardCard,
  ExchangeRate,
  VerifyResult,
  DeductResult,
  PayInvoiceResult,
  PayInvoiceFn,
  LnurlWithdrawResponse,
  WithdrawCallbackResult,
  InvoiceAmount,
  BalanceInfo,
}
