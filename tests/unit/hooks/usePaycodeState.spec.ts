/**
 * Tests for usePaycodeState hook
 *
 * Visibility-only hook (amount + PDF-generation state were removed when the
 * Paycodes menu and the print page were unified into the shared
 * PrintPaycodeView, which is variable-amount only).
 *
 * @module tests/unit/hooks/usePaycodeState.spec
 */

import { renderHook, act } from "@testing-library/react"

import { usePaycodeState } from "../../../lib/hooks/usePaycodeState"

describe("usePaycodeState", () => {
  describe("Initial State", () => {
    it("should initialize hidden", () => {
      const { result } = renderHook(() => usePaycodeState())
      expect(result.current.showPaycode).toBe(false)
    })
  })

  describe("Visibility State", () => {
    it("should set showPaycode to true", () => {
      const { result } = renderHook(() => usePaycodeState())
      act(() => result.current.setShowPaycode(true))
      expect(result.current.showPaycode).toBe(true)
    })

    it("should set showPaycode to false", () => {
      const { result } = renderHook(() => usePaycodeState())
      act(() => result.current.setShowPaycode(true))
      act(() => result.current.setShowPaycode(false))
      expect(result.current.showPaycode).toBe(false)
    })

    it("should open paycode", () => {
      const { result } = renderHook(() => usePaycodeState())
      act(() => result.current.openPaycode())
      expect(result.current.showPaycode).toBe(true)
    })

    it("should close paycode", () => {
      const { result } = renderHook(() => usePaycodeState())
      act(() => result.current.openPaycode())
      act(() => result.current.closePaycode())
      expect(result.current.showPaycode).toBe(false)
    })

    it("should toggle from closed to open", () => {
      const { result } = renderHook(() => usePaycodeState())
      expect(result.current.showPaycode).toBe(false)
      act(() => result.current.togglePaycode())
      expect(result.current.showPaycode).toBe(true)
    })

    it("should toggle from open to closed", () => {
      const { result } = renderHook(() => usePaycodeState())
      act(() => result.current.openPaycode())
      act(() => result.current.togglePaycode())
      expect(result.current.showPaycode).toBe(false)
    })

    it("should toggle multiple times correctly", () => {
      const { result } = renderHook(() => usePaycodeState())
      act(() => result.current.togglePaycode())
      expect(result.current.showPaycode).toBe(true)
      act(() => result.current.togglePaycode())
      expect(result.current.showPaycode).toBe(false)
      act(() => result.current.togglePaycode())
      expect(result.current.showPaycode).toBe(true)
    })
  })

  describe("Callback Stability", () => {
    it("should maintain stable references across rerenders", () => {
      const { result, rerender } = renderHook(() => usePaycodeState())
      const refs = {
        setShowPaycode: result.current.setShowPaycode,
        openPaycode: result.current.openPaycode,
        closePaycode: result.current.closePaycode,
        togglePaycode: result.current.togglePaycode,
      }

      rerender()

      expect(result.current.setShowPaycode).toBe(refs.setShowPaycode)
      expect(result.current.openPaycode).toBe(refs.openPaycode)
      expect(result.current.closePaycode).toBe(refs.closePaycode)
      expect(result.current.togglePaycode).toBe(refs.togglePaycode)
    })
  })

  describe("Edge Cases", () => {
    it("should handle rapid state changes", () => {
      const { result } = renderHook(() => usePaycodeState())
      act(() => {
        result.current.openPaycode()
        result.current.closePaycode()
        result.current.openPaycode()
      })
      expect(result.current.showPaycode).toBe(true)
    })
  })
})
