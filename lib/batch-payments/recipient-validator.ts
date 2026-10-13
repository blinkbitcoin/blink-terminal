/**
 * Recipient Validator for Batch Payments
 *
 * Validates recipients by type:
 * - Blink usernames: Check via Blink GraphQL API (usernameAvailable query)
 * - Lightning Addresses: Fetch LNURL-pay metadata
 * - LNURLs: Decode and fetch metadata
 */

import { getApiUrl, getAllValidDomains } from "../config/api"
import { fetchJsonWithRetry } from "../lnurl"

import { RECIPIENT_TYPES, type ParsedRecipient } from "./csv-parser"

// Blink API endpoint - now uses centralized config
const getBlinkApiUrl = (): string => getApiUrl()

// Known Blink domains (recipients at these are treated as Blink users)
// Now uses dynamic list from config that includes production AND staging domains
const getBlinkDomains = (): string[] => getAllValidDomains()

/**
 * Validation error codes
 */
export const ERROR_CODES = {
  INVALID_FORMAT: "INVALID_FORMAT",
  BLINK_USER_NOT_FOUND: "BLINK_USER_NOT_FOUND",
  LNURL_UNREACHABLE: "LNURL_UNREACHABLE",
  LNURL_INVALID_RESPONSE: "LNURL_INVALID_RESPONSE",
  AMOUNT_BELOW_MIN: "AMOUNT_BELOW_MIN",
  AMOUNT_ABOVE_MAX: "AMOUNT_ABOVE_MAX",
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export interface ValidationError {
  code: string
  message: string
}

export interface LnurlData {
  callback: string
  minSendable: number
  maxSendable: number
  metadata?: string
  tag?: string
  commentAllowed?: number
}

export interface ValidationResult {
  recipient: ParsedRecipient
  valid: boolean
  blinkUsername?: string
  walletId?: string
  lnurlData?: LnurlData
  error?: ValidationError
}

export interface ValidationProgress {
  completed: number
  total: number
  percent: number
}

export interface ValidationOptions {
  concurrency?: number
  delayMs?: number
  onProgress?: (progress: ValidationProgress) => void
}

export interface AllValidationResults {
  results: ValidationResult[]
  summary: {
    total: number
    valid: number
    invalid: number
    byType: Record<string, number>
    errorGroups: Record<string, ValidationResult[]>
  }
}

/** GraphQL response shape for accountDefaultWallet */
interface BlinkWalletResponse {
  data?: {
    accountDefaultWallet?: {
      id?: string
      walletCurrency?: string
    }
  }
  errors?: Array<{ message: string }>
}

/** LNURL-pay endpoint response shape */
interface LnurlPayResponse {
  status?: string
  reason?: string
  callback?: string
  minSendable?: number
  maxSendable?: number
  metadata?: string
  tag?: string
  commentAllowed?: number
}

/**
 * Validate a Blink username and fetch their wallet ID
 * Uses accountDefaultWallet query to get wallet ID for intra-ledger payments
 * (which support memo, unlike lnAddressPaymentSend)
 * @param {ParsedRecipient} recipient - Parsed recipient object
 * @returns {Promise<ValidationResult>} Validation result with walletId
 */
export async function validateBlinkUser(
  recipient: ParsedRecipient,
): Promise<ValidationResult> {
  let username = recipient.normalized

  // Clean username - strip any Blink domain if present
  const blinkDomains = getBlinkDomains()
  for (const domain of blinkDomains) {
    if (username.includes(`@${domain}`)) {
      username = username.replace(`@${domain}`, "").trim()
      break
    }
  }
  if (username.includes("@")) {
    username = username.split("@")[0].trim()
  }

  // Validate username format (alphanumeric + underscore, 3-50 chars)
  if (!/^[a-z0-9_]{3,50}$/i.test(username)) {
    return {
      recipient,
      valid: false,
      error: {
        code: ERROR_CODES.INVALID_FORMAT,
        message: `Invalid Blink username format: "${username}"`,
      },
    }
  }

  try {
    // Use accountDefaultWallet to get wallet ID for intra-ledger payments
    // This also validates the user exists (returns error if not found)
    const query = `
      query GetDefaultWalletByUsername($username: Username!) {
        accountDefaultWallet(username: $username) {
          id
          walletCurrency
        }
      }
    `

    const response = await fetch(getBlinkApiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { username },
      }),
    })

    if (!response.ok) {
      throw new Error(`Blink API returned ${response.status}`)
    }

    const data: BlinkWalletResponse = await response.json()

    if (data.errors && data.errors.length > 0) {
      const errorMessage = data.errors[0].message

      if (errorMessage.includes("Invalid value for Username")) {
        return {
          recipient,
          valid: false,
          error: {
            code: ERROR_CODES.INVALID_FORMAT,
            message: `Invalid username format: "${username}"`,
          },
        }
      }

      // User not found returns an error from this query
      if (
        errorMessage.includes("Account does not exist") ||
        errorMessage.includes("CouldNotFindAccountFromUsername")
      ) {
        return {
          recipient,
          valid: false,
          error: {
            code: ERROR_CODES.BLINK_USER_NOT_FOUND,
            message: `Blink user "${username}" not found`,
          },
        }
      }

      return {
        recipient,
        valid: false,
        error: {
          code: ERROR_CODES.NETWORK_ERROR,
          message: errorMessage,
        },
      }
    }

    const wallet = data.data?.accountDefaultWallet

    if (!wallet?.id) {
      return {
        recipient,
        valid: false,
        error: {
          code: ERROR_CODES.BLINK_USER_NOT_FOUND,
          message: `Blink user "${username}" not found or has no wallet`,
        },
      }
    }

    // User exists and we have their wallet ID for intra-ledger payment
    return {
      recipient,
      valid: true,
      blinkUsername: username,
      walletId: wallet.id,
    }
  } catch (err: unknown) {
    return {
      recipient,
      valid: false,
      error: {
        code: ERROR_CODES.NETWORK_ERROR,
        message: `Failed to validate "${username}": ${(err as Error).message}`,
      },
    }
  }
}

