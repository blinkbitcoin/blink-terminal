/** @jest-environment node */

/**
 * Bolt Card spend + top-up security:
 * - a verified tap creates ONE single-use, tap-bound k1 (atomic with the
 *   counter advance); the callback requires and consumes it, enforces the
 *   tap-time maximum, and pays at most once;
 * - balance is restored only when the payment definitely wasn't sent;
 * - top-ups are verified with Blink before crediting, claimed atomically,
 *   and USD top-ups are credited only after a successful transfer.
 */

import { encode as encodeInvoice, sign as signInvoice } from "bolt11"

jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: {
    verifySession: () => null,
    encryptApiKey: (k: string) => k,
    decryptApiKey: (k: string) => k,
  },
}))

// --- Store (proxy of jest.fns) ---------------------------------------------
const mockStoreFns: Record<string, jest.Mock> = {}
const mockStore = new Proxy(mockStoreFns, {
  get: (target, prop: string) => (target[prop] ??= jest.fn()),
}) as Record<string, jest.Mock>
jest.mock("../../lib/boltcard/store", () => {
  const actual = jest.requireActual("../../lib/boltcard/store")
  return {
    ...actual,
    __esModule: true,
    default: new Proxy({}, { get: (_t, prop: string) => mockStore[prop] }),
  }
})

// --- Blink API -------------------------------------------------------------------
const mockBlink = {
  getWalletInfo: jest.fn(),
  payLnInvoice: jest.fn(),
  intraLedgerPaymentSend: jest.fn(),
  getExchangeRatePublic: jest.fn(),
}
jest.mock("../../lib/blink-api", () => {
  class PaymentRejectedError extends Error {}
  class BlinkAuthError extends Error {}
  class BlinkAPI {
    static getExchangeRatePublic(...args: unknown[]) {
      return mockBlink.getExchangeRatePublic(...args)
    }
    getWalletInfo() {
      return mockBlink.getWalletInfo()
    }
    payLnInvoice(...args: unknown[]) {
      return mockBlink.payLnInvoice(...args)
    }
    intraLedgerPaymentSend(...args: unknown[]) {
      return mockBlink.intraLedgerPaymentSend(...args)
    }
  }
  return {
    __esModule: true,
    default: BlinkAPI,
    BlinkAPI,
    PaymentRejectedError,
    BlinkAuthError,
  }
})

const mockVerifyCardTap = jest.fn()
jest.mock("../../lib/boltcard/crypto", () => ({
  ...jest.requireActual("../../lib/boltcard/crypto"),
  verifyCardTap: (...args: unknown[]) => mockVerifyCardTap(...args),
}))

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_READ: {},
  RATE_LIMIT_WRITE: {},
}))

import { BlinkAuthError, PaymentRejectedError } from "../../lib/blink-api"
import { processTopUpPayment } from "../../lib/boltcard/lnurlp"
import {
  handleWithdrawCallback,
  handleWithdrawRequest,
  payCardInvoice,
  reconcilePendingWithdrawals,
} from "../../lib/boltcard/lnurlw"
import balanceHandler from "../../pages/api/boltcard/balance/[cardId]"
import callbackHandler from "../../pages/api/boltcard/lnurlw/[cardId]/callback"

const PRIVKEY = "e126f68f7eafcc8b74f54d269fe206be715000f94dac067d1c04a8ca3b2db734"
const invoice = (sats: number) =>
  signInvoice(
    encodeInvoice({
      satoshis: sats,
      timestamp: Math.floor(Date.now() / 1000),
      tags: [
        { tagName: "payment_hash", data: "00".repeat(32) },
        { tagName: "payment_secret", data: "11".repeat(32) },
        { tagName: "description", data: "t" },
        { tagName: "expire_time", data: 3600 },
      ],
    }),
    PRIVKEY,
  ).paymentRequest as string

const CARD_ID = "c".repeat(32)
const K1 = "f".repeat(64)
const card = (overrides: Record<string, unknown> = {}) => ({
  id: CARD_ID,
  cardUid: "04a39493cc8680",
  name: "Card",
  status: "ACTIVE",
  walletId: "wallet-btc",
  walletCurrency: "BTC",
  balance: 5000,
  maxTxAmount: null,
  dailyLimit: null,
  dailySpent: 0,
  lastCounter: 3,
  environment: "production",
  apiKey: "blink_key",
  k1: "11".repeat(16),
  k2: "22".repeat(16),
  ...overrides,
})

