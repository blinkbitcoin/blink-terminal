/**
 * selectContent - chooses the orange-pill footer for a receipt.
 *
 * Pure, deterministic-by-seed selection logic. No I/O. Given a mode and the
 * receipt date, returns a {@link FooterContent} payload (or null when off).
 *
 * Selection rules:
 * - "ondate": prefer a curated QR link for the receipt's date; if the day has
 *   no links, fall back to a history event for that day; if the day has nothing
 *   at all, fall back to a random quote.
 * - "quote":  a random quote.
 * - "static": a fixed QR to the configured URL.
 *
 * Determinism: when a `seed` is provided (e.g. the payment hash), the same
 * receipt always yields the same footer, so re-prints match the original.
 *
 * @module lib/orangepill/selectContent
 */

import calendarData from "./data/calendar.json"
import quotesData from "./data/quotes.json"
import {
  DEFAULT_STATIC_URL,
  type CalendarData,
  type CalendarLink,
  type FooterContent,
  type OrangePillMode,
  type Quote,
  type SelectFooterOptions,
} from "./types"

const QUOTES = quotesData as Quote[]
const CALENDAR = calendarData as CalendarData

/**
 * Small, stable string hash (FNV-1a) used to derive a deterministic index from
 * a seed. Not cryptographic — only needs to be stable and well-distributed.
 */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // Force unsigned 32-bit.
  return h >>> 0
}

/**
 * Pick an index in [0, length) from a seed (or at random when no seed).
 */
function pickIndex(length: number, seed?: string): number {
  if (length <= 0) return 0
  if (seed) return hashSeed(seed) % length
  return Math.floor(Math.random() * length)
}

/** Format the "MM-DD" key for a date. */
export function dateKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${m}-${d}`
}

/** Strip a leading "YYYY - " prefix from an event string, returning year + text. */
function splitEvent(event: string): { year: string | null; text: string } {
  const m = event.match(/^(\d{4})\s*-\s*(.*)$/s)
  if (m) return { year: m[1], text: m[2].trim() }
  return { year: null, text: event.trim() }
}

/** Build a quote footer from a seeded/random pick. */
function quoteFooter(seed?: string): FooterContent | null {
  if (QUOTES.length === 0) return null
  const q = QUOTES[pickIndex(QUOTES.length, seed)]
  const lines = [`"${q.text}"`]
  return {
    kind: "quote",
    lines,
    caption: q.author ? `- ${q.author}` : undefined,
  }
}

/** Build a caption for a curated link (e.g. "Read: Title - Author"). */
function linkCaption(link: CalendarLink): string {
  const parts = [link.title]
  if (link.author) parts.push(link.author)
  return `Read: ${parts.join(" - ")}`
}

/**
 * Build a footer from a curated link, keeping heading and body coherent.
 *
 * The heading year and the body text are derived from the same source: if the
 * day has an event whose year matches the link's year, that event is the body;
 * otherwise the link's own title is the body. This avoids a "2019 heading /
 * 2011 body" mismatch.
 *
 * @param link  the curated link to feature
 * @param events the day's events (used to find a year-matching event), may be []
 */
function linkFooter(link: CalendarLink, events: string[] = []): FooterContent {
  const heading = link.year ? `On this day, ${link.year}:` : "On this day:"
  let body = link.title

  if (link.year != null) {
    const match = events.map(splitEvent).find((e) => e.year === String(link.year))
    if (match) body = match.text
  }

  return {
    kind: "event",
    heading,
    lines: [body],
    qr: link.url,
    caption: linkCaption(link),
  }
}

/**
 * Build the "on this day" footer for a date, with graceful fallbacks.
 */
function onDateFooter(date: Date, seed?: string): FooterContent | null {
  const day = CALENDAR[dateKey(date)]

  // 1. Prefer a curated link (QR).
  if (day && day.links.length > 0) {
    const link = day.links[pickIndex(day.links.length, seed)]
    return linkFooter(link, day.events)
  }

  // 2. Fall back to a history event (no QR).
  if (day && day.events.length > 0) {
    const ev = day.events[pickIndex(day.events.length, seed)]
    const { year, text } = splitEvent(ev)
    return {
      kind: "event",
      heading: year ? `On this day, ${year}:` : "On this day:",
      lines: [text],
    }
  }

  // 3. Fall back to a quote.
  return quoteFooter(seed)
}

/**
 * Flattened list of all curated links across the calendar (with their day's
 * events, for coherent body text). Built once at module load.
 */
const ALL_LINKS: Array<{ link: CalendarLink; events: string[] }> = (() => {
  const out: Array<{ link: CalendarLink; events: string[] }> = []
  for (const key of Object.keys(CALENDAR)) {
    const day = CALENDAR[key]
    for (const link of day.links) {
      out.push({ link, events: day.events })
    }
  }
  return out
})()

/**
 * Size of the combined shuffle pool (curated links + quotes). The first
 * ALL_LINKS.length indices map to links; the rest map to quotes.
 */
const SHUFFLE_POOL_SIZE = ALL_LINKS.length + QUOTES.length

/**
 * Build a random education footer from the whole pool (curated links + quotes),
 * date-independent. Used by "shuffle" mode so every receipt differs.
 *
 * When `seed` is omitted the pick is fully random (a fresh bit per print).
 */
function shuffleFooter(seed?: string): FooterContent | null {
  if (SHUFFLE_POOL_SIZE === 0) return null
  const idx = pickIndex(SHUFFLE_POOL_SIZE, seed)
  if (idx < ALL_LINKS.length) {
    const entry = ALL_LINKS[idx]
    return linkFooter(entry.link, entry.events)
  }
  // Map the remainder onto the quotes pool.
  const q = QUOTES[idx - ALL_LINKS.length]
  return {
    kind: "quote",
    lines: [`"${q.text}"`],
    caption: q.author ? `- ${q.author}` : undefined,
  }
}

/**
 * Select the footer content for a receipt.
 *
 * @param mode - the configured orange-pill mode
 * @param date - the receipt's date
 * @param options - seed (for determinism) and static URL
 * @returns the footer payload, or null when the footer should be omitted
 */
export function selectFooter(
  mode: OrangePillMode,
  date: Date = new Date(),
  options: SelectFooterOptions = {},
): FooterContent | null {
  const { seed, staticUrl } = options

  switch (mode) {
    case "off":
      return null

    case "quote":
      return quoteFooter(seed)

    case "shuffle":
      return shuffleFooter(seed)

    case "static": {
      const url = staticUrl || DEFAULT_STATIC_URL
      return {
        kind: "static",
        lines: ["Learn more about Bitcoin"],
        qr: url,
        // Use the blog-specific caption only for the default URL; a custom URL
        // gets a generic caption so the receipt isn't misleading.
        caption:
          url === DEFAULT_STATIC_URL
            ? "Scan to read the Blink blog"
            : "Scan to learn more about Bitcoin",
      }
    }

    case "ondate":
      return onDateFooter(date, seed)

    default:
      return null
  }
}

export default selectFooter
