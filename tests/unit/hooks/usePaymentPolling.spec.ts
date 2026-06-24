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

describe("usePaymentPolling - escrow path (no verify URL)", () => {
  it("polls /api/payment-status and triggers on completed", async () => {
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
