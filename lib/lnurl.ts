/**
 * LNURL Utilities for Lightning Address payments
 *
 * Provides LNURL-pay resolution and npub.cash address validation.
 * Used for sending tips and forwarding payments to npub.cash addresses.
 */

import { nip19 } from "nostr-tools"
import type { DecodedResult } from "nostr-tools/lib/types/nip19"

// =============================================================================
// Types
// =============================================================================

export interface ParsedLightningAddress {
  localpart: string
  domain: string
  lnurlEndpoint: string
}

export interface NpubValidationResult {
  valid: boolean
  pubkey?: string
  error?: string
}

export interface NpubCashValidationResult {
  valid: boolean
  localpart?: string
  isNpub?: boolean
  pubkey?: string
  error?: string
}

export interface LnurlPayMetadata {
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  commentAllowed: number
  allowsNostr: boolean
  nostrPubkey: string | undefined
}

export interface LnurlInvoiceResponse {
  paymentRequest: string
  paymentHash?: string
  successAction?: unknown
  /**
   * LUD-21 verify URL, when the LNURL server advertises one. Used by the POS to
   * poll payment status without an authenticated GraphQL call. Self-custodial
   * (Spark) recipients on blink-lnurl-server require this path for settlement
   * detection.
   */
  verify?: string
}

export interface LnurlFullInvoiceResponse extends LnurlInvoiceResponse {
  metadata: LnurlPayMetadata
}

export interface NpubCashProbeResult {
  valid: boolean
  minSats?: number
  maxSats?: number
  allowsNostr?: boolean
  error?: string
}

// =============================================================================
// Internal types for LNURL API responses
// =============================================================================

interface LnurlPayResponse {
  tag: string
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  commentAllowed?: number
  allowsNostr?: boolean
  nostrPubkey?: string
}

interface LnurlCallbackResponse {
  status?: string
  reason?: string
  pr?: string
  paymentHash?: string
  successAction?: unknown
  // LUD-21: URL to poll payment status (settled/preimage) for this invoice.
  verify?: string
}

// =============================================================================
// Resilient fetch
// =============================================================================

const DEFAULT_FETCH_TIMEOUT_MS = 4000
const DEFAULT_FETCH_RETRIES = 2 // total attempts = retries + 1
const RETRY_BACKOFF_MS = 300

/**
 * fetch() with a per-attempt timeout and retry-with-backoff.
 *
 * Server-side calls to the Blink LNURL host (blink.sv / lnurl.blink.sv) via
 * Node's undici fetch intermittently fail with "fetch failed" (transient
 * connection/keep-alive races), even though the host is healthy. A single blip
 * must not surface to the user as "address not found", so we retry transient
 * failures. Each attempt uses a fresh connection (Connection: close) to avoid
 * reusing a half-broken pooled socket.
 *
 * @param url - URL to fetch
 * @param init - fetch init (headers are merged with `Connection: close`)
 * @param retries - number of retries after the first attempt
 * @param timeoutMs - per-attempt timeout in milliseconds
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  retries: number = DEFAULT_FETCH_RETRIES,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          // Avoid reusing a stale pooled keep-alive socket on retries.
          Connection: "close",
          ...(init.headers || {}),
        },
      })
      clearTimeout(timer)
      return response
    } catch (err) {
      clearTimeout(timer)
      lastError = err

      // Last attempt: give up.
      if (attempt === retries) break

      // Backoff before retrying (linear).
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)),
      )
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`fetch failed for ${url}: ${String(lastError)}`)
}

// =============================================================================
// Functions
// =============================================================================

/**
 * Parse a Lightning address into its LNURL-pay endpoint
 * @param address - Lightning address (e.g., "user@domain.com")
 * @returns Parsed address parts including LNURL endpoint
 */
export function parseLightningAddress(address: string): ParsedLightningAddress {
  if (!address || typeof address !== "string") {
    throw new Error("Invalid Lightning address: address is required")
  }

  const parts: string[] = address.split("@")
  if (parts.length !== 2) {
    throw new Error(`Invalid Lightning address format: ${address}`)
  }

  const [localpart, domain] = parts

  if (!localpart || !domain) {
    throw new Error(`Invalid Lightning address: missing local part or domain`)
  }

  // Construct the LNURL-pay endpoint (LUD-16)
  const lnurlEndpoint: string = `https://${domain}/.well-known/lnurlp/${localpart}`

  return {
    localpart,
    domain,
    lnurlEndpoint,
  }
}

/**
 * Check if an address is an npub.cash Lightning address
 * @param address - Lightning address to check
 * @returns boolean
 */
export function isNpubCashAddress(address: string): boolean {
  if (!address || typeof address !== "string") {
    return false
  }

  return address.toLowerCase().endsWith("@npub.cash")
}

