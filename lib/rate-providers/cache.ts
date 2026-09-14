/**
 * Rate Cache Manager
 *
 * Caches exchange rates in Redis with configurable TTL.
 * Citrusrate recommends 30-60 second caching.
 *
 * Uses the shared Redis lifecycle from lib/redis.ts (bounded initial connect,
 * fail-fast during reconnect gaps) rather than a hand-rolled client — see that
 * file for why. When hybrid storage is off or Redis is unavailable, every
 * function here degrades to a no-op / cache miss and callers fall back to
 * inline upstream fetches.
 */

import { RedisClientType } from "redis"

import { getSharedRedisClient } from "../redis"

// Cache configuration
const RATE_CACHE_TTL: number = 45 // seconds (between 30-60 recommended by Citrusrate)
// All Redis keys use the "blink-terminal:" prefix to avoid collisions in shared Redis instances.
const CACHE_KEY_PREFIX: string = "blink-terminal:rate:"

export interface CachedRate {
  [key: string]: unknown
  cachedAt?: string
}

/**
 * Get the shared Redis client, or null when caching is unavailable
 * (hybrid storage off, or Redis down — callers then behave as cache-miss).
 */
async function getRedisClient(): Promise<RedisClientType | null> {
  try {
    return await getSharedRedisClient()
  } catch {
    return null
  }
}

/**
 * Generate cache key for a rate
 * @param provider - Provider ID (e.g., 'blink', 'citrusrate_street')
 * @param currency - Currency code
 * @returns Cache key
 */
function getCacheKey(provider: string, currency: string): string {
  return `${CACHE_KEY_PREFIX}${provider}:${currency.toUpperCase()}`
}

/**
 * Get cached rate
 * @param provider - Provider ID
 * @param currency - Currency code
 * @returns Cached rate or null if not found/expired
 */
export async function getCachedRate(
  provider: string,
  currency: string,
): Promise<CachedRate | null> {
  try {
    const redis: RedisClientType | null = await getRedisClient()
    if (!redis) {
      return null
    }

    const cacheKey: string = getCacheKey(provider, currency)
    const cached: string | null = await redis.get(cacheKey)

    if (cached) {
      const rate: CachedRate = JSON.parse(cached) as CachedRate
      console.log(`Rate cache HIT: ${cacheKey}`)
      return rate
    }

    console.log(`Rate cache MISS: ${cacheKey}`)
    return null
  } catch (error: unknown) {
    console.warn("Rate cache get error:", (error as Error).message)
    return null
  }
}

/**
 * Cache a rate
 * @param provider - Provider ID
 * @param currency - Currency code
 * @param rate - Rate data to cache
 * @param ttl - TTL in seconds (optional, defaults to RATE_CACHE_TTL)
 */
export async function setCachedRate(
  provider: string,
  currency: string,
  rate: CachedRate,
  ttl: number = RATE_CACHE_TTL,
): Promise<void> {
  try {
    const redis: RedisClientType | null = await getRedisClient()
    if (!redis) {
      return
    }

    const cacheKey: string = getCacheKey(provider, currency)
    await redis.setEx(
      cacheKey,
      ttl,
      JSON.stringify({
        ...rate,
        cachedAt: new Date().toISOString(),
      }),
    )

    console.log(`Rate cached: ${cacheKey} (TTL: ${ttl}s)`)
  } catch (error: unknown) {
    console.warn("Rate cache set error:", (error as Error).message)
  }
}

/**
 * Invalidate a cached rate
 * @param provider - Provider ID
 * @param currency - Currency code
 */
export async function invalidateCachedRate(
  provider: string,
  currency: string,
): Promise<void> {
  try {
    const redis: RedisClientType | null = await getRedisClient()
    if (!redis) {
      return
    }

    const cacheKey: string = getCacheKey(provider, currency)
    await redis.del(cacheKey)
    console.log(`Rate cache invalidated: ${cacheKey}`)
  } catch (error: unknown) {
    console.warn("Rate cache invalidate error:", (error as Error).message)
  }
}

/**
 * Clear all cached rates
 */
export async function clearAllCachedRates(): Promise<void> {
  try {
    const redis: RedisClientType | null = await getRedisClient()
    if (!redis) {
      return
    }

    const keys: string[] = await redis.keys(`${CACHE_KEY_PREFIX}*`)
    if (keys.length > 0) {
      await redis.del(keys)
      console.log(`Cleared ${keys.length} cached rates`)
    }
  } catch (error: unknown) {
    console.warn("Rate cache clear error:", (error as Error).message)
  }
}

/**
 * Cache multiple rates at once (used by the Citrusrate poller)
 * @param provider - Provider ID
 * @param rates - Map of currency code to rate data
 * @param ttl - TTL in seconds (optional, defaults to RATE_CACHE_TTL)
 */
export async function setCachedRatesBulk(
  provider: string,
  rates: Record<string, CachedRate>,
  ttl: number = RATE_CACHE_TTL,
): Promise<void> {
  try {
    const redis: RedisClientType | null = await getRedisClient()
    if (!redis) {
      return
    }

    const cachedAt: string = new Date().toISOString()
    const pipeline = redis.multi()
    for (const [currency, rate] of Object.entries(rates)) {
      const cacheKey: string = getCacheKey(provider, currency)
      pipeline.setEx(cacheKey, ttl, JSON.stringify({ ...rate, cachedAt }))
    }
    await pipeline.exec()

    console.log(
      `Rate cache bulk write: ${provider} (${Object.keys(rates).length} currencies, TTL: ${ttl}s)`,
    )
  } catch (error: unknown) {
    console.warn("Rate cache bulk set error:", (error as Error).message)
  }
}

export { RATE_CACHE_TTL }
