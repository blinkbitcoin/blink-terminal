/**
 * Tests for usePublicPOSSettings display-currency persistence.
 *
 * Precedence: a `?display=` URL param (initialDisplayCurrency) wins and becomes
 * the new persisted default; otherwise the last device choice is restored from
 * localStorage (`publicpos-display-currency`), falling back to USD.
 *
 * @module tests/unit/hooks/usePublicPOSSettings.spec
 */

import { renderHook, act } from "@testing-library/react"

import { usePublicPOSSettings } from "../../../lib/hooks/usePublicPOSSettings"

const KEY = "publicpos-display-currency"

describe("usePublicPOSSettings display currency", () => {
  let mockLocalStorage: Record<string, string>

  beforeEach(() => {
    mockLocalStorage = {}
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: jest.fn((key: string) => mockLocalStorage[key] ?? null),
        setItem: jest.fn((key: string, value: string) => {
          mockLocalStorage[key] = value
        }),
        removeItem: jest.fn((key: string) => {
          delete mockLocalStorage[key]
        }),
        clear: jest.fn(() => {
          mockLocalStorage = {}
        }),
      },
      writable: true,
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it("defaults to USD when nothing is stored and no param is given", () => {
    const { result } = renderHook(() => usePublicPOSSettings())
    expect(result.current.displayCurrency).toBe("USD")
  })

  it("restores the last persisted device choice when no param is given", () => {
    mockLocalStorage[KEY] = "BTC"
    const { result } = renderHook(() => usePublicPOSSettings())
    expect(result.current.displayCurrency).toBe("BTC")
  })

  it("falls back to USD when the stored value is empty", () => {
    mockLocalStorage[KEY] = ""
    const { result } = renderHook(() => usePublicPOSSettings())
    expect(result.current.displayCurrency).toBe("USD")
  })

  it("falls back to USD when reading localStorage throws", () => {
    ;(window.localStorage.getItem as jest.Mock).mockImplementationOnce(() => {
      throw new Error("blocked")
    })
    const { result } = renderHook(() => usePublicPOSSettings())
    expect(result.current.displayCurrency).toBe("USD")
  })

  it("prefers the ?display= param over the persisted device choice", () => {
    mockLocalStorage[KEY] = "BTC"
    const { result } = renderHook(() => usePublicPOSSettings("EUR"))
    expect(result.current.displayCurrency).toBe("EUR")
  })

  it("persists a currency change to localStorage", () => {
    const { result } = renderHook(() => usePublicPOSSettings())

    act(() => {
      result.current.setDisplayCurrency("BTC")
    })

    expect(mockLocalStorage[KEY]).toBe("BTC")
  })

  it("persists the ?display= param so it becomes the new device default", () => {
    const { unmount } = renderHook(() => usePublicPOSSettings("EUR"))
    expect(mockLocalStorage[KEY]).toBe("EUR")
    unmount()

    // A later visit without a param restores the persisted value.
    const { result } = renderHook(() => usePublicPOSSettings())
    expect(result.current.displayCurrency).toBe("EUR")
  })
})