/**
 * Validate a Lightning Address
 * @param {ParsedRecipient} recipient - Parsed recipient object
 * @returns {Promise<ValidationResult>} Validation result
 */
export async function validateLnAddress(
  recipient: ParsedRecipient,
): Promise<ValidationResult> {
  const address = recipient.normalized
  const parts = address.split("@")

  if (parts.length !== 2) {
    return {
      recipient,
      valid: false,
      error: {
        code: ERROR_CODES.INVALID_FORMAT,
        message: `Invalid Lightning Address format: "${address}"`,
      },
    }
  }

  const [user, domain] = parts

  // Check if this is actually a Blink user (production or staging)
  const blinkDomains = getBlinkDomains()
  if (blinkDomains.includes(domain.toLowerCase())) {
    // Treat as Blink user
    const blinkRecipient: ParsedRecipient = {
      ...recipient,
      type: RECIPIENT_TYPES.BLINK,
      normalized: user.toLowerCase(),
    }
    return validateBlinkUser(blinkRecipient)
  }

  // Validate external Lightning Address via LNURL-pay
  const lnurlpUrl = `https://${domain}/.well-known/lnurlp/${user}`

  try {
    // SSRF-safe: refuses internal/private targets.
    const data = (await fetchJsonWithRetry(lnurlpUrl, 0)) as LnurlPayResponse

    // Check for LNURL error response
    if (data.status === "ERROR") {
      return {
        recipient,
        valid: false,
        error: {
          code: ERROR_CODES.LNURL_INVALID_RESPONSE,
          message: data.reason || `LNURL error from ${domain}`,
        },
      }
    }

    // Validate required fields
    if (
      !data.callback ||
      data.minSendable === undefined ||
      data.maxSendable === undefined
    ) {
      return {
        recipient,
        valid: false,
        error: {
          code: ERROR_CODES.LNURL_INVALID_RESPONSE,
          message: `Invalid LNURL response from ${domain}`,
        },
      }
    }

    // Validate amount is within bounds (if amountSats is known)
    if (recipient.amountSats !== null) {
      const amountMsats = recipient.amountSats * 1000

      if (amountMsats < data.minSendable) {
        return {
          recipient,
          valid: false,
          error: {
            code: ERROR_CODES.AMOUNT_BELOW_MIN,
            message: `Amount ${recipient.amountSats} sats below minimum ${Math.ceil(data.minSendable / 1000)} sats`,
          },
        }
      }

      if (amountMsats > data.maxSendable) {
        return {
          recipient,
          valid: false,
          error: {
            code: ERROR_CODES.AMOUNT_ABOVE_MAX,
            message: `Amount ${recipient.amountSats} sats above maximum ${Math.floor(data.maxSendable / 1000)} sats`,
          },
        }
      }
    }

    return {
      recipient,
      valid: true,
      lnurlData: {
        callback: data.callback,
        minSendable: data.minSendable,
        maxSendable: data.maxSendable,
        metadata: data.metadata,
        tag: data.tag,
        commentAllowed: data.commentAllowed || 0,
      },
    }
  } catch (err: unknown) {
    return {
      recipient,
      valid: false,
      error: {
        code: ERROR_CODES.LNURL_UNREACHABLE,
        message: `Failed to reach ${domain}: ${(err as Error).message}`,
      },
    }
  }
}

