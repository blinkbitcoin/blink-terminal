/**
 * Boltcard LNURL-pay - Handle card top-up via Lightning
 *
 * Implements LNURL-pay (LUD-06) for Boltcard top-up:
 * - Users can top up their card by paying an LNURL-pay
 * - Similar to BTCPay Boltcards plugin top-up flow
 * - Supports both BTC and USD (Stablesats) cards
 *
 * Flow:
 * 1. User scans card's top-up QR code (LNURL-pay)
 * 2. GET request to /api/boltcard/lnurlp/{cardId}
 * 3. We return LNURL-pay metadata (min/max amounts)
 * 4. User enters amount, wallet sends amount to callback
 * 5. We generate Blink invoice and return it
 * 6. User pays invoice
 * 7. Webhook or polling detects payment, credits card balance
 *
 * References:
 * - LUD-06: https://github.com/lnurl/luds/blob/luds/06.md
 * - LUD-09: https://github.com/lnurl/luds/blob/luds/09.md (successAction)
 * - BTCPay Boltcards Plugin top-up
 */

import { bech32 } from "bech32"

import type { EnvironmentName } from "../config/api"

import boltcardStore, { CardStatus } from "./store"

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

interface CurrencyLimits {
  min: number
  max: number
}

interface TopUpLimitsType {
  BTC: CurrencyLimits
  USD: CurrencyLimits
  [key: string]: CurrencyLimits
}

interface PendingTopUpCache {
  cardId: string
  amount: number
  currency: string
  createdAt: number
}

interface PendingTopUpData {
  cardId: string
  amount: number
  currency: string
  paymentHash?: string
  createdAt?: number
  expiresAt?: number
}

interface LnurlPayResponse {
  tag?: string
  callback?: string
  minSendable?: number
  maxSendable?: number
  metadata?: string
  commentAllowed?: number
  status?: string
  reason?: string
}

interface LnurlPayCallbackResponse {
  pr?: string
  successAction?: {
    tag: string
    message: string
  }
  routes?: Array<unknown>
  status?: string
  reason?: string
}

interface InvoiceResult {
  invoice?: string
  paymentHash?: string
  error?: string
}

type CreateInvoiceFn = (
  amount: number,
  memo: string,
  walletId: string,
  apiKey: string,
  environment: EnvironmentName,
  walletCurrency: string,
) => Promise<InvoiceResult>

interface ProcessTopUpResult {
  success: boolean
  cardId?: string
  amount?: number
  amountSats?: number
  balance?: number
  error?: string
}

interface TopUpQR {
  url: string
  lnurl: string
  qrData: string
}

interface CheckAndProcessResult {
  processed: number
  total: number
  errors: number
}

type InvoiceStatus = "PAID" | "PENDING" | "UNSEEN" | "EXPIRED" | "ERROR"

interface WalletInfo {
  id: string
  walletCurrency: string
  balance: number
}

interface ExchangeRate {
  satPriceInCurrency: number
  currency?: string
}

interface TransferResult {
  status: string
}

interface TopUpResult {
  success: boolean
  balance?: number
  error?: string
  transaction?: unknown
  /** Definite: this payment already credited a card (store.topUpCard). */
  alreadyCredited?: boolean
}

interface BlinkTransaction {
  direction: string
  status: string
  settlementAmount: number
}

// ============================================================================
// Bech32 Encoding
// ============================================================================

/**
 * Encode URL to LNURL-bech32
 * @param url - URL to encode
 * @returns LNURL-bech32 string
 */
function encodeLnurl(url: string): string {
  const words = bech32.toWords(Buffer.from(url, "utf8"))
  return bech32.encode("lnurl", words, 2000)
}

/**
 * Generate the LNURL-pay URL for card top-up
 * @param serverUrl - BlinkPOS server URL
 * @param cardId - Card ID from database
 * @returns Top-up URL
 */
function generateTopUpUrl(serverUrl: string, cardId: string): string {
  const baseUrl = serverUrl.replace(/\/$/, "")
  return `${baseUrl}/api/boltcard/lnurlp/${cardId}`
}