jest.spyOn(console, "log").mockImplementation(() => {})
jest.spyOn(console, "warn").mockImplementation(() => {})
jest.spyOn(console, "error").mockImplementation(() => {})

beforeEach(() => {
  for (const fn of Object.values(mockStoreFns)) fn.mockReset()
  mockStore.setTopUpReviewReason = jest.fn().mockResolvedValue(undefined)
  mockStore.recordPendingWithdrawal = jest.fn().mockResolvedValue(undefined)
  mockStore.getPendingWithdrawals = jest.fn().mockResolvedValue([])
  mockStore.resolvePendingWithdrawal = jest.fn().mockResolvedValue(true)
  for (const fn of Object.values(mockBlink)) fn.mockReset()
  mockVerifyCardTap.mockReset()
  mockStore.getCard = jest.fn().mockResolvedValue(card())
  mockBlink.getWalletInfo.mockResolvedValue([
    { id: "wallet-btc", walletCurrency: "BTC" },
    { id: "wallet-usd", walletCurrency: "USD" },
  ])
})

// ---------------------------------------------------------------------------
describe("tap -> single-use, tap-bound k1", () => {
  const tap = () =>
    handleWithdrawRequest(CARD_ID, "A".repeat(32), "B".repeat(16), "https://t/callback")

  it("a verified tap returns a random k1 from an atomic session start (never the cardId)", async () => {
    mockVerifyCardTap.mockReturnValue({ valid: true, counter: 4 })
    mockStore.startWithdrawSession = jest.fn().mockResolvedValue(K1)

    const res = await tap()

    expect(res.k1).toBe(K1)
    expect(res.k1).not.toBe(CARD_ID)
    expect(mockStore.startWithdrawSession).toHaveBeenCalledWith(CARD_ID, 4, 5000 * 1000)
    expect(mockStore.updateLastCounter).not.toHaveBeenCalled()
  })

  it("a replayed / concurrent tap gets no k1", async () => {
    mockVerifyCardTap.mockReturnValue({ valid: true, counter: 4 })
    mockStore.startWithdrawSession = jest.fn().mockResolvedValue(null)

    const res = await tap()

    expect(res.status).toBe("ERROR")
    expect(res.k1).toBeUndefined()
  })

  it("an invalid tap creates no session", async () => {
    mockVerifyCardTap.mockReturnValue({ valid: false, error: "bad cmac" })
    const res = await tap()
    expect(res.status).toBe("ERROR")
    expect(mockStore.startWithdrawSession).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
describe("callback: k1 required, single-use, capped", () => {
  const pay = jest.fn()

  beforeEach(() => {
    pay.mockReset()
    mockStore.incrementDailySpent = jest
      .fn()
      .mockResolvedValue({ success: true, balance: 4000 })
    mockStore.recordTransaction = jest.fn().mockResolvedValue(undefined)
    mockStore.rollbackSpend = jest.fn().mockResolvedValue(true)
  })

  it("no k1 -> refused, nothing consumed or paid", async () => {
    const res = await handleWithdrawCallback(CARD_ID, undefined, invoice(1000), pay)
    expect(res.status).toBe("ERROR")
    expect(mockStore.consumeWithdrawSession).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it("the cardId as k1 (old scheme) -> refused", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(null)
    const res = await handleWithdrawCallback(CARD_ID, CARD_ID, invoice(1000), pay)
    expect(res.status).toBe("ERROR")
    expect(pay).not.toHaveBeenCalled()
  })

  it("an invoice above the tap-time maximum -> refused", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(1000 * 1000)
    const res = await handleWithdrawCallback(CARD_ID, K1, invoice(1001), pay)
    expect(res.reason).toMatch(/exceeds/)
    expect(mockStore.incrementDailySpent).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it("pays once per k1: a replayed callback is refused", async () => {
    mockStore.consumeWithdrawSession = jest
      .fn()
      .mockResolvedValueOnce(5000 * 1000)
      .mockResolvedValueOnce(null)
    pay.mockResolvedValue({ success: true, paymentHash: "h" })

    expect((await handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)).status).toBe(
      "OK",
    )
    expect((await handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)).status).toBe(
      "ERROR",
    )
    expect(pay).toHaveBeenCalledTimes(1)
    expect(mockStore.consumeWithdrawSession).toHaveBeenCalledWith(K1, CARD_ID)
  })

  it("a PENDING payment returns OK only after the pending-withdrawal row persists", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(5000 * 1000)
    pay.mockResolvedValue({ success: true, status: "PENDING", paymentHash: "h" })
    const res = await handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)

    expect(res.status).toBe("OK")
    expect(mockStore.rollbackSpend).not.toHaveBeenCalled()
    expect(mockStore.recordPendingWithdrawal).toHaveBeenCalledWith(
      "h",
      CARD_ID,
      1000,
      4000,
    )
    expect(mockStore.recordTransaction).toHaveBeenCalledWith(
      CARD_ID,
      expect.objectContaining({
        description: "Card payment - in flight, pending reconciliation",
      }),
    )
  })

  it("a PENDING payment whose queue write fails returns ERROR (no silent unreconcilable OK)", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(5000 * 1000)
    pay.mockResolvedValue({ success: true, status: "PENDING", paymentHash: "h" })
    mockStore.recordPendingWithdrawal = jest.fn().mockRejectedValue(new Error("db down"))

    // The error propagates: OK is impossible without the persisted state
    // (the route maps it to a 500 ERROR).
    await expect(handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)).rejects.toThrow(
      "db down",
    )
  })

  it("an unknown-outcome payment is queued by its invoice payment hash", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(5000 * 1000)
    pay.mockResolvedValue({ success: false, definite: false, error: "socket hang up" })
    await handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)

    expect(mockStore.recordPendingWithdrawal).toHaveBeenCalledWith(
      "00".repeat(32),
      CARD_ID,
      1000,
      4000,
    )
  })

  it("a definite payment failure restores the balance", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(5000 * 1000)
    pay.mockResolvedValue({ success: false, definite: true, error: "no route" })
    await handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)
    expect(mockStore.rollbackSpend).toHaveBeenCalledWith(CARD_ID, 1000)
  })

  it("an unknown payment outcome keeps the deduction and records it for review", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(5000 * 1000)
    pay.mockResolvedValue({ success: false, definite: false, error: "socket hang up" })
    await handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)
    expect(mockStore.rollbackSpend).not.toHaveBeenCalled()
    expect(mockStore.recordTransaction).toHaveBeenCalledWith(
      CARD_ID,
      expect.objectContaining({ description: expect.stringMatching(/outcome unknown/) }),
    )
  })
})

