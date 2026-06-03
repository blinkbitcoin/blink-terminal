/**
 * Time / timestamp utilities shared across the app.
 */

/**
 * Parse a transaction timestamp into milliseconds since epoch.
 *
 * Blink's `createdAt` can arrive either as a Unix timestamp in seconds
 * (number) or as an ISO-8601 string (e.g. "2024-01-15T10:30:00Z").
 *
 * - number  -> treated as Unix seconds, multiplied by 1000
 * - string  -> parsed via Date.parse
 *
 * Returns `NaN` only if the input is an unparsable string; callers that
 * need a guaranteed value should fall back to `Date.now()`.
 *
 * @param createdAt - Unix seconds (number) or ISO date string
 * @returns milliseconds since epoch
 */
export function parseTxTimestamp(createdAt: string | number): number {
  if (typeof createdAt === "number") {
    // Unix timestamp in seconds
    return createdAt * 1000
  }
  return new Date(createdAt).getTime()
}
