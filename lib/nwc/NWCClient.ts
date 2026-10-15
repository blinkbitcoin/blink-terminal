/**
 * NWCClient - Nostr Wallet Connect client implementation
 *
 * Implements NIP-47 for communicating with lightning wallets over Nostr.
 * Supports: pay_invoice, get_balance, make_invoice, lookup_invoice
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/47.md
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import {
  nip04,
  nip19,
  finalizeEvent,
  getPublicKey,
  SimplePool,
  type Event as NostrEvent,
} from "nostr-tools"

import { isBlinkInvoice, getNonBlinkWalletError } from "../invoice-decoder"

import { createPinnedWebSocket } from "./pinned-socket"
import { assertNwcRelays, assertNwcRelayUrl, MAX_NWC_RELAYS } from "./relays"

/** Minimal type for the object returned by SimplePool.subscribe() */
interface PoolSubCloser {
  close: (reason?: string) => void
}

// =============================================================================
// Types
// =============================================================================

/**
 * @typedef {Object} NWCUri
 * @property {string} walletPubkey - The wallet service's public key (hex)
 * @property {string[]} relays - Array of relay URLs
 * @property {string} clientSecretHex - Client's private key (hex)
 * @property {string} clientPubkey - Client's public key (hex)
 */
export interface NWCUri {
  walletPubkey: string
  relays: string[]
  clientSecretHex: string
  clientPubkey: string
}

/**
 * @typedef {Object} NWCInfo
 * @property {string[]} methods - Supported NWC methods
 * @property {string[]} [notifications] - Supported notification types
 * @property {string[]} [encryption] - Supported encryption schemes
 */
export interface NWCInfo {
  methods: string[]
  notifications?: string[]
  encryption?: string[]
}

/**
 * @typedef {Object} NWCError
 * @property {string} code - Error code
 * @property {string} message - Error message
 */
export interface NWCError {
  code: string
  message: string
}

/**
 * @typedef {Object} NWCResponse
 * @property {string} result_type - The method this response is for
 * @property {T|null} result - The result data, or null if error
 * @property {NWCError|null} error - Error info, or null if success
 */
export interface NWCResponse<T = Record<string, unknown>> {
  result_type: string
  result: T | null
  error: NWCError | null
}

export interface PayInvoiceResult {
  preimage: string
  fees_paid?: number
}

export interface GetBalanceResult {
  balance: number
}

export interface MakeInvoiceParams {
  amount?: number
  description?: string
  description_hash?: string
  expiry?: number
}

export interface MakeInvoiceResult {
  invoice: string
  payment_hash: string
}

export interface ListTransactionsParams {
  from?: number
  until?: number
  limit?: number
  offset?: number
  unpaid?: boolean
  type?: "incoming" | "outgoing"
}

export interface NWCValidationResult {
  valid: boolean
  info?: NWCInfo
  blinkNodePubkey?: string
  error?: string
}

export interface BlinkValidationResult {
  valid: boolean
  nodePubkey?: string
  error?: string
}

interface NWCRequest {
  method: string
  params: Record<string, unknown>
}

// =============================================================================
// Class
// =============================================================================

class NWCClient {
  /** @type {NWCUri} */
  uri: NWCUri

  /** @type {SimplePool | null} */
  pool: SimplePool | null = null

  private poolReady: Promise<SimplePool> | null = null

  /**
   * Create an NWC client from a connection string
   * @param connectionString - nostr+walletconnect:// URI
   */
  constructor(connectionString: string) {
    this.uri = this.parseConnectionString(connectionString)
  }

  /**
   * Open the pool only after relays are pinned to a public lookup.
   * On the server, a missing pin means do not dial.
   */
  private ensurePool(): Promise<SimplePool> {
    if (!this.poolReady) {
      this.poolReady = this.openPool().catch((err: unknown) => {
        this.poolReady = null
        throw err
      })
    }
    return this.poolReady
  }

  private async openPool(): Promise<SimplePool> {
    if (typeof window === "undefined") {
      const Socket = await createPinnedWebSocket(this.uri.relays)
      if (typeof Socket !== "function") {
        throw new Error("Invalid NWC connection")
      }
      const pool = new SimplePool({
        websocketImplementation: Socket,
      } as ConstructorParameters<typeof SimplePool>[0])
      this.pool = pool
      return pool
    }

    await assertNwcRelays(this.uri.relays)
    const pool = new SimplePool()
    this.pool = pool
    return pool
  }