/**
 * Generate LNURL for card top-up
 * @param serverUrl - BlinkPOS server URL
 * @param cardId - Card ID
 * @returns LNURL-bech32 encoded URL
 */
function generateTopUpLnurl(serverUrl: string, cardId: string): string {
  const url = generateTopUpUrl(serverUrl, cardId)
  return encodeLnurl(url)
}

/**
 * Default limits for top-up (in sats/cents)
 */
const TopUpLimits: TopUpLimitsType = {
  BTC: {
    min: 100, // 100 sats minimum
    max: 10000000, // 10M sats (~$4000 at $40k/BTC)
  },
  USD: {
    min: 10, // 10 cents minimum
    max: 100000, // $1000 maximum
  },
}

/**
 * Process LNURL-pay GET request (top-up metadata)
 * Returns the LNURL-pay response
 *
 * @param cardId - Card ID from URL path
 * @param serverUrl - Server URL for callback
 * @returns LNURL-pay response or error
 */
async function handleTopUpRequest(
  cardId: string,
  serverUrl: string,
): Promise<LnurlPayResponse> {
  // Get card (no keys needed for top-up)
  const card = (await boltcardStore.getCard(cardId)) as BoltcardCard | null

  if (!card) {
    return {
      status: "ERROR",
      reason: "Card not found",
    }
  }

  // Allow top-up for PENDING and ACTIVE cards
  if (card.status !== CardStatus.ACTIVE && card.status !== CardStatus.PENDING) {
    return {
      status: "ERROR",
      reason: `Card is ${card.status.toLowerCase()}`,
    }
  }

  const limits = TopUpLimits[card.walletCurrency]
  const unit = card.walletCurrency === "USD" ? "cents" : "sats"

  // Convert to millisats for LNURL
  const minSendable = limits.min * 1000
  const maxSendable = limits.max * 1000

  const callbackUrl = `${serverUrl.replace(/\/$/, "")}/api/boltcard/lnurlp/${cardId}/callback`

  console.log(
    `[LNURLP] Top-up request for card ${cardId}. Balance: ${card.balance} ${unit}`,
  )

  // Build metadata (required by LUD-06)
  // Note: Include warning about self-payment since Blink blocks paying your own invoices
  const metadata = JSON.stringify([
    [
      "text/plain",
      `Top up ${card.name || "Boltcard"} (Note: Cannot pay from card owner's account)`,
    ],
    ["text/identifier", `card:${cardId.substring(0, 8)}`],
  ])

  return {
    tag: "payRequest",
    callback: callbackUrl,
    minSendable,
    maxSendable,
    metadata,
    // Optional: allow payer to specify comment
    commentAllowed: 100,
  }
}

/**
 * Process LNURL-pay callback (invoice request)
 * Generates a Blink invoice for the top-up amount
 *
 * @param cardId - Card ID from URL path
 * @param amountMsats - Amount in millisats from query
 * @param comment - Optional comment from payer
 * @param createInvoice - Function to create invoice
 * @returns LNURL-pay callback response
 */
