/**
 * Time / timestamp utilities shared across the app.
 */

/**
 * Parse a transaction timestamp into milliseconds since epoch.
 *
 * Blink's GraphQL `Timestamp` scalar serializes `createdAt` as Unix seconds
 * (an integer number) — confirmed in the blink monorepo's Timestamp scalar
 * (`Math.floor(date.getTime() / 1000)`). This helper additionally tolerates an
 * ISO-8601 string defensively in case a caller passes a non-API value.
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