  /**
   * Get wallet service info (supported methods, notifications, etc.)
   * @returns Promise resolving to NWCInfo or null
   */
  async getInfo(): Promise<NWCInfo | null> {
    try {
      const pool = await this.ensurePool()
      console.log("[NWCClient] Getting wallet info...")
      const filter = {
        kinds: [13194],
        authors: [this.uri.walletPubkey],
      }

      // Add timeout
      const timeoutPromise = new Promise<null>((resolve) => {
        setTimeout(() => {
          console.log("[NWCClient] getInfo timed out after 10s")
          resolve(null)
        }, 10000)
      })

      const getPromise: Promise<NostrEvent | null> = pool.get(this.uri.relays, filter)
      const evt: NostrEvent | null = await Promise.race([getPromise, timeoutPromise])

      if (!evt) {
        console.log("[NWCClient] No info event found")
        return null
      }

      console.log("[NWCClient] Info event received:", evt.id?.slice(0, 8) + "...")

      const content: string = evt.content || ""
      const methods: string[] = content.trim() ? content.trim().split(/\s+/) : []
      const tags: string[][] = evt.tags || []

      console.log("[NWCClient] Raw content:", content)
      console.log("[NWCClient] Parsed methods:", methods)

      const notificationsTag: string[] | undefined = tags.find(
        (t) => t[0] === "notifications",
      )
      const encryptionTag: string[] | undefined = tags.find((t) => t[0] === "encryption")

      const notifications: string[] | undefined =
        notificationsTag && notificationsTag[1]
          ? notificationsTag[1].split(/\s+/)
          : undefined
      const encryption: string[] | undefined =
        encryptionTag && encryptionTag[1] ? encryptionTag[1].split(/\s+/) : undefined

      return { methods, notifications, encryption }
    } catch (err: unknown) {
      console.error("[NWCClient] Failed to get info:", err)
      return null
    }
  }

  /**
   * Validate an NWC connection string by fetching info
   * @param connectionString - nostr+walletconnect:// URI
   * @returns Promise resolving to validation result
   */
  static async validate(connectionString: string): Promise<NWCValidationResult> {
    try {
      console.log("[NWCClient] Validating connection string...")
      const client = new NWCClient(connectionString)
      console.log("[NWCClient] Fetching wallet info from relays:", client.uri.relays)
      const info: NWCInfo | null = await client.getInfo()

      console.log("[NWCClient] Wallet info received:", info)

      if (!info || !info.methods || info.methods.length === 0) {
        console.error("[NWCClient] No capabilities found")
        client.close()
        return { valid: false, error: "Could not fetch wallet capabilities" }
      }

      console.log("[NWCClient] Wallet capabilities:", info.methods)
      console.log("[NWCClient] Has make_invoice:", info.methods.includes("make_invoice"))

      // Require make_invoice for Blink validation
      if (!info.methods.includes("make_invoice")) {
        console.error(
          "[NWCClient] make_invoice not supported - cannot validate Blink wallet",
        )
        client.close()
        return {
          valid: false,
          error:
            "This wallet does not support invoice generation (make_invoice). Only Blink NWC wallets are supported.",
        }
      }

      // Validate that this is a Blink wallet by generating a test invoice
      console.log("[NWCClient] Validating Blink wallet by generating test invoice...")
      const blinkValidation: BlinkValidationResult = await client.validateBlinkWallet()

      if (!blinkValidation.valid) {
        console.error("[NWCClient] Blink validation failed:", blinkValidation.error)
        client.close()
        return { valid: false, error: blinkValidation.error }
      }

      console.log(
        "[NWCClient] Blink wallet validation successful! Node pubkey:",
        blinkValidation.nodePubkey,
      )

      client.close()
      return { valid: true, info, blinkNodePubkey: blinkValidation.nodePubkey }
    } catch (err: unknown) {
      console.error("[NWCClient] Validation error:", err)
      return {
        valid: false,
        error: (err as Error).message || "Invalid connection string",
      }
    }
  }

