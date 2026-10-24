/**
 * Tests for usePublicPOSPayment — payment detection.
 *
 * Covers the two detection paths:
 *   - Self-custodial (Spark): polls the LUD-21 verify URL via verifyLnurlPayment.
 *   - Custodial: polls Blink GraphQL lnInvoicePaymentStatus.
 *
 * Polling starts after a 2s initial delay (then every 5s); fake timers are used
 * to drive it deterministically.
 *
 * @module tests/unit/hooks/usePublicPOSPayment.spec
 */

import { renderHook, act, waitFor } from "@testing-library/react"
import { useRef } from "react"

const mockVerifyLnurlPayment = jest.fn()
jest.mock("../../../lib/lnurl", () => ({
  verifyLnurlPayment: (...a: unknown[]) => mockVerifyLnurlPayment(...a),
}))

jest.mock("../../../lib/config/api", () => ({
  getApiUrl: () => "https://api.blink.test/graphql",
}))

import { usePublicPOSPayment } from "../../../lib/hooks/usePublicPOSPayment"

const INITIAL_DELAY_MS = 2000

function renderPayment() {
  return renderHook(() => {
    const posPaymentReceivedRef = useRef<(() => void) | null>(null)
    return usePublicPOSPayment({
      showingInvoice: true,
      soundEnabled: false,
      posPaymentReceivedRef,
      merchant: "merchant",
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

describe("usePublicPOSPayment - self-custodial (verify URL)", () => {
  it("polls the verify URL and reports success when settled", async () => {
    mockVerifyLnurlPayment.mockResolvedValue({ settled: true, preimage: "p" })
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as unknown as typeof fetch

    const { result } = renderPayment()

    act(() => {
      result.current.setCurrentInvoice({
        paymentRequest: "lnbc-spark",
        paymentHash: "hash-1",
        satAmount: 5000,
        verifyUrl: "https://blink.sv/verify/hash-1",
      })
    })

    await act(async () => {
      await jest.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    })

    await waitFor(() => expect(result.current.paymentSuccess).toBe(true))

    expect(mockVerifyLnurlPayment).toHaveBeenCalledWith("https://blink.sv/verify/hash-1")
    // Verify path must NOT hit the GraphQL endpoint.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.current.paymentData?.satAmount).toBe(5000)
  })

  it("does not report success while unsettled", async () => {
    mockVerifyLnurlPayment.mockResolvedValue({ settled: false })
    global.fetch = jest.fn() as unknown as typeof fetch

    const { result } = renderPayment()

    act(() => {
      result.current.setCurrentInvoice({
        paymentRequest: "lnbc-spark",
        verifyUrl: "https://blink.sv/verify/hash-2",
      })
    })

    await act(async () => {
      await jest.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    })

    expect(mockVerifyLnurlPayment).toHaveBeenCalled()
    expect(result.current.paymentSuccess).toBe(false)
  })
})

describe("usePublicPOSPayment - custodial (GraphQL)", () => {
  it("polls GraphQL and reports success when PAID", async () => {
    const fetchSpy = jest.fn(async () => ({
      json: async () => ({ data: { lnInvoicePaymentStatus: { status: "PAID" } } }),
    }))
    global.fetch = fetchSpy as unknown as typeof fetch

    const { result } = renderPayment()

    act(() => {
      result.current.setCurrentInvoice({
        paymentRequest: "lnbc-custodial",
        paymentHash: "hash-3",
        satAmount: 2000,
      })
    })

    await act(async () => {
      await jest.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    })

    await waitFor(() => expect(result.current.paymentSuccess).toBe(true))

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.blink.test/graphql",
      expect.objectContaining({ method: "POST" }),
    )
    // Custodial path must NOT call the verify helper.
    expect(mockVerifyLnurlPayment).not.toHaveBeenCalled()
  })
})
