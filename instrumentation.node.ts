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

import { NodeSDK } from "@opentelemetry/sdk-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"
import { NetInstrumentation } from "@opentelemetry/instrumentation-net"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { W3CTraceContextPropagator } from "@opentelemetry/core"

const serviceName = process.env.TRACING_SERVICE_NAME || "bbt"
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT

const sdk = new NodeSDK({
  textMapPropagator: new W3CTraceContextPropagator(),
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  }),
  spanProcessor: new SimpleSpanProcessor(
    new OTLPTraceExporter(
      otlpEndpoint ? { url: `${otlpEndpoint}/v1/traces` } : undefined,
    ),
  ),
  instrumentations: [new NetInstrumentation(), new HttpInstrumentation()],
})

sdk.start()

/**
 * Export the SDK instance so lib/shutdown.ts can call sdk.shutdown()
 * during graceful shutdown.
 */
export { sdk as otelSdk }
