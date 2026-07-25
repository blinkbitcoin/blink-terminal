/**
 * Tests for ThemeCycleOverlay — the selectable theme-cycle list.
 *
 * Covers: all four themes render with their labels; selecting a disabled theme
 * enables it AND applies it (live preview); deselecting removes it from the
 * cycle without switching; the last enabled theme can't be turned off.
 *
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { useState } from "react"

import ThemeCycleOverlay from "../../../components/Settings/ThemeCycleOverlay"
import type { Theme } from "../../../lib/hooks/useTheme"

const noopClasses = () => ""

// Stateful harness mirroring how Dashboard threads the props.
function Harness({
  initialTheme = "blink-classic-dark" as Theme,
  initialEnabled = ["blink-classic-dark", "blink-classic-light"] as Theme[],
}: {
  initialTheme?: Theme
  initialEnabled?: Theme[]
}) {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [enabledThemes, setEnabledThemesRaw] = useState<Theme[]>(initialEnabled)

  // Mimic the hook's canonical-order + never-empty normalization.
  const order: Theme[] = ["blink-classic-dark", "blink-classic-light", "dark", "light"]
  const setEnabledThemes = (next: Theme[]) => {
    const set = order.filter((t) => next.includes(t))
    setEnabledThemesRaw(set.length > 0 ? set : initialEnabled)
  }

  return (
    <>
      <div data-testid="active">{theme}</div>
      {/* Pipe-delimited so membership checks are exact (no substring bleed). */}
      <div data-testid="enabled">{`|${enabledThemes.join("|")}|`}</div>
      <ThemeCycleOverlay
        theme={theme}
        enabledThemes={enabledThemes}
        setEnabledThemes={setEnabledThemes}
        setTheme={setTheme}
        setShowThemeCycle={jest.fn()}
        getSubmenuBgClasses={noopClasses}
        getSubmenuHeaderClasses={noopClasses}
        getSelectionTileClasses={noopClasses}
        getSelectionTileActiveClasses={noopClasses}
      />
    </>
  )
}

describe("ThemeCycleOverlay", () => {
  it("renders all four themes with their labels", () => {
    render(<Harness />)
    expect(screen.getByText("Blink Dark")).toBeTruthy()
    expect(screen.getByText("Blink Light")).toBeTruthy()
    expect(screen.getByText("Retro Night")).toBeTruthy()
    expect(screen.getByText("Retro Day")).toBeTruthy()
  })

  it("selecting a disabled theme enables and applies it immediately", () => {
    render(<Harness />)
    // 'dark' (Retro Night) starts disabled.
    expect(screen.getByTestId("enabled").textContent).not.toContain("|dark|")

    fireEvent.click(screen.getByTestId("theme-option-dark"))

    expect(screen.getByTestId("enabled").textContent).toContain("|dark|")
    // Live preview: it became the active theme.
    expect(screen.getByTestId("active").textContent).toBe("dark")
  })

  it("deselecting removes a theme from the cycle without switching", () => {
    render(<Harness />)
    // blink-classic-light is enabled but not active.
    fireEvent.click(screen.getByTestId("theme-option-blink-classic-light"))

    expect(screen.getByTestId("enabled").textContent).not.toContain(
      "|blink-classic-light|",
    )
    // Active theme unchanged by a deselect.
    expect(screen.getByTestId("active").textContent).toBe("blink-classic-dark")
  })

  it("cannot deselect the last enabled theme", () => {
    render(<Harness initialEnabled={["blink-classic-dark"]} />)

    fireEvent.click(screen.getByTestId("theme-option-blink-classic-dark"))

    expect(screen.getByTestId("enabled").textContent).toBe("|blink-classic-dark|")
  })
})
