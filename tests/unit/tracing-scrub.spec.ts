/** @jest-environment node */

/**
 * blink-wip#1590: no bearer secret — query string or capability path
 * segment — reaches an exported span.
 *
 * - scrubUrl: the pure rules.
 * - ScrubbingSpanProcessor with real SDK spans (sdk-trace-node), including
 *   a Next.js-shaped root span (`${method} ${req.url}`, http.target = url).
 * - An actual HTTP request through the real HttpInstrumentation, in a child
 *   process (core `http` patching is not reliable inside jest) running the
 *   real lib/tracing-scrub.ts compiled with @swc/core — plus a control run
 *   without the processor proving the probe sees the secrets.
 */

import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

import { trace, type Context } from "@opentelemetry/api"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node"
import { transformSync } from "@swc/core"

import { ScrubbingSpanProcessor, scrubText, scrubUrl } from "../../lib/tracing-scrub"

const K1 = "f00dfacecafebeef0123456789abcdef" // voucher chargeId = redeemable k1
const REG = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d" // Bolt Card key-fetch capability

describe("scrubUrl", () => {
  it.each([
    ["/api/voucher/callback?k1=x&pr=y", "/api/voucher/callback"],
    ["https://h.example/a/b?x=1#f", "https://h.example/a/b"],
    [`/api/voucher/lnurl/${K1}/1000`, "/api/voucher/lnurl/[chargeId]/1000"],
    [`/api/voucher/lnurl/${K1}/1000?other=s`, "/api/voucher/lnurl/[chargeId]/1000"],
    [
      `https://t.example/api/voucher/status/${K1}`,
      "https://t.example/api/voucher/status/[chargeId]",
    ],
    [`/api/boltcard/keys/${REG}`, "/api/boltcard/keys/[registrationId]"],
    // not capabilities: unchanged (query still stripped)
    ["/api/boltcard/lnurlw/card-1?p=AA&c=BB", "/api/boltcard/lnurlw/card-1"],
    ["/api/paycode/lnurlp/alice", "/api/paycode/lnurlp/alice"],
    ["/api/health", "/api/health"],
  ])("%s -> %s", (input, expected) => {
    expect(scrubUrl(input)).toBe(expected)
  })
})

describe("scrubText (span names, messages)", () => {
  it.each([
    [
      `GET /api/voucher/lnurl/${K1}/1000?other=s`,
      "GET /api/voucher/lnurl/[chargeId]/1000",
    ],
    [
      "fetch failed for https://t.example/cb?k1=abc (timeout)",
      "fetch failed for https://t.example/cb (timeout)",
    ],
    ["is it ok? card #3 declined", "is it ok? card #3 declined"],
    ["GET", "GET"],
  ])("%s -> %s", (input, expected) => {
    expect(scrubText(input)).toBe(expected)
  })
})

