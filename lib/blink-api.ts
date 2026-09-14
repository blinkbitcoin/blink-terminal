// Import centralized API configuration
import { SpanStatusCode } from "@opentelemetry/api"

import { getApiUrl } from "./config/api"
import { getTracer, injectTraceHeaders } from "./tracing"

const tracer = getTracer("bbt-blink-api")

// =============================================================================
// Interfaces
// =============================================================================

/**
 * GraphQL response data record.
 * Uses `any` because GraphQL responses are dynamically shaped and
 * require deep chained property access (e.g. data.me.defaultAccount.wallets)
 * that TypeScript's recursive union types cannot resolve.
 * Fully typing these would require GraphQL code generation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GraphQLData = Record<string, any>

interface GraphQLResponse {
  data?: GraphQLData
  errors?: Array<{ message: string; [key: string]: unknown }>
}

/** Typed response for realtimePrice query */
interface RealtimePriceResponse {
  data?: {
    realtimePrice?: {
      btcSatPrice?: {
        base: number
        offset: number
      }
    }
  }
  errors?: Array<{ message: string; [key: string]: unknown }>
}

/** Typed response for accountDefaultWallet query */
interface AccountDefaultWalletResponse {
  data?: {
    accountDefaultWallet?: {
      id: string
      currency: string
    }
  }
  errors?: Array<{ message: string; [key: string]: unknown }>
}

/** Typed response for lnInvoiceCreateOnBehalfOfRecipient mutation */
interface InvoiceOnBehalfResponse {
  data?: {
    lnInvoiceCreateOnBehalfOfRecipient: {
      invoice: Invoice
    }
  }
  errors?: Array<{ message: string; [key: string]: unknown }>
}

interface ExchangeRate {
  satPriceInCurrency: number
  currency?: string
}

interface Wallet {
  id: string
  walletCurrency: string
  balance: number
}

interface Invoice {
  paymentRequest: string
  paymentHash: string
  paymentSecret?: string
  satoshis: number
}

interface PaymentResult {
  status: string
  errors?: Array<{ message: string; code?: string; path?: string[] }>
}

interface WalletInfo {
  id: string
  currency: string
}

interface Transaction {
  settlementAmount: number
  direction: string
  settlementCurrency: string
}

// =============================================================================
// Helper
// =============================================================================

// Note: We use a try/catch wrapper for compatibility with both client and server
const getApiUrlFromConfig = (): string => {
  try {
    // Try to use the centralized config
    return getApiUrl()
  } catch (_e: unknown) {
    // Fallback if config not available (e.g., during SSR build)
    return process.env.BLINK_API_URL || "https://api.blink.sv/graphql"
  }
}

// =============================================================================
// BlinkAPI Class
// =============================================================================

class BlinkAPI {
  apiKey: string
  baseUrl: string

  /**
   * Create a BlinkAPI instance
   * @param {string} apiKey - Blink API key
   * @param {string|null} apiUrl - Optional API URL override (for environment switching on server-side)
   */
  constructor(apiKey: string, apiUrl: string | null = null) {
    this.apiKey = apiKey
    this.baseUrl = apiUrl || getApiUrlFromConfig()
  }

  // Make GraphQL request to Blink API
  async query(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<GraphQLData> {
    // Extract operation name from "query Foo" or "mutation Foo" for span naming
    const operationName = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] || "anonymous"
    const operationType = query.trimStart().startsWith("mutation") ? "mutation" : "query"

    return tracer.startActiveSpan(`blink.graphql ${operationName}`, async (span) => {
      span.setAttribute("graphql.operation.name", operationName)
      span.setAttribute("graphql.operation.type", operationType)
      span.setAttribute("http.url", this.baseUrl)
      span.setAttribute("http.method", "POST")

      try {
        // Build headers with W3C trace context injection
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-API-KEY": this.apiKey,
        }
        injectTraceHeaders(headers)

        const response = await fetch(this.baseUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables }),
        })

        span.setAttribute("http.status_code", response.status)

