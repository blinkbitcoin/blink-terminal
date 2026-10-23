/** @jest-environment node */

/**
 * blink-wip#1590: HTTP span URL attributes keep the path, never the query.
 * Uses real SDK spans (sdk-trace-node), so the hook is exercised against the
 * same Span implementation HttpInstrumentation hands it.
 */

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node"

import { scrubSpanUrlAttributes, stripQuery } from "../../lib/tracing-scrub"

const K1 = "f00dfacecafebeef0123456789abcdef"

const run = (attributes: Record<string, string>) => {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  const span = provider.getTracer("test").startSpan("GET", { attributes })
  scrubSpanUrlAttributes(span)
  span.end()
  return exporter.getFinishedSpans()[0].attributes
}

describe("stripQuery", () => {
  it("keeps the path, drops query and fragment", () => {
    expect(stripQuery("/api/voucher/callback?k1=x&pr=y")).toBe("/api/voucher/callback")
    expect(stripQuery("https://h.example/a/b?x=1#f")).toBe("https://h.example/a/b")
    expect(stripQuery("/a#frag")).toBe("/a")
    expect(stripQuery("/plain")).toBe("/plain")
  })
})

describe("scrubSpanUrlAttributes on real SDK spans", () => {
  it("voucher callback: the k1 never reaches the exported span (old semconv)", () => {
    const out = run({
      "http.method": "GET",
      "http.target": `/api/voucher/callback?k1=${K1}&pr=lnbc1`,
      "http.url": `https://terminal.example/api/voucher/callback?k1=${K1}&pr=lnbc1`,
    })
    expect(JSON.stringify(out)).not.toContain(K1)
    expect(out["http.target"]).toBe("/api/voucher/callback")
    expect(out["http.url"]).toBe("https://terminal.example/api/voucher/callback")
    expect(out["http.method"]).toBe("GET")
  })

  it("Bolt Card tap: p and c never exported (stable semconv)", () => {
    const out = run({
      "url.full": "https://terminal.example/api/boltcard/lnurlw/card-1?p=AABB&c=CCDD",
      "url.path": "/api/boltcard/lnurlw/card-1",
      "url.query": "p=AABB&c=CCDD",
    })
    const text = JSON.stringify(out)
    expect(text).not.toContain("AABB")
    expect(text).not.toContain("CCDD")
    expect(out["url.full"]).toBe("https://terminal.example/api/boltcard/lnurlw/card-1")
    expect(out["url.path"]).toBe("/api/boltcard/lnurlw/card-1")
    expect(out["url.query"]).toBe("[REDACTED]")
  })

  it("leaves query-free URLs untouched", () => {
    const out = run({
      "http.target": "/api/health",
      "http.url": "https://t.example/api/health",
    })
    expect(out["http.target"]).toBe("/api/health")
    expect(out["http.url"]).toBe("https://t.example/api/health")
  })

  it("is a no-op on a span without readable attributes", () => {
    const setAttribute = jest.fn()
    scrubSpanUrlAttributes({ setAttribute } as never)
    expect(setAttribute).not.toHaveBeenCalled()
  })
})