/**
 * Validate an LNURL
 * @param {ParsedRecipient} recipient - Parsed recipient object
 * @returns {Promise<ValidationResult>} Validation result
 */
export async function validateLnurl(
  recipient: ParsedRecipient,
): Promise<ValidationResult> {
  const lnurl = recipient.normalized

  // Decode bech32 LNURL
  let url: string
  try {
    url = decodeLnurl(lnurl)
  } catch (err: unknown) {
    return {
      recipient,
      valid: false,
      error: {
        code: ERROR_CODES.INVALID_FORMAT,
        message: `Invalid LNURL format: ${(err as Error).message}`,
      },
    }
  }

  try {
    // SSRF-safe: refuses internal/private targets.
    const data = (await fetchJsonWithRetry(url, 0)) as LnurlPayResponse

    // Check for error response
    if (data.status === "ERROR") {
      return {
        recipient,
        valid: false,
        error: {
          code: ERROR_CODES.LNURL_INVALID_RESPONSE,
          message: data.reason || "LNURL error",
        },
      }
    }

    // Must be a pay request (tag: payRequest)
    if (data.tag !== "payRequest") {
      return {
        recipient,
        valid: false,
        error: {
          code: ERROR_CODES.INVALID_FORMAT,
          message: `LNURL is not a pay request (tag: ${data.tag})`,
        },
      }
    }

    // Validate amount bounds
    if (recipient.amountSats !== null) {
      const amountMsats = recipient.amountSats * 1000

      if (data.minSendable !== undefined && amountMsats < data.minSendable) {
        return {
          recipient,
          valid: false,
          error: {
            code: ERROR_CODES.AMOUNT_BELOW_MIN,
            message: `Amount ${recipient.amountSats} sats below minimum ${Math.ceil(data.minSendable / 1000)} sats`,
          },
        }
      }

      if (data.maxSendable !== undefined && amountMsats > data.maxSendable) {
        return {
          recipient,
          valid: false,
          error: {
            code: ERROR_CODES.AMOUNT_ABOVE_MAX,
            message: `Amount ${recipient.amountSats} sats above maximum ${Math.floor(data.maxSendable / 1000)} sats`,
          },
        }
      }
    }

    return {
      recipient,
      valid: true,
      lnurlData: {
        callback: data.callback!,
        minSendable: data.minSendable!,
        maxSendable: data.maxSendable!,
        metadata: data.metadata,
        tag: data.tag,
      },
    }
  } catch (err: unknown) {
    return {
      recipient,
      valid: false,
      error: {
        code: ERROR_CODES.LNURL_UNREACHABLE,
        message: `Failed to validate LNURL: ${(err as Error).message}`,
      },
    }
  }
}

/**
 * Decode bech32 LNURL to URL
 * @param {string} lnurl - LNURL string
 * @returns {string} Decoded URL
 */