// ---------------------------------------------------------------------------
describe("payCardInvoice: wallet by currency, outcome classification", () => {
  const run = (currency = "BTC") =>
    payCardInvoice(1000, invoice(1000), "blink_key", "production", currency)

  it("pays from the wallet of the card's currency", async () => {
    mockBlink.payLnInvoice.mockResolvedValue({ status: "SUCCESS" })
    await run("USD")
    expect(mockBlink.payLnInvoice).toHaveBeenCalledWith(
      "wallet-usd",
      expect.any(String),
      "Boltcard payment",
    )
  })

  it.each([
    ["SUCCESS", { success: true, status: "SUCCESS" }],
    ["PENDING", { success: true, status: "PENDING" }],
    ["FAILURE", { success: false, definite: true }],
    ["WEIRD", { success: false, definite: false }],
  ])("status %s", async (status, expected) => {
    mockBlink.payLnInvoice.mockResolvedValue({ status })
    expect(await run()).toMatchObject(expected)
  })

  it.each([
    ["PaymentRejectedError", () => new PaymentRejectedError("x"), true],
    ["BlinkAuthError", () => new BlinkAuthError("x"), true],
    ["a transport error", () => new Error("socket hang up"), false],
  ])("%s -> definite=%p", async (_name, makeError, definite) => {
    mockBlink.payLnInvoice.mockRejectedValue(makeError())
    expect(await run()).toMatchObject({ success: false, definite })
  })
})

