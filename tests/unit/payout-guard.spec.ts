/**
 * Unit Tests for lib/payout-guard.ts
 *
 * These guard the BlinkPOS intermediary wallet from being drained:
 *   - max-forward ceiling
 *   - invoice amount must match the expected (stored) amount exactly
 *   - amountless invoices are rejected
 *   - expired invoices are rejected
 *   - non-Blink payee nodes are rejected when intraledger is required
 */

import { decodeInvoice, isBlinkNodePubkey } from "../../lib/invoice-decoder"
import {
  assertWithinMaxForward,
  getMaxForwardSats,
  verifyForwardInvoice,
} from "../../lib/payout-guard"

jest.mock("../../lib/invoice-decoder", () => ({
  decodeInvoice: jest.fn(),
  isBlinkNodePubkey: jest.fn(),
}))

const mockedDecode = decodeInvoice as jest.MockedFunction<typeof decodeInvoice>
const mockedIsBlink = isBlinkNodePubkey as jest.MockedFunction<typeof isBlinkNodePubkey>

const FUTURE = Math.floor(Date.now() / 1000) + 3600
const PAST = Math.floor(Date.now() / 1000) - 3600

function decoded(over: Partial<Record<string, unknown>> = {}) {
  return {
    success: true as const,
    data: {
      payeeNodeKey: "02blinknode",
      satoshis: 1000,
      millisatoshis: "1000000",
      timestamp: 1,
      timeExpireDate: FUTURE,
      tags: [],
      paymentHash: "hash",
      description: "desc",
      network: "mainnet",
      ...over,
    },
  }
}

beforeEach(() => {
  jest.resetAllMocks()
  delete process.env.BLINKPOS_MAX_FORWARD_SATS
  mockedIsBlink.mockReturnValue(true)
})

describe("getMaxForwardSats / assertWithinMaxForward", () => {
  it("returns null and is a no-op when env unset", () => {
    expect(getMaxForwardSats()).toBeNull()
    expect(assertWithinMaxForward(999_999_999)).toEqual({ ok: true })
  })

  it("rejects amounts above the ceiling", () => {
    process.env.BLINKPOS_MAX_FORWARD_SATS = "1000"
    expect(getMaxForwardSats()).toBe(1000)
    const result = assertWithinMaxForward(1001)
    expect(result.ok).toBe(false)
  })

  it("allows amounts at/below the ceiling", () => {
    process.env.BLINKPOS_MAX_FORWARD_SATS = "1000"
    expect(assertWithinMaxForward(1000)).toEqual({ ok: true })
    expect(assertWithinMaxForward(1)).toEqual({ ok: true })
  })

  it("ignores invalid env values", () => {
    process.env.BLINKPOS_MAX_FORWARD_SATS = "not-a-number"
    expect(getMaxForwardSats()).toBeNull()
  })
})

describe("verifyForwardInvoice", () => {
  it("accepts an invoice with exact amount, unexpired, Blink node", () => {
    mockedDecode.mockReturnValue(decoded({ satoshis: 1000 }))
    const result = verifyForwardInvoice({
      invoice: "lnbc...",
      expectedSats: 1000,
      requireBlinkNode: true,
    })
    expect(result).toEqual({ ok: true })
  })

  it("DRAIN VECTOR: rejects an invoice whose amount exceeds the expected amount", () => {
    mockedDecode.mockReturnValue(decoded({ satoshis: 1_000_000 }))
    const result = verifyForwardInvoice({
      invoice: "lnbc...",
      expectedSats: 1000,
      requireBlinkNode: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("does not match expected")
  })

  it("rejects an invoice whose amount is below the expected amount", () => {
    mockedDecode.mockReturnValue(decoded({ satoshis: 500 }))
    const result = verifyForwardInvoice({ invoice: "lnbc...", expectedSats: 1000 })
    expect(result.ok).toBe(false)
  })

  it("DRAIN VECTOR: rejects amountless invoices", () => {
    mockedDecode.mockReturnValue(decoded({ satoshis: null }))
    const result = verifyForwardInvoice({ invoice: "lnbc...", expectedSats: 1000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("amountless")
  })

  it("rejects expired invoices", () => {
    mockedDecode.mockReturnValue(decoded({ satoshis: 1000, timeExpireDate: PAST }))
    const result = verifyForwardInvoice({ invoice: "lnbc...", expectedSats: 1000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("expired")
  })

  it("DRAIN VECTOR: rejects non-Blink payee when intraledger required", () => {
    mockedDecode.mockReturnValue(decoded({ satoshis: 1000, payeeNodeKey: "02attacker" }))
    mockedIsBlink.mockReturnValue(false)
    const result = verifyForwardInvoice({
      invoice: "lnbc...",
      expectedSats: 1000,
      requireBlinkNode: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("not a Blink node")
  })

  it("allows non-Blink payee when intraledger NOT required", () => {
    mockedDecode.mockReturnValue(decoded({ satoshis: 1000, payeeNodeKey: "02external" }))
    mockedIsBlink.mockReturnValue(false)
    const result = verifyForwardInvoice({
      invoice: "lnbc...",
      expectedSats: 1000,
      requireBlinkNode: false,
    })
    expect(result).toEqual({ ok: true })
  })

  it("rejects when the invoice fails to decode", () => {
    mockedDecode.mockReturnValue({ success: false, error: "bad invoice" })
    const result = verifyForwardInvoice({ invoice: "garbage", expectedSats: 1000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("decode")
  })
})