export function decodeLnurl(lnurl: string): string {
  // Simple bech32 decode (basic implementation)
  const ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

  const normalized = lnurl.toLowerCase()
  if (!normalized.startsWith("lnurl")) {
    throw new Error("Not a valid LNURL")
  }

  const data = normalized.slice(normalized.indexOf("1") + 1)
  const decoded: number[] = []

  for (let i = 0; i < data.length - 6; i++) {
    // -6 for checksum
    const idx = ALPHABET.indexOf(data[i])
    if (idx === -1) throw new Error("Invalid character in LNURL")
    decoded.push(idx)
  }

  // Convert 5-bit groups to 8-bit bytes
  let bits = 0
  let value = 0
  const bytes: number[] = []

  for (const d of decoded) {
    value = (value << 5) | d
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
    }
  }

  // Convert bytes to string
  const url = String.fromCharCode(...bytes)

  if (!url.startsWith("http")) {
    throw new Error("Decoded LNURL is not a valid URL")
  }

  return url
}

/**
 * Validate a single recipient
 * @param {ParsedRecipient} recipient - Parsed recipient object
 * @returns {Promise<ValidationResult>} Validation result
 */
export async function validateRecipient(
  recipient: ParsedRecipient,
): Promise<ValidationResult> {
  switch (recipient.type) {
    case RECIPIENT_TYPES.BLINK:
      return validateBlinkUser(recipient)
    case RECIPIENT_TYPES.LN_ADDRESS:
      return validateLnAddress(recipient)
    case RECIPIENT_TYPES.LNURL:
      return validateLnurl(recipient)
    default:
      return {
        recipient,
        valid: false,
        error: {
          code: ERROR_CODES.INVALID_FORMAT,
          message: `Unknown recipient type: ${recipient.type}`,
        },
      }
  }
}

/**
 * Validate all recipients with throttling
 * @param {ParsedRecipient[]} recipients - Array of parsed recipients
 * @param {ValidationOptions} options - Validation options
 * @returns {Promise<AllValidationResults>} Validation results
 */
export async function validateAllRecipients(
  recipients: ParsedRecipient[],
  options: ValidationOptions = {},
): Promise<AllValidationResults> {
  const { concurrency = 10, delayMs = 100, onProgress = () => {} } = options

  const results: ValidationResult[] = []
  let completed = 0

  // Process in batches
  for (let i = 0; i < recipients.length; i += concurrency) {
    const batch = recipients.slice(i, i + concurrency)

    const batchResults = await Promise.allSettled(batch.map((r) => validateRecipient(r)))

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j]
      if (result.status === "fulfilled") {
        results.push(result.value)
      } else {
        results.push({
          recipient: batch[j],
          valid: false,
          error: {
            code: ERROR_CODES.NETWORK_ERROR,
            message: (result.reason as Error)?.message || "Validation failed",
          },
        })
      }
      completed++
    }

    // Progress callback
    onProgress({
      completed,
      total: recipients.length,
      percent: Math.round((completed / recipients.length) * 100),
    })

    // Rate limiting delay between batches
    if (i + concurrency < recipients.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    }
  }

  // Generate summary
  const valid = results.filter((r) => r.valid)
  const invalid = results.filter((r) => !r.valid)

  const errorGroups: Record<string, ValidationResult[]> = {}
  for (const r of invalid) {
    const code = r.error?.code || "UNKNOWN"
    if (!errorGroups[code]) {
      errorGroups[code] = []
    }
    errorGroups[code].push(r)
  }

  return {
    results,
    summary: {
      total: results.length,
      valid: valid.length,
      invalid: invalid.length,
      byType: {
        [RECIPIENT_TYPES.BLINK]: valid.filter(
          (r) => r.recipient.type === RECIPIENT_TYPES.BLINK,
        ).length,
        [RECIPIENT_TYPES.LN_ADDRESS]: valid.filter(
          (r) => r.recipient.type === RECIPIENT_TYPES.LN_ADDRESS,
        ).length,
        [RECIPIENT_TYPES.LNURL]: valid.filter(
          (r) => r.recipient.type === RECIPIENT_TYPES.LNURL,
        ).length,
      },
      errorGroups,
    },
  }
}

export { getBlinkDomains }
