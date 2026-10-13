/**
 * Payment Executor for Batch Payments
 *
 * Executes batch payments in chunks:
 * - Intra-ledger: Uses intraLedgerPaymentSend
 * - External LN Address: Uses lnAddressPaymentSend
 * - External LNURL: Fetches invoice from callback, then pays
 */

import { getApiUrl } from "../config/api"
import { fetchJsonWithRetry } from "../lnurl"

import { RECIPIENT_TYPES, type ParsedRecipient } from "./csv-parser"

// Execution settings
// Process sequentially to avoid Redlock conflicts (Blink API uses Redis locks per wallet)
export const PAYMENT_DELAY_MS = 100 // Delay between each payment

// Blink API - now uses centralized config
const getBlinkApiUrl = (): string => getApiUrl()

/**
 * Payment error codes
 */
export const PAYMENT_ERROR_CODES = {
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  NO_ROUTE: "NO_ROUTE",
  INVOICE_EXPIRED: "INVOICE_EXPIRED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
} as const

export type PaymentErrorCode =
  (typeof PAYMENT_ERROR_CODES)[keyof typeof PAYMENT_ERROR_CODES]

export interface PaymentError {
  code: string
  message: string
}

export interface PaymentResult {
  success: boolean
  status?: string
  feeSats?: number
  error?: PaymentError
}

export interface PaymentResultWithRecipient extends PaymentResult {
  recipient: ParsedRecipient
}

export interface IntraLedgerParams {
  apiKey: string
  senderWalletId: string
  recipientWalletId: string
  amountSats: number
  memo?: string
}

export interface LnAddressParams {
  apiKey: string
  senderWalletId: string
  lnAddress: string
  amountSats: number
}

export interface LnurlPaymentParams {
  apiKey: string
  senderWalletId: string
  lnurlData: { callback: string; [key: string]: unknown }
  amountSats: number
}

// The validationResult from the API has a flattened structure:
export interface FlatValidationResult {
  rowNumber?: number
  recipient?: string
  type: string
  normalized: string
  amount?: number
  amountSats: number
  currency?: string
  memo?: string
  walletId?: string
  lnurlData?: { callback: string; [key: string]: unknown }
  valid?: boolean
}

export interface ProcessPaymentParams {
  apiKey: string
  senderWalletId: string
  validationResult: FlatValidationResult
}

export interface ExecutionProgress {
  completed: number
  total: number
  successful: number
  failed: number
  percent: number
}

export interface BatchExecutionParams {
  apiKey: string
  senderWalletId: string
  validationResults: FlatValidationResult[]
  onProgress?: (progress: ExecutionProgress) => void
}

export interface BatchExecutionResult {
  results: PaymentResultWithRecipient[]
  summary: {
    totalRecipients: number
    successful: number
    failed: number
    totalSentSats: number
    totalFeesSats: number
  }
}

/** GraphQL mutation response shape for intra-ledger payments */
interface IntraLedgerMutationResponse {
  data?: {
    intraLedgerPaymentSend?: {
      status?: string
      errors?: Array<{ message: string; code?: string }>
    }
  }
  errors?: Array<{ message: string }>
}

/** GraphQL mutation response shape for LN address payments */
interface LnAddressMutationResponse {
  data?: {
    lnAddressPaymentSend?: {
      status?: string
      errors?: Array<{ message: string; code?: string }>
    }
  }
  errors?: Array<{ message: string }>
}

/** GraphQL mutation response shape for LN invoice payments */
interface LnInvoiceMutationResponse {
  data?: {
    lnInvoicePaymentSend?: {
      status?: string
      errors?: Array<{ message: string; code?: string }>
    }
  }
  errors?: Array<{ message: string }>
}

/** LNURL callback response shape */
interface LnurlCallbackResponse {
  status?: string
  reason?: string
  pr?: string
}

/**
 * Execute intra-ledger payment (Blink to Blink)
 * @param {IntraLedgerParams} params - Payment parameters
 * @returns {Promise<PaymentResult>} Payment result
 */