async function handleTopUpCallback(
  cardId: string,
  amountMsats: number,
  comment: string,
  createInvoice: CreateInvoiceFn,
): Promise<LnurlPayCallbackResponse> {
  // Get card with keys (need apiKey for invoice creation)
  const card = (await boltcardStore.getCard(cardId, true)) as BoltcardCard | null

  if (!card) {
    return {
      status: "ERROR",
      reason: "Card not found",
    }
  }

  if (card.status !== CardStatus.ACTIVE && card.status !== CardStatus.PENDING) {
    return {
      status: "ERROR",
      reason: `Card is ${card.status.toLowerCase()}`,
    }
  }

  const limits = TopUpLimits[card.walletCurrency]
  const amountSats = Math.floor(amountMsats / 1000)

  // Validate amount
  if (amountSats < limits.min) {
    return {
      status: "ERROR",
      reason: `Minimum top-up is ${limits.min} ${card.walletCurrency === "USD" ? "cents" : "sats"}`,
    }
  }

  if (amountSats > limits.max) {
    return {
      status: "ERROR",
      reason: `Maximum top-up is ${limits.max} ${card.walletCurrency === "USD" ? "cents" : "sats"}`,
    }
  }

  // Create memo for invoice
  const memo = comment
    ? `Boltcard top-up: ${comment}`
    : `Top up ${card.name || "Boltcard"}`

  // Create invoice via Blink
  // For USD cards, use lnUsdInvoiceCreate mutation
  // For BTC cards, use lnInvoiceCreate mutation
  const invoiceResult: InvoiceResult = await createInvoice(
    amountSats,
    memo,
    card.walletId,
    card.apiKey as string,
    card.environment as EnvironmentName,
    card.walletCurrency,
  )

  if (invoiceResult.error) {
    return {
      status: "ERROR",
      reason: invoiceResult.error,
    }
  }

  // Store pending top-up for webhook processing
  // We'll credit the card when the invoice is paid
  // IMPORTANT: For both BTC and USD cards, we now create BTC invoices (exact sat amount)
  // So we always store amount in SATS here. For USD cards, we convert sats→cents at processing time.
  const stored = await storePendingTopUp(
    cardId,
    invoiceResult.paymentHash as string,
    amountSats,
    card.walletCurrency,
  )

  // Never hand out an invoice we cannot credit: without the pending record,
  // neither the webhook nor polling has the card/amount mapping.
  if (!stored) {
    console.error(
      `[LNURLP] Pending top-up record failed to persist for card ${cardId}; invoice withheld`,
    )
    return {
      status: "ERROR",
      reason: "Could not register the top-up - please try again",
    }
  }

  console.log(
    `[LNURLP] Generated invoice for card ${cardId} (${card.walletCurrency}) top-up: ${amountSats} sats`,
  )

  return {
    pr: invoiceResult.invoice,
    // Success action - show message when paid
    successAction: {
      tag: "message",
      message: `Card topped up with ${amountSats} sats!`,
    },
    // Routes for MPP (optional)
    routes: [],
  }
}

/**
 * Store a pending top-up for webhook processing
 * Uses database storage for persistence across server restarts
 * Also maintains in-memory cache for fast lookups
 *
 * @param cardId - Card ID
 * @param paymentHash - Payment hash from invoice
 * @param amount - Amount in sats/cents
 * @param currency - 'BTC' or 'USD'
 */
// In-memory cache for fast lookups (populated from DB on miss)
const pendingTopUpsCache = new Map<string, PendingTopUpCache>()

async function storePendingTopUp(
  cardId: string,
  paymentHash: string,
  amount: number,
  currency: string,
): Promise<boolean> {
  // Store in database for persistence
  const stored: boolean = await boltcardStore.storePendingTopUp(
    cardId,
    paymentHash,
    amount,
    currency,
  )

  if (stored) {
    // Also cache in memory for fast lookups
    pendingTopUpsCache.set(paymentHash, {
      cardId,
      amount,
      currency,
      createdAt: Date.now(),
    })

    // Clean up old cache entries (older than 1 hour)
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    for (const [hash, data] of pendingTopUpsCache.entries()) {
      if (data.createdAt < oneHourAgo) {
        pendingTopUpsCache.delete(hash)
      }
    }
  }

  return stored
}

/**
 * Process a paid top-up (called from webhook or polling)
 * Credits the card balance
 *
 * For BTC cards: Credits balance in sats
 * For USD cards:
 *   1. Transfers sats from BTC wallet to USD wallet (Blink converts automatically)
 *   2. Converts sats to cents using current exchange rate for local balance tracking
 *
 * @param paymentHash - Payment hash that was paid
 * @returns Result { success, cardId, amount, error }
 */
