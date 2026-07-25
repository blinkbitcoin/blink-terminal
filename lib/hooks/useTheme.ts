import { useEffect, useState, useCallback } from "react"

// ─── Types ────────────────────────────────────────────────────────

export type Theme = "dark" | "blink-classic-dark" | "light" | "blink-classic-light"

type ThemeListener = (theme: Theme) => void

export interface UseThemeReturn {
  theme: Theme
  setTheme: (newTheme: Theme) => void
  /**
   * Advance to the next theme in the cycle. When `enabled` is provided, cycle
   * through only that subset (the logo-tap "selectable cycle"); if the active
   * theme isn't in the subset, jump to the first enabled theme.
   */
  cycleTheme: (enabled?: readonly Theme[]) => void
  isDark: boolean
  isLight: boolean
  isBlinkClassic: boolean
  isBlinkClassicDark: boolean
  isBlinkClassicLight: boolean
  /** Backward compatibility: true for both dark and blink-classic-dark */
  darkMode: boolean
  /** Alias for cycleTheme — for easier migration */
  toggleDarkMode: () => void
}

// ─── Theme constants ──────────────────────────────────────────────

export const THEMES = {
  DARK: "dark",
  BLINK_CLASSIC_DARK: "blink-classic-dark",
  LIGHT: "light",
  BLINK_CLASSIC_LIGHT: "blink-classic-light",
} as const

// Theme cycle order (issue #44): the Blink themes lead, Retro follow.
// Blink Dark → Blink Light → Retro Night → Retro Day → wrap.
// (Internal ids are unchanged — blink-classic-* is the "Blink" look, dark/light
// is "Retro". Only the user-facing labels and order changed.)
export const THEME_ORDER: readonly Theme[] = [
  THEMES.BLINK_CLASSIC_DARK,
  THEMES.BLINK_CLASSIC_LIGHT,
  THEMES.DARK,
  THEMES.LIGHT,
]

/** User-facing theme names (ids stay stable for persistence). */
export const THEME_LABELS: Record<Theme, string> = {
  "blink-classic-dark": "Blink Dark",
  "blink-classic-light": "Blink Light",
  "dark": "Retro Night",
  "light": "Retro Day",
}

// Fresh installs cycle only the two Blink themes (issue #44).
export const DEFAULT_ENABLED_THEMES: readonly Theme[] = [
  THEMES.BLINK_CLASSIC_DARK,
  THEMES.BLINK_CLASSIC_LIGHT,
]

/**
 * Normalize an enabled-themes list: keep only known themes in canonical
 * THEME_ORDER and never return an empty set (falls back to the default).
 */
export function normalizeEnabledThemes(themes: readonly Theme[]): Theme[] {
  const set = THEME_ORDER.filter((t) => themes.includes(t))
  return set.length > 0 ? set : [...DEFAULT_ENABLED_THEMES]
}

/** Parse a stored enabled-themes JSON array into a normalized theme list. */
export function parseEnabledThemes(raw: string | null): Theme[] {
  if (!raw) {
    return [...DEFAULT_ENABLED_THEMES]
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_ENABLED_THEMES]
    }
    return normalizeEnabledThemes(parsed as Theme[])
  } catch {
    return [...DEFAULT_ENABLED_THEMES]
  }
}

const STORAGE_KEY = "theme"
const LEGACY_STORAGE_KEY = "darkMode"

// ─── Shared theme store ───────────────────────────────────────────
// Module-level singleton so every useTheme() instance shares the same
// theme value.  When any instance calls setTheme / cycleTheme, all
// subscribers (i.e. every mounted useTheme) are notified and re-render
// with the new value.
// ───────────────────────────────────────────────────────────────────

// Fresh installs default to Blink Dark (issue #44).
const DEFAULT_THEME: Theme = THEMES.BLINK_CLASSIC_DARK

let _currentTheme: Theme = DEFAULT_THEME
let _initialized = false
const _listeners: Set<ThemeListener> = new Set()

function _notify(): void {
  _listeners.forEach((fn) => fn(_currentTheme))
}

function _subscribe(fn: ThemeListener): () => void {
  _listeners.add(fn)
  return () => {
    _listeners.delete(fn)
  }
}

function _setSharedTheme(theme: Theme): void {
  _currentTheme = theme
  _notify()
}

// ─── Helpers (unchanged) ──────────────────────────────────────────

/**
 * Migrate from old darkMode boolean storage to new theme string
 */
function migrateFromLegacy(): Theme | null {
  const legacyValue = localStorage.getItem(LEGACY_STORAGE_KEY)
  if (legacyValue !== null) {
    const newTheme: Theme = legacyValue === "true" ? THEMES.DARK : THEMES.LIGHT
    localStorage.setItem(STORAGE_KEY, newTheme)
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    return newTheme
  }
  return null
}

/**
 * Migrate from old 'blink-classic' to new 'blink-classic-dark'
 */
function migrateBlinkClassic(savedTheme: string): Theme | string {
  if (savedTheme === "blink-classic") {
    localStorage.setItem(STORAGE_KEY, THEMES.BLINK_CLASSIC_DARK)
    return THEMES.BLINK_CLASSIC_DARK
  }
  return savedTheme
}