  /**
   * Validate that this NWC wallet is a Blink wallet
   * Generates a test invoice and checks the destination node pubkey
   * @returns Promise resolving to Blink validation result
   */
  async validateBlinkWallet(): Promise<BlinkValidationResult> {
    try {
      console.log("[NWCClient] Creating test invoice for Blink validation...")

      // Generate a minimal test invoice (1 sat, will expire quickly)
      const invoiceResult: NWCResponse<MakeInvoiceResult> = await this.makeInvoice({
        amount: 1000, // 1000 millisats = 1 sat
        description: "Blink wallet validation",
        expiry: 60, // 60 seconds expiry - minimal
      })

      if (invoiceResult.error) {
        console.error("[NWCClient] Failed to create test invoice:", invoiceResult.error)
        return {
          valid: false,
          error: `Failed to create test invoice: ${invoiceResult.error.message || "Unknown error"}`,
        }
      }

      const invoice: string | undefined = invoiceResult.result?.invoice
      if (!invoice) {
        console.error("[NWCClient] No invoice in response:", invoiceResult)
        return { valid: false, error: "Wallet did not return an invoice" }
      }

      console.log("[NWCClient] Test invoice created, checking destination node...")

      // Check if this invoice is destined for a Blink node
      const blinkCheck = isBlinkInvoice(invoice)

      if (blinkCheck.error) {
        console.error("[NWCClient] Failed to decode invoice:", blinkCheck.error)
        return { valid: false, error: `Failed to decode invoice: ${blinkCheck.error}` }
      }

      if (!blinkCheck.isBlink) {
        console.warn(
          "[NWCClient] Not a Blink wallet! Node pubkey:",
          blinkCheck.nodePubkey,
        )
        return {
          valid: false,
          error: getNonBlinkWalletError(),
          nodePubkey: blinkCheck.nodePubkey,
        }
      }

      console.log("[NWCClient] Confirmed Blink wallet, node:", blinkCheck.nodePubkey)
      return { valid: true, nodePubkey: blinkCheck.nodePubkey }
    } catch (err: unknown) {
      console.error("[NWCClient] Blink validation error:", err)
      return {
        valid: false,
        error: (err as Error).message || "Failed to validate Blink wallet",
      }
    }
  }

  /**
   * Pay a lightning invoice
   * @param invoice - BOLT11 invoice string
   * @returns Promise resolving to NWC response with pay invoice result
   */
  async payInvoice(invoice: string): Promise<NWCResponse<PayInvoiceResult>> {
    return this.sendRequest<PayInvoiceResult>({
      method: "pay_invoice",
      params: { invoice },
    })
  }

  /**
   * Get wallet balance
   * @returns Promise resolving to NWC response with balance result
   */
  async getBalance(): Promise<NWCResponse<GetBalanceResult>> {
    return this.sendRequest<GetBalanceResult>({
      method: "get_balance",
      params: {},
    })
  }

  /**
   * Create a lightning invoice
   * @param params - Invoice parameters
   * @param params.amount - Amount in millisats
   * @param params.description - Invoice description
   * @param params.description_hash - SHA256 hash of description
   * @param params.expiry - Expiry in seconds
   * @returns Promise resolving to NWC response with make invoice result
   */
  async makeInvoice(params: MakeInvoiceParams): Promise<NWCResponse<MakeInvoiceResult>> {
    return this.sendRequest<MakeInvoiceResult>({
      method: "make_invoice",
      params: params as unknown as Record<string, unknown>,
    })
  }

  /**
   * Look up an invoice by payment hash
   * @param paymentHash - Payment hash (hex)
   * @returns Promise resolving to NWC response
   */
  async lookupInvoice(paymentHash: string): Promise<NWCResponse> {
    return this.sendRequest({
      method: "lookup_invoice",
      params: { payment_hash: paymentHash },
    })
  }

