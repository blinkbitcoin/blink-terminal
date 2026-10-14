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
import {
  checkAndProcessPendingTopUps,
  handleTopUpCallback,
  processTopUpPayment,
} from "../../lib/boltcard/lnurlp"
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
    mockStore.peekWithdrawSession = jest.fn().mockResolvedValue(5000 * 1000)
    mockStore.claimAndDeductWithdrawal = jest.fn().mockResolvedValue({
      status: "claimed",
      balance: 4000,
      dailySpent: 1000,
      dailyResetAt: null,
      attempt: 1,
    })
    mockStore.beginWithdrawalSend = jest.fn().mockResolvedValue(true)
    mockStore.finalizeWithdrawal = jest.fn().mockResolvedValue(undefined)
    mockStore.resolvePendingWithdrawalFailed = jest.fn().mockResolvedValue(true)
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

  it("an invoice above the tap-time maximum -> refused without consuming the tap", async () => {
    mockStore.peekWithdrawSession = jest.fn().mockResolvedValue(1000 * 1000)
    const res = await handleWithdrawCallback(CARD_ID, K1, invoice(1001), pay)
    expect(res.reason).toMatch(/exceeds/)
    expect(mockStore.consumeWithdrawSession).not.toHaveBeenCalled()
    expect(mockStore.claimAndDeductWithdrawal).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it("a non-whole-sat invoice is refused before the tap is consumed", async () => {
    const fractional = signInvoice(
      encodeInvoice({
        millisatoshis: "1500",
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

    const res = await handleWithdrawCallback(CARD_ID, K1, fractional, pay)

    expect(res.status).toBe("ERROR")
    expect(res.reason).toMatch(/whole number of sats/)
    expect(mockStore.consumeWithdrawSession).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it("an invoice with no payment hash is refused before the tap is consumed", async () => {
    const res = await handleWithdrawCallback(CARD_ID, K1, "lnbc1u1notaninvoice", pay)
    expect(res.reason).toMatch(/payment hash/)
    expect(mockStore.consumeWithdrawSession).not.toHaveBeenCalled()
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
    expect(mockStore.finalizeWithdrawal).toHaveBeenCalledWith(
      "00".repeat(32),
      "PENDING",
      1,
    )
    expect(mockStore.recordPendingWithdrawal).not.toHaveBeenCalled()
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
    mockStore.finalizeWithdrawal = jest.fn().mockRejectedValue(new Error("db down"))

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

    expect(mockStore.finalizeWithdrawal).toHaveBeenCalledWith(
      "00".repeat(32),
      "UNKNOWN",
      1,
    )
    expect(mockStore.recordPendingWithdrawal).not.toHaveBeenCalled()
  })

  it("a definite payment failure restores the balance", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(5000 * 1000)
    pay.mockResolvedValue({ success: false, definite: true, error: "no route" })
    await handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)
    expect(mockStore.resolvePendingWithdrawalFailed).toHaveBeenCalledWith(
      "00".repeat(32),
      1,
    )
    expect(mockStore.rollbackSpend).not.toHaveBeenCalled()
  })

  it("a successful payment resolves the claim so the hash stays spent", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(5000 * 1000)
    pay.mockResolvedValue({ success: true, status: "SUCCESS", paymentHash: "h" })

    const res = await handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)

    expect(res.status).toBe("OK")
    expect(mockStore.finalizeWithdrawal).toHaveBeenCalledWith(
      "00".repeat(32),
      "SUCCESS",
      1,
    )
  })

  it("reconciliation during pay cannot restore a claim already handed to Blink", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(5000 * 1000)
    let releasePay: (value: unknown) => void = () => undefined
    let payStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      payStarted = resolve
    })
    pay.mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePay = resolve
          payStarted()
        }),
    )

    const pending = handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)
    await started
    expect(mockStore.beginWithdrawalSend).toHaveBeenCalledWith("00".repeat(32), 1)

    // Stale snapshot still says CLAIMED and old. The compare-and-set loses
    // because the row is no longer CLAIMED.
    mockStore.getPendingWithdrawals = jest.fn().mockResolvedValue([
      {
        paymentHash: "00".repeat(32),
        cardId: CARD_ID,
        amount: 1000,
        createdAt: 1,
        kind: "CLAIMED",
        attempt: 1,
      },
    ])
    mockStore.resolvePendingWithdrawalFailed = jest.fn().mockResolvedValue(false)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            me: {
              defaultAccount: { walletById: { transactionsByPaymentHash: [] } },
            },
          },
        }),
    }) as unknown as typeof fetch

    const recon = await reconcilePendingWithdrawals(CARD_ID)
    expect(recon).toEqual({ checked: 1, resolved: 0, restored: 0 })
    expect(mockStore.resolvePendingWithdrawalFailed).toHaveBeenCalledWith(
      "00".repeat(32),
      1,
      expect.any(Number),
    )

    releasePay({ success: true, status: "SUCCESS", paymentHash: "h" })
    await expect(pending).resolves.toMatchObject({ status: "OK" })
    expect(mockStore.finalizeWithdrawal).toHaveBeenCalledWith(
      "00".repeat(32),
      "SUCCESS",
      1,
    )
    expect(mockStore.rollbackSpend).not.toHaveBeenCalled()
  })

  it("a claim resolved before pay is not paid", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(5000 * 1000)
    mockStore.beginWithdrawalSend = jest.fn().mockResolvedValue(false)

    const res = await handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)

    expect(res.status).toBe("ERROR")
    expect(pay).not.toHaveBeenCalled()
  })

  it("a spent invoice hash is refused without paying again", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(5000 * 1000)
    mockStore.claimAndDeductWithdrawal = jest.fn().mockResolvedValue({ status: "spent" })

    const res = await handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)

    expect(res.status).toBe("ERROR")
    expect(pay).not.toHaveBeenCalled()
    expect(mockStore.finalizeWithdrawal).not.toHaveBeenCalled()
  })

  it("a lost restore result is not queued for a second restore", async () => {
    mockStore.consumeWithdrawSession = jest.fn().mockResolvedValue(5000 * 1000)
    mockStore.resolvePendingWithdrawalFailed = jest
      .fn()
      .mockRejectedValue(new Error("db down"))
    pay.mockResolvedValue({ success: false, definite: true, error: "no route" })

    await expect(handleWithdrawCallback(CARD_ID, K1, invoice(1000), pay)).rejects.toThrow(
      "db down",
    )
    expect(mockStore.rollbackSpend).not.toHaveBeenCalled()
    expect(mockStore.recordPendingWithdrawal).not.toHaveBeenCalled()
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
    mockStore.hasTopUpTransaction = jest.fn().mockResolvedValue(true)
    expect((await processTopUpPayment(HASH)).success).toBe(false)
    expect(mockStore.topUpCard).not.toHaveBeenCalled()
    expect(mockStore.setTopUpReviewReason).not.toHaveBeenCalled()
  })

  it("a processed claim with no credit is flagged for review", async () => {
    receipt("SUCCESS", 1000)
    mockStore.markTopUpProcessed = jest.fn().mockResolvedValue(false)
    mockStore.hasTopUpTransaction = jest.fn().mockResolvedValue(false)
    expect((await processTopUpPayment(HASH)).success).toBe(false)
    expect(mockStore.topUpCard).not.toHaveBeenCalled()
    expect(mockStore.flagUncreditedTopUp).toHaveBeenCalledWith(HASH)
    expect(mockStore.setTopUpReviewReason).not.toHaveBeenCalled()
  })

  it("an ambiguous claim error is flagged, not treated as already processed", async () => {
    receipt("SUCCESS", 1000)
    mockStore.markTopUpProcessed = jest
      .fn()
      .mockRejectedValue(new Error("connection reset"))
    const res = await processTopUpPayment(HASH)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/claim outcome unknown/)
    expect(mockStore.topUpCard).not.toHaveBeenCalled()
    expect(mockStore.setTopUpReviewReason).toHaveBeenCalledWith(
      HASH,
      expect.stringContaining("connection reset"),
    )
  })

  it("a failed review flag propagates (not swallowed)", async () => {
    receipt("SUCCESS", 1000)
    mockStore.markTopUpProcessed = jest
      .fn()
      .mockRejectedValue(new Error("connection reset"))
    mockStore.setTopUpReviewReason = jest.fn().mockRejectedValue(new Error("review down"))
    await expect(processTopUpPayment(HASH)).rejects.toThrow("review down")
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
      ["FAILURE (PaymentSendResult)", "FAILURE", true],
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

    it("transfer SUCCESS but the card vanished before credit -> kept AND flagged for review", async () => {
      mockBlink.intraLedgerPaymentSend.mockResolvedValue({ status: "SUCCESS" })
      mockBlink.getExchangeRatePublic.mockResolvedValue({ satPriceInCurrency: 0.07 })
      mockStore.topUpCard = jest
        .fn()
        .mockResolvedValue({ success: false, error: "Card not found or not active" })

      const res = await processTopUpPayment(HASH)

      expect(res.success).toBe(false)
      expect(mockStore.unmarkTopUpProcessed).not.toHaveBeenCalled()
      expect(mockStore.setTopUpReviewReason).toHaveBeenCalledWith(
        HASH,
        expect.stringContaining("Post-transfer credit failed"),
      )
    })

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
describe("handleTopUpCallback: no invoice without a persisted pending record", () => {
  it("storePendingTopUp fails -> LNURL ERROR, no invoice", async () => {
    mockStore.getCard = jest.fn().mockResolvedValue(card())
    mockStore.storePendingTopUp = jest.fn().mockResolvedValue(false)
    const createInvoice = jest
      .fn()
      .mockResolvedValue({ invoice: "lnbc1x", paymentHash: "h1" })

    const res = await handleTopUpCallback(CARD_ID, 1000 * 1000, "", createInvoice)

    expect(res).toMatchObject({ status: "ERROR" })
    expect(JSON.stringify(res)).not.toContain("lnbc1x")
  })

  it("persisted -> invoice returned", async () => {
    mockStore.getCard = jest.fn().mockResolvedValue(card())
    mockStore.storePendingTopUp = jest.fn().mockResolvedValue(true)
    const createInvoice = jest
      .fn()
      .mockResolvedValue({ invoice: "lnbc1x", paymentHash: "h1" })

    const res = await handleTopUpCallback(CARD_ID, 1000 * 1000, "", createInvoice)

    expect((res as { pr?: string }).pr).toBe("lnbc1x")
    expect(mockStore.storePendingTopUp).toHaveBeenCalledWith(CARD_ID, "h1", 1000, "BTC")
  })
})

describe("unpaid top-up invoices are not cleaned up", () => {
  it("no Blink transaction (UNSEEN) is left pending, not marked processed", async () => {
    mockStore.getPendingTopUpsForCard = jest
      .fn()
      .mockResolvedValue([{ paymentHash: "ab".repeat(32), amount: 1000 }])
    mockStore.markTopUpProcessed = jest.fn().mockResolvedValue(true)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            me: {
              defaultAccount: { walletById: { transactionsByPaymentHash: [] } },
            },
          },
        }),
    }) as unknown as typeof fetch

    const res = await checkAndProcessPendingTopUps(
      CARD_ID,
      "blink_key",
      "production",
      "wallet-btc",
      "BTC",
    )

    expect(res.processed).toBe(0)
    expect(mockStore.markTopUpProcessed).not.toHaveBeenCalled()
    expect(mockStore.processTopUpPayment).not.toHaveBeenCalled()
  })
})