/**
 * Validate an npub string using nostr-tools
 * @param npub - The npub to validate (e.g., "npub1abc...")
 * @returns Validation result with optional pubkey or error
 */
export function validateNpub(npub: string): NpubValidationResult {
  if (!npub || typeof npub !== "string") {
    return { valid: false, error: "npub is required" }
  }

  if (!npub.startsWith("npub1")) {
    return { valid: false, error: "npub must start with npub1" }
  }

  try {
    const decoded: DecodedResult = nip19.decode(npub)
    if (decoded.type !== "npub") {
      return { valid: false, error: "Invalid npub encoding" }
    }
    return { valid: true, pubkey: decoded.data }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    return { valid: false, error: `Invalid npub format: ${error.message}` }
  }
}

/**
 * Validate an npub.cash address
 * Checks format and validates npub if present
 * @param address - npub.cash address (e.g., "npub1xxx@npub.cash" or "username@npub.cash")
 * @returns Validation result
 */
export function validateNpubCashAddress(address: string): NpubCashValidationResult {
  if (!isNpubCashAddress(address)) {
    return { valid: false, error: "Address must end with @npub.cash" }
  }

  const { localpart } = parseLightningAddress(address)

  // Check if the local part is an npub
  const isNpub: boolean = localpart.startsWith("npub1")

  if (isNpub) {
    const npubValidation: NpubValidationResult = validateNpub(localpart)
    if (!npubValidation.valid) {
      return { valid: false, error: npubValidation.error }
    }
    return {
      valid: true,
      localpart,
      isNpub: true,
      pubkey: npubValidation.pubkey,
    }
  }

  // Username-based address (requires registration on npub.cash)
  // We can't validate existence without probing the endpoint
  if (localpart.length < 1) {
    return { valid: false, error: "Username cannot be empty" }
  }

  return {
    valid: true,
    localpart,
    isNpub: false,
  }
}

/**
 * Fetch LNURL-pay metadata from endpoint
 * @param lnurlEndpoint - The LNURL endpoint URL
 * @returns LNURL-pay metadata
 */
export async function fetchLnurlPayMetadata(
  lnurlEndpoint: string,
): Promise<LnurlPayMetadata> {
  const response: Response = await fetchWithRetry(lnurlEndpoint, {
    headers: {
      Accept: "application/json",
    },
  })

  if (!response.ok) {
    throw new Error(`LNURL endpoint returned ${response.status}: ${response.statusText}`)
  }

  const data: LnurlPayResponse = await response.json()

  // Validate it's a pay request
  if (data.tag !== "payRequest") {
    throw new Error(`Invalid LNURL tag: expected 'payRequest', got '${data.tag}'`)
  }

  // Validate required fields
  if (!data.callback) {
    throw new Error("LNURL response missing callback URL")
  }

  if (typeof data.minSendable !== "number" || typeof data.maxSendable !== "number") {
    throw new Error("LNURL response missing min/max sendable amounts")
  }

  return {
    callback: data.callback,
    minSendable: data.minSendable, // in millisatoshis
    maxSendable: data.maxSendable, // in millisatoshis
    metadata: data.metadata,
    commentAllowed: data.commentAllowed || 0,
    allowsNostr: data.allowsNostr || false,
    nostrPubkey: data.nostrPubkey,
  }
}

/**
 * Request an invoice from LNURL-pay callback
 * @param callbackUrl - The LNURL callback URL
 * @param amountMsats - Amount in millisatoshis
 * @param comment - Optional comment/memo
 * @returns Invoice response with payment request
 */
export async function requestInvoiceFromCallback(
  callbackUrl: string,
  amountMsats: number,
  comment: string = "",
): Promise<LnurlInvoiceResponse> {
  // Build callback URL with amount
  const url: URL = new URL(callbackUrl)
  url.searchParams.set("amount", amountMsats.toString())

  if (comment) {
    url.searchParams.set("comment", comment)
  }

  const response: Response = await fetchWithRetry(url.toString(), {
    headers: {
      Accept: "application/json",
    },
  })

  if (!response.ok) {
    throw new Error(`LNURL callback returned ${response.status}: ${response.statusText}`)
  }

  const data: LnurlCallbackResponse = await response.json()

  if (data.status === "ERROR") {
    throw new Error(`LNURL error: ${data.reason || "Unknown error"}`)
  }

  if (!data.pr) {
    throw new Error("LNURL callback did not return a payment request")
  }

  return {
    paymentRequest: data.pr,
    paymentHash: data.paymentHash,
    successAction: data.successAction,
    verify: data.verify,
  }
}

