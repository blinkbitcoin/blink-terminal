/**
 * Citrusrate Rate Poller
 *
 * Server-side background poller that keeps the shared Redis rate cache warm,
 * so client requests to /api/rates/exchange-rate are served from cache instead
 * of triggering an upstream Citrusrate call per cache miss.
 *
 * Pattern: the backend pulls from Citrusrate on a FIXED SCHEDULE and fans out
 * to all clients via the shared cache — upstream request volume is driven by
 * the poll cadence, not by the number of connected POS clients.
 *
 * Per tick (every 60s):
 * - 1x GET /v1/btc/all           -> warms ALL official currencies at once
 * - 13x GET /v1/btc/blackmarket  -> one per supported street-rate currency
 *   (the /blackmarket/all endpoint requires a scope this key does not have)
 *
 * Volume: ~14 calls/min (~20K/day) — within Citrusrate Basic tier limits
 * (rates:btc_all 5 req/min, rates:btc:blackmarket:single 60 req/min).
 *
 * Started from instrumentation.node.ts (Node.js runtime only). Requires a
 * long-lived server process (self-hosted / docker-compose); on serverless the
 * inline per-request fetch in the exchange-rate route remains the fallback.
 */

import { setCachedRatesBulk, CachedRate } from "./cache"
import { getCitrusrateAPI, CitrusrateRateData } from "./citrusrate"
import {
  CITRUSRATE_EXCLUSIVE_CURRENCIES,
  CITRUSRATE_ALT_CURRENCIES,
} from "./citrusrate-currencies"

import { STREET_RATE_CURRENCIES } from "./index"

const POLL_INTERVAL_MS: number = 60_000
// Cache TTL must outlive the poll interval, otherwise entries expire before
// the next tick lands and requests in the gap fall through to inline fetches
const POLLER_CACHE_TTL_SECS: number = 120
// Spread the 13 sequential black-market calls over the tick to avoid bursting
const BLACKMARKET_CALL_SPACING_MS: number = 500

// Persist across module re-instantiation (Next.js dev can re-import modules)
const globalState = globalThis as typeof globalThis & {
  __citrusratePollerStarted?: boolean
}

/**
 * Fetch all official Citrusrate rates and write them to the shared cache.
 * One upstream call warms every official currency:
 * - exclusive currencies under their plain id (e.g. "AOA", "VUV")
 * - alternative currencies under their _CITRUS id (e.g. "NGN_CITRUS"),
 *   matching the cache keys the exchange-rate route looks up
 */
async function pollOfficialRates(): Promise<void> {
  const citrusrate = getCitrusrateAPI()
  const allRates = await citrusrate.getAllOfficialRates()

  const rates: Record<string, CachedRate> = {}

  for (const currency of CITRUSRATE_EXCLUSIVE_CURRENCIES) {
    const rate: CitrusrateRateData | undefined = allRates.rates[currency.id]
    if (rate) {
      rates[currency.id] = { ...rate, currency: currency.id }
    }
  }

  for (const alt of CITRUSRATE_ALT_CURRENCIES) {
    const rate: CitrusrateRateData | undefined = allRates.rates[alt.baseId]
    if (rate) {
      rates[alt.id] = { ...rate, currency: alt.id }
    }
  }

  await setCachedRatesBulk("citrusrate_official", rates, POLLER_CACHE_TTL_SECS)
}

/**
 * Fetch black-market rates for all supported street-rate currencies.
 * Sequential with spacing: per-currency endpoint only, 60 req/min Basic limit.
 * Individual failures are logged and skipped so one bad currency cannot
 * stall the rest of the tick.
 */
async function pollStreetRates(): Promise<void> {
  const citrusrate = getCitrusrateAPI()

  for (const street of STREET_RATE_CURRENCIES) {
    try {
      const rate: CitrusrateRateData = await citrusrate.getBlackMarketRate(street.baseId)
      await setCachedRatesBulk(
        "citrusrate_street",
        { [street.id]: { ...rate, currency: street.id } },
        POLLER_CACHE_TTL_SECS,
      )
    } catch (error: unknown) {
      console.warn(
        `[citrusrate-poller] street rate failed for ${street.baseId}:`,
        error instanceof Error ? error.message : error,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, BLACKMARKET_CALL_SPACING_MS))
  }
}

async function tick(): Promise<void> {
  try {
    await pollOfficialRates()
  } catch (error: unknown) {
    console.warn(
      "[citrusrate-poller] official rates tick failed:",
      error instanceof Error ? error.message : error,
    )
  }
  await pollStreetRates()
}

/**
 * Start the background poller. Idempotent — safe to call more than once.
 * No-ops (with a log line) when CITRUSRATE_API_KEY is not configured.
 */
export function startCitrusratePoller(): void {
  if (globalState.__citrusratePollerStarted) {
    return
  }

  if (!process.env.CITRUSRATE_API_KEY) {
    console.log(
      "[citrusrate-poller] CITRUSRATE_API_KEY not set — poller disabled " +
        "(exchange-rate route will fetch inline on cache miss)",
    )
    return
  }

  globalState.__citrusratePollerStarted = true

  console.log(
    `[citrusrate-poller] started (interval: ${POLL_INTERVAL_MS / 1000}s, ` +
      `${CITRUSRATE_EXCLUSIVE_CURRENCIES.length} exclusive + ` +
      `${CITRUSRATE_ALT_CURRENCIES.length} alt + ` +
      `${STREET_RATE_CURRENCIES.length} street currencies)`,
  )

  // Warm the cache immediately, then keep it fresh on the fixed schedule
  const runTick = (): void => {
    tick().catch((error: unknown) =>
      console.warn(
        "[citrusrate-poller] tick failed:",
        error instanceof Error ? error.message : error,
      ),
    )
  }
  runTick()
  setInterval(runTick, POLL_INTERVAL_MS)
}