async function processTopUpPayment(paymentHash: string): Promise<ProcessTopUpResult> {
  // The database is authoritative (the in-memory cache may be stale/processed)
  const pending = (await boltcardStore.getPendingTopUp(
    paymentHash,
  )) as PendingTopUpData | null
  if (!pending) {
    console.log(`[LNURLP] No pending top-up found for payment hash: ${paymentHash}`)
    return { success: false, error: "No pending top-up found" }
  }

  const { cardId, amount: amountSats, currency } = pending

  // Get card with API key for making authenticated API calls
  const card = (await boltcardStore.getCard(cardId, true)) as BoltcardCard | null
  if (!card) {
    console.error(`[LNURLP] Card not found: ${cardId}`)
    return { success: false, error: "Card not found" }
  }

  const BlinkAPI = (await import("../blink-api")).default
  const { PaymentRejectedError } = await import("../blink-api")
  const { getApiUrlForEnvironment } = await import("../config/api")
  const apiUrl = getApiUrlForEnvironment(card.environment as "production" | "staging")
  const blinkAPI = new BlinkAPI(card.apiKey as string, apiUrl)

  // The top-up invoice was created on the owner's BTC wallet (the card's
  // wallet for BTC cards); USD cards also need the USD wallet for the transfer.
  let btcWalletId: string = card.walletId
  let usdWalletId: string | undefined
  if (currency === "USD") {
    try {
      const wallets: WalletInfo[] = await blinkAPI.getWalletInfo()
      const btcWallet = wallets.find((w: WalletInfo) => w.walletCurrency === "BTC")
      const usdWallet = wallets.find((w: WalletInfo) => w.walletCurrency === "USD")
      if (!btcWallet || !usdWallet) {
        console.error(`[LNURLP] Missing wallet: BTC=${!!btcWallet}, USD=${!!usdWallet}`)
        return { success: false, error: "Missing BTC or USD wallet for transfer" }
      }
      btcWalletId = btcWallet.id
      usdWalletId = usdWallet.id
    } catch (err: unknown) {
      return { success: false, error: `Wallet lookup failed: ${(err as Error).message}` }
    }
  }

  // 1. Never credit on a claim alone: verify with Blink that the invoice was
  //    received, for at least the expected amount, whoever triggered this.
  const receipt = await fetchInvoiceReceipt(
    paymentHash,
    card.apiKey as string,
    apiUrl,
    btcWalletId,
  )
  if (receipt.status !== "PAID") {
    return { success: false, error: `Top-up not paid (${receipt.status})` }
  }
  if (Math.abs(receipt.settlementAmount as number) < amountSats) {
    console.error(
      `[LNURLP] Top-up ${paymentHash.substring(0, 16)}... received ${receipt.settlementAmount} < expected ${amountSats} sats`,
    )
    return { success: false, error: "Received amount is lower than the top-up amount" }
  }

  // A card still PENDING is activated by its first top-up — BEFORE claiming
  // or transferring anything. If activation doesn't persist, nothing has been
  // claimed or moved and the top-up can retry once the card is active.
  if (card.status === CardStatus.PENDING) {
    if (!(await boltcardStore.activateCard(cardId))) {
      console.error(`[LNURLP] Could not activate card ${cardId} for its first top-up`)
      return { success: false, error: "Card could not be activated" }
    }
    console.log(`[LNURLP] Card ${cardId} activated on first top-up`)
  }

  // 2. Claim it atomically: of concurrent processors (webhook + polling) only
  //    one proceeds, so a payment is credited at most once. A database error
  //    is ambiguous (the claim may have committed) and must be flagged, not
  //    reported as a clean "already processed".
  const review = (reason: string) =>
    boltcardStore.setTopUpReviewReason(paymentHash, reason)
  let claimed: boolean
  try {
    claimed = await boltcardStore.markTopUpProcessed(paymentHash)
  } catch (err: unknown) {
    console.error(
      `[LNURLP] Top-up claim outcome unknown for ${paymentHash.substring(0, 16)}...: ${(err as Error).message}`,
    )
    await review(`claim outcome unknown: ${(err as Error).message}`)
    return {
      success: false,
      error: "Top-up claim outcome unknown - manual review needed",
    }
  }
  if (!claimed) {
    // A replay of a processed claim that never got a credit must stay visible.
    // Cleanup deletes processed rows after 24h unless they are flagged.
    if (!(await boltcardStore.hasTopUpTransaction(paymentHash))) {
      // Does not replace a reason already recorded by the first failure.
      await boltcardStore.flagUncreditedTopUp(paymentHash)
    }
    return { success: false, error: "Top-up already processed" }
  }
  pendingTopUpsCache.delete(paymentHash)
  const release = () => boltcardStore.unmarkTopUpProcessed(paymentHash)

  // A payment credits a card at most once (blink-wip#1623). The claim above
  // only covers this pending row; the hash may have credited before (row
  // re-stored, or cleaned up and recreated). Check before anything external
  // happens (the USD transfer); topUpCard's primary key is the atomic
  // backstop for a race past this check.
  let alreadyCredited: boolean
  try {
    alreadyCredited = await boltcardStore.isTopUpCredited(paymentHash)
  } catch (err: unknown) {
    // Keep the claim: we cannot tell whether crediting is safe.
    await review(`credited-check failed: ${(err as Error).message}`)
    return { success: false, error: "Top-up credit check failed - manual review needed" }
  }
  if (alreadyCredited) {
    console.error(
      `[LNURLP] Payment ${paymentHash.substring(0, 16)}... already credited a card - not crediting again`,
    )
    return { success: false, error: "Top-up already processed" }
  }

  let creditAmount = amountSats
  let creditUnit = "sats"

  // 3. USD cards: move the received sats to the USD wallet; credit only if
  //    the transfer succeeded.
  if (currency === "USD") {
    let transferResult: TransferResult
    try {
      transferResult = await blinkAPI.intraLedgerPaymentSend(
        btcWalletId,
        usdWalletId as string,
        amountSats,
        `Boltcard top-up transfer`,
      )
    } catch (err: unknown) {
      if (err instanceof PaymentRejectedError) {
        // Rejected, nothing moved: release for a later retry
        await release()
        return { success: false, error: `USD transfer failed: ${(err as Error).message}` }
      }
      // Outcome unknown: keep the claim (a retry could transfer twice)
      console.error(
        `[LNURLP] USD transfer outcome unknown for top-up ${paymentHash.substring(0, 16)}... - manual review needed: ${(err as Error).message}`,
      )
      await review(`USD transfer outcome unknown: ${(err as Error).message}`)
      return {
        success: false,
        error: "USD transfer outcome unknown - manual review needed",
      }
    }

    // PaymentSendResult (blinkbitcoin public schema) is SUCCESS | FAILURE |
    // PENDING | ALREADY_PAID. FAILED is accepted too so a spelling drift
    // cannot wedge a transfer that never moved. Only a terminal failure
    // releases the claim. PENDING may still settle, ALREADY_PAID did move,
    // and unknown statuses say nothing — those keep the claim for review.
    const transferStatus = String(transferResult.status || "").toUpperCase()
    if (transferStatus === "FAILED" || transferStatus === "FAILURE") {
      console.error(`[LNURLP] Transfer failed: ${JSON.stringify(transferResult)}`)
      await release()
      return { success: false, error: "USD transfer failed" }
    }
    if (transferStatus !== "SUCCESS") {
      console.error(
        `[LNURLP] Transfer status ${transferStatus} for top-up ${paymentHash.substring(0, 16)}... - manual review needed`,
      )
      await review(`USD transfer status ${transferStatus}`)
      return {
        success: false,
        error: `USD transfer ${transferStatus.toLowerCase()} - manual review needed`,
      }
    }

    try {
      // Get exchange rate for local balance tracking (in cents)
      const rate: ExchangeRate = await BlinkAPI.getExchangeRatePublic("USD")
      creditAmount = Math.round(amountSats * rate.satPriceInCurrency)
      creditUnit = "cents"
    } catch (err: unknown) {
      // Transfer done, credit not computed: keep the claim, manual review
      console.error(
        `[LNURLP] Rate lookup failed after USD transfer for top-up ${paymentHash.substring(0, 16)}... - manual review needed: ${(err as Error).message}`,
      )
      await review(`Rate lookup failed after transfer: ${(err as Error).message}`)
      return {
        success: false,
        error: "Rate lookup failed after transfer - manual review needed",
      }
    }
  }

  // 4. Credit the card's local balance. topUpCard distinguishes a definite
  // failure (zero rows: card missing/not active — nothing written) from an
  // ambiguous database error (the write may have committed), which throws.
  let result: TopUpResult
  try {
    result = await boltcardStore.topUpCard(
      cardId,
      creditAmount,
      paymentHash,
      `Top-up via LNURL-pay (${amountSats} sats)`,
    )
  } catch (err: unknown) {
    // Ambiguous: the balance write may have committed. NEVER release the
    // claim (a retry would credit twice) — flag for manual review.
    console.error(
      `[LNURLP] Top-up credit outcome unknown for ${paymentHash.substring(0, 16)}... - manual review needed: ${(err as Error).message}`,
    )
    await review(`Credit outcome unknown: ${(err as Error).message}`)
    return { success: false, error: "Credit outcome unknown - manual review needed" }
  }

  if (result.alreadyCredited) {
    // Lost a race to another credit of this payment: nothing written, keep
    // the claim. USD: this attempt's transfer still moved funds -> review.
    if (currency === "USD") {
      await review("USD transfer done but payment already credited")
    }
    return { success: false, error: "Top-up already processed" }
  }

  if (!result.success) {
    // Definite failure, nothing written. BTC: nothing external happened ->
    // retryable. USD: the transfer already happened -> keep the claim AND
    // flag it for review (the transferred funds need reconciliation).
    if (currency !== "USD") {
      await release()
    } else {
      await review(`Post-transfer credit failed: ${result.error}`)
    }
    return { success: false, error: result.error }
  }

  console.log(
    `[LNURLP] Processed top-up for card ${cardId}: +${creditAmount} ${creditUnit} (from ${amountSats} sats)`,
  )

  return {
    success: true,
    cardId,
    amount: creditAmount,
    amountSats,
    balance: result.balance,
  }
}