export async function executeIntraLedgerPayment({
  apiKey,
  senderWalletId,
  recipientWalletId,
  amountSats,
  memo,
}: IntraLedgerParams): Promise<PaymentResult> {
  const mutation = `
    mutation IntraLedgerPaymentSend($input: IntraLedgerPaymentSendInput!) {
      intraLedgerPaymentSend(input: $input) {
        status
        errors {
          message
          code
        }
      }
    }
  `

  const variables = {
    input: {
      walletId: senderWalletId,
      recipientWalletId,
      amount: amountSats,
      memo: memo || undefined,
    },
  }

  try {
    const response = await fetch(getBlinkApiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ query: mutation, variables }),
    })

    if (!response.ok) {
      throw new Error(`Blink API returned ${response.status}`)
    }

    const data: IntraLedgerMutationResponse = await response.json()

    if (data.errors && data.errors.length > 0) {
      return {
        success: false,
        error: {
          code: PAYMENT_ERROR_CODES.PAYMENT_FAILED,
          message: data.errors[0].message,
        },
      }
    }

    const result = data.data?.intraLedgerPaymentSend

    if (result?.errors?.length && result.errors.length > 0) {
      const error = result.errors[0]
      return {
        success: false,
        error: {
          code: error.code || PAYMENT_ERROR_CODES.PAYMENT_FAILED,
          message: error.message,
        },
      }
    }

    return {
      success: true,
      status: result?.status || "SUCCESS",
      feeSats: 0,
    }
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: PAYMENT_ERROR_CODES.NETWORK_ERROR,
        message: (err as Error).message,
      },
    }
  }
}

/**
 * Execute Lightning Address payment
 * @param {LnAddressParams} params - Payment parameters
 * @returns {Promise<PaymentResult>} Payment result
 */
export async function executeLnAddressPayment({
  apiKey,
  senderWalletId,
  lnAddress,
  amountSats,
}: LnAddressParams): Promise<PaymentResult> {
  const mutation = `
    mutation LnAddressPaymentSend($input: LnAddressPaymentSendInput!) {
      lnAddressPaymentSend(input: $input) {
        status
        errors {
          message
          code
        }
      }
    }
  `

  const variables = {
    input: {
      walletId: senderWalletId,
      lnAddress,
      amount: amountSats,
    },
  }

  try {
    const response = await fetch(getBlinkApiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ query: mutation, variables }),
    })

    if (!response.ok) {
      throw new Error(`Blink API returned ${response.status}`)
    }

    const data: LnAddressMutationResponse = await response.json()

    if (data.errors && data.errors.length > 0) {
      return {
        success: false,
        error: {
          code: PAYMENT_ERROR_CODES.PAYMENT_FAILED,
          message: data.errors[0].message,
        },
      }
    }

    const result = data.data?.lnAddressPaymentSend

    if (result?.errors?.length && result.errors.length > 0) {
      const error = result.errors[0]

      // Map specific error codes
      let errorCode: string = PAYMENT_ERROR_CODES.PAYMENT_FAILED
      if (error.code === "ROUTE_FINDING_ERROR" || error.message?.includes("route")) {
        errorCode = PAYMENT_ERROR_CODES.NO_ROUTE
      } else if (error.code === "INSUFFICIENT_BALANCE") {
        errorCode = PAYMENT_ERROR_CODES.INSUFFICIENT_BALANCE
      }

      return {
        success: false,
        error: {
          code: errorCode,
          message: error.message,
        },
      }
    }

    return {
      success: true,
      status: result?.status || "SUCCESS",
    }
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: PAYMENT_ERROR_CODES.NETWORK_ERROR,
        message: (err as Error).message,
      },
    }
  }
}

/**
 * Execute LNURL payment (fetch invoice from callback, then pay)
 * @param {LnurlPaymentParams} params - Payment parameters
 * @returns {Promise<PaymentResult>} Payment result
 */