// ---------------------------------------------------------------------------
describe("processTopUpPayment: verified, claimed once, USD only on transfer success", () => {
  const HASH = "ab".repeat(32)
  const receipt = (status: string, settlementAmount?: number) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            me: {
              defaultAccount: {
                walletById: {
                  transactionsByPaymentHash:
                    status === "NONE"
                      ? []
                      : [{ status, direction: "RECEIVE", settlementAmount }],
                },
              },
            },
          },
        }),
    }) as unknown as typeof fetch
  }

  beforeEach(() => {
    mockStore.getPendingTopUp = jest
      .fn()
      .mockResolvedValue({ cardId: CARD_ID, amount: 1000, currency: "BTC" })
    mockStore.markTopUpProcessed = jest.fn().mockResolvedValue(true)
    mockStore.unmarkTopUpProcessed = jest.fn().mockResolvedValue(true)
    mockStore.topUpCard = jest.fn().mockResolvedValue({ success: true, balance: 6000 })
  })

  it("not paid at Blink -> no claim, no credit", async () => {
    receipt("NONE")
    const res = await processTopUpPayment(HASH)
    expect(res.success).toBe(false)
    expect(mockStore.markTopUpProcessed).not.toHaveBeenCalled()
    expect(mockStore.topUpCard).not.toHaveBeenCalled()
  })

  it("received less than the top-up amount -> no credit", async () => {
    receipt("SUCCESS", 999)
    expect((await processTopUpPayment(HASH)).success).toBe(false)
    expect(mockStore.topUpCard).not.toHaveBeenCalled()
  })

  it("a lost claim (already processed concurrently) -> no second credit", async () => {
    receipt("SUCCESS", 1000)
    mockStore.markTopUpProcessed = jest.fn().mockResolvedValue(false)
    expect((await processTopUpPayment(HASH)).success).toBe(false)
    expect(mockStore.topUpCard).not.toHaveBeenCalled()
  })

  it("BTC: verified + claimed -> credited once", async () => {
    receipt("SUCCESS", 1000)
    expect((await processTopUpPayment(HASH)).success).toBe(true)
    expect(mockStore.topUpCard).toHaveBeenCalledTimes(1)
    expect(mockStore.topUpCard).toHaveBeenCalledWith(
      CARD_ID,
      1000,
      HASH,
      expect.any(String),
    )
  })

  it("BTC: a definite credit failure (zero rows) releases the claim for a retry", async () => {
    receipt("SUCCESS", 1000)
    mockStore.topUpCard = jest.fn().mockResolvedValue({
      success: false,
      error: "Card not found or not active",
    })
    await processTopUpPayment(HASH)
    expect(mockStore.unmarkTopUpProcessed).toHaveBeenCalledWith(HASH)
  })

  it("BTC: an ambiguous credit error (write may have committed) keeps the claim, flagged for review", async () => {
    receipt("SUCCESS", 1000)
    mockStore.topUpCard = jest.fn().mockRejectedValue(new Error("connection reset"))
    const res = await processTopUpPayment(HASH)
    expect(res.success).toBe(false)
    expect(mockStore.unmarkTopUpProcessed).not.toHaveBeenCalled()
    expect(mockStore.setTopUpReviewReason).toHaveBeenCalledWith(
      HASH,
      expect.stringContaining("Credit outcome unknown"),
    )
  })

  it("a receipt without a usable settlement amount fails closed", async () => {
    receipt("SUCCESS", undefined as unknown as number)
    const res = await processTopUpPayment(HASH)
    expect(res.success).toBe(false)
    expect(mockStore.markTopUpProcessed).not.toHaveBeenCalled()
    expect(mockStore.topUpCard).not.toHaveBeenCalled()
  })

  it("activates a PENDING card BEFORE claiming or transferring", async () => {
    receipt("SUCCESS", 1000)
    const order: string[] = []
    mockStore.getCard = jest
      .fn()
      .mockResolvedValue(
        card({ status: "PENDING", walletCurrency: "USD", walletId: "wallet-usd" }),
      )
    mockStore.getPendingTopUp = jest
      .fn()
      .mockResolvedValue({ cardId: CARD_ID, amount: 1000, currency: "USD" })
    mockStore.activateCard = jest.fn().mockImplementation(async () => {
      order.push("activate")
      return true
    })
    mockStore.markTopUpProcessed = jest.fn().mockImplementation(async () => {
      order.push("claim")
      return true
    })
    mockBlink.intraLedgerPaymentSend = jest.fn().mockImplementation(async () => {
      order.push("transfer")
      return { status: "SUCCESS" }
    })
    mockBlink.getExchangeRatePublic.mockResolvedValue({ satPriceInCurrency: 0.07 })

    expect((await processTopUpPayment(HASH)).success).toBe(true)
    expect(order).toEqual(["activate", "claim", "transfer"])
  })

  it("a PENDING card whose activation fails: no claim, no transfer, retryable", async () => {
    receipt("SUCCESS", 1000)
    mockStore.getCard = jest.fn().mockResolvedValue(card({ status: "PENDING" }))
    mockStore.activateCard = jest.fn().mockResolvedValue(false)

    const res = await processTopUpPayment(HASH)

    expect(res.success).toBe(false)
    expect(mockStore.markTopUpProcessed).not.toHaveBeenCalled()
    expect(mockBlink.intraLedgerPaymentSend).not.toHaveBeenCalled()
    expect(mockStore.topUpCard).not.toHaveBeenCalled()
  })

  describe("USD card", () => {
    beforeEach(() => {
      mockStore.getCard = jest
        .fn()
        .mockResolvedValue(card({ walletCurrency: "USD", walletId: "wallet-usd" }))
      mockStore.getPendingTopUp = jest
        .fn()
        .mockResolvedValue({ cardId: CARD_ID, amount: 1000, currency: "USD" })
      mockBlink.getExchangeRatePublic.mockResolvedValue({ satPriceInCurrency: 0.07 })
      receipt("SUCCESS", 1000)
    })

    it.each([
      ["FAILED (terminal failure)", "FAILED", true],
      ["failed (lowercase)", "failed", true],
      ["PENDING (may still settle)", "PENDING", false],
      ["ALREADY_PAID (it moved)", "ALREADY_PAID", false],
      ["an unrecognized status", "WEIRD", false],
    ])("transfer %s -> released=%p", async (_name, status, released) => {
      mockBlink.intraLedgerPaymentSend.mockResolvedValue({ status })
      expect((await processTopUpPayment(HASH)).success).toBe(false)
      expect(mockStore.topUpCard).not.toHaveBeenCalled()
      if (released) {
        expect(mockStore.unmarkTopUpProcessed).toHaveBeenCalledWith(HASH)
      } else {
        expect(mockStore.unmarkTopUpProcessed).not.toHaveBeenCalled()
      }
    })

    it("transfer rejected by the API -> released, no credit", async () => {
      mockBlink.intraLedgerPaymentSend.mockRejectedValue(new PaymentRejectedError("x"))
      await processTopUpPayment(HASH)
      expect(mockStore.topUpCard).not.toHaveBeenCalled()
      expect(mockStore.unmarkTopUpProcessed).toHaveBeenCalledWith(HASH)
    })

    it("transfer outcome unknown -> claim kept and flagged for review", async () => {
      mockBlink.intraLedgerPaymentSend.mockRejectedValue(new Error("socket hang up"))
      await processTopUpPayment(HASH)
      expect(mockStore.topUpCard).not.toHaveBeenCalled()
      expect(mockStore.unmarkTopUpProcessed).not.toHaveBeenCalled()
      expect(mockStore.setTopUpReviewReason).toHaveBeenCalledWith(
        HASH,
        expect.stringContaining("outcome unknown"),
      )
    })

    it.each(["PENDING", "ALREADY_PAID", "WEIRD"])(
      "transfer %s flags the top-up for review",
      async (status) => {
        mockBlink.intraLedgerPaymentSend.mockResolvedValue({ status })
        await processTopUpPayment(HASH)
        expect(mockStore.setTopUpReviewReason).toHaveBeenCalledWith(
          HASH,
          expect.stringContaining(status),
        )
      },
    )

    it("transfer SUCCESS -> verified on the BTC wallet, credited in cents", async () => {
      mockBlink.intraLedgerPaymentSend.mockResolvedValue({ status: "SUCCESS" })
      expect((await processTopUpPayment(HASH)).success).toBe(true)
      expect(mockBlink.intraLedgerPaymentSend).toHaveBeenCalledWith(
        "wallet-btc",
        "wallet-usd",
        1000,
        expect.any(String),
      )
      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
      expect(body.variables.walletId).toBe("wallet-btc")
      expect(mockStore.topUpCard).toHaveBeenCalledWith(
        CARD_ID,
        70,
        HASH,
        expect.any(String),
      )
    })
  })
})

