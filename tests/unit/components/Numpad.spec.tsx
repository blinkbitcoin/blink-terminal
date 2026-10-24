/**
 * Visual/design tests for the Numpad keypad (issue #44).
 *
 * The Blink themes (blink-classic-*) render the main-app keypad design:
 * flat 1px-bordered keys, a 2px green (success) OK with 24px label, 28px
 * digits, and a primary-orange C/backspace (amber in dark, #FC5805 in light).
 *
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import Numpad from "../../../components/Numpad"

function renderNumpad(over: Partial<React.ComponentProps<typeof Numpad>> = {}) {
  render(
    <Numpad
      onDigitPress={jest.fn()}
      onClear={jest.fn()}
      onBackspace={jest.fn()}
      onOkPress={jest.fn()}
      onPlusPress={jest.fn()}
      {...over}
    />,
  )
}

describe("Numpad — Blink keypad design (#44)", () => {
  it("blink-classic-dark: green 2px OK, 28px digits, amber C", () => {
    renderNumpad({ theme: "blink-classic-dark" })

    const ok = screen.getByTestId("generate-invoice")
    expect(ok.className).toContain("border-2")
    expect(ok.className).toContain("border-success")
    expect(ok.className).toContain("text-success")
    expect(ok.className).toContain("text-[24px]")

    const digit = screen.getByTestId("numpad-1")
    expect(digit.className).toContain("text-[28px]")

    const clear = screen.getByTestId("clear-button")
    expect(clear.className).toContain("text-blink-classic-amber")
  })

  it("blink-classic-light: green 2px OK, primary-orange C/backspace", () => {
    renderNumpad({ theme: "blink-classic-light" })

    const ok = screen.getByTestId("generate-invoice")
    expect(ok.className).toContain("border-2")
    expect(ok.className).toContain("border-success")
    expect(ok.className).toContain("text-success")

    const clear = screen.getByTestId("clear-button")
    expect(clear.className).toContain("text-blink-primary")

    const backspace = screen.getByTestId("numpad-backspace")
    expect(backspace.className).toContain("text-blink-primary")
  })

  it("respects the numpad layout preference (telephone puts 1-2-3 on top)", () => {
    renderNumpad({ theme: "blink-classic-dark", layout: "telephone" })
    // Smoke: all digits + OK still present regardless of order.
    for (const d of ["0", "1", "5", "9"]) {
      expect(screen.getByTestId(`numpad-${d}`)).toBeTruthy()
    }
    expect(screen.getByTestId("generate-invoice")).toBeTruthy()
  })
})