export async function executeLnurlPayment({
  apiKey,
  senderWalletId,
  lnurlData,
  amountSats,
}: LnurlPaymentParams): Promise<PaymentResult> {
  try {
    // Step 1: Get invoice from LNURL callback
    const amountMsats = amountSats * 1000
    const callbackUrl = new URL(lnurlData.callback)
    callbackUrl.searchParams.set("amount", amountMsats.toString())

    // SSRF-safe: the callback URL comes from a
    // third-party LNURL server, so it must never reach internal targets.
    const invoiceData = (await fetchJsonWithRetry(
      callbackUrl.toString(),
      0,
    )) as LnurlCallbackResponse

    if (invoiceData.status === "ERROR") {
      return {
        success: false,
        error: {
          code: PAYMENT_ERROR_CODES.PAYMENT_FAILED,
          message: invoiceData.reason || "LNURL callback error",
        },
      }
    }

    if (!invoiceData.pr) {
      return {
        success: false,
        error: {
          code: PAYMENT_ERROR_CODES.PAYMENT_FAILED,
          message: "No invoice returned from LNURL callback",
        },
      }
    }

    // Step 2: Pay the invoice
    const mutation = `
      mutation LnInvoicePaymentSend($input: LnInvoicePaymentInput!) {
        lnInvoicePaymentSend(input: $input) {
          status
          errors {
            message
            code
          }
        }
      }
    `

    const variables = {
      input: {
        walletId: senderWalletId,
        paymentRequest: invoiceData.pr,
      },
    }

    const response = await fetch(getBlinkApiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ query: mutation, variables }),
    })

    if (!response.ok) {
      throw new Error(`Blink API returned ${response.status}`)
    }

    const data: LnInvoiceMutationResponse = await response.json()

    if (data.errors && data.errors.length > 0) {
      return {
        success: false,
        error: {
          code: PAYMENT_ERROR_CODES.PAYMENT_FAILED,
          message: data.errors[0].message,
        },
      }
    }

    const result = data.data?.lnInvoicePaymentSend

    if (result?.errors?.length && result.errors.length > 0) {
      const error = result.errors[0]
      return {
        success: false,
        error: {
          code: error.code || PAYMENT_ERROR_CODES.PAYMENT_FAILED,
          message: error.message,
        },
      }
    }

    return {
      success: true,
      status: result?.status || "SUCCESS",
    }
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: PAYMENT_ERROR_CODES.NETWORK_ERROR,
        message: (err as Error).message,
      },
    }
  }
}

/**
 * Process a single payment
 * @param {ProcessPaymentParams} params - Payment parameters
 * @returns {Promise<PaymentResultWithRecipient>} Payment result
 */
export async function processPayment({
  apiKey,
  senderWalletId,
  validationResult,
}: ProcessPaymentParams): Promise<PaymentResultWithRecipient> {
  // Validation results from API have flattened structure:
  // { recipient: "original string", type, normalized, amountSats, memo, lnurlData, ... }
  const { lnurlData, walletId } = validationResult

  // Build recipient object from flattened properties for return value
  const recipient: ParsedRecipient = {
    rowNumber: validationResult.rowNumber ?? 0,
    original: validationResult.recipient ?? "",
    type: validationResult.type as ParsedRecipient["type"],
    normalized: validationResult.normalized,
    amount: validationResult.amount ?? 0,
    amountSats: validationResult.amountSats,
    currency: validationResult.currency ?? "SATS",
    memo: validationResult.memo ?? "",
  }

  try {
    // Intra-ledger payment (Blink user with walletId)
    if (walletId) {
      const result = await executeIntraLedgerPayment({
        apiKey,
        senderWalletId,
        recipientWalletId: walletId,
        amountSats: validationResult.amountSats,
        memo: validationResult.memo,
      })

      return {
        recipient,
        ...result,
      }
    }

    // Blink user payment - use Lightning Address (username@blink.sv)
    // Blink-to-Blink payments via LN address are automatically intra-ledger (zero fees)
    if (validationResult.type === RECIPIENT_TYPES.BLINK) {
      const blinkLnAddress = `${validationResult.normalized}@blink.sv`
      const result = await executeLnAddressPayment({
        apiKey,
        senderWalletId,
        lnAddress: blinkLnAddress,
        amountSats: validationResult.amountSats,
      })

      return {
        recipient,
        ...result,
      }
    }

    // External Lightning Address payment
    if (validationResult.type === RECIPIENT_TYPES.LN_ADDRESS) {
      const result = await executeLnAddressPayment({
        apiKey,
        senderWalletId,
        lnAddress: validationResult.normalized,
        amountSats: validationResult.amountSats,
      })

      return {
        recipient,
        ...result,
      }
    }

    // LNURL payment
    if (validationResult.type === RECIPIENT_TYPES.LNURL && lnurlData) {
      const result = await executeLnurlPayment({
        apiKey,
        senderWalletId,
        lnurlData,
        amountSats: validationResult.amountSats,
      })

      return {
        recipient,
        ...result,
      }
    }

    // Unknown payment type
    return {
      recipient,
      success: false,
      error: {
        code: PAYMENT_ERROR_CODES.PAYMENT_FAILED,
        message: `Unknown payment type: ${validationResult.type}`,
      },
    }
  } catch (err: unknown) {
    return {
      recipient,
      success: false,
      error: {
        code: PAYMENT_ERROR_CODES.NETWORK_ERROR,
        message: (err as Error).message,
      },
    }
  }
}

