/**
 * Unit Tests for lib/blink-api.js
 *
 * Tests the Blink API client class.
 */

import BlinkAPI, { BlinkAuthError, PaymentRejectedError } from "../../lib/blink-api"

describe("BlinkAPI", () => {
  let api: InstanceType<typeof BlinkAPI>

  beforeEach(() => {
    jest.resetAllMocks()
    api = new BlinkAPI("test-api-key")
  })

  describe("constructor", () => {
    it("should initialize with API key", () => {
      expect(api.apiKey).toBe("test-api-key")
    })

    it("should set baseUrl from config", () => {
      expect(api.baseUrl).toBeDefined()
      expect(api.baseUrl).toContain("blink.sv")
    })
  })

  describe("query()", () => {
    it("should make POST request with correct headers", async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({ data: { test: "value" } }),
        headers: new Map([["content-type", "application/json"]]),
      }
      global.fetch = jest.fn().mockResolvedValue(mockResponse)

      const result = await api.query("query { test }")

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": "test-api-key",
          },
          body: expect.stringContaining("query { test }"),
        }),
      )
      expect(result).toEqual({ test: "value" })
    })

    it("should pass variables in request body", async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({ data: {} }),
        headers: new Map([["content-type", "application/json"]]),
      }
      global.fetch = jest.fn().mockResolvedValue(mockResponse)

      await api.query("query Test($var: String!)", { var: "testValue" })

      const [, options] = (global.fetch as jest.Mock).mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body.variables).toEqual({ var: "testValue" })
    })

    it("should throw on HTTP error", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => "text/html" },
        text: jest.fn().mockResolvedValue("Server Error"),
      })

      await expect(api.query("query { test }")).rejects.toThrow("500")
    })

    it("should throw on GraphQL errors", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          errors: [{ message: "Invalid query" }],
        }),
        headers: { get: () => "application/json" },
      })

      await expect(api.query("query { test }")).rejects.toThrow("Invalid query")
    })
  })

  describe("getBalance()", () => {
    it("should return wallets array", async () => {
      const mockWallets = [
        { id: "wallet1", walletCurrency: "BTC", balance: 100000 },
        { id: "wallet2", walletCurrency: "USD", balance: 5000 },
      ]

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: {
            me: {
              defaultAccount: {
                wallets: mockWallets,
              },
            },
          },
        }),
        headers: { get: () => "application/json" },
      })

      const result = await api.getBalance()

      expect(result).toEqual(mockWallets)
      expect(result).toHaveLength(2)
    })

    it("should return empty array when no wallets", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: { me: null },
        }),
        headers: { get: () => "application/json" },
      })

      const result = await api.getBalance()
      expect(result).toEqual([])
    })
  })

  describe("getWalletInfo()", () => {
    it("should return wallet info", async () => {
      const mockWallets = [{ id: "btc-wallet", walletCurrency: "BTC", balance: 50000 }]

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: {
            me: {
              defaultAccount: {
                wallets: mockWallets,
              },
            },
          },
        }),
        headers: { get: () => "application/json" },
      })

      const result = await api.getWalletInfo()

      expect(result).toEqual(mockWallets)
    })
  })

  describe("createLnInvoice()", () => {
    it("should create Lightning invoice", async () => {
      const mockInvoice = {
        paymentRequest: "lnbc...",
        paymentHash: "abc123",
        paymentSecret: "secret",
        satoshis: 1000,
      }

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: {
            lnInvoiceCreate: {
              invoice: mockInvoice,
              errors: [],
            },
          },
        }),
        headers: { get: () => "application/json" },
      })

      const result = await api.createLnInvoice("wallet-id", 1000, "Test memo")

      expect(result).toEqual(mockInvoice)

      const [, options] = (global.fetch as jest.Mock).mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body.variables.input).toEqual({
        walletId: "wallet-id",
        amount: 1000,
        memo: "Test memo",
      })
    })

    it("should throw on invoice creation error", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: {
            lnInvoiceCreate: {
              invoice: null,
              errors: [{ message: "Insufficient balance" }],
            },
          },
        }),
        headers: { get: () => "application/json" },
      })

      await expect(api.createLnInvoice("wallet-id", 1000)).rejects.toThrow(
        "Insufficient balance",
      )
    })
  })

  describe("createLnUsdInvoice()", () => {
    it("should create USD Lightning invoice", async () => {
      const mockInvoice = {
        paymentRequest: "lnbc...",
        paymentHash: "abc123",
        satoshis: 1000,
      }

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: {
            lnUsdInvoiceCreate: {
              invoice: mockInvoice,
              errors: [],
            },
          },
        }),
        headers: { get: () => "application/json" },
      })

      const result = await api.createLnUsdInvoice("usd-wallet-id", 500, "USD payment")

      expect(result).toEqual(mockInvoice)
    })
  })

  describe("auth failures -> BlinkAuthError", () => {
    const respond = (status: number, body: unknown, contentType = "application/json") => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: jest.fn().mockResolvedValue(body),
        text: jest.fn().mockResolvedValue(String(body)),
        headers: { get: () => contentType },
      })
    }

    it.each([401, 403])("HTTP %i (invalid / revoked key)", async (status) => {
      respond(status, "<html>401 Authorization Required</html>", "text/html")
      await expect(api.query("query { me { id } }")).rejects.toBeInstanceOf(
        BlinkAuthError,
      )
    })

    it('GraphQL "Not authorized" (no key / insufficient scope)', async () => {
      respond(200, { data: { me: null }, errors: [{ message: "Not authorized" }] })
      await expect(api.query("query { me { id } }")).rejects.toBeInstanceOf(
        BlinkAuthError,
      )
    })

    it("GraphQL extensions.code UNAUTHENTICATED", async () => {
      respond(200, {
        errors: [{ message: "nope", extensions: { code: "UNAUTHENTICATED" } }],
      })
      await expect(api.query("query { me { id } }")).rejects.toBeInstanceOf(
        BlinkAuthError,
      )
    })

    it("a 401 on the payment mutation means nothing was executed", async () => {
      respond(401, "<html>401</html>", "text/html")
      await expect(api.payLnInvoice("wallet-id", "lnbc...")).rejects.toBeInstanceOf(
        BlinkAuthError,
      )
    })

    it.each([
      ["HTTP 500", () => respond(500, "Server Error", "text/html")],
      [
        "an ordinary GraphQL error",
        () => respond(200, { errors: [{ message: "Invalid wallet" }] }),
      ],
    ])("%s stays a plain Error", async (_name, arrange) => {
      arrange()
      const error = await api.query("query { me { id } }").catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(BlinkAuthError)
    })
  })

  describe("payLnInvoice()", () => {
    it("should pay Lightning invoice", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: {
            lnInvoicePaymentSend: {
              status: "SUCCESS",
              errors: [],
            },
          },
        }),
        headers: { get: () => "application/json" },
      })

      const result = await api.payLnInvoice("wallet-id", "lnbc...", "Payment memo")

      expect(result.status).toBe("SUCCESS")
    })

    it("should include memo in payment request", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: {
            lnInvoicePaymentSend: {
              status: "SUCCESS",
              errors: [],
            },
          },
        }),
        headers: { get: () => "application/json" },
      })

      await api.payLnInvoice("wallet-id", "lnbc...", "Test memo")

      const [, options] = (global.fetch as jest.Mock).mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body.variables.input.memo).toBe("Test memo")
    })

    it("should not include memo when empty", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: {
            lnInvoicePaymentSend: {
              status: "SUCCESS",
              errors: [],
            },
          },
        }),
        headers: { get: () => "application/json" },
      })

      await api.payLnInvoice("wallet-id", "lnbc...")

      const [, options] = (global.fetch as jest.Mock).mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body.variables.input.memo).toBeUndefined()
    })

    it("throws PaymentRejectedError (with code) when the mutation returns errors", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: {
            lnInvoicePaymentSend: {
              status: "FAILURE",
              errors: [
                {
                  message: "Insufficient balance",
                  code: "INSUFFICIENT_BALANCE",
                  path: [],
                },
              ],
            },
          },
        }),
        headers: { get: () => "application/json" },
      })

      const error = await api
        .payLnInvoice("wallet-id", "lnbc...")
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(PaymentRejectedError)
      expect(error).toBeInstanceOf(Error)
      expect((error as PaymentRejectedError).message).toBe("Insufficient balance")
      expect((error as PaymentRejectedError).code).toBe("INSUFFICIENT_BALANCE")
    })

    it("keeps transport failures as plain Errors (outcome unknown)", async () => {
      global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed"))

      const error = await api
        .payLnInvoice("wallet-id", "lnbc...")
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(PaymentRejectedError)
    })
  })

  describe("getExchangeRate()", () => {
    it("should return 1:1 rate for BTC", async () => {
      const result = await api.getExchangeRate("BTC")

      expect(result.satPriceInCurrency).toBe(1)
    })

    it("should calculate sat price for fiat currencies", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: {
            realtimePrice: {
              btcSatPrice: {
                base: 45,
                offset: 6, // 45 / 10^6 = 0.000045 USD per sat
              },
            },
          },
        }),
        headers: { get: () => "application/json" },
      })

      const result = await api.getExchangeRate("USD")

      expect(result.satPriceInCurrency).toBeCloseTo(0.000045)
      expect(result.currency).toBe("USD")
    })

    it("should throw when rate not available", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: { realtimePrice: null },
        }),
        headers: { get: () => "application/json" },
      })

      await expect(api.getExchangeRate("XYZ")).rejects.toThrow("not available")
    })
  })

  describe("convertToSatoshis()", () => {
    it("should return amount as-is for BTC", () => {
      const result = api.convertToSatoshis(1000, "BTC", null)
      expect(result).toBe(1000)
    })

    it("should convert fiat to sats", () => {
      const exchangeRate = { satPriceInCurrency: 0.0005 } // $0.0005 per sat = $50,000/BTC

      const result = api.convertToSatoshis(10, "USD", exchangeRate, 2)

      // $10 = 1000 cents, 1000 / 0.0005 = 2,000,000 sats
      expect(result).toBe(2000000)
    })

    it("should handle zero fraction digits (JPY, KRW)", () => {
      const exchangeRate = { satPriceInCurrency: 0.05 } // 0.05 JPY per sat

      const result = api.convertToSatoshis(1000, "JPY", exchangeRate, 0)

      // 1000 JPY / 0.05 = 20,000 sats
      expect(result).toBe(20000)
    })

    it("should throw when exchange rate not available", () => {
      expect(() => api.convertToSatoshis(10, "USD", null)).toThrow("not available")
    })
  })

  describe("static formatAmount()", () => {
    it("should format BTC amounts as sats", () => {
      expect(BlinkAPI.formatAmount(1000, "BTC")).toBe("1,000 sats")
      expect(BlinkAPI.formatAmount(1234567, "BTC")).toBe("1,234,567 sats")
    })

    it("should format USD amounts from cents to dollars", () => {
      expect(BlinkAPI.formatAmount(500, "USD")).toBe("5.00 USD")
      expect(BlinkAPI.formatAmount(12345, "USD")).toBe("123.45 USD")
    })

    it("should format other currencies with amount", () => {
      expect(BlinkAPI.formatAmount(100, "EUR")).toBe("100 EUR")
    })
  })

  describe("static formatDate()", () => {
    it("should format ISO date strings", () => {
      const result = BlinkAPI.formatDate("2024-01-15T10:30:00Z")
      expect(result).toContain("Jan")
      expect(result).toContain("2024")
    })

    it("should format Unix timestamps (seconds)", () => {
      const result = BlinkAPI.formatDate(1705313400) // Jan 15, 2024
      expect(result).toContain("Jan")
      expect(result).toContain("2024")
    })

    it("should format Unix timestamps (milliseconds)", () => {
      // Using a large number that's clearly milliseconds
      const result = BlinkAPI.formatDate("1705313400000") // As string
      expect(result).toContain("Jan")
      expect(result).toContain("2024")
    })

    it("should return original on invalid date", () => {
      const result = BlinkAPI.formatDate("invalid-date")
      expect(result).toBe("invalid-date")
    })
  })

  describe("static getTransactionAmount()", () => {
    it("should return positive amount for RECEIVE", () => {
      const tx = {
        direction: "RECEIVE",
        settlementAmount: 1000,
        settlementCurrency: "BTC",
      }

      const result = BlinkAPI.getTransactionAmount(tx)
      expect(result).toBe("+1,000 sats")
    })

    it("should return negative amount for SEND", () => {
      const tx = {
        direction: "SEND",
        settlementAmount: -1000,
        settlementCurrency: "BTC",
      }

      const result = BlinkAPI.getTransactionAmount(tx)
      expect(result).toBe("-1,000 sats")
    })
  })

  describe("static getExchangeRatePublic()", () => {
    it("should return 1:1 for BTC", async () => {
      const result = await BlinkAPI.getExchangeRatePublic("BTC")
      expect(result.satPriceInCurrency).toBe(1)
    })

    it("should return 1:1 for SAT", async () => {
      const result = await BlinkAPI.getExchangeRatePublic("SAT")
      expect(result.satPriceInCurrency).toBe(1)
    })

    it("should always use mainnet for public queries", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: {
            realtimePrice: {
              btcSatPrice: { base: 45, offset: 6 },
            },
          },
        }),
        headers: { get: () => "application/json" },
      })

      await BlinkAPI.getExchangeRatePublic("USD")

      const [url] = (global.fetch as jest.Mock).mock.calls[0]
      expect(url).toBe("https://api.blink.sv/graphql")
    })
  })
})
