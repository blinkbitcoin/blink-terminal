/**
 * Keep bearer secrets out of exported traces (blink-wip#1590).
 *
 * Several routes carry secrets in their URL:
 * - query strings: /api/voucher/callback?k1=<voucher secret>, the Bolt Card
 *   tap's ?p=…&c=…, LNURL payer comments;
 * - path segments: /api/voucher/lnurl/<chargeId>/<amount> and
 *   /api/voucher/status/<chargeId> (chargeId = the voucher's redeemable k1),
 *   /api/boltcard/keys/<registrationId> (single-use key-fetch capability).
 *
 * Those URLs reach spans from more than one source: HttpInstrumentation
 * (http.url / http.target, url.full / url.path / url.query) and Next.js's own
 * root span, which is named `${method} ${req.url}` with http.target = req.url
 * and is renamed to the route pattern only when Next resolves a route.
 *
 * ScrubbingSpanProcessor is therefore applied at the span-processor level,
 * where every span from every instrumentation passes: the inner processor
 * (and its exporter) only ever sees a scrubbed view. Any additional span
 * processor registered with the SDK must be wrapped the same way.
 */

import type { Context } from "@opentelemetry/api"
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-node"

/**
 * Path segments that are bearer capabilities, replaced by their route
 * placeholder. Matched anywhere in a string (bare path, full URL, span name).
 */
const CAPABILITY_SEGMENTS: Array<[RegExp, string]> = [
  [/(\/api\/voucher\/lnurl\/)[^/?#\s]+/g, "$1[chargeId]"],
  [/(\/api\/voucher\/status\/)[^/?#\s]+/g, "$1[chargeId]"],
  [/(\/api\/boltcard\/keys\/)[^/?#\s]+/g, "$1[registrationId]"],
]

/** Attributes that hold a URL or URL part: query and fragment are dropped. */
const URL_ATTRIBUTES = new Set(["http.url", "http.target", "url.full", "url.path"])

/** Replace capability path segments; leaves everything else as is. */
export function scrubCapabilities(value: string): string {
  let out = value
  for (const [pattern, replacement] of CAPABILITY_SEGMENTS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/** "/a/b?x=1#f" -> "/a/b"; "https://h/a?x" -> "https://h/a". */
export function stripQuery(value: string): string {
  const cut = value.search(/[?#]/)
  return cut === -1 ? value : value.substring(0, cut)
}

/** A URL or span name with capability segments replaced and no query string. */
export function scrubUrl(value: string): string {
  return scrubCapabilities(stripQuery(value))
}

/**
 * Free text that may embed URLs — span names ("GET /path?query", Next.js),
 * next.span_name, exception messages: drop the query/fragment that follows
 * any path-like token, and replace capability segments. Prose such as "ok?"
 * or "card #3" is left alone (no preceding "/").
 */
export function scrubText(text: string): string {
  return scrubCapabilities(text.replace(/(\/[^\s?#]*)[?#][^\s"'<>]*/g, "$1"))
}

function scrubAttributes(
  attributes: ReadableSpan["attributes"],
): ReadableSpan["attributes"] {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== "string") {
      out[key] = value
    } else if (key === "url.query") {
      out[key] = value === "" ? value : "[REDACTED]"
    } else if (URL_ATTRIBUTES.has(key)) {
      out[key] = scrubUrl(value)
    } else {
      // e.g. next.span_name, exception.message: URLs embedded in free text
      out[key] = scrubText(value)
    }
  }
  return out as ReadableSpan["attributes"]
}

/** A read-only view of `span` with name, attributes and events scrubbed. */
export function scrubbedView(span: ReadableSpan): ReadableSpan {
  const name = scrubText(span.name)
  const attributes = scrubAttributes(span.attributes)
  const events = span.events.map((event) => ({
    ...event,
    attributes: event.attributes ? scrubAttributes(event.attributes) : event.attributes,
  }))
  return new Proxy(span, {
    get(target, prop, receiver) {
      if (prop === "name") return name
      if (prop === "attributes") return attributes
      if (prop === "events") return events
      const value = Reflect.get(target, prop, receiver)
      // Methods (e.g. spanContext()) run against the real span
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/** Wraps a span processor so it only ever receives scrubbed spans. */
export class ScrubbingSpanProcessor implements SpanProcessor {
  private readonly inner: SpanProcessor

  constructor(inner: SpanProcessor) {
    this.inner = inner
  }

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext)
  }

  onEnd(span: ReadableSpan): void {
    this.inner.onEnd(scrubbedView(span))
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush()
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }
}
