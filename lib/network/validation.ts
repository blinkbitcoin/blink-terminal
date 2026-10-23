/**
 * Input validation for /api/network/* route parameters.
 *
 * Ids that reach uuid columns must be validated first: Postgres raises
 * "invalid input syntax for type uuid" on anything else, and a route that
 * lets that escape answers a raw 500 before its own authorization has run
 * (blink-wip#1690 item 1).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i // what Postgres accepts

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value)
}
