/**
 * Tests for useTheme hook — default theme, cycle order, and the selectable
 * (subset) logo-tap cycle introduced with the Blink keypad redesign (#44).
 *
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"

import {
  useTheme,
  _resetThemeStore,
  THEME_ORDER,
  THEME_LABELS,
  type Theme,
} from "../../../lib/hooks/useTheme"

describe("useTheme", () => {
  let store: Record<string, string>

  beforeEach(() => {
    store = {}
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: jest.fn((k: string) => store[k] ?? null),
        setItem: jest.fn((k: string, v: string) => {
          store[k] = v
        }),
        removeItem: jest.fn((k: string) => {
          delete store[k]
        }),
        clear: jest.fn(() => {
          store = {}
        }),
      },
      writable: true,
    })
    _resetThemeStore()
  })

  it("labels: Blink Dark / Blink Light / Retro Night / Retro Day", () => {
    expect(THEME_LABELS["blink-classic-dark"]).toBe("Blink Dark")
    expect(THEME_LABELS["blink-classic-light"]).toBe("Blink Light")
    expect(THEME_LABELS.dark).toBe("Retro Night")
    expect(THEME_LABELS.light).toBe("Retro Day")
  })

  it("cycle order leads with the two Blink themes", () => {
    expect(THEME_ORDER).toEqual([
      "blink-classic-dark",
      "blink-classic-light",
      "dark",
      "light",
    ])
  })

  it("defaults a fresh install to Blink Dark", () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe("blink-classic-dark")
  })

  it("full cycle walks the whole order and wraps", () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe("blink-classic-dark")

    act(() => result.current.cycleTheme())
    expect(result.current.theme).toBe("blink-classic-light")
    act(() => result.current.cycleTheme())
    expect(result.current.theme).toBe("dark")
    act(() => result.current.cycleTheme())
    expect(result.current.theme).toBe("light")
    act(() => result.current.cycleTheme())
    expect(result.current.theme).toBe("blink-classic-dark")
  })

  it("subset cycle walks only the enabled themes", () => {
    const enabled: Theme[] = ["blink-classic-dark", "blink-classic-light"]
    const { result } = renderHook(() => useTheme())

    act(() => result.current.cycleTheme(enabled))
    expect(result.current.theme).toBe("blink-classic-light")
    act(() => result.current.cycleTheme(enabled))
    expect(result.current.theme).toBe("blink-classic-dark")
  })

  it("subset cycle jumps to the first enabled when active isn't in the set", () => {
    const { result } = renderHook(() => useTheme())
    // Start on a Retro theme, then cycle a Blink-only subset.
    act(() => result.current.setTheme("dark"))
    expect(result.current.theme).toBe("dark")

    const enabled: Theme[] = ["blink-classic-dark", "blink-classic-light"]
    act(() => result.current.cycleTheme(enabled))
    expect(result.current.theme).toBe("blink-classic-dark")
  })

  it("empty subset falls back to the full order", () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current.cycleTheme([]))
    expect(result.current.theme).toBe("blink-classic-light")
  })

  it("persists the active theme to localStorage", () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current.cycleTheme())
    expect(store.theme).toBe("blink-classic-light")
  })
})