/**
 * Check if a payment hash has a pending top-up
 * Checks both cache and database
 * @param paymentHash - Payment hash
 * @returns Pending top-up data or null
 */
async function getPendingTopUp(paymentHash: string): Promise<PendingTopUpData | null> {
  // Try cache first
  const cached = pendingTopUpsCache.get(paymentHash)
  if (cached) {
    return cached
  }

  // Try database
  return (await boltcardStore.getPendingTopUp(paymentHash)) as PendingTopUpData | null
}

/**
 * Get all pending top-ups (for debugging/admin)
 * @returns Array of pending top-ups
 */
async function getAllPendingTopUps(): Promise<PendingTopUpData[]> {
  // Get from database (authoritative source)
  return (await boltcardStore.getAllPendingTopUps()) as PendingTopUpData[]
}

/**
 * Check invoice payment status via Blink API
 * Uses the transactionsByPaymentHash query to check if a payment was received
 *
 * @param paymentHash - Payment hash to check
 * @param apiKey - Blink API key
 * @param apiUrl - Blink API URL
 * @param walletId - Wallet ID to check transactions for
 * @returns { status: PAID | PENDING | UNSEEN | EXPIRED | ERROR }. PAID always
 * carries a finite numeric settlementAmount (otherwise ERROR). UNSEEN means
 * Blink has no transaction for the hash; PENDING means one exists and is not
 * terminal.
 */
