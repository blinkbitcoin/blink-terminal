/**
 * Tests for usePaymentPolling — self-custodial (LUD-21 verify) detection branch.
 *
 * The authenticated POS normally polls /api/payment-status (BlinkPOS escrow
 * record). For a self-custodial (Spark) direct-receive invoice the invoice
 * carries a `verifyUrl`, and detection polls that LUD-21 URL instead.
 *
 * @module tests/unit/hooks/usePaymentPolling.spec
 */

import { renderHook, act } from "@testing-library/react"
import { useRef } from "react"

const mockVerifyLnurlPayment = jest.fn()
jest.mock("../../../lib/lnurl", () => ({
  verifyLnurlPayment: (...a: unknown[]) => mockVerifyLnurlPayment(...a),
}))

// Feature flag: toggled per-test. Default is disabled (direct/no-escrow),
// matching the interim production default.
const mockSplitEnabled = jest.fn(() => false)
jest.mock("../../../lib/config/features", () => ({
  isSplitPaymentsEnabled: () => mockSplitEnabled(),
}))

jest.mock("../../../lib/config/api", () => ({
  getApiUrl: () => "https://api.blink.sv/graphql",
}))

// useNFC touches browser NFC APIs; stub it out.
jest.mock("../../../components/NFCPayment", () => ({
  useNFC: () => ({ nfcSupported: false }),
}))

import {
  usePaymentPolling,
  type PaymentPollingInvoice,
} from "../../../lib/hooks/usePaymentPolling"

const INITIAL_POLL_DELAY = 0 // polls immediately, then on interval

function renderPolling(invoice: PaymentPollingInvoice, onAnimate: jest.Mock) {
  return renderHook(() => {
    const posPaymentReceivedRef = useRef<(() => void) | null>(null)
    return usePaymentPolling({
      currentInvoice: invoice,
      triggerPaymentAnimation: onAnimate,
      posPaymentReceivedRef,
      fetchData: jest.fn(),
      soundEnabled: false,
      soundTheme: "default",
      merchant: "yasar",
    })
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSplitEnabled.mockReturnValue(false)
  jest.useFakeTimers()
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("usePaymentPolling - self-custodial (verify URL)", () => {
  it("polls the verify URL and triggers animation when settled", async () => {
    mockVerifyLnurlPayment.mockResolvedValue({ settled: true })
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as unknown as typeof fetch
    const onAnimate = jest.fn()

    renderPolling(
      {
        paymentHash: "hash-sc",
        paymentRequest: "lnbc-sc",
        satAmount: 160,
        verifyUrl: "https://blink.sv/verify/hash-sc",
      },
      onAnimate,
    )

    // immediate poll fires on mount
    await act(async () => {
      await Promise.resolve()
      await jest.advanceTimersByTimeAsync(INITIAL_POLL_DELAY)
    })

    expect(mockVerifyLnurlPayment).toHaveBeenCalledWith("https://blink.sv/verify/hash-sc")
    // Verify path must NOT hit the escrow status endpoint.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(onAnimate).toHaveBeenCalledTimes(1)
    expect(onAnimate.mock.calls[0][0]).toMatchObject({ satAmount: 160 })
  })

  it("does not trigger when unsettled", async () => {
    mockVerifyLnurlPayment.mockResolvedValue({ settled: false })
    global.fetch = jest.fn() as unknown as typeof fetch
    const onAnimate = jest.fn()

    renderPolling(
      {
        paymentHash: "hash-sc2",
        verifyUrl: "https://blink.sv/verify/hash-sc2",
      },
      onAnimate,
    )

    await act(async () => {
      await Promise.resolve()
      await jest.advanceTimersByTimeAsync(0)
    })

    expect(mockVerifyLnurlPayment).toHaveBeenCalled()
    expect(onAnimate).not.toHaveBeenCalled()
  })
})

describe("usePaymentPolling - direct path (splits disabled, no verify URL)", () => {
  it("polls public lnInvoicePaymentStatus by payment request and triggers on PAID", async () => {
    mockSplitEnabled.mockReturnValue(false)
    const fetchSpy = jest.fn(async () => ({
      json: async () => ({ data: { lnInvoicePaymentStatus: { status: "PAID" } } }),
    }))
    global.fetch = fetchSpy as unknown as typeof fetch
    const onAnimate = jest.fn()

    renderPolling(
      {
        paymentHash: "hash-direct",
        paymentRequest: "lnbc-direct",
        satAmount: 100,
      },
      onAnimate,
    )

    await act(async () => {
      await Promise.resolve()
      await jest.advanceTimersByTimeAsync(0)
    })

    // Direct path hits the Blink GraphQL endpoint, NOT the escrow status route.
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.blink.sv/graphql",
      expect.objectContaining({ method: "POST" }),
    )
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body)
    expect(body.variables.input.paymentRequest).toBe("lnbc-direct")
    expect(mockVerifyLnurlPayment).not.toHaveBeenCalled()
    expect(onAnimate).toHaveBeenCalledTimes(1)
  })
})

describe("usePaymentPolling - escrow path (splits enabled, no verify URL)", () => {
  it("polls /api/payment-status and triggers on completed", async () => {
    mockSplitEnabled.mockReturnValue(true)
    const fetchSpy = jest.fn(async () => ({
      json: async () => ({ status: "completed" }),
    }))
    global.fetch = fetchSpy as unknown as typeof fetch
    const onAnimate = jest.fn()

    renderPolling(
      {
        paymentHash: "hash-escrow",
        paymentRequest: "lnbc-escrow",
        satAmount: 100,
      },
      onAnimate,
    )

    await act(async () => {
      await Promise.resolve()
      await jest.advanceTimersByTimeAsync(0)
    })

    expect(fetchSpy).toHaveBeenCalledWith("/api/payment-status/hash-escrow")
    // Escrow path must NOT call the verify helper.
    expect(mockVerifyLnurlPayment).not.toHaveBeenCalled()
    expect(onAnimate).toHaveBeenCalledTimes(1)
  })
})
