/**
 * Rate Cache Manager
 *
 * Caches exchange rates in Redis with configurable TTL.
 * Citrusrate recommends 30-60 second caching.
 */

import { createClient, RedisClientType } from "redis"

// Cache configuration
const RATE_CACHE_TTL: number = 45 // seconds (between 30-60 recommended by Citrusrate)
const CACHE_KEY_PREFIX: string = "blink-terminal:rate:"

// Redis client singleton
let redisClient: RedisClientType | null = null
let isConnected: boolean = false

export interface CachedRate {
  [key: string]: unknown
  cachedAt?: string
}

/**
 * Get or create Redis client for rate caching
 */
async function getRedisClient(): Promise<RedisClientType | null> {
  if (redisClient && isConnected) {
    return redisClient
  }

  try {
    redisClient = createClient({
      socket: {
        host: process.env.REDIS_HOST || "localhost",
        port: parseInt(process.env.REDIS_PORT || "6379"),
      },
      password: process.env.REDIS_PASSWORD || undefined,
      database: parseInt(process.env.REDIS_DB || "0"),
    }) as RedisClientType

    redisClient.on("error", (err: Error) => {
      console.error("Rate cache Redis error:", err.message)
      isConnected = false
    })

    redisClient.on("connect", () => {
      isConnected = true
    })

    await redisClient.connect()
    return redisClient
  } catch (error: unknown) {
    console.warn("Rate cache Redis connection failed:", (error as Error).message)
    isConnected = false
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

export { RATE_CACHE_TTL }
