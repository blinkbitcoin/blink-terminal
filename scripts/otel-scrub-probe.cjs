/* eslint-disable @typescript-eslint/no-require-imports, import/order --
   CommonJS script; `http` must be required after the instrumentation is
   enabled, so require order is deliberate. */
/**
 * OTel trace-scrub probe (blink-wip#1590) — spawned by
 * tests/unit/tracing-scrub.spec.ts.
 *
 * Patching core `http` with HttpInstrumentation is not reliable inside the
 * jest sandbox, so the spec runs this plain-Node script instead: real
 * HttpInstrumentation, a real HTTP server and client, an in-memory exporter.
 *
 * env:
 *   SCRUB_MODULE  path to a CommonJS build of lib/tracing-scrub.ts (the spec
 *                 compiles the real module with @swc/core); unset = no
 *                 scrubbing (control run)
 *   PROBE_PATHS   JSON array of request paths
 *
 * Prints the exported spans (name + attributes + events) as JSON on stdout.
 */

const {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} = require("@opentelemetry/sdk-trace-node")
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http")

const exporter = new InMemorySpanExporter()
let processor = new SimpleSpanProcessor(exporter)
if (process.env.SCRUB_MODULE) {
  const { ScrubbingSpanProcessor } = require(process.env.SCRUB_MODULE)
  processor = new ScrubbingSpanProcessor(processor)
}
const provider = new NodeTracerProvider({ spanProcessors: [processor] })
provider.register()

const instrumentation = new HttpInstrumentation()
instrumentation.setTracerProvider(provider)
instrumentation.enable()

// Required after the instrumentation is enabled so it is patched.
const http = require("http")

const paths = JSON.parse(process.env.PROBE_PATHS || "[]")

const server = http
  .createServer((req, res) => res.end("ok"))
  .listen(0, async () => {
    const port = server.address().port
    for (const path of paths) {
      await new Promise((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}${path}`, (res) => {
            res.resume()
            res.on("end", resolve)
          })
          .on("error", reject)
      })
    }
    await new Promise((r) => setTimeout(r, 50))
    await provider.forceFlush()
    const spans = exporter.getFinishedSpans().map((s) => ({
      name: s.name,
      kind: s.kind,
      attributes: s.attributes,
      events: s.events.map((e) => ({ name: e.name, attributes: e.attributes })),
    }))
    process.stdout.write(JSON.stringify(spans))
    server.close()
  })