/**
 * Payment/invoice status lookup, classified by DIRECTION because outgoing and
 * incoming payments have different terminal statuses:
 * - RECEIVE (top-ups): SUCCESS is final; FAILED -> EXPIRED.
 * - SEND (withdrawals): SUCCESS is final; FAILURE is the terminal failure.
 */
async function fetchInvoiceReceipt(
  paymentHash: string,
  apiKey: string,
  apiUrl: string,
  walletId: string,
  direction: "RECEIVE" | "SEND" = "RECEIVE",
  signal?: AbortSignal,
): Promise<InvoiceReceipt> {
  const query = `
    query GetTransactionsByPaymentHash($paymentHash: PaymentHash!, $walletId: WalletId!) {
      me {
        defaultAccount {
          walletById(walletId: $walletId) {
            transactionsByPaymentHash(paymentHash: $paymentHash) {
              id
              status
              direction
              settlementAmount
              createdAt
            }
          }
        }
      }
    }
  `

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({
        query,
        variables: { paymentHash, walletId },
      }),
      // Callers running under a deadline (the reconcile scheduler) abort a
      // slow lookup instead of waiting on it; an abort is reported as ERROR
      // ("try again next pass"), never as a payment outcome.
      ...(signal ? { signal } : {}),
    })

    if (!response.ok) {
      const text = await response.text()
      console.error(
        `[LNURLP] Invoice status check failed: HTTP ${response.status}`,
        text.substring(0, 200),
      )
      return { status: "ERROR" }
    }

    const data = await response.json()

    if (data.errors) {
      const errorMsg = data.errors[0]?.message
      console.error(`[LNURLP] Invoice status check GraphQL error: ${errorMsg}`)
      return { status: "ERROR" }
    }

    const transactions: BlinkTransaction[] | undefined =
      data.data?.me?.defaultAccount?.walletById?.transactionsByPaymentHash

    if (!transactions || transactions.length === 0) {
      // No transaction at all. Distinct from an in-flight SEND/PENDING so a
      // never-sent payment can be restored without touching one that may settle.
      return { status: "UNSEEN" }
    }

    // Look for a successful transaction in the requested direction
    const receiveTransaction = transactions.find(
      (tx: BlinkTransaction) => tx.direction === direction && tx.status === "SUCCESS",
    )

    if (receiveTransaction) {
      // Fail closed: without a finite numeric settlement amount we cannot
      // prove the expected amount was received.
      const amount = Number(receiveTransaction.settlementAmount)
      if (!Number.isFinite(amount)) {
        console.error(
          `[LNURLP] Paid invoice ${paymentHash.substring(0, 16)}... has no usable settlementAmount`,
        )
        return { status: "ERROR" }
      }
      console.log(
        `[LNURLP] Found paid invoice: ${paymentHash.substring(0, 16)}... amount: ${amount}`,
      )
      return { status: "PAID", settlementAmount: amount }
    }

    // Transaction exists but not successful. Terminal failure is FAILURE on
    // the send path and FAILED on the receive path historically; accept both
    // spellings on both directions.
    const failedTx = transactions.find(
      (tx: BlinkTransaction) =>
        tx.direction === direction && ["FAILED", "FAILURE"].includes(tx.status),
    )
    if (failedTx) {
      return { status: "EXPIRED" }
    }

    return { status: "PENDING" }
  } catch (err: unknown) {
    console.error(`[LNURLP] Invoice status check exception: ${(err as Error).message}`)
    return { status: "ERROR" }
  }
}