/**
 * Apply theme class to document
 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement
  // Remove all theme classes
  Object.values(THEMES).forEach((t) => root.classList.remove(t))
  // Also remove old 'blink-classic' class if present
  root.classList.remove("blink-classic")
  // Add the current theme class
  root.classList.add(theme)

  // Add/remove 'dark' class for Tailwind dark mode
  const isDarkTheme = theme === THEMES.DARK || theme === THEMES.BLINK_CLASSIC_DARK
  if (isDarkTheme) {
    root.classList.add("dark")
  } else {
    root.classList.remove("dark")
  }
}

/**
 * One-time initialization: read from localStorage, run migrations,
 * set the shared theme value and apply DOM classes.
 */
function _initTheme(): void {
  if (_initialized) return
  _initialized = true

  // Check for legacy migration first
  const migratedTheme = migrateFromLegacy()
  if (migratedTheme) {
    _currentTheme = migratedTheme
    applyTheme(migratedTheme)
    return
  }

  // Check for saved theme preference
  let savedTheme: string | null = localStorage.getItem(STORAGE_KEY)

  // Migrate old 'blink-classic' to 'blink-classic-dark'
  if (savedTheme) {
    savedTheme = migrateBlinkClassic(savedTheme) as string
  }

  if (savedTheme && THEME_ORDER.includes(savedTheme as Theme)) {
    _currentTheme = savedTheme as Theme
    applyTheme(savedTheme as Theme)
  } else {
    _currentTheme = DEFAULT_THEME
    applyTheme(DEFAULT_THEME)
    localStorage.setItem(STORAGE_KEY, DEFAULT_THEME)
  }
}

// ─── Hook ─────────────────────────────────────────────────────────

/**
 * Hook for managing app theme (dark, blink-classic-dark, light, blink-classic-light)
 * Supports 4-theme cycling.
 *
 * Uses a module-level shared store so every component that calls useTheme()
 * sees the same theme value and re-renders together when it changes.
 */
export function useTheme(): UseThemeReturn {
  const [theme, setThemeLocal] = useState<Theme>(() => {
    // Eagerly initialize on first useState call (SSR-safe: falls back to DARK)
    if (typeof window !== "undefined") {
      _initTheme()
    }
    return _currentTheme
  })

  // Subscribe to shared store changes
  useEffect(() => {
    // Sync in case initialization happened after our initial render
    if (theme !== _currentTheme) {
      setThemeLocal(_currentTheme)
    }
    return _subscribe(setThemeLocal)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Set a specific theme
   */
  const setTheme = useCallback((newTheme: Theme): void => {
    if (!THEME_ORDER.includes(newTheme)) {
      console.warn(`Invalid theme: ${newTheme}. Valid themes: ${THEME_ORDER.join(", ")}`)
      return
    }
    localStorage.setItem(STORAGE_KEY, newTheme)
    applyTheme(newTheme)
    _setSharedTheme(newTheme)
  }, [])

  /**
   * Cycle to the next theme. Without an argument, walks the full THEME_ORDER
   * (Blink Dark → Blink Light → Retro Night → Retro Day → wrap). With an
   * `enabled` subset, walks only those (in canonical order); if the active
   * theme isn't in the subset, jumps to the first enabled theme.
   */
  const cycleTheme = useCallback((enabled?: readonly Theme[]): void => {
    // Restrict to the enabled subset (canonical order preserved); fall back to
    // the full order if the subset is missing or empty.
    const cycle =
      enabled && enabled.length > 0 ? normalizeEnabledThemes(enabled) : THEME_ORDER

    const currentIndex = cycle.indexOf(_currentTheme)
    // -1 (active theme not in the subset) → first enabled theme.
    const nextTheme =
      currentIndex === -1 ? cycle[0] : cycle[(currentIndex + 1) % cycle.length]

    localStorage.setItem(STORAGE_KEY, nextTheme)
    applyTheme(nextTheme)
    _setSharedTheme(nextTheme)
  }, [])

  // Convenience booleans
  const isDark = theme === THEMES.DARK
  const isLight = theme === THEMES.LIGHT
  const isBlinkClassicDark = theme === THEMES.BLINK_CLASSIC_DARK
  const isBlinkClassicLight = theme === THEMES.BLINK_CLASSIC_LIGHT
  const isBlinkClassic = isBlinkClassicDark || isBlinkClassicLight

  // Backward compatibility: darkMode is true for both dark and blink-classic-dark
  const darkMode = theme === THEMES.DARK || theme === THEMES.BLINK_CLASSIC_DARK

  return {
    theme,
    setTheme,
    cycleTheme,
    isDark,
    isLight,
    isBlinkClassic,
    isBlinkClassicDark,
    isBlinkClassicLight,
    // Backward compatibility
    darkMode,
    toggleDarkMode: cycleTheme, // Alias for easier migration
  }
}

// For testing: reset shared state
export function _resetThemeStore(): void {
  _currentTheme = DEFAULT_THEME
  _initialized = false
  _listeners.clear()
}

export default useTheme