// ---------------------------------------------------------------------------
describe("reconcilePendingWithdrawals", () => {
  const blinkStatus = (transactions: Array<Record<string, string | number>>) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            me: {
              defaultAccount: {
                walletById: { transactionsByPaymentHash: transactions },
              },
            },
          },
        }),
    }) as unknown as typeof fetch
  }

  beforeEach(() => {
    mockStore.getPendingWithdrawals = jest
      .fn()
      .mockResolvedValue([
        { paymentHash: "h1", cardId: CARD_ID, amount: 1000, createdAt: 1 },
      ])
    mockStore.rollbackSpend = jest.fn().mockResolvedValue(true)
  })

  it("PAID -> resolved SUCCESS, deduction untouched", async () => {
    blinkStatus([{ status: "SUCCESS", direction: "RECEIVE", settlementAmount: 1000 }])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 1, restored: 0 })
    expect(mockStore.resolvePendingWithdrawal).toHaveBeenCalledWith("h1", "SUCCESS")
    expect(mockStore.rollbackSpend).not.toHaveBeenCalled()
  })

  it("EXPIRED -> deduction restored and resolved FAILED", async () => {
    blinkStatus([{ status: "FAILED", direction: "RECEIVE", settlementAmount: 1000 }])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 1, restored: 1 })
    expect(mockStore.rollbackSpend).toHaveBeenCalledWith(CARD_ID, 1000)
    expect(mockStore.resolvePendingWithdrawal).toHaveBeenCalledWith("h1", "FAILED")
  })

  it("still PENDING -> left for the next pass", async () => {
    blinkStatus([])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 0, restored: 0 })
    expect(mockStore.resolvePendingWithdrawal).not.toHaveBeenCalled()
  })

  it("a wiped card closes its pending withdrawal without restoring", async () => {
    mockStore.getCard = jest.fn().mockResolvedValue(card({ status: "WIPED" }))
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 1, restored: 0 })
    expect(mockStore.rollbackSpend).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