  /**
   * List transactions
   * @param params - Transaction filter parameters
   * @param params.from - Start timestamp
   * @param params.until - End timestamp
   * @param params.limit - Max number of transactions
   * @param params.offset - Offset for pagination
   * @param params.unpaid - Include unpaid invoices
   * @param params.type - Filter by type ('incoming' or 'outgoing')
   * @returns Promise resolving to NWC response
   */
  async listTransactions(params: ListTransactionsParams = {}): Promise<NWCResponse> {
    return this.sendRequest({
      method: "list_transactions",
      params: params as unknown as Record<string, unknown>,
    })
  }

  /**
   * Send a request to the wallet service
   * @private
   * @param request - The NWC request to send
   * @param timeoutMs - Timeout in milliseconds (default 60000)
   * @returns Promise resolving to NWC response
   */
  private async sendRequest<T = Record<string, unknown>>(
    request: NWCRequest,
    timeoutMs: number = 60000,
  ): Promise<NWCResponse<T>> {
    const now: number = Math.floor(Date.now() / 1000)
    const contentJson: string = JSON.stringify(request)

    /** Helper to build a typed error response (result is always null for errors) */
    const errorResponse = (code: string, message: string): NWCResponse<T> => ({
      result_type: "error",
      result: null,
      error: { code, message },
    })

    console.log(
      "[NWCClient] Sending request:",
      request.method,
      "to relays:",
      this.uri.relays,
    )

    // Encrypt with NIP-04
    let ciphertext: string
    try {
      ciphertext = await nip04.encrypt(
        this.uri.clientSecretHex,
        this.uri.walletPubkey,
        contentJson,
      )
      console.log("[NWCClient] Message encrypted successfully")
    } catch (encryptError: unknown) {
      console.error("[NWCClient] Encryption failed:", encryptError)
      return errorResponse(
        "encryption_failed",
        encryptError instanceof Error
          ? encryptError.message
          : "Failed to encrypt request",
      )
    }

    // Build request event (kind 23194)
    const eventTemplate = {
      kind: 23194,
      created_at: now,
      content: ciphertext,
      tags: [
        ["p", this.uri.walletPubkey],
        ["encryption", "nip04"],
      ],
    }

    const skBytes: Uint8Array = hexToBytes(this.uri.clientSecretHex)
    const requestEvent = finalizeEvent(eventTemplate, skBytes)
    console.log("[NWCClient] Request event created:", requestEvent.id)

    // Publish only after the relay hosts are pinned to a public lookup.
    let pool: SimplePool
    try {
      pool = await this.ensurePool()
      console.log("[NWCClient] Publishing to relays:", this.uri.relays)
      await pool.publish(this.uri.relays, requestEvent)
      console.log("[NWCClient] Published successfully")
    } catch (err: unknown) {
      console.error("[NWCClient] Publish failed:", err)
      return errorResponse(
        "publish_failed",
        err instanceof Error ? err.message : "Failed to publish request",
      )
    }

    // Subscribe for response
    const filter = {
      "kinds": [23195],
      "authors": [this.uri.walletPubkey],
      "#p": [this.uri.clientPubkey],
      "#e": [requestEvent.id],
    }

    console.log("[NWCClient] Subscribing for response with filter:", {
      "kinds": filter.kinds,
      "authors": filter.authors.map((a: string) => a.slice(0, 8) + "..."),
      "#p": filter["#p"].map((p: string) => p.slice(0, 8) + "..."),
      "#e": filter["#e"].map((e: string) => e.slice(0, 8) + "..."),
    })

    return new Promise<NWCResponse<T>>((resolve) => {
      let sub: PoolSubCloser | null = null
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      let resolved = false

      const cleanup = (): void => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        if (sub && typeof sub.close === "function") {
          try {
            sub.close()
          } catch (_e: unknown) {
            // Ignore cleanup errors
          }
          sub = null
        }
      }

      try {
        // Use subscribe() like PubPay does - passing filter directly, not in array
        sub = pool.subscribe(this.uri.relays, filter, {
          onevent: async (evt: NostrEvent): Promise<void> => {
            console.log("[NWCClient] Received event:", evt.id.slice(0, 8) + "...")
            if (resolved) return
            try {
              const plaintext: string = await nip04.decrypt(
                this.uri.clientSecretHex,
                this.uri.walletPubkey,
                evt.content,
              )
              const parsed = JSON.parse(plaintext) as NWCResponse<T>
              console.log("[NWCClient] Decrypted response:", parsed.result_type)
              resolved = true
              cleanup()
              resolve(parsed)
            } catch (err: unknown) {
              console.error("[NWCClient] Failed to decrypt response:", err)
            }
          },
          oneose: (): void => {
            console.log("[NWCClient] End of stored events, waiting for new events...")
            // End of stored events - keep waiting for new events
          },
          onclose: (reasons: string[]): void => {
            console.log("[NWCClient] Subscription closed:", reasons)
            if (resolved) return
            resolved = true
            cleanup()
            resolve(
              errorResponse(
                "subscription_closed",
                "Subscription closed before receiving response",
              ),
            )
          },
        })

        console.log(
          "[NWCClient] Subscription created, waiting for response (timeout:",
          timeoutMs,
          "ms)",
        )

        // Set up timeout
        timeoutId = setTimeout(() => {
          if (resolved) return
          console.log("[NWCClient] Request timed out after", timeoutMs, "ms")
          resolved = true
          cleanup()
          resolve(
            errorResponse("timeout", "Request timed out waiting for wallet response"),
          )
        }, timeoutMs)
      } catch (err: unknown) {
        console.error("[NWCClient] Failed to create subscription:", err)
        resolved = true
        cleanup()
        resolve(
          errorResponse(
            "subscription_failed",
            err instanceof Error ? err.message : "Failed to set up subscription",
          ),
        )
      }
    })
  }

  /**
   * Parse NWC connection string into components
   * @private
   * @param connectionString - nostr+walletconnect:// or nostrnwc:// URI
   * @returns Parsed NWC URI components
   */
  private parseConnectionString(connectionString: string): NWCUri {
    // Support both URI schemes
    const normalized: string = connectionString
      .replace(/^nostr\+walletconnect:\/\//i, "https://")
      .replace(/^nostrnwc:\/\//i, "https://")

    const url = new URL(normalized)

    // Extract wallet pubkey (can be in hostname or path)
    const candidateFromHost: string = (url.hostname || "").trim()
    const candidateFromPath: string = (url.pathname || "").replace(/^\/+/, "").trim()
    const walletPubkey: string = candidateFromHost || candidateFromPath

    // Collect relays
    const relayParams: string[] = url.searchParams.getAll("relay")
    const relays: string[] = []
    for (const rp of relayParams) {
      const decoded: string = decodeURIComponent(rp)
      decoded
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean)
        .forEach((r: string) => relays.push(r))
    }

    // Get secret (can be hex or nsec)
    let secret: string = url.searchParams.get("secret") || ""
    secret = secret.trim()

    let clientSecretHex: string
    if (secret.startsWith("nsec")) {
      const decoded = nip19.decode(secret)
      clientSecretHex = bytesToHex(decoded.data as Uint8Array)
    } else {
      clientSecretHex = secret
    }

    if (
      !walletPubkey ||
      !clientSecretHex ||
      relays.length === 0 ||
      relays.length > MAX_NWC_RELAYS
    ) {
      throw new Error("Invalid NWC connection string: missing required fields")
    }
    for (const relay of relays) {
      assertNwcRelayUrl(relay)
    }

    const clientPubkey: string = getPublicKey(hexToBytes(clientSecretHex))

    return { walletPubkey, relays, clientSecretHex, clientPubkey }
  }

  /**
   * Get a display name for the wallet (truncated pubkey)
   * @returns Display name string
   */
  getDisplayName(): string {
    const pk: string = this.uri.walletPubkey
    return `${pk.slice(0, 8)}...${pk.slice(-8)}`
  }

  /**
   * Get the wallet's public key
   * @returns Wallet public key hex string
   */
  getWalletPubkey(): string {
    return this.uri.walletPubkey
  }

  /**
   * Get the relay URLs
   * @returns Copy of relay URL array
   */
  getRelays(): string[] {
    return [...this.uri.relays]
  }

  /**
   * Close the connection pool
   */
  close(): void {
    try {
      this.pool?.close(this.uri.relays)
    } catch (_e: unknown) {
      // Ignore
    }
    this.pool = null
    this.poolReady = null
  }
}

export default NWCClient