/**
 * Get invoice from Lightning address via LNURL-pay
 * Complete flow: resolve address -> fetch metadata -> request invoice
 *
 * @param lightningAddress - Lightning address (e.g., "npub1xxx@npub.cash")
 * @param amountSats - Amount in satoshis
 * @param memo - Optional memo/comment
 * @returns Full invoice response with metadata
 */
export async function getInvoiceFromLightningAddress(
  lightningAddress: string,
  amountSats: number,
  memo: string = "",
): Promise<LnurlFullInvoiceResponse> {
  // Parse the address
  const { lnurlEndpoint } = parseLightningAddress(lightningAddress)

  // Fetch LNURL-pay metadata
  const lnurlData: LnurlPayMetadata = await fetchLnurlPayMetadata(lnurlEndpoint)

  // Convert sats to millisats
  const amountMsats: number = amountSats * 1000

  // Validate amount is within bounds
  if (amountMsats < lnurlData.minSendable) {
    throw new Error(
      `Amount ${amountSats} sats is below minimum ${Math.ceil(lnurlData.minSendable / 1000)} sats`,
    )
  }

  if (amountMsats > lnurlData.maxSendable) {
    throw new Error(
      `Amount ${amountSats} sats exceeds maximum ${Math.floor(lnurlData.maxSendable / 1000)} sats`,
    )
  }

  // Truncate comment if necessary
  let comment: string = memo
  if (lnurlData.commentAllowed > 0 && memo.length > lnurlData.commentAllowed) {
    comment = memo.substring(0, lnurlData.commentAllowed)
  } else if (lnurlData.commentAllowed === 0) {
    comment = "" // Comments not allowed
  }

  // Request invoice
  const invoiceData: LnurlInvoiceResponse = await requestInvoiceFromCallback(
    lnurlData.callback,
    amountMsats,
    comment,
  )

  return {
    paymentRequest: invoiceData.paymentRequest,
    paymentHash: invoiceData.paymentHash,
    successAction: invoiceData.successAction,
    verify: invoiceData.verify,
    metadata: lnurlData,
  }
}

/**
 * LUD-21 verify response.
 * See https://github.com/lnurl/luds/blob/luds/21.md
 */
export interface LnurlVerifyResult {
  /** True once the LNURL server has observed the invoice as paid. */
  settled: boolean
  /** Payment preimage, present once settled. */
  preimage?: string
  /** The bolt11 payment request the verify URL refers to. */
  pr?: string
}

/**
 * Poll a LUD-21 verify URL to check whether an invoice has been paid.
 *
 * Note for self-custodial (Spark) recipients on blink-lnurl-server: the verify
 * endpoint is populated by the Spark SSP webhook (there is no synchronous Spark
 * status pull server-side), so `settled` only flips to true once that webhook
 * lands. Polling tolerates the lag; do not expect sub-second confirmation.
 *
 * @param verifyUrl - The LUD-21 verify URL returned alongside the invoice
 * @returns Parsed verify result
 */
export async function verifyLnurlPayment(verifyUrl: string): Promise<LnurlVerifyResult> {
  const response: Response = await fetchWithRetry(verifyUrl, {
    headers: {
      Accept: "application/json",
    },
  })

  if (!response.ok) {
    throw new Error(`LNURL verify returned ${response.status}: ${response.statusText}`)
  }

  const data: {
    status?: string
    reason?: string
    settled?: boolean
    preimage?: string | null
    pr?: string
  } = await response.json()

  if (data.status === "ERROR") {
    throw new Error(`LNURL verify error: ${data.reason || "Unknown error"}`)
  }

  return {
    settled: data.settled === true,
    preimage: data.preimage ?? undefined,
    pr: data.pr,
  }
}

/**
 * Probe an npub.cash address to verify it exists/responds
 * @param address - npub.cash address
 * @returns Probe result with validity and capacity info
 */
export async function probeNpubCashAddress(
  address: string,
): Promise<NpubCashProbeResult> {
  try {
    const validation: NpubCashValidationResult = validateNpubCashAddress(address)
    if (!validation.valid) {
      return { valid: false, error: validation.error }
    }

    const { lnurlEndpoint } = parseLightningAddress(address)
    const metadata: LnurlPayMetadata = await fetchLnurlPayMetadata(lnurlEndpoint)

    return {
      valid: true,
      minSats: Math.ceil(metadata.minSendable / 1000),
      maxSats: Math.floor(metadata.maxSendable / 1000),
      allowsNostr: metadata.allowsNostr,
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    return {
      valid: false,
      error: error.message,
    }
  }
}

export default {
  parseLightningAddress,
  isNpubCashAddress,
  validateNpub,
  validateNpubCashAddress,
  fetchLnurlPayMetadata,
  requestInvoiceFromCallback,
  getInvoiceFromLightningAddress,
  verifyLnurlPayment,
  probeNpubCashAddress,
}