/**
 * Execute batch payments sequentially
 * Note: Payments must be sequential to avoid Redlock conflicts in Blink API.
 * The API uses Redis locks per wallet, so parallel payments from the same
 * wallet cause ResourceAttemptsRedlockServiceError.
 * @param {BatchExecutionParams} params - Execution parameters
 * @returns {Promise<BatchExecutionResult>} Execution results
 */
export async function executeBatchPayments({
  apiKey,
  senderWalletId,
  validationResults,
  onProgress = () => {},
}: BatchExecutionParams): Promise<BatchExecutionResult> {
  const results: PaymentResultWithRecipient[] = []
  const validRecipients = validationResults.filter((v) => v.valid)

  let completed = 0
  let successful = 0
  let failed = 0

  // Process payments sequentially (one at a time)
  for (let i = 0; i < validRecipients.length; i++) {
    const validationResult = validRecipients[i]

    try {
      const result = await processPayment({
        apiKey,
        senderWalletId,
        validationResult,
      })

      results.push(result)
      if (result.success) {
        successful++
      } else {
        failed++
      }
    } catch (err: unknown) {
      // Build recipient object from flattened validation result
      const recipient: ParsedRecipient = {
        rowNumber: validationResult.rowNumber ?? 0,
        original: validationResult.recipient ?? "",
        type: validationResult.type as ParsedRecipient["type"],
        normalized: validationResult.normalized,
        amount: validationResult.amount ?? 0,
        amountSats: validationResult.amountSats,
        currency: validationResult.currency ?? "SATS",
        memo: validationResult.memo ?? "",
      }
      results.push({
        recipient,
        success: false,
        error: {
          code: PAYMENT_ERROR_CODES.NETWORK_ERROR,
          message: (err as Error).message || "Payment execution failed",
        },
      })
      failed++
    }

    completed++

    // Progress callback
    onProgress({
      completed,
      total: validRecipients.length,
      successful,
      failed,
      percent: Math.round((completed / validRecipients.length) * 100),
    })

    // Small delay between payments to avoid rate limiting
    if (i < validRecipients.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, PAYMENT_DELAY_MS))
    }
  }

  // Calculate summary
  const successfulPayments = results.filter((r) => r.success)
  const failedPayments = results.filter((r) => !r.success)

  const totalSent = successfulPayments.reduce(
    (sum: number, r: PaymentResultWithRecipient) => sum + (r.recipient.amountSats || 0),
    0,
  )

  const totalFees = successfulPayments.reduce(
    (sum: number, r: PaymentResultWithRecipient) => sum + (r.feeSats || 0),
    0,
  )

  return {
    results,
    summary: {
      totalRecipients: validRecipients.length,
      successful: successfulPayments.length,
      failed: failedPayments.length,
      totalSentSats: totalSent,
      totalFeesSats: totalFees,
    },
  }
}