describe("terminal failure spellings (fetchInvoiceReceipt via top-up path)", () => {
  beforeEach(() => {
    mockStore.getPendingTopUp = jest
      .fn()
      .mockResolvedValue({ cardId: CARD_ID, amount: 1000, currency: "BTC" })
    mockStore.markTopUpProcessed = jest.fn().mockResolvedValue(true)
    mockStore.topUpCard = jest.fn().mockResolvedValue({ success: true, balance: 6000 })
  })

  it.each(["FAILED", "FAILURE"])(
    "a receive-side %s is terminal (top-up not credited)",
    async (status) => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              me: {
                defaultAccount: {
                  walletById: {
                    transactionsByPaymentHash: [
                      { status, direction: "RECEIVE", settlementAmount: 1000 },
                    ],
                  },
                },
              },
            },
          }),
      })
      const res = await processTopUpPayment("cd".repeat(32))
      expect(res.success).toBe(false)
      expect(mockStore.topUpCard).not.toHaveBeenCalled()
    },
  )
})

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
    mockStore.resolvePendingWithdrawalFailed = jest.fn().mockResolvedValue(true)
    mockStore.getPendingWithdrawals = jest.fn().mockResolvedValue([
      {
        paymentHash: "h1",
        cardId: CARD_ID,
        amount: 1000,
        createdAt: 1,
        kind: "PENDING",
        attempt: 1,
      },
    ])
  })

  it("SEND/SUCCESS -> resolved SUCCESS, deduction untouched", async () => {
    blinkStatus([{ status: "SUCCESS", direction: "SEND", settlementAmount: 1000 }])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 1, restored: 0 })
    expect(mockStore.resolvePendingWithdrawal).toHaveBeenCalledWith("h1", "SUCCESS", 1)
    expect(mockStore.rollbackSpend).not.toHaveBeenCalled()
  })

  it("a delayed EXPIRED is pinned to the attempt that was read", async () => {
    mockStore.getPendingWithdrawals = jest.fn().mockResolvedValue([
      {
        paymentHash: "h1",
        cardId: CARD_ID,
        amount: 1000,
        createdAt: 1,
        kind: "UNKNOWN",
        attempt: 1,
      },
    ])
    mockStore.resolvePendingWithdrawalFailed = jest.fn().mockResolvedValue(false)
    blinkStatus([{ status: "FAILURE", direction: "SEND", settlementAmount: 1000 }])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 0, restored: 0 })
    expect(mockStore.resolvePendingWithdrawalFailed).toHaveBeenCalledWith("h1", 1)
  })

  it("a delayed PAID is pinned to the attempt that was read", async () => {
    mockStore.getPendingWithdrawals = jest.fn().mockResolvedValue([
      {
        paymentHash: "h1",
        cardId: CARD_ID,
        amount: 1000,
        createdAt: 1,
        kind: "UNKNOWN",
        attempt: 2,
      },
    ])
    mockStore.resolvePendingWithdrawal = jest.fn().mockResolvedValue(false)
    blinkStatus([{ status: "SUCCESS", direction: "SEND", settlementAmount: 1000 }])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 0, restored: 0 })
    expect(mockStore.resolvePendingWithdrawal).toHaveBeenCalledWith("h1", "SUCCESS", 2)
  })

  it("SEND/FAILURE -> deduction restored and resolved FAILED (atomically)", async () => {
    blinkStatus([{ status: "FAILURE", direction: "SEND", settlementAmount: 1000 }])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 1, restored: 1 })
    expect(mockStore.resolvePendingWithdrawalFailed).toHaveBeenCalledWith("h1", 1)
    expect(mockStore.rollbackSpend).not.toHaveBeenCalled()
  })

  it("a receive-side fixture must NOT resolve an outgoing withdrawal", async () => {
    blinkStatus([{ status: "SUCCESS", direction: "RECEIVE", settlementAmount: 1000 }])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 0, restored: 0 })
    expect(mockStore.resolvePendingWithdrawal).not.toHaveBeenCalled()
  })

  it("a fresh CLAIMED row is only restored if the compare-and-set still matches", async () => {
    mockStore.getPendingWithdrawals = jest.fn().mockResolvedValue([
      {
        paymentHash: "h1",
        cardId: CARD_ID,
        amount: 1000,
        createdAt: Date.now(),
        kind: "CLAIMED",
        attempt: 1,
      },
    ])
    mockStore.resolvePendingWithdrawalFailed = jest.fn().mockResolvedValue(false)
    blinkStatus([])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 0, restored: 0 })
    expect(mockStore.resolvePendingWithdrawalFailed).toHaveBeenCalledWith(
      "h1",
      1,
      expect.any(Number),
    )
  })

  it("a CLAIMED row with no Blink transaction is restored (died before pay)", async () => {
    mockStore.getPendingWithdrawals = jest.fn().mockResolvedValue([
      {
        paymentHash: "h1",
        cardId: CARD_ID,
        amount: 1000,
        createdAt: 1,
        kind: "CLAIMED",
      },
    ])
    blinkStatus([])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 1, restored: 1 })
  })

  it("a RESTORE_FAILED row with no Blink transaction is restored (payment was never sent)", async () => {
    mockStore.getPendingWithdrawals = jest.fn().mockResolvedValue([
      {
        paymentHash: "h1",
        cardId: CARD_ID,
        amount: 1000,
        createdAt: 1,
        kind: "RESTORE_FAILED",
      },
    ])
    blinkStatus([]) // no transaction at all
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 1, restored: 1 })
  })

  it("a RESTORE_FAILED row with an in-flight SEND is not restored", async () => {
    mockStore.getPendingWithdrawals = jest.fn().mockResolvedValue([
      {
        paymentHash: "h1",
        cardId: CARD_ID,
        amount: 1000,
        createdAt: 1,
        kind: "RESTORE_FAILED",
      },
    ])
    blinkStatus([{ status: "PENDING", direction: "SEND", settlementAmount: 1000 }])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 0, restored: 0 })
    expect(mockStore.resolvePendingWithdrawalFailed).not.toHaveBeenCalled()
  })

  it("a RESTORE_FAILED row with a settled send resolves without restoring", async () => {
    mockStore.getPendingWithdrawals = jest.fn().mockResolvedValue([
      {
        paymentHash: "h1",
        cardId: CARD_ID,
        amount: 1000,
        createdAt: 1,
        kind: "RESTORE_FAILED",
      },
    ])
    blinkStatus([{ status: "SUCCESS", direction: "SEND", settlementAmount: 1000 }])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 1, restored: 0 })
  })

  it("SEND/FAILURE where the atomic resolve-restore loses -> nothing counted", async () => {
    blinkStatus([{ status: "FAILURE", direction: "SEND", settlementAmount: 1000 }])
    mockStore.resolvePendingWithdrawalFailed = jest.fn().mockResolvedValue(false)
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 0, restored: 0 })
  })

  it("still PENDING -> left for the next pass", async () => {
    blinkStatus([{ status: "PENDING", direction: "SEND", settlementAmount: 1000 }])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 0, restored: 0 })
    expect(mockStore.resolvePendingWithdrawal).not.toHaveBeenCalled()
  })

  it("a PENDING-kind row with no transaction yet is not restored", async () => {
    blinkStatus([])
    const res = await reconcilePendingWithdrawals(CARD_ID)
    expect(res).toEqual({ checked: 1, resolved: 0, restored: 0 })
    expect(mockStore.resolvePendingWithdrawalFailed).not.toHaveBeenCalled()
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

  it("balance: a restored withdrawal is reflected in the response", async () => {
    mockVerifyCardTap.mockReturnValue({ valid: true, counter: 4 })
    mockStore.updateLastCounter = jest.fn().mockResolvedValue(true)
    mockStore.getCard = jest
      .fn()
      .mockResolvedValueOnce(card({ balance: 4000 }))
      .mockResolvedValueOnce(card({ balance: 4000 }))
      .mockResolvedValueOnce(card({ balance: 5000 }))
    mockStore.getPendingWithdrawals = jest.fn().mockResolvedValue([
      {
        paymentHash: "h1",
        cardId: CARD_ID,
        amount: 1000,
        createdAt: 1,
        kind: "CLAIMED",
      },
    ])
    mockStore.resolvePendingWithdrawalFailed = jest.fn().mockResolvedValue(true)
    mockStore.getPendingTopUpsForCard = jest.fn().mockResolvedValue([])
    mockStore.getCardTransactions = jest.fn().mockResolvedValue([])
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            me: {
              defaultAccount: { walletById: { transactionsByPaymentHash: [] } },
            },
          },
        }),
    }) as unknown as typeof fetch

    const res = await call(balanceHandler, {
      method: "GET",
      query: { cardId: CARD_ID, p: "A".repeat(32), c: "B".repeat(16) },
    })

    expect(res.statusCode).toBe(200)
    expect((res.body as { card: { balance: number } }).card.balance).toBe(5000)
    expect(mockStore.getCard).toHaveBeenCalledTimes(3)
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