describe("ScrubbingSpanProcessor with real SDK spans", () => {
  const exportOne = (
    name: string,
    attributes: Record<string, string>,
    event?: Record<string, string>,
  ) => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new ScrubbingSpanProcessor(new SimpleSpanProcessor(exporter))],
    })
    const span = provider.getTracer("test").startSpan(name, { attributes })
    if (event) span.addEvent("exception", event)
    span.end()
    const [exported] = exporter.getFinishedSpans()
    return {
      exported,
      json: JSON.stringify({
        n: exported.name,
        a: exported.attributes,
        e: exported.events,
      }),
    }
  }

  it("a Next.js-shaped root span: name, http.target and an exception message", () => {
    const url = `/api/voucher/lnurl/${K1}/1000?other=query-secret`
    const { exported, json } = exportOne(
      `GET ${url}`,
      { "http.method": "GET", "http.target": url, "next.span_name": `GET ${url}` },
      { "exception.message": `fetch failed for https://t.example${url}` },
    )
    expect(json).not.toContain(K1)
    expect(json).not.toContain("query-secret")
    expect(exported.name).toBe("GET /api/voucher/lnurl/[chargeId]/1000")
    expect(exported.attributes["http.target"]).toBe("/api/voucher/lnurl/[chargeId]/1000")
    expect(exported.attributes["http.method"]).toBe("GET")
  })

  it("HttpInstrumentation-shaped attributes (old and stable semconv)", () => {
    const { exported, json } = exportOne("GET", {
      "http.url": `https://t.example/api/boltcard/keys/${REG}?x=1`,
      "url.full": `https://t.example/api/voucher/status/${K1}`,
      "url.path": `/api/voucher/status/${K1}`,
      "url.query": "p=AABB&c=CCDD",
    })
    for (const secret of [K1, REG, "AABB", "CCDD"]) expect(json).not.toContain(secret)
    expect(exported.attributes["url.query"]).toBe("[REDACTED]")
    expect(exported.attributes["url.path"]).toBe("/api/voucher/status/[chargeId]")
  })

  it("leaves the real span's context and non-secret data intact", () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new ScrubbingSpanProcessor(new SimpleSpanProcessor(exporter))],
    })
    const span = provider.getTracer("test").startSpan("GET /api/health")
    const traceId = span.spanContext().traceId
    span.end()
    const [exported] = exporter.getFinishedSpans()
    expect(exported.spanContext().traceId).toBe(traceId)
    expect(exported.name).toBe("GET /api/health")
  })

  it("forwards lifecycle calls to the inner processor", async () => {
    const inner = {
      onStart: jest.fn(),
      onEnd: jest.fn(),
      forceFlush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }
    const processor = new ScrubbingSpanProcessor(inner)
    const span = trace.getTracer("noop").startSpan("x")
    processor.onStart(span as never, {} as Context)
    await processor.forceFlush()
    await processor.shutdown()
    expect(inner.onStart).toHaveBeenCalled()
    expect(inner.forceFlush).toHaveBeenCalled()
    expect(inner.shutdown).toHaveBeenCalled()
  })
})

describe("actual HTTP requests through the real HttpInstrumentation", () => {
  const ROOT = process.cwd()
  const PATHS = [
    `/api/voucher/lnurl/${K1}/1000?other=query-secret`,
    `/api/voucher/status/${K1}`,
    `/api/boltcard/keys/${REG}`,
    `/api/voucher/callback?k1=${K1}&pr=lnbc1`,
  ]
  let scrubModule: string

  beforeAll(() => {
    // The real lib/tracing-scrub.ts, compiled the way jest compiles it.
    const source = fs.readFileSync(path.join(ROOT, "lib", "tracing-scrub.ts"), "utf8")
    const { code } = transformSync(source, {
      filename: "tracing-scrub.ts",
      jsc: { parser: { syntax: "typescript" }, target: "es2020" },
      module: { type: "commonjs" },
    })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-scrub-"))
    scrubModule = path.join(dir, "tracing-scrub.cjs")
    fs.writeFileSync(scrubModule, code)
  })

  const probe = (scrub: boolean) => {
    const run = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "otel-scrub-probe.cjs")],
      {
        env: {
          ...process.env,
          NODE_PATH: path.join(ROOT, "node_modules"),
          PROBE_PATHS: JSON.stringify(PATHS),
          ...(scrub ? { SCRUB_MODULE: scrubModule } : { SCRUB_MODULE: "" }),
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    )
    if (run.status !== 0) throw new Error(`probe failed: ${run.stderr}`)
    return { spans: JSON.parse(run.stdout) as Array<{ kind: number }>, raw: run.stdout }
  }

  it("control: without the processor the probe exports the secrets", () => {
    const { raw } = probe(false)
    expect(raw).toContain(K1)
    expect(raw).toContain(REG)
  })

  it("with the processor, neither server nor client spans carry a capability or query", () => {
    const { spans, raw } = probe(true)
    expect(spans.length).toBe(PATHS.length * 2) // a server and a client span per request
    expect(new Set(spans.map((s) => s.kind))).toEqual(new Set([1, 2]))
    for (const secret of [K1, REG, "query-secret", "lnbc1"])
      expect(raw).not.toContain(secret)
    expect(raw).toContain("/api/voucher/lnurl/[chargeId]/1000")
    expect(raw).toContain("/api/boltcard/keys/[registrationId]")
  })
})