        // Check if response is OK before parsing JSON
        if (!response.ok) {
          const contentType = response.headers.get("content-type")
          let errorMessage = `Blink API HTTP error: ${response.status}`

          // Try to get error details if it's JSON
          if (contentType && contentType.includes("application/json")) {
            try {
              const errorData = await response.json()
              errorMessage = errorData.message || errorData.error || errorMessage
            } catch (_e: unknown) {
              // Failed to parse error as JSON, use default message
            }
          } else {
            // Response is not JSON (likely HTML error page)
            const text = await response.text()
            console.error("Blink API non-JSON response:", text.substring(0, 200))
            errorMessage = `Blink API returned non-JSON response (${response.status})`
          }

          throw new Error(errorMessage)
        }

        const data: GraphQLResponse = await response.json()

        if (data.errors) {
          throw new Error(data.errors[0]?.message || "GraphQL error")
        }

        if (!data.data) {
          throw new Error("GraphQL response contained no data")
        }

        span.setStatus({ code: SpanStatusCode.OK })
        return data.data
      } catch (error: unknown) {
        console.error("Blink API error:", error)
        span.setStatus({ code: SpanStatusCode.ERROR })
        if (error instanceof Error) {
          span.recordException(error)
        }
        throw error
      } finally {
        span.end()
      }
    })
  }

  // Get user information including display currency
  async getMe(): Promise<GraphQLData | undefined> {
    const query = `
      query Me {
        me {
          username
          defaultAccount {
            displayCurrency
          }
        }
      }
    `

    const data = await this.query(query)
    return data?.me
  }

  // Get exchange rate for a currency
  async getExchangeRate(currency: string): Promise<ExchangeRate> {
    if (currency === "BTC") {
      return { satPriceInCurrency: 1 } // 1 sat = 1 sat
    }

    const query = `
      query realtimePrice($currency: DisplayCurrency!) {
        realtimePrice(currency: $currency) {
          btcSatPrice {
            base
            offset
          }
        }
      }
    `

    const variables = {
      currency: currency.toUpperCase(),
    }

    const data = await this.query(query, variables)

    if (!data.realtimePrice || !data.realtimePrice.btcSatPrice) {
      throw new Error(`Exchange rate not available for ${currency}`)
    }

    const btcSatPrice = data.realtimePrice.btcSatPrice
    // Calculate price of 1 sat in the queried currency
    const satPriceInCurrency: number = btcSatPrice.base / Math.pow(10, btcSatPrice.offset)

    return {
      satPriceInCurrency: satPriceInCurrency,
      currency: currency.toUpperCase(),
    }
  }

  // Convert fiat currency amount to satoshis
  convertToSatoshis(
    amount: number,
    currency: string,
    exchangeRate: ExchangeRate | null,
    fractionDigits: number = 2,
  ): number {
    if (currency === "BTC") {
      return Math.round(amount) // Already in sats
    }

    if (!exchangeRate || !exchangeRate.satPriceInCurrency) {
      throw new Error(`Exchange rate not available for ${currency}`)
    }

    // Use currency's fractionDigits (0 for KRW/JPY, 2 for USD/EUR, etc.)
    const amountInMinorUnits: number = amount * Math.pow(10, fractionDigits)
    const satsAmount: number = Math.round(
      amountInMinorUnits / exchangeRate.satPriceInCurrency,
    )

    return satsAmount
  }

  // Get wallet balances
  async getBalance(): Promise<Wallet[]> {
    const query = `
      query {
        me {
          defaultAccount {
            wallets {
              id
              walletCurrency
              balance
            }
          }
        }
      }
    `

    const data = await this.query(query)
    return data.me?.defaultAccount?.wallets || []
  }

  // Get transaction history with all fields for CSV export
  async getTransactions(
    first: number = 100,
    after: string | null = null,
  ): Promise<GraphQLData> {
    const query = `
      query TransactionsList($first: Int!, $after: String) {
        me {
          defaultAccount {
            id
            transactions(first: $first, after: $after) {
              edges {
                cursor
                node {
                  id
                  direction
                  status
                  settlementAmount
                  settlementFee
                  settlementCurrency
                  settlementDisplayAmount
                  settlementDisplayCurrency
                  settlementDisplayFee
                  createdAt
                  memo
                  initiationVia {
                    __typename
                    ... on InitiationViaLn {
                      paymentHash
                    }
                    ... on InitiationViaOnChain {
                      address
                    }
                    ... on InitiationViaIntraLedger {
                      counterPartyUsername
                      counterPartyWalletId
                    }
                  }
                  settlementVia {
                    __typename
                    ... on SettlementViaLn {
                      preImage
                    }
                    ... on SettlementViaOnChain {
                      transactionHash
                      vout
                    }
                    ... on SettlementViaIntraLedger {
                      counterPartyUsername
                      counterPartyWalletId
                      preImage
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `

    const data = await this.query(query, { first, after })
    const transactions = data.me?.defaultAccount?.transactions || {
      edges: [],
      pageInfo: {},
    }

    // Add walletId to each transaction for CSV export
    const walletId: string | undefined = data.me?.defaultAccount?.id
    if (walletId && transactions.edges) {
      transactions.edges = transactions.edges.map(
        (edge: { cursor: string; node: Record<string, unknown> }) => ({
          ...edge,
          node: {
            ...edge.node,
            walletId,
          },
        }),
      )
    }

    return transactions
  }

  // Get user info
  async getUserInfo(): Promise<GraphQLData> {
    const query = `
      query {
        me {
          id
          username
          defaultAccount {
            id
          }
        }
      }
    `

    return this.query(query)
  }

  // Get CSV export from Blink (official backend-generated CSV with all fields)
  async getCsvTransactions(walletIds: string[]): Promise<string> {
    const query = `
      query ExportCsv($walletIds: [WalletId!]!) {
        me {
          id
          defaultAccount {
            id
            csvTransactions(walletIds: $walletIds)
          }
        }
      }
    `

    const data = await this.query(query, { walletIds })
    return data.me?.defaultAccount?.csvTransactions
  }

  // Create Lightning invoice for BTC payments
  async createLnInvoice(
    walletId: string,
    amount: number,
    memo: string = "",
  ): Promise<Invoice> {
    const query = `
      mutation LnInvoiceCreate($input: LnInvoiceCreateInput!) {
        lnInvoiceCreate(input: $input) {
          invoice {
            paymentRequest
            paymentHash
            paymentSecret
            satoshis
          }
          errors {
            message
          }
        }
      }
    `

    const variables = {
      input: {
        walletId,
        amount,
        memo,
      },
    }

    const data = await this.query(query, variables)

    if (data.lnInvoiceCreate?.errors?.length > 0) {
      throw new Error(data.lnInvoiceCreate.errors[0].message)
    }

    return data.lnInvoiceCreate?.invoice
  }

  // Create Lightning invoice for USD payments
  async createLnUsdInvoice(
    walletId: string,
    amount: number,
    memo: string = "",
  ): Promise<Invoice> {
    const query = `
      mutation LnUsdInvoiceCreate($input: LnUsdInvoiceCreateInput!) {
        lnUsdInvoiceCreate(input: $input) {
          invoice {
            paymentRequest
            paymentHash
            paymentSecret
            satoshis
          }
          errors {
            message
          }
        }
      }
    `

    const variables = {
      input: {
        walletId,
        amount,
        memo,
      },
    }

    const data = await this.query(query, variables)

    if (data.lnUsdInvoiceCreate?.errors?.length > 0) {
      throw new Error(data.lnUsdInvoiceCreate.errors[0].message)
    }

    return data.lnUsdInvoiceCreate?.invoice
  }

  // Get wallet IDs and currencies
  async getWalletInfo(): Promise<Wallet[]> {
    const query = `
      query {
        me {
          defaultAccount {
            wallets {
              id
              walletCurrency
              balance
            }
          }
        }
      }
    `

    const data = await this.query(query)
    return data.me?.defaultAccount?.wallets || []
  }

  // Format amount for display
  static formatAmount(amount: number, currency: string): string {
    if (currency === "BTC") {
      // Amount is already in sats from Blink API
      return `${Math.round(amount).toLocaleString()} sats`
    }

    if (currency === "USD") {
      // Amount is in cents, convert to dollars
      const dollars: number = amount / 100
      return `${dollars.toFixed(2)} USD`
    }

    return `${amount.toLocaleString()} ${currency}`
  }

  // Intra-ledger payment (internal transfer between Blink wallets)
  // Used for transferring funds between BTC and USD wallets within the same account
  // When sending from BTC wallet to USD wallet, Blink automatically converts at current rate
  async intraLedgerPaymentSend(
    senderWalletId: string,
    recipientWalletId: string,
    amountSats: number,
    memo: string = "",
  ): Promise<PaymentResult> {
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
        ...(memo && { memo }),
      },
    }

    const data = await this.query(mutation, variables)

    if (data.intraLedgerPaymentSend?.errors?.length > 0) {
      throw new Error(data.intraLedgerPaymentSend.errors[0].message)
    }

    return data.intraLedgerPaymentSend
  }

  // Pay a Lightning invoice (for payment forwarding)
  // memo: Optional memo to associate with the payment (shows in receiver's transaction history for intra-ledger)
  async payLnInvoice(
    walletId: string,
    paymentRequest: string,
    memo: string = "",
  ): Promise<PaymentResult> {
    const query = `
      mutation LnInvoicePaymentSend($input: LnInvoicePaymentInput!) {
        lnInvoicePaymentSend(input: $input) {
          status
          errors {
            message
            path
            code
          }
        }
      }
    `

    const variables = {
      input: {
        walletId,
        paymentRequest,
        ...(memo && { memo }), // Only include memo if provided
      },
    }

    const data = await this.query(query, variables)

    if (data.lnInvoicePaymentSend?.errors?.length > 0) {
      throw new Error(data.lnInvoicePaymentSend.errors[0].message)
    }

    return data.lnInvoicePaymentSend
  }

  // Send payment to Lightning Address (for tips)
  // NOTE: Currently commented out as LN Address payments don't support custom memos
  // May be used later for external Lightning addresses
  /*
  async payLnAddress(walletId, lnAddress, amount, memo = '') {
    
    const query = `
      mutation LnAddressPaymentSend($input: LnAddressPaymentSendInput!) {
        lnAddressPaymentSend(input: $input) {
          status
          errors {
            code
            message
            path
          }
        }
      }
    `;

    // Note: Based on the provided schema, memo is not supported in LnAddressPaymentSend
    const variables = {
      input: {
        walletId,
        lnAddress,
        amount: amount.toString() // Convert to string as per schema
      }
    };

    try {
      const data = await this.query(query, variables);
      
      if (data.lnAddressPaymentSend?.errors?.length > 0) {
        console.error('❌ LN Address payment errors:', data.lnAddressPaymentSend.errors);
        throw new Error(`LN Address payment failed: ${data.lnAddressPaymentSend.errors[0].message} (Code: ${data.lnAddressPaymentSend.errors[0].code})`);
      }
      
      return data.lnAddressPaymentSend;
    } catch (error) {
      console.error('❌ LN Address payment failed:', error);
      throw error;
    }
  }
  */

  // Get exchange rate without authentication (uses mainnet public endpoint)
  // This is useful for public POS and other unauthenticated scenarios
  static async getExchangeRatePublic(
    currency: string,
  ): Promise<{ satPriceInCurrency: number; currency: string }> {
    if (currency === "BTC" || currency === "SAT") {
      return { satPriceInCurrency: 1, currency: "BTC" } // 1 sat = 1 sat
    }

    const query = `
      query realtimePrice($currency: DisplayCurrency!) {
        realtimePrice(currency: $currency) {
          btcSatPrice {
            base
            offset
          }
        }
      }
    `

    const variables = {
      currency: currency.toUpperCase(),
    }

    try {
      // Always use mainnet for public exchange rates (no auth required)
      const mainnetUrl = "https://api.blink.sv/graphql"

      const response = await fetch(mainnetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // No API key needed for public realtimePrice query
        },
        body: JSON.stringify({ query, variables }),
      })

      if (!response.ok) {
        const text = await response.text()
        console.error("Public exchange rate API error response:", text.substring(0, 200))
        throw new Error(`Failed to fetch public exchange rate: ${response.status}`)
      }

      const data: RealtimePriceResponse = await response.json()

      if (data.errors) {
        throw new Error(data.errors[0]?.message || "GraphQL error fetching exchange rate")
      }

      if (!data.data?.realtimePrice?.btcSatPrice) {
        throw new Error(`Exchange rate not available for ${currency}`)
      }

      const btcSatPrice = data.data.realtimePrice.btcSatPrice
      // Calculate price of 1 sat in the queried currency
      const satPriceInCurrency: number =
        btcSatPrice.base / Math.pow(10, btcSatPrice.offset)

      return {
        satPriceInCurrency: satPriceInCurrency,
        currency: currency.toUpperCase(),
      }
    } catch (error: unknown) {
      console.error("❌ Error getting public exchange rate:", currency, error)
      throw error
    }
  }

  // Get wallet information for a Blink username (unauthenticated call)
  // apiUrl: Optional API URL override (for environment switching)
  static async getWalletByUsername(
    username: string,
    apiUrl: string | null = null,
  ): Promise<WalletInfo> {
    const query = `
      query AccountDefaultWallet($username: Username!) {
        accountDefaultWallet(username: $username) {
          id
          currency
        }
      }
    `

    const variables = { username }
    const url: string = apiUrl || getApiUrlFromConfig()

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      })

      const data: AccountDefaultWalletResponse = await response.json()

      if (data.errors) {
        throw new Error(data.errors[0]?.message || "Error fetching wallet information")
      }

      return {
        id: data.data!.accountDefaultWallet!.id,
        currency: data.data!.accountDefaultWallet!.currency,
      }
    } catch (error: unknown) {
      console.error("❌ Error getting wallet for username:", username, error)
      throw error
    }
  }

  // Get BTC wallet for a username
  // Uses walletCurrency parameter to directly query for BTC wallet,
  // even if user's default wallet is USD
  // apiUrl: Optional API URL override (for environment switching)
  static async getBtcWalletByUsername(
    username: string,
    apiUrl: string | null = null,
  ): Promise<WalletInfo> {
    const query = `
      query AccountDefaultWallet($username: Username!, $walletCurrency: WalletCurrency) {
        accountDefaultWallet(username: $username, walletCurrency: $walletCurrency) {
          id
          currency
        }
      }
    `

    const variables = {
      username,
      walletCurrency: "BTC", // Explicitly request BTC wallet
    }
    const url: string = apiUrl || getApiUrlFromConfig()

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      })

      const data: AccountDefaultWalletResponse = await response.json()

      if (data.errors) {
        throw new Error(data.errors[0]?.message || "Error fetching wallet information")
      }

      const btcWallet = data.data!.accountDefaultWallet
      if (!btcWallet?.id) {
        throw new Error(
          `No BTC wallet found for username: ${username}. User may not have a BTC wallet set up.`,
        )
      }

      if (btcWallet.currency !== "BTC") {
        throw new Error(
          `Expected BTC wallet but got ${btcWallet.currency} wallet for username: ${username}`,
        )
      }

      return {
        id: btcWallet.id,
        currency: btcWallet.currency,
      }
    } catch (error: unknown) {
      console.error("❌ Error getting BTC wallet for username:", username, error)
      throw error
    }
  }

  // Create invoice on behalf of recipient with custom memo (unauthenticated call)
  // apiUrl: Optional API URL override (for environment switching)
  static async createInvoiceOnBehalfOfRecipient(
    recipientWalletId: string,
    amount: number,
    memo: string,
    expiresInMinutes: number = 15,
    apiUrl: string | null = null,
  ): Promise<Invoice> {
    const mutation = `
      mutation LnInvoiceCreateOnBehalfOfRecipient($input: LnInvoiceCreateOnBehalfOfRecipientInput!) {
        lnInvoiceCreateOnBehalfOfRecipient(input: $input) {
          invoice {
            paymentRequest
            paymentHash
            satoshis
          }
        }
      }
    `

    const variables = {
      input: {
        recipientWalletId,
        amount: amount.toString(),
        memo,
        expiresIn: expiresInMinutes.toString(),
      },
    }
    const url: string = apiUrl || getApiUrlFromConfig()

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: mutation, variables }),
      })

      const data: InvoiceOnBehalfResponse = await response.json()

      if (data.errors) {
        throw new Error(
          data.errors[0]?.message || "Error creating invoice on behalf of recipient",
        )
      }

      return data.data!.lnInvoiceCreateOnBehalfOfRecipient.invoice
    } catch (error: unknown) {
      console.error("❌ Error creating invoice on behalf of recipient:", error)
      throw error
    }
  }

  // Send tip by creating invoice on behalf of recipient and paying it
  async sendTipViaInvoice(
    fromWalletId: string,
    recipientUsername: string,
    amount: number,
    memo: string,
  ): Promise<{ status: string; paymentHash: string; satoshis: number; memo: string }> {
    try {
      console.log("💡 Sending tip via invoice creation approach:", {
        fromWalletId,
        recipientUsername,
        amount,
        memo,
      })

      // Step 1: Get recipient's BTC wallet ID (required for BTC invoice creation)
      // This will throw an error if the user's default wallet is not BTC
      const recipientWallet: WalletInfo =
        await BlinkAPI.getBtcWalletByUsername(recipientUsername)
      if (!recipientWallet?.id) {
        throw new Error(`Could not find BTC wallet for username: ${recipientUsername}`)
      }

      console.log("📋 Recipient BTC wallet found:", recipientWallet)

      // Step 2: Create invoice on behalf of recipient with custom memo
      const invoice: Invoice = await BlinkAPI.createInvoiceOnBehalfOfRecipient(
        recipientWallet.id,
        amount,
        memo,
        15, // 15 minutes expiry
      )

      if (!invoice || !invoice.paymentHash) {
        throw new Error(
          `Failed to create invoice for ${recipientUsername}: invoice creation returned null or invalid response`,
        )
      }

      console.log("📄 Invoice created on behalf of recipient:", {
        paymentHash: invoice.paymentHash,
        satoshis: invoice.satoshis,
      })

      // Step 3: Pay the invoice from our wallet (pass memo for intra-ledger visibility)
      const paymentResult: PaymentResult = await this.payLnInvoice(
        fromWalletId,
        invoice.paymentRequest,
        memo,
      )

      console.log("💰 Invoice payment result:", paymentResult)

      return {
        status: "SUCCESS",
        paymentHash: invoice.paymentHash,
        satoshis: invoice.satoshis,
        memo,
      }
    } catch (error: unknown) {
      console.error("❌ Tip via invoice failed:", error)
      throw error
    }
  }

  // Format date for display
  static formatDate(dateString: string | number): string {
    try {
      let date: Date

      // Handle different date formats
      if (typeof dateString === "number") {
        // Unix timestamp (seconds)
        date = new Date(dateString * 1000)
      } else if (typeof dateString === "string") {
        // Check if it's an ISO date string first
        if (dateString.includes("T") || dateString.includes("-")) {
          // ISO date string format
          date = new Date(dateString)
        } else {
          // Check if it's a timestamp in milliseconds or seconds
          const numericValue: number = parseInt(dateString)
          if (!isNaN(numericValue)) {
            // If it's a very large number, it's likely milliseconds
            if (numericValue > 1000000000000) {
              date = new Date(numericValue)
            } else {
              // Otherwise it's likely seconds
              date = new Date(numericValue * 1000)
            }
          } else {
            // Regular date string
            date = new Date(dateString)
          }
        }
      } else {
        date = new Date(String(dateString))
      }

      // Validate the date
      if (isNaN(date.getTime())) {
        return String(dateString)
      }

      return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    } catch (error: unknown) {
      console.error("Date formatting error:", error, "Input:", dateString)
      return String(dateString)
    }
  }

  // Determine transaction amount with proper sign
  static getTransactionAmount(transaction: Transaction): string {
    const amount: number = Math.abs(transaction.settlementAmount)
    const sign: string = transaction.direction === "RECEIVE" ? "+" : "-"
    const formattedAmount: string = BlinkAPI.formatAmount(
      amount,
      transaction.settlementCurrency,
    )

    return `${sign}${formattedAmount}`
  }
}

export default BlinkAPI
export { BlinkAPI }
export type {
  GraphQLResponse,
  ExchangeRate,
  Wallet,
  Invoice,
  PaymentResult,
  WalletInfo,
  Transaction,
}
