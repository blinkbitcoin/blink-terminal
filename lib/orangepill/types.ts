/**
 * Types for the receipt "orange-pill" footer feature.
 *
 * The footer prints a small piece of Bitcoin education on each payment receipt
 * to nudge the recipient toward learning more. Content is sourced from the
 * bitcoinCalendar dataset (see scripts/build-orangepill-data.mjs).
 *
 * @module lib/orangepill/types
 */

/**
 * Footer content mode (user setting).
 * - "off"     : no footer (default)
 * - "ondate"  : "On this day in Bitcoin history" event + curated QR for the
 *               receipt's date, falling back to a quote when the day is empty
 * - "shuffle" : a random education bit (curated link or quote) drawn from the
 *               whole pool, date-independent — different on every receipt
 * - "quote"   : a random Bitcoin quote
 * - "static"  : a fixed QR to a configured URL (defaults to the Blink blog)
 */
export type OrangePillMode = "off" | "ondate" | "shuffle" | "quote" | "static"

/** A single quote entry. */
export interface Quote {
  text: string
  author: string
}

/** A curated article/podcast/video link for a given day. */
export interface CalendarLink {
  year: number | null
  author: string
  title: string
  url: string
}

/** All content recorded for a single calendar day. */
export interface CalendarDay {
  events: string[]
  links: CalendarLink[]
}

/** Map of "MM-DD" -> day content. */
export type CalendarData = Record<string, CalendarDay>

/**
 * The resolved footer payload handed to the ReceiptBuilder.
 * `lines` are pre-wrapping text rows; the builder wraps to paper width.
 */
export interface FooterContent {
  kind: "quote" | "event" | "static"
  /** Heading shown above the body (e.g. "On this day, 2009:"). Optional. */
  heading?: string
  /** Main body text rows (quote text, event text, etc.). */
  lines: string[]
  /** QR code payload (URL). Optional. */
  qr?: string
  /** Caption shown under the QR (e.g. "Read: Bitcoin is Time - Gigi"). Optional. */
  caption?: string
}

/** Options for {@link selectFooter}. */
export interface SelectFooterOptions {
  /**
   * Seed for deterministic selection so reprints of the same receipt are
   * identical. Typically the payment hash.
   */
  seed?: string
  /** Static-mode URL. Defaults to the Blink blog articles page. */
  staticUrl?: string
}

/** Default landing page for static-QR mode. */
export const DEFAULT_STATIC_URL = "https://www.blink.sv/en/blog/articles"

/** Ordered list of modes for settings UI. */
export const ORANGE_PILL_OPTIONS: OrangePillMode[] = [
  "off",
  "ondate",
  "shuffle",
  "quote",
  "static",
]

/** Human-readable labels for each mode. */
export const ORANGE_PILL_LABELS: Record<OrangePillMode, string> = {
  off: "Off",
  ondate: "On this day + QR",
  shuffle: "Shuffle",
  quote: "Random quote",
  static: "Static QR",
}

/** Short descriptions for each mode (settings UI). */
export const ORANGE_PILL_DESCRIPTIONS: Record<OrangePillMode, string> = {
  off: "No Bitcoin education on receipts",
  ondate: "A Bitcoin history fact and curated link for the receipt's date",
  shuffle: "A different random fact or quote on every receipt",
  quote: "A random Bitcoin quote on each receipt",
  static: "A fixed QR code to a page you choose",
}
