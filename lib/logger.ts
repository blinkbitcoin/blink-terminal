/**
 * Structured logging with Pino + OpenTelemetry trace context
 *
 * Aligned with blink/apps/pay convention: pino@8.20.0, baseLogger singleton.
 * Use `baseLogger.child({ module: "name" })` for per-module context.
 *
 * The OTEL mixin automatically injects `traceId` and `spanId` from the
 * active OpenTelemetry span into every log record, enabling log-to-trace
 * correlation in Jaeger / Grafana / any OTLP-compatible backend.
 *
 * @see https://github.com/GaloyMoney/blink/blob/main/apps/pay/lib/logger.ts
 * @module lib/logger
 */

import pino from "pino"

import { getActiveTraceId, getActiveSpanId } from "./tracing"

/**
 * Fields that must never be written verbatim, wherever a structured log
 * object carries them (blink-wip#1590): API keys, auth headers and cookies,
 * Bolt Card keys K0–K4 and the LNURL k1, generic secrets/tokens/passwords
 * and Nostr secret keys. Defense in depth — call sites should not log these
 * at all. Pino wildcards match one level; the header paths also cover
 * `{ req: { headers } }`-shaped objects.
 */
export const REDACT_PATHS: string[] = [
  ...[
    "apiKey",
    "api_key",
    "apiKeyEncrypted",
    "secret",
    "token",
    "accessToken",
    "refreshToken",
    "password",
    "nsec",
    "privateKey",
    "encryptionKey",
    "k0",
    "k1",
    "k2",
    "k3",
    "k4",
  ].flatMap((field) => [field, `*.${field}`]),
  ...["authorization", "cookie", '["x-api-key"]', '["set-cookie"]'].flatMap((h) => {
    const key = h.startsWith("[") ? h : `.${h}`
    return [`headers${key}`, `*.headers${key}`]
  }),
]

export const loggerOptions: pino.LoggerOptions = {
  level: process.env.LOGLEVEL ?? "info",
  browser: { asObject: true },
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  mixin() {
    const traceId = getActiveTraceId()
    const spanId = getActiveSpanId()
    if (traceId) {
      return { traceId, ...(spanId ? { spanId } : {}) }
    }
    return {}
  },
}

export const baseLogger = pino(loggerOptions)
