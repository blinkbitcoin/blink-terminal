/**
 * OpenTelemetry SDK setup for the Node.js runtime
 *
 * Initializes the OTEL NodeSDK with:
 * - OTLP HTTP trace exporter (sends spans to any OTEL-compatible collector)
 * - W3C Trace Context propagation (for distributed tracing with Blink core)
 * - Automatic HTTP instrumentation (spans for all inbound/outbound HTTP)
 * - Net instrumentation (low-level network visibility)
 *
 * If OTEL_EXPORTER_OTLP_ENDPOINT is not set, the SDK starts but spans are
 * dropped silently (graceful no-op in environments without a collector).
 *
 * Aligned with blink/apps/pay convention.
 * @see https://github.com/GaloyMoney/blink/blob/main/apps/pay/instrumentation.node.ts
 *
 * @module instrumentation.node
 */

import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { NetInstrumentation } from "@opentelemetry/instrumentation-net"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"

const serviceName = process.env.TRACING_SERVICE_NAME || "bbt"
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT

/**
 * Only initialize tracing when an OTLP collector endpoint is configured.
 *
 * Previously the SDK always started with a SimpleSpanProcessor pointed at the
 * default `http://localhost:4318` collector. In local dev (no collector) the
 * synchronous span export stalled the server's own outbound `fetch` calls
 * intermittently for many seconds, which surfaced as spurious "User Not Found"
 * (LNURL probe timeouts). Skipping init when unconfigured makes it a true no-op,
 * and we use a BatchSpanProcessor (async, non-blocking) when it IS configured.
 */
let sdk: NodeSDK | undefined

if (otlpEndpoint) {
  sdk = new NodeSDK({
    textMapPropagator: new W3CTraceContextPropagator(),
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    spanProcessor: new BatchSpanProcessor(
      new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
    ),
    instrumentations: [new NetInstrumentation(), new HttpInstrumentation()],
  })

  sdk.start()
} else {
  // eslint-disable-next-line no-console
  console.log("[otel] OTEL_EXPORTER_OTLP_ENDPOINT not set — tracing disabled (no-op).")
}

/**
 * Export the SDK instance so lib/shutdown.ts can call sdk.shutdown()
 * during graceful shutdown. May be undefined when tracing is disabled.
 */
export { sdk as otelSdk }