describe("routes", () => {
  const call = async (handler: unknown, req: Record<string, unknown>) => {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      setHeader: jest.fn(),
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(payload: unknown) {
        this.body = payload
        return this
      },
    }
    await (handler as (req: never, res: never) => Promise<unknown>)(
      { headers: { host: "t" }, query: {}, body: {}, ...req } as never,
      res as never,
    )
    return res
  }

  afterEach(() => {
    delete process.env.BOLTCARD_SPEND_ENABLED
  })

  it("callback forwards the k1 and refuses without one (spending enabled)", async () => {
    process.env.BOLTCARD_SPEND_ENABLED = "true"
    const res = await call(callbackHandler, {
      method: "GET",
      query: { cardId: CARD_ID, pr: invoice(1000) },
    })
    expect(res.statusCode).toBe(400)
    expect(mockStore.consumeWithdrawSession).not.toHaveBeenCalled()
  })

  it("balance: a replayed tap (counter not advanced) -> 409", async () => {
    mockVerifyCardTap.mockReturnValue({ valid: true, counter: 3 })
    mockStore.updateLastCounter = jest.fn().mockResolvedValue(false)
    const res = await call(balanceHandler, {
      method: "GET",
      query: { cardId: CARD_ID, p: "A".repeat(32), c: "B".repeat(16) },
    })
    expect(res.statusCode).toBe(409)
    expect(mockStore.getCardTransactions).not.toHaveBeenCalled()
  })
})
