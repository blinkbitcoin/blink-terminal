/**
 * Log redaction helpers (blink-wip#1590).
 *
 * Some identifiers are bearer secrets: a voucher id is the LNURL-withdraw k1
 * that redeems it, so the full value must never reach stdout, log shipping or
 * traces. Log a short prefix instead — enough to correlate lines, useless for
 * redemption.
 */

/** First 8 characters plus an ellipsis; "missing" for empty input. */
export function shortId(id: string | null | undefined): string {
  if (!id) return "missing"
  return id.length <= 8 ? `${id.substring(0, 2)}…` : `${id.substring(0, 8)}…`
}
