/**
 * Coordinated graceful shutdown handler
 *
 * Registers a single SIGTERM/SIGINT handler that runs all cleanup callbacks
 * in registration order. This replaces scattered `process.on` calls and
 * prevents the "only the last handler runs" race.
 *
 * OTEL SDK shutdown is integrated: the SDK is flushed/shut down as the
 * last step to ensure all pending spans are exported before exit.
 *
 * Usage:
 *   import { onShutdown } from "../lib/shutdown"
 *   onShutdown("SharedPool", async () => { await pool.end() })
 *
 * @module lib/shutdown
 */

import { baseLogger } from "./logger"

const logger = baseLogger.child({ module: "shutdown" })

type ShutdownCallback = () => Promise<void> | void

interface ShutdownEntry {
  name: string
  callback: ShutdownCallback
}

const callbacks: ShutdownEntry[] = []
let registered = false
let shuttingDown = false

/** Timeout for the entire shutdown sequence (ms). */
const SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * Register a named cleanup callback to run during graceful shutdown.
 * Callbacks execute in registration order.
 */
export function onShutdown(name: string, callback: ShutdownCallback): void {
  callbacks.push({ name, callback })
  ensureHandlersRegistered()
}

function ensureHandlersRegistered(): void {
  if (registered) return
  registered = true

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return // prevent double-shutdown
    shuttingDown = true

    logger.info({ signal, callbackCount: callbacks.length }, "Shutdown initiated")

    // Force-exit after timeout
    const timer = setTimeout(() => {
      console.error(`[Shutdown] Timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`)
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)

    // Allow the timer to not keep the event loop alive on its own
    if (timer.unref) {
      timer.unref()
    }

    for (const entry of callbacks) {
      try {
        logger.info({ name: entry.name }, "Running shutdown callback")
        await entry.callback()
      } catch (err) {
        logger.error({ name: entry.name, err }, "Shutdown callback failed")
      }
    }

    // Flush and shut down the OTEL SDK last, so all pending spans
    // (including those generated during earlier callbacks) are exported.
    try {
      const { otelSdk } = await import("../instrumentation.node")
      // otelSdk is undefined when tracing is disabled (no OTLP endpoint).
      await otelSdk?.shutdown()
      if (otelSdk) logger.info("OTEL SDK shut down")
    } catch (_err) {
      // OTEL may not be initialised (e.g. tests, edge runtime) — that's fine.
    }

    logger.info("All shutdown callbacks completed")
    clearTimeout(timer)
    process.exit(0)
  }

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((err) => {
      console.error("[Shutdown] SIGTERM handler error:", err)
    })
  })
  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((err) => {
      console.error("[Shutdown] SIGINT handler error:", err)
    })
  })
}
