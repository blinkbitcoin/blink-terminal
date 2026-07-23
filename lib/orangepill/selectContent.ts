/**
 * selectContent - chooses the orange-pill footer for a receipt.
 *
 * Deterministic-by-seed selection logic. Given a mode and the receipt date,
 * returns a {@link FooterContent} payload (or null when off).
 *
 * The quotes/calendar dataset (~290 KB of JSON) is loaded lazily via dynamic
 * import the first time a footer is actually needed (i.e. at print time), so
 * it is code-split out of the main client bundle instead of being paid on
 * every first load — including by users who never enable the feature.
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

import {
  DEFAULT_STATIC_URL,
  type CalendarData,
  type CalendarLink,
  type FooterContent,
  type OrangePillMode,
  type Quote,
  type SelectFooterOptions,
} from "./types"

// ─── Lazy dataset loading ─────────────────────────────────────────

interface OrangePillDataset {
  quotes: Quote[]
  calendar: CalendarData
  /** Flattened curated links (with their day's events) for shuffle mode. */
  allLinks: Array<{ link: CalendarLink; events: string[] }>
}

let datasetPromise: Promise<OrangePillDataset> | null = null

/** Load (and cache) the quotes/calendar dataset via dynamic import. */
function loadDataset(): Promise<OrangePillDataset> {
  if (!datasetPromise) {
    datasetPromise = Promise.all([
      import("./data/quotes.json"),
      import("./data/calendar.json"),
    ])
      .then(([quotesModule, calendarModule]) => {
        const quotes = quotesModule.default as Quote[]
        const calendar = calendarModule.default as CalendarData
        const allLinks: Array<{ link: CalendarLink; events: string[] }> = []
        for (const key of Object.keys(calendar)) {
          const day = calendar[key]
          for (const link of day.links) {
            allLinks.push({ link, events: day.events })
          }
        }
        return { quotes, calendar, allLinks }
      })
      .catch((error) => {
        // Reset so a transient load failure (e.g. offline chunk fetch) can
        // be retried on the next print instead of being cached forever.
        datasetPromise = null
        throw error
      })
  }
  return datasetPromise
}

// ─── Selection helpers (pure) ─────────────────────────────────────

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
function quoteFooter(quotes: Quote[], seed?: string): FooterContent | null {
  if (quotes.length === 0) return null
  const q = quotes[pickIndex(quotes.length, seed)]
  const lines = [`"${q.text}"`]
  return {
    kind: "quote",
    lines,
    caption: q.author ? `- ${q.author}` : undefined,
  }
}

/**
 * Max length for a footer body line. Matches the companion deep-link cap so a
 * body chosen here never gets truncated downstream. Quotes are filtered to this
 * length at generation; long history events are handled in onDateFooter.
 */
const MAX_BODY_LEN = 420

/** Truncate text to MAX_BODY_LEN on a word boundary, with an ASCII ellipsis. */
function truncateBody(text: string): string {
  if (text.length <= MAX_BODY_LEN) return text
  const slice = text.slice(0, MAX_BODY_LEN - 3)
  const lastSpace = slice.lastIndexOf(" ")
  const body = lastSpace > MAX_BODY_LEN * 0.6 ? slice.slice(0, lastSpace) : slice
  return body.trimEnd() + "..."
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
    // Use the matching event as the body only when it fits; otherwise keep the
    // (short) link title so the body never gets truncated mid-sentence.
    if (match && match.text.length <= MAX_BODY_LEN) body = match.text
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
function onDateFooter(
  data: OrangePillDataset,
  date: Date,
  seed?: string,
): FooterContent | null {
  const day = data.calendar[dateKey(date)]

  // 1. Prefer a curated link (QR).
  if (day && day.links.length > 0) {
    const link = day.links[pickIndex(day.links.length, seed)]
    return linkFooter(link, day.events)
  }

  // 2. Fall back to a history event (no QR). Clean-truncate long events.
  if (day && day.events.length > 0) {
    const ev = day.events[pickIndex(day.events.length, seed)]
    const { year, text } = splitEvent(ev)
    return {
      kind: "event",
      heading: year ? `On this day, ${year}:` : "On this day:",
      lines: [truncateBody(text)],
    }
  }

  // 3. Fall back to a quote.
  return quoteFooter(data.quotes, seed)
}

/**
 * Build a random education footer from the whole pool (curated links + quotes),
 * date-independent. Used by "shuffle" mode so every receipt differs.
 *
 * When `seed` is omitted the pick is fully random (a fresh bit per print).
 */
function shuffleFooter(data: OrangePillDataset, seed?: string): FooterContent | null {
  const poolSize = data.allLinks.length + data.quotes.length
  if (poolSize === 0) return null
  const idx = pickIndex(poolSize, seed)
  if (idx < data.allLinks.length) {
    const entry = data.allLinks[idx]
    return linkFooter(entry.link, entry.events)
  }
  // Map the remainder onto the quotes pool.
  const q = data.quotes[idx - data.allLinks.length]
  return {
    kind: "quote",
    lines: [`"${q.text}"`],
    caption: q.author ? `- ${q.author}` : undefined,
  }
}

/**
 * Select the footer content for a receipt.
 *
 * Async because the dataset is dynamically imported on first use (and cached
 * afterwards); "off" and "static" resolve without touching the dataset.
 *
 * @param mode - the configured orange-pill mode
 * @param date - the receipt's date
 * @param options - seed (for determinism) and static URL
 * @returns the footer payload, or null when the footer should be omitted
 */
export async function selectFooter(
  mode: OrangePillMode,
  date: Date = new Date(),
  options: SelectFooterOptions = {},
): Promise<FooterContent | null> {
  const { seed, staticUrl } = options

  switch (mode) {
    case "off":
      return null

    case "quote":
      return quoteFooter((await loadDataset()).quotes, seed)

    case "shuffle":
      return shuffleFooter(await loadDataset(), seed)

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
      return onDateFooter(await loadDataset(), date, seed)

    default:
      return null
  }
}

export default selectFooter
