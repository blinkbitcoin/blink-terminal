/**
 * Tests for asciiizeReceiptText — printer-safe ASCII transliteration.
 */

import { asciiizeReceiptText } from "../../lib/escpos/asciiize"

/** True if every character is in the 7-bit ASCII range (0–127). */
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return false
  }
  return true
}

describe("asciiizeReceiptText", () => {
  it("maps em/en dashes and horizontal bar to hyphen", () => {
    expect(asciiizeReceiptText("a — b – c ― d")).toBe("a - b - c - d")
  })

  it("maps the ellipsis to three dots", () => {
    expect(asciiizeReceiptText("wait…")).toBe("wait...")
  })

  it("maps smart quotes to straight quotes", () => {
    expect(asciiizeReceiptText("\u201Chello\u201D \u2018world\u2019")).toBe(
      "\"hello\" 'world'",
    )
  })

  it("strips diacritics from accented Latin letters", () => {
    expect(asciiizeReceiptText("Maréchal")).toBe("Marechal")
    expect(asciiizeReceiptText("Böhm-Bawerk")).toBe("Bohm-Bawerk")
    expect(asciiizeReceiptText("Häagen")).toBe("Haagen")
  })

  it("handles ligatures and special Latin letters", () => {
    expect(asciiizeReceiptText("conﬂict")).toBe("conflict")
    expect(asciiizeReceiptText("Wałęsa")).toBe("Walesa")
  })

  it("produces pure ASCII for the Hazlitt quote", () => {
    const input =
      "Mere inflation \u2014 that is, the mere issuance of more money \u2014 may look like..."
    const out = asciiizeReceiptText(input)
    expect(isAscii(out)).toBe(true)
    expect(out).toContain("Mere inflation - that is")
  })

  it("preserves newlines and tabs", () => {
    expect(asciiizeReceiptText("a\nb\tc")).toBe("a\nb\tc")
  })

  it("drops unmappable non-ASCII characters", () => {
    // An emoji has no ASCII equivalent and should be removed.
    const out = asciiizeReceiptText("hi 😀 there")
    expect(isAscii(out)).toBe(true)
    expect(out).toContain("hi")
    expect(out).toContain("there")
  })

  it("is idempotent on already-ASCII text", () => {
    const s = "Plain ASCII text - with dashes and 'quotes'."
    expect(asciiizeReceiptText(s)).toBe(s)
  })
})
