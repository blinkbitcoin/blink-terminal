/**
 * lib/orangepill - receipt "orange-pill" footer.
 *
 * Adds a small piece of Bitcoin education (a date-matched history event + QR,
 * a random quote, or a static QR) to payment receipts. Content is sourced from
 * the bitcoinCalendar dataset and bundled as JSON for offline use.
 *
 * @module lib/orangepill
 */

export { selectFooter, dateKey } from "./selectContent"
export {
  DEFAULT_STATIC_URL,
  ORANGE_PILL_OPTIONS,
  ORANGE_PILL_LABELS,
  ORANGE_PILL_DESCRIPTIONS,
  type OrangePillMode,
  type Quote,
  type CalendarLink,
  type CalendarDay,
  type CalendarData,
  type FooterContent,
  type SelectFooterOptions,
} from "./types"