/**
 * Check invoice payment status via Blink API (see fetchInvoiceReceipt)
 * @returns Payment status: 'PAID', 'PENDING', 'EXPIRED', or 'ERROR'
 */
async function checkInvoiceStatus(
  paymentHash: string,
  apiKey: string,
  apiUrl: string,
  walletId: string,
  direction?: "RECEIVE" | "SEND",
  signal?: AbortSignal,
): Promise<InvoiceStatus> {
  return (
    await fetchInvoiceReceipt(paymentHash, apiKey, apiUrl, walletId, direction, signal)
  ).status
}

/**
 * Check and process any pending top-ups for a card
 * Called when user checks their balance to detect paid invoices
 *
 * For USD cards: Invoice was created on BTC wallet, so we need to query the BTC wallet
 *
 * @param cardId - Card ID
 * @param apiKey - Card's Blink API key
 * @param environment - 'production' or 'staging'
 * @param walletId - Card's Blink wallet ID
 * @param walletCurrency - Card's wallet currency ('BTC' or 'USD')
 * @returns Processing result
 */
async function checkAndProcessPendingTopUps(
  cardId: string,
  apiKey: string,
  environment: string = "production",
  walletId: string,
  walletCurrency: string = "BTC",
): Promise<CheckAndProcessResult> {
  const { getApiUrlForEnvironment } = await import("../config/api")
  const apiUrl = getApiUrlForEnvironment(environment as "production" | "staging")

  // Get all pending top-ups for this card
  const pendingTopUps = (await boltcardStore.getPendingTopUpsForCard(
    cardId,
  )) as PendingTopUpData[]

  if (pendingTopUps.length === 0) {
    return { processed: 0, total: 0, errors: 0 }
  }

  console.log(
    `[LNURLP] Checking ${pendingTopUps.length} pending top-up(s) for card ${cardId}`,
  )

  // For USD cards, we need to query the BTC wallet because that's where the invoice was created
  let queryWalletId = walletId
  if (walletCurrency === "USD") {
    try {
      const BlinkAPI = (await import("../blink-api")).default
      const blinkAPI = new BlinkAPI(apiKey, apiUrl)
      const wallets: WalletInfo[] = await blinkAPI.getWalletInfo()
      const btcWallet = wallets.find((w: WalletInfo) => w.walletCurrency === "BTC")

      if (btcWallet) {
        queryWalletId = btcWallet.id
        console.log(
          `[LNURLP] USD card: Using BTC wallet ${queryWalletId} for invoice status check`,
        )
      } else {
        console.warn(`[LNURLP] USD card: No BTC wallet found, falling back to USD wallet`)
      }
    } catch (err: unknown) {
      console.error(
        `[LNURLP] Error getting BTC wallet for USD card: ${(err as Error).message}`,
      )
    }
  }

  let processed = 0
  let errors = 0

  for (const pending of pendingTopUps) {
    try {
      // Check if invoice has been paid
      // Use queryWalletId which is the BTC wallet for USD cards
      const status = await checkInvoiceStatus(
        pending.paymentHash as string,
        apiKey,
        apiUrl,
        queryWalletId,
      )

      console.log(
        `[LNURLP] Invoice ${(pending.paymentHash as string).substring(0, 16)}... status: ${status}`,
      )

      if (status === "PAID") {
        // Process the top-up
        const result = await processTopUpPayment(pending.paymentHash as string)

        if (result.success) {
          console.log(
            `[LNURLP] ✅ Processed pending top-up: +${result.amountSats || pending.amount} sats for card ${cardId}`,
          )
          processed++
        } else {
          console.error(`[LNURLP] ❌ Failed to process top-up: ${result.error}`)
          errors++
        }
      } else if (status === "EXPIRED") {
        // Mark expired invoices as processed to clean them up
        await boltcardStore.markTopUpProcessed(pending.paymentHash as string)
        console.log(
          `[LNURLP] Cleaned up expired top-up invoice: ${(pending.paymentHash as string).substring(0, 16)}...`,
        )
      }
      // PENDING (in flight), UNSEEN (no transaction yet), or ERROR: next check.
      // UNSEEN is not an expiry — do not mark the top-up processed.
    } catch (err: unknown) {
      console.error(`[LNURLP] Error processing pending top-up: ${(err as Error).message}`)
      errors++
    }
  }

  return { processed, total: pendingTopUps.length, errors }
}

