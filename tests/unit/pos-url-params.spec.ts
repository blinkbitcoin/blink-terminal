/**
 * Tests for lib/pos-url-params.ts
 *
 * The public POS parses `?amount=&memo=&display=` with pay.blink.sv semantics:
 * amount is in the display currency's major units (whole sats for bitcoin
 * displays), display accepts fiat codes or SAT/BTC (normalized to the
 * terminal-internal "BTC" sats id), memo is free text capped at 200 chars.
 */

import {
  MAX_MEMO_LEN,
  normalizePosAmountParam,
  normalizePosDisplayParam,
  normalizePosMemoParam,
  parsePosUrlParams,
} from "../../lib/pos-url-params"

describe("normalizePosDisplayParam", () => {
  it.each(["SAT", "sat", "Sat", "BTC", "btc", "BTC-BIP177"])(
    "maps sats representations (%s) to BTC",
    (input) => {
      expect(normalizePosDisplayParam(input)).toBe("BTC")
    },
  )

  it.each(["USD", "eur", "Crc", "US"])(
    "passes fiat-shaped codes through uppercased (%s)",
    (input) => {
      expect(normalizePosDisplayParam(input)).toBe(input.toUpperCase())
    },
  )

  it("rejects underscore variant ids (street/citrus), matching the native app's CURRENCY_RE", () => {
    expect(normalizePosDisplayParam("MZN_STREET")).toBeUndefined()
  })

  it.each([
    undefined,
    "",
    "   ",
    "usd$",
    "U1D",
    "TOOLONGCODE", // 11 chars > regex max of 8
    "SATOSHI NAKAMOTO",
  ])("rejects invalid display values (%s)", (input) => {
    expect(normalizePosDisplayParam(input)).toBeUndefined()
  })

  it("takes the first entry of a repeated param", () => {
    expect(normalizePosDisplayParam(["EUR", "USD"])).toBe("EUR")
  })
})

describe("normalizePosAmountParam", () => {
  it("keeps fiat major units as-is", () => {
    expect(normalizePosAmountParam("21", "USD")).toBe("21")
    expect(normalizePosAmountParam("21.50", "USD")).toBe("21.5")
  })

  it("clamps fiat amounts to 2dp (pay semantics)", () => {
    expect(normalizePosAmountParam("21.999", "USD")).toBe("22")
    expect(normalizePosAmountParam("0.099", "EUR")).toBe("0.1")
  })

  it("rounds to whole sats for bitcoin displays", () => {
    expect(normalizePosAmountParam("21.6", "BTC")).toBe("22")
    expect(normalizePosAmountParam("21000.4", "BTC")).toBe("21000")
  })

  it("treats amounts as fiat when display is absent (USD default)", () => {
    expect(normalizePosAmountParam("10.005", undefined)).toBe("10.01")
  })

  it.each(["0", "0.00", "-5", "abc", "", "  ", "0.001", "NaN", "Infinity"])(
    "drops non-positive, non-numeric, and rounds-to-zero amounts (%s)",
    (input) => {
      expect(normalizePosAmountParam(input, "USD")).toBeUndefined()
      expect(normalizePosAmountParam(input, "BTC")).toBeUndefined()
    },
  )

  it("drops sub-1-sat bitcoin amounts after rounding", () => {
    expect(normalizePosAmountParam("0.4", "BTC")).toBeUndefined()
  })

  it("handles scientific notation and whitespace", () => {
    expect(normalizePosAmountParam(" 1e3 ", "USD")).toBe("1000")
  })

  it("takes the first entry of a repeated param", () => {
    expect(normalizePosAmountParam(["5", "10"], "USD")).toBe("5")
  })
})

describe("normalizePosMemoParam", () => {
  it("trims and keeps the memo", () => {
    expect(normalizePosMemoParam("  hello world  ")).toBe("hello world")
  })

  it("caps the memo at MAX_MEMO_LEN", () => {
    const long = "x".repeat(MAX_MEMO_LEN + 50)
    expect(normalizePosMemoParam(long)).toHaveLength(MAX_MEMO_LEN)
  })

  it.each([undefined, "", "   "])("drops empty memos (%s)", (input) => {
    expect(normalizePosMemoParam(input)).toBeUndefined()
  })

  it("takes the first entry of a repeated param", () => {
    expect(normalizePosMemoParam(["a", "b"])).toBe("a")
  })
})

describe("parsePosUrlParams", () => {
  it("parses the canonical pay.blink.sv link shape", () => {
    expect(parsePosUrlParams({ amount: "21", memo: "test", display: "USD" })).toEqual({
      display: "USD",
      amount: "21",
      memo: "test",
    })
  })

  it("maps display=SAT to BTC and interprets amount as sats", () => {
    expect(parsePosUrlParams({ amount: "21000.7", display: "SAT" })).toEqual({
      display: "BTC",
      amount: "21001",
      memo: undefined,
    })
  })

  it("returns all-undefined for an empty query", () => {
    expect(parsePosUrlParams({})).toEqual({
      display: undefined,
      amount: undefined,
      memo: undefined,
    })
  })

  it("keeps a valid amount when display is invalid (fiat default)", () => {
    expect(parsePosUrlParams({ amount: "5.25", display: "???" })).toEqual({
      display: undefined,
      amount: "5.25",
      memo: undefined,
    })
  })

  it("ignores unrelated params", () => {
    expect(
      parsePosUrlParams({ display: "EUR", lightning: "LNURL1..." } as never),
    ).toEqual({ display: "EUR", amount: undefined, memo: undefined })
  })
})
