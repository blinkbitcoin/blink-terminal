/**
 * Strip query strings from HTTP span URL attributes (blink-wip#1590).
 *
 * @opentelemetry/instrumentation-http records the full request target on
 * every incoming and outgoing span (`http.url`, `http.target`, and under the
 * stable conventions `url.full`, `url.query`). Several routes carry bearer
 * secrets in the query: `/api/voucher/callback?k1=<voucher secret>&pr=…`,
 * `/api/boltcard/lnurlw/<id>?p=…&c=…` (the tap authorization), LNURL-pay
 * callbacks with payer comments. Traces do not need query strings; the path
 * and route are kept.
 *
 * Used as HttpInstrumentation's requestHook, which runs right after the span
 * is created with those attributes.
 */

import type { Span } from "@opentelemetry/api"

const URL_ATTRIBUTES = ["http.url", "http.target", "url.full"] as const

/** "/a/b?x=1#f" -> "/a/b"; "https://h/a?x" -> "https://h/a". */
export function stripQuery(value: string): string {
  const cut = value.search(/[?#]/)
  return cut === -1 ? value : value.substring(0, cut)
}

/** Overwrite query-bearing URL attributes on `span` with their path-only form. */
export function scrubSpanUrlAttributes(span: Span): void {
  // SDK spans expose the attributes they were started with.
  const attributes = (span as unknown as { attributes?: Record<string, unknown> })
    .attributes
  if (!attributes) return
  for (const key of URL_ATTRIBUTES) {
    const value = attributes[key]
    if (typeof value === "string" && /[?#]/.test(value)) {
      span.setAttribute(key, stripQuery(value))
    }
  }
  if (typeof attributes["url.query"] === "string" && attributes["url.query"] !== "") {
    span.setAttribute("url.query", "[REDACTED]")
  }
}