/**
 * Generate a QR code data for card top-up
 * Returns both the URL and LNURL-bech32 encoded version
 *
 * @param serverUrl - BlinkPOS server URL
 * @param cardId - Card ID
 * @returns QR code data object
 */
function generateTopUpQR(serverUrl: string, cardId: string): TopUpQR {
  const url = generateTopUpUrl(serverUrl, cardId)
  const lnurl = encodeLnurl(url)

  return {
    url,
    lnurl,
    // For display: LNURL is what wallets scan
    qrData: lnurl.toUpperCase(), // Uppercase is more QR-efficient
  }
}

export {
  encodeLnurl,
  generateTopUpUrl,
  generateTopUpLnurl,
  handleTopUpRequest,
  handleTopUpCallback,
  processTopUpPayment,
  getPendingTopUp,
  getAllPendingTopUps,
  checkInvoiceStatus,
  fetchInvoiceReceipt,
  checkAndProcessPendingTopUps,
  generateTopUpQR,
  TopUpLimits,
}

interface InvoiceReceipt {
  status: InvoiceStatus
  /** Settlement amount of the RECEIVE transaction (sats for a BTC wallet) */
  settlementAmount?: number
}

export type {
  InvoiceReceipt,
  BoltcardCard,
  LnurlPayResponse,
  LnurlPayCallbackResponse,
  InvoiceResult,
  CreateInvoiceFn,
  ProcessTopUpResult,
  TopUpQR,
  CheckAndProcessResult,
  InvoiceStatus,
  PendingTopUpData,
  PendingTopUpCache,
  TopUpLimitsType,
  CurrencyLimits,
}
