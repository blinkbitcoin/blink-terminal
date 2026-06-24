/**
 * Tests for useReceiverType — self-custodial (Spark) LN-address detection.
 *
 * An account whose `type === "ln-address"` may be either custodial or
 * self-custodial (Spark). The hook resolves the distinction via
 * /api/blink/resolve-receiver and exposes `isSparkLnAddress`, which the
 * authenticated POS uses to suppress Tip Options / Payment Splits.
 *
 * Fail-safe: ln-address accounts are treated as Spark (true) until a custodial
 * result is confirmed; non-ln-address accounts are always custodial (false).
 *
 * @module tests/unit/hooks/useReceiverType.spec
 */

import { renderHook, waitFor } from "@testing-library/react"

jest.mock("../../../lib/config/api", () => ({
  getEnvironment: () => "production",
}))

import { useReceiverType } from "../../../lib/hooks/useReceiverType"

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  ;(global.fetch as jest.Mock).mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  })
}

describe("useReceiverType", () => {
  beforeEach(() => {
    global.fetch = jest.fn()
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it("returns false (custodial) for a non-ln-address account without calling the API", () => {
    const { result } = renderHook(() =>
      useReceiverType({ username: "alice", type: undefined }),
    )

    expect(result.current.isSparkLnAddress).toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("returns false for null account", () => {
    const { result } = renderHook(() => useReceiverType(null))
    expect(result.current.isSparkLnAddress).toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("starts true (suppressed) for an ln-address account while resolving", () => {
    // Never resolves within this synchronous assertion.
    ;(global.fetch as jest.Mock).mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() =>
      useReceiverType({ username: "yasar", type: "ln-address" }),
    )

    expect(result.current.isSparkLnAddress).toBe(true)
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/blink/resolve-receiver",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("resolves to false when the endpoint confirms custodial", async () => {
    mockFetchOnce({ exists: true, type: "custodial", username: "pretyflaco" })

    const { result } = renderHook(() =>
      useReceiverType({ username: "pretyflaco", type: "ln-address" }),
    )

    await waitFor(() => expect(result.current.isSparkLnAddress).toBe(false))
  })

  it("stays true when the endpoint resolves type lnaddress (Spark)", async () => {
    mockFetchOnce({ exists: true, type: "lnaddress", username: "yasar" })

    const { result } = renderHook(() =>
      useReceiverType({ username: "yasar", type: "ln-address" }),
    )

    // give the effect a tick; value must remain true
    await waitFor(() => expect(result.current.receiverTypeLoading).toBe(false))
    expect(result.current.isSparkLnAddress).toBe(true)
  })

  it("stays true (suppressed) when the resolve call fails", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    ;(global.fetch as jest.Mock).mockRejectedValueOnce(new Error("network"))

    const { result } = renderHook(() =>
      useReceiverType({ username: "yasar", type: "ln-address" }),
    )

    await waitFor(() => expect(result.current.receiverTypeLoading).toBe(false))
    expect(result.current.isSparkLnAddress).toBe(true)
    warnSpy.mockRestore()
  })

  it("stays true when account is not found (404)", async () => {
    mockFetchOnce({ exists: false, error: "not found" }, false, 404)

    const { result } = renderHook(() =>
      useReceiverType({ username: "ghost", type: "ln-address" }),
    )

    await waitFor(() => expect(result.current.receiverTypeLoading).toBe(false))
    expect(result.current.isSparkLnAddress).toBe(true)
  })
})
