/**
 * Tests for lib/orangepill/selectContent — footer selection logic.
 */

import { selectFooter, dateKey } from "../../lib/orangepill"
import calendarData from "../../lib/orangepill/data/calendar.json"
import quotesData from "../../lib/orangepill/data/quotes.json"
import { DEFAULT_STATIC_URL, type CalendarData } from "../../lib/orangepill/types"

const CALENDAR = calendarData as CalendarData

describe("orangepill datasets", () => {
  it("ships a non-empty quotes dataset with text + author shape", () => {
    expect(Array.isArray(quotesData)).toBe(true)
    expect(quotesData.length).toBeGreaterThan(100)
    for (const q of quotesData.slice(0, 20)) {
      expect(typeof q.text).toBe("string")
      expect(q.text.length).toBeGreaterThan(0)
      expect(typeof q.author).toBe("string")
    }
  })

  it("ships a calendar keyed by MM-DD with events/links", () => {
    const keys = Object.keys(CALENDAR)
    expect(keys.length).toBeGreaterThan(300)
    for (const k of keys) {
      expect(k).toMatch(/^\d{2}-\d{2}$/)
    }
    // Genesis block day exists.
    expect(CALENDAR["01-03"]).toBeDefined()
    expect(CALENDAR["01-03"].events.join(" ")).toMatch(/Genesis Block/i)
  })
})

describe("dateKey", () => {
  it("formats month and day zero-padded", () => {
    expect(dateKey(new Date(2026, 0, 3))).toBe("01-03")
    expect(dateKey(new Date(2026, 11, 25))).toBe("12-25")
  })
})

describe("selectFooter", () => {
  it("returns null when off", () => {
    expect(selectFooter("off")).toBeNull()
  })

  it("returns a quote footer in quote mode", () => {
    const f = selectFooter("quote", new Date(), { seed: "abc" })
    expect(f).not.toBeNull()
    expect(f!.kind).toBe("quote")
    expect(f!.lines[0]).toMatch(/^".*"$/)
  })

  it("is deterministic for the same seed", () => {
    const a = selectFooter("quote", new Date(), { seed: "deadbeef" })
    const b = selectFooter("quote", new Date(), { seed: "deadbeef" })
    expect(a).toEqual(b)
  })

  it("differs for different seeds (probabilistically)", () => {
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h"]
    const texts = new Set(
      seeds.map((s) => selectFooter("quote", new Date(), { seed: s })!.lines[0]),
    )
    // With 280+ quotes and 8 seeds, expect more than one distinct result.
    expect(texts.size).toBeGreaterThan(1)
  })

  it("static mode returns the default URL when none provided", () => {
    const f = selectFooter("static")
    expect(f!.kind).toBe("static")
    expect(f!.qr).toBe(DEFAULT_STATIC_URL)
  })

  it("static mode honors a custom URL", () => {
    const url = "https://example.com/learn"
    const f = selectFooter("static", new Date(), { staticUrl: url })
    expect(f!.qr).toBe(url)
  })

  it("ondate returns a coherent event/link + QR for a curated day", () => {
    // 01-03 has one curated link (year 2019) and a Genesis event (year 2009).
    // The coherence fix means the body matches the heading's source: since no
    // 2019 event exists, the body is the link title (not the 2009 Genesis event).
    const f = selectFooter("ondate", new Date(2026, 0, 3), { seed: "x" })
    expect(f!.kind).toBe("event")
    expect(f!.heading).toMatch(/On this day, 2019/)
    expect(f!.lines.join(" ")).toMatch(/Two Parts Math/i)
    expect(f!.qr).toMatch(/^https?:\/\//)
    expect(f!.caption).toMatch(/^Read:/)
  })

  it("ondate heading year is coherent with the body (no year mismatch)", () => {
    // Check every day that has at least one link: if the heading carries a year
    // and the body came from an event, the body's year must match the heading.
    for (const key of Object.keys(CALENDAR)) {
      const day = CALENDAR[key]
      if (day.links.length === 0) continue
      const [mm, dd] = key.split("-").map(Number)
      // Try a few seeds to exercise different link picks.
      for (const seed of ["a", "b", "c"]) {
        const f = selectFooter("ondate", new Date(2026, mm - 1, dd), { seed })
        if (!f || f.kind !== "event" || !f.heading) continue
        const headingYear = f.heading.match(/(\d{4})/)?.[1]
        const bodyYear = f.lines.join(" ").match(/^(\d{4})\b/)?.[1]
        if (headingYear && bodyYear) {
          expect(bodyYear).toBe(headingYear)
        }
      }
    }
  })

  it("shuffle returns content (link or quote)", () => {
    const f = selectFooter("shuffle")
    expect(f).not.toBeNull()
    expect(["event", "quote"]).toContain(f!.kind)
  })

  it("shuffle is varied across many unseeded calls", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const f = selectFooter("shuffle")
      seen.add((f!.heading || "") + "|" + f!.lines.join(" ") + "|" + (f!.qr || ""))
    }
    // With ~850 pool items, 50 random draws should yield many distinct results.
    expect(seen.size).toBeGreaterThan(10)
  })

  it("shuffle is deterministic when seeded", () => {
    const a = selectFooter("shuffle", new Date(), { seed: "fixed-seed" })
    const b = selectFooter("shuffle", new Date(), { seed: "fixed-seed" })
    expect(a).toEqual(b)
  })

  it("ondate falls back to a quote for an empty day", () => {
    // Find a date key not present in the calendar.
    let missing: Date | null = null
    for (let m = 0; m < 12 && !missing; m++) {
      for (let d = 1; d <= 28; d++) {
        const key = dateKey(new Date(2026, m, d))
        if (!CALENDAR[key]) {
          missing = new Date(2026, m, d)
          break
        }
      }
    }
    if (!missing) {
      // Calendar is fully populated; nothing to assert.
      return
    }
    const f = selectFooter("ondate", missing, { seed: "y" })
    expect(f!.kind).toBe("quote")
  })
})
