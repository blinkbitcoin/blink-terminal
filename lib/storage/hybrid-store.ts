/**
 * Hybrid Storage Manager for BlinkPOS
 *
 * Uses Redis for hot data (active payments) and PostgreSQL for cold data (completed payments).
 *
 * Features:
 * - Fast retrieval of active payment splits via Redis
 * - Persistent storage of all payments in PostgreSQL
 * - Automatic expiration of old Redis keys
 * - Audit trail via payment events
 * - Analytics via PostgreSQL views
 */

import crypto from "crypto"

import type { Pool, PoolClient } from "pg"
import { createClient } from "redis"

import AuthManager from "../auth"
import { getSharedPool, closePool } from "../db"
import { onShutdown } from "../shutdown"

// ============= Interfaces =============

interface RedisConfig {
  host: string
  port: number
  password: string | undefined
  db: number
}

interface PostgresConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
  max: number
  idleTimeoutMillis: number
  connectionTimeoutMillis: number
}

interface TTLConfig {
  active: number
  processing: number
}

interface HybridStoreConfig {
  redis: RedisConfig
  postgres: PostgresConfig
  ttl: TTLConfig
}

interface TipRecipient {
  username: string
  share: number
}

interface TipDataInput {
  baseAmount: number
  tipAmount: number
  tipPercent?: number
  tipRecipient?: string
  tipRecipients?: TipRecipient[]
  userApiKey?: string
  userWalletId?: string
  displayCurrency?: string
  baseAmountDisplay?: string
  tipAmountDisplay?: string
  memo?: string
  nwcActive?: boolean
  nwcConnectionUri?: string | null
  blinkLnAddress?: boolean
  blinkLnAddressWalletId?: string | null
  blinkLnAddressUsername?: string | null
  npubCashActive?: boolean
  npubCashLightningAddress?: string | null
  environment?: string
  forwardingType?: string
  createdAt?: number
}

interface StoredPaymentData {
  paymentHash: string
  totalAmount: number
  baseAmount: number
  tipAmount: number
  tipPercent: number
  tipRecipient: string | null
  tipRecipients: TipRecipient[]
  userApiKeyHash: string
  userApiKey: string | null
  userWalletId: string | null
  displayCurrency: string
  baseAmountDisplay: string | null
  tipAmountDisplay: string | null
  memo: string | null
  nwcActive: boolean
  nwcConnectionUri: string | null
  blinkLnAddress: boolean
  blinkLnAddressWalletId: string | null
  blinkLnAddressUsername: string | null
  npubCashActive: boolean
  npubCashLightningAddress: string | null
  forwardingType: string
  environment: string
  status: string
  createdAt: string
  metadata?: Record<string, unknown>
  expiresAt?: string
}

interface PaymentMetadata {
  userApiKey?: string | null
  baseAmountDisplay?: string
  tipAmountDisplay?: string
  tipRecipients?: TipRecipient[]
  nwcActive?: boolean
  nwcConnectionUri?: string | null
  blinkLnAddress?: boolean
  blinkLnAddressWalletId?: string | null
  blinkLnAddressUsername?: string | null
  npubCashActive?: boolean
  npubCashLightningAddress?: string | null
  forwardingType?: string
  environment?: string
  claimedAt?: string
  lastError?: string
  lastFailedAt?: string
  [key: string]: unknown
}

interface StoreResult {
  success: boolean
  id: number
}

interface ClaimResult {
  claimed: boolean
  reason: string
  currentStatus?: string
  paymentData: StoredPaymentData | null
}

interface PaymentStats {
  pending_count: string
  processing_count: string
  completed_count: string
  failed_count: string
  total_volume: string | null
  total_tips: string | null
  avg_tip: string | null
}

interface HealthCheckResult {
  redis: boolean
  postgres: boolean
  overall: boolean
}

type RedisClient = ReturnType<typeof createClient>

class HybridStore {
  private redis: RedisClient | null
  private pg: Pool | null
  private isRedisConnected: boolean
  private isPostgresConnected: boolean
  private cleanupInterval: ReturnType<typeof setInterval> | null
  private config: HybridStoreConfig

  constructor() {
    this.redis = null
    this.pg = null
    this.isRedisConnected = false
    this.isPostgresConnected = false
    this.cleanupInterval = null

    // Configuration from environment
    this.config = {
      redis: {
        host: process.env.REDIS_HOST || "localhost",
        port: parseInt(process.env.REDIS_PORT || "6379"),
        password: process.env.REDIS_PASSWORD || undefined,
        db: parseInt(process.env.REDIS_DB || "0"),
      },
      postgres: {
        host: process.env.POSTGRES_HOST || "localhost",
        port: parseInt(process.env.POSTGRES_PORT || "5432"),
        database: process.env.POSTGRES_DB || "blinkpos",
        user: process.env.POSTGRES_USER || "blinkpos",
        password: process.env.POSTGRES_PASSWORD || "blinkpos_dev_password",
        max: 20, // Max pool size
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      },
      ttl: {
        active: 900, // 15 minutes for active payments
        processing: 1800, // 30 minutes for processing payments
      },
    }
  }

  /**
   * Initialize connections to Redis and PostgreSQL
   */
  async connect(): Promise<void> {
    // Connect to Redis
    try {
      this.redis = createClient({
        socket: {
          host: this.config.redis.host,
          port: this.config.redis.port,
        },
        password: this.config.redis.password,
        database: this.config.redis.db,
      })

      this.redis.on("error", (err: Error): void => {
        console.error("❌ Redis error:", err.message)
        this.isRedisConnected = false
      })

      this.redis.on("connect", (): void => {
        console.log("✅ Redis connected")
        this.isRedisConnected = true
      })

      await this.redis.connect()
    } catch (error: unknown) {
      const errMsg: string = error instanceof Error ? error.message : String(error)
      console.error("❌ Failed to connect to Redis:", errMsg)
      console.log("⚠️  Running in fallback mode without Redis cache")
    }

    // Connect to PostgreSQL via shared pool
    try {
      this.pg = getSharedPool()

      // Test connection
      const client: PoolClient = await this.pg.connect()
      console.log("✅ PostgreSQL connected (shared pool)")
      this.isPostgresConnected = true
      client.release()
    } catch (error: unknown) {
      const errMsg: string = error instanceof Error ? error.message : String(error)
      console.error("❌ Failed to connect to PostgreSQL:", errMsg)
      throw new Error("PostgreSQL connection required for operation")
    }

    // Start background cleanup job
    this.startCleanupJob()
  }

  /**
   * Disconnect from Redis and PostgreSQL
   */
  async disconnect(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
      console.log("Cleanup job stopped")
    }
    if (this.redis && this.isRedisConnected) {
      await this.redis.quit()
      console.log("Redis disconnected")
    }
    if (this.pg && this.isPostgresConnected) {
      await closePool()
      this.pg = null
      this.isPostgresConnected = false
      console.log("PostgreSQL disconnected (shared pool)")
    }
  }

  /**
   * Hash API key for privacy (don't store raw API keys)
   * For NWC-only users without an API key, returns a placeholder hash
   */
  hashApiKey(apiKey: string | null | undefined, nwcActive: boolean = false): string {
    if (!apiKey) {
      // For NWC-only users, use a placeholder hash to satisfy NOT NULL constraint
      if (nwcActive) {
        return crypto.createHash("sha256").update("NWC_ONLY_USER").digest("hex")
      }
      return crypto.createHash("sha256").update("UNKNOWN_USER").digest("hex")
    }
    return crypto.createHash("sha256").update(apiKey).digest("hex")
  }

  /**
   * Generate Redis key for payment hash
   */
  getRedisKey(paymentHash: string): string {
    return `blink-terminal:payment:${paymentHash}`
  }

  /**
   * Store tip data (called when invoice is created)
   */
  async storeTipData(paymentHash: string, tipData: TipDataInput): Promise<StoreResult> {
    const startTime: number = Date.now()

    try {
      const {
        baseAmount,
        tipAmount,
        tipPercent,
        tipRecipient, // Legacy single recipient (backward compatibility)
        tipRecipients, // New: Array of recipients with shares
        userApiKey,
        userWalletId,
        displayCurrency = "BTC",
        baseAmountDisplay,
        tipAmountDisplay,
        memo,
        nwcActive = false, // Flag for NWC-only users
        nwcConnectionUri = null, // NWC connection string for server-side forwarding
        // Lightning Address wallet info (for webhook forwarding)
        blinkLnAddress = false,
        blinkLnAddressWalletId = null,
        blinkLnAddressUsername = null,
        // npub.cash wallet info (for webhook forwarding)
        npubCashActive = false,
        npubCashLightningAddress = null,
        // Environment for staging/production API calls
        environment = "production",
        // Additional metadata
        forwardingType = "unknown",
      } = tipData

      const totalAmount: number = baseAmount + tipAmount
      const userApiKeyHash: string = this.hashApiKey(userApiKey, nwcActive) // Uses placeholder for NWC-only users

      // For NWC-only users, use a placeholder wallet ID to satisfy NOT NULL constraint
      const effectiveWalletId: string =
        userWalletId || (nwcActive ? "NWC_ONLY_USER" : "UNKNOWN_USER")

      // For backward compatibility: use first recipient's username for the legacy column
      // Store full array in metadata
      const legacyTipRecipient: string | null =
        tipRecipients?.length && tipRecipients.length > 0
          ? tipRecipients[0].username
          : tipRecipient || null

      // Data to store
      const paymentData: StoredPaymentData = {
        paymentHash,
        totalAmount,
        baseAmount,
        tipAmount,
        tipPercent: tipPercent || 0,
        tipRecipient: legacyTipRecipient,
        tipRecipients:
          tipRecipients || (tipRecipient ? [{ username: tipRecipient, share: 100 }] : []),
        userApiKeyHash,
        userApiKey: userApiKey || null, // Encrypted by caller (may be null for NWC-only users)
        userWalletId: userWalletId || null, // May be null for NWC-only users
        displayCurrency,
        baseAmountDisplay: baseAmountDisplay || null,
        tipAmountDisplay: tipAmountDisplay || null,
        memo: memo || null,
        nwcActive: !!nwcActive, // Flag for NWC-only users
        nwcConnectionUri: nwcConnectionUri || null, // NWC connection string for server-side forwarding
        // Forwarding destination info
        blinkLnAddress: !!blinkLnAddress,
        blinkLnAddressWalletId: blinkLnAddressWalletId || null,
        blinkLnAddressUsername: blinkLnAddressUsername || null,
        npubCashActive: !!npubCashActive,
        npubCashLightningAddress: npubCashLightningAddress || null,
        forwardingType: forwardingType,
        // Environment for staging/production API calls
        environment: environment,
        status: "pending",
        createdAt: new Date().toISOString(),
      }

      // 1. Store in PostgreSQL (primary storage)
      // Note: userApiKey is encrypted before reaching this point (via AuthManager.encryptApiKey)
      // Store tipRecipients and forwarding info in metadata JSONB
      const metadata: PaymentMetadata = {
        userApiKey: userApiKey || null, // Already encrypted by caller (may be null for NWC)
        baseAmountDisplay,
        tipAmountDisplay,
        tipRecipients: paymentData.tipRecipients, // Store full recipients array in metadata
        nwcActive: !!nwcActive, // Store NWC flag in metadata
        nwcConnectionUri: nwcConnectionUri || null, // NWC connection string for server-side forwarding
        // Forwarding destination info (for webhook-based forwarding)
        blinkLnAddress: !!blinkLnAddress,
        blinkLnAddressWalletId: blinkLnAddressWalletId || null,
        blinkLnAddressUsername: blinkLnAddressUsername || null,
        npubCashActive: !!npubCashActive,
        npubCashLightningAddress: npubCashLightningAddress || null,
        forwardingType: forwardingType,
        // Environment for staging/production API calls (critical for correct forwarding)
        environment: paymentData.environment || "production",
      }

      const pgResult = await this.pg!.query(
        `
        INSERT INTO payment_splits (
          payment_hash,
          user_api_key_hash,
          user_wallet_id,
          total_amount,
          base_amount,
          tip_amount,
          tip_percent,
          tip_recipient,
          display_currency,
          base_amount_display,
          tip_amount_display,
          memo,
          status,
          metadata,
          created_at,
          expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW() + INTERVAL '15 minutes')
        RETURNING id
      `,
        [
          paymentHash,
          userApiKeyHash,
          effectiveWalletId, // Use placeholder for NWC-only users
          totalAmount,
          baseAmount,
          tipAmount,
          tipPercent || 0,
          tipRecipient,
          displayCurrency,
          baseAmountDisplay,
          tipAmountDisplay,
          memo,
          "pending",
          JSON.stringify(metadata),
        ],
      )

      // 2. Log event
      await this.logEvent(paymentHash, "created", "success", {
        totalAmount,
        tipAmount,
        tipRecipients: paymentData.tipRecipients,
      })

      // 3. Store in Redis cache (if available)
      if (this.isRedisConnected) {
        try {
          const redisKey: string = this.getRedisKey(paymentHash)
          await this.redis!.setEx(
            redisKey,
            this.config.ttl.active,
            JSON.stringify(paymentData),
          )
        } catch (redisError: unknown) {
          const errMsg: string =
            redisError instanceof Error ? redisError.message : String(redisError)
          console.warn("⚠️  Redis cache write failed:", errMsg)
          // Continue - PostgreSQL is source of truth
        }
      }

      const duration: number = Date.now() - startTime
      console.log(`✅ Stored payment split ${paymentHash} (${duration}ms)`)

      return { success: true, id: pgResult.rows[0].id as number }
    } catch (error: unknown) {
      console.error("❌ Failed to store tip data:", error)

      // Log failure event
      try {
        const errMsg: string = error instanceof Error ? error.message : String(error)
        await this.logEvent(paymentHash, "created", "failure", null, errMsg)
      } catch (logError: unknown) {
        console.error("Failed to log error event:", logError)
      }

      throw error
    }
  }

  /**
   * Retrieve tip data (called when payment is detected)
   */
  async getTipData(paymentHash: string): Promise<StoredPaymentData | null> {
    const startTime: number = Date.now()

    try {
      // 1. Try Redis first (hot data)
      if (this.isRedisConnected) {
        try {
          const redisKey: string = this.getRedisKey(paymentHash)
          const cached: string | null = await this.redis!.get(redisKey)

          if (cached) {
            const duration: number = Date.now() - startTime
            console.log(`✅ Retrieved from Redis cache (${duration}ms)`)
            return JSON.parse(cached) as StoredPaymentData
          }
        } catch (redisError: unknown) {
          const errMsg: string =
            redisError instanceof Error ? redisError.message : String(redisError)
          console.warn("⚠️  Redis cache read failed:", errMsg)
          // Fall through to PostgreSQL
        }
      }

      // 2. Retrieve from PostgreSQL (cold data or cache miss)
      const result = await this.pg!.query(
        `
        SELECT 
          payment_hash as "paymentHash",
          total_amount as "totalAmount",
          base_amount as "baseAmount",
          tip_amount as "tipAmount",
          tip_percent as "tipPercent",
          tip_recipient as "tipRecipient",
          user_api_key_hash as "userApiKeyHash",
          user_wallet_id as "userWalletId",
          display_currency as "displayCurrency",
          base_amount_display as "baseAmountDisplay",
          tip_amount_display as "tipAmountDisplay",
          memo,
          status,
          metadata,
          created_at as "createdAt",
          expires_at as "expiresAt"
        FROM payment_splits
        WHERE payment_hash = $1
      `,
        [paymentHash],
      )

      if (result.rows.length === 0) {
        return null
      }

      const paymentData = result.rows[0] as StoredPaymentData

      // Extract userApiKey and tipRecipients from metadata
      if (paymentData.metadata) {
        const meta = paymentData.metadata as PaymentMetadata
        if (meta.userApiKey) {
          // Decrypt the API key (stored encrypted in metadata JSONB)
          const decryptedKey = AuthManager.decryptApiKey(meta.userApiKey)
          ;(paymentData as unknown as Record<string, unknown>).userApiKey =
            decryptedKey || meta.userApiKey // Fall back to raw value for backward compat with pre-encryption data
        }
        if (meta.tipRecipients) {
          paymentData.tipRecipients = meta.tipRecipients
        }
      }
      // Backward compatibility: if no tipRecipients in metadata but tipRecipient exists
      if (!paymentData.tipRecipients && paymentData.tipRecipient) {
        paymentData.tipRecipients = [{ username: paymentData.tipRecipient, share: 100 }]
      }
      const duration: number = Date.now() - startTime
      console.log(`✅ Retrieved from PostgreSQL (${duration}ms)`)

      // 3. Warm up Redis cache if payment is still active
      if (this.isRedisConnected && paymentData.status === "pending") {
        try {
          const redisKey: string = this.getRedisKey(paymentHash)
          await this.redis!.setEx(
            redisKey,
            this.config.ttl.active,
            JSON.stringify(paymentData),
          )
        } catch (redisError: unknown) {
          const errMsg: string =
            redisError instanceof Error ? redisError.message : String(redisError)
          console.warn("⚠️  Redis cache warm-up failed:", errMsg)
        }
      }

      return paymentData
    } catch (error: unknown) {
      console.error("❌ Failed to get tip data:", error)
      throw error
    }
  }

  /**
   * ATOMIC: Claim a payment for processing (prevents duplicate payouts)
   *
   * This method atomically transitions a payment from 'pending' to 'processing'
   * using PostgreSQL's UPDATE ... WHERE to ensure only ONE process can claim it.
   */
  async claimPaymentForProcessing(paymentHash: string): Promise<ClaimResult> {
    const startTime: number = Date.now()

    try {
      // ATOMIC: Update status to 'processing' only if currently 'pending'
      // This uses PostgreSQL's row-level locking to prevent race conditions
      const result = await this.pg!.query(
        `
        UPDATE payment_splits
        SET 
          status = 'processing',
          processed_at = NOW(),
          metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE payment_hash = $1 
          AND status = 'pending'
        RETURNING 
          payment_hash as "paymentHash",
          total_amount as "totalAmount",
          base_amount as "baseAmount",
          tip_amount as "tipAmount",
          tip_percent as "tipPercent",
          tip_recipient as "tipRecipient",
          user_api_key_hash as "userApiKeyHash",
          user_wallet_id as "userWalletId",
          display_currency as "displayCurrency",
          base_amount_display as "baseAmountDisplay",
          tip_amount_display as "tipAmountDisplay",
          memo,
          status,
          metadata,
          created_at as "createdAt",
          expires_at as "expiresAt"
      `,
        [paymentHash, JSON.stringify({ claimedAt: new Date().toISOString() })],
      )

      const duration: number = Date.now() - startTime

      if (result.rows.length === 0) {
        // Payment was already claimed by another process, or doesn't exist, or already processed
        // Check what state it's in for logging
        const checkResult = await this.pg!.query(
          `
          SELECT status FROM payment_splits WHERE payment_hash = $1
        `,
          [paymentHash],
        )

        if (checkResult.rows.length === 0) {
          console.log(`⚠️  Payment ${paymentHash} not found in database (${duration}ms)`)
          return { claimed: false, reason: "not_found", paymentData: null }
        }

        const currentStatus: string = checkResult.rows[0].status as string
        console.log(
          `🔒 Payment ${paymentHash} already ${currentStatus} - preventing duplicate (${duration}ms)`,
        )

        return {
          claimed: false,
          reason:
            currentStatus === "completed" ? "already_completed" : "already_processing",
          currentStatus,
          paymentData: null,
        }
      }

      const paymentData = result.rows[0] as StoredPaymentData

      // Extract userApiKey and tipRecipients from metadata
      if (paymentData.metadata) {
        const meta = paymentData.metadata as PaymentMetadata
        if (meta.userApiKey) {
          // Decrypt the API key (stored encrypted in metadata JSONB)
          const decryptedKey = AuthManager.decryptApiKey(meta.userApiKey)
          ;(paymentData as unknown as Record<string, unknown>).userApiKey =
            decryptedKey || meta.userApiKey // Fall back to raw value for backward compat with pre-encryption data
        }
        if (meta.tipRecipients) {
          paymentData.tipRecipients = meta.tipRecipients
        }
      }
      // Backward compatibility: if no tipRecipients in metadata but tipRecipient exists
      if (!paymentData.tipRecipients && paymentData.tipRecipient) {
        paymentData.tipRecipients = [{ username: paymentData.tipRecipient, share: 100 }]
      }

      // Log the claim event
      await this.logEvent(paymentHash, "claimed_for_processing", "success", {
        claimedAt: new Date().toISOString(),
      })

      // Remove from Redis cache (it's now being processed)
      if (this.isRedisConnected) {
        try {
          const redisKey: string = this.getRedisKey(paymentHash)
          await this.redis!.del(redisKey)
        } catch (redisError: unknown) {
          const errMsg: string =
            redisError instanceof Error ? redisError.message : String(redisError)
          console.warn("⚠️  Redis cache deletion failed:", errMsg)
        }
      }

      console.log(`✅ CLAIMED payment ${paymentHash} for processing (${duration}ms)`)

      return { claimed: true, reason: "success", paymentData }
    } catch (error: unknown) {
      console.error("❌ Failed to claim payment for processing:", error)
      throw error
    }
  }

  /**
   * Mark a claimed payment as failed (allows retry)
   * Call this if payment processing fails after claiming
   */
  async releaseFailedClaim(paymentHash: string, errorMessage: string): Promise<void> {
    try {
      await this.pg!.query(
        `
        UPDATE payment_splits
        SET 
          status = 'pending',
          processed_at = NULL,
          metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE payment_hash = $1 
          AND status = 'processing'
      `,
        [
          paymentHash,
          JSON.stringify({
            lastError: errorMessage,
            lastFailedAt: new Date().toISOString(),
          }),
        ],
      )

      await this.logEvent(paymentHash, "claim_released", "failure", { errorMessage })

      console.log(`🔓 Released failed claim for payment ${paymentHash}`)
    } catch (error: unknown) {
      console.error("❌ Failed to release claim:", error)
      // Don't throw - this is cleanup
    }
  }

  /**
   * Update payment status
   */
  async updatePaymentStatus(
    paymentHash: string,
    status: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      // Update PostgreSQL with proper JSONB casting
      await this.pg!.query(
        `
        UPDATE payment_splits
        SET 
          status = $1,
          processed_at = CASE WHEN $2 IN ('completed', 'failed') THEN NOW() ELSE processed_at END,
          metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
        WHERE payment_hash = $4
      `,
        [status, status, JSON.stringify(metadata), paymentHash],
      )

      // Update Redis cache if exists
      if (this.isRedisConnected) {
        try {
          const redisKey: string = this.getRedisKey(paymentHash)
          const cached: string | null = await this.redis!.get(redisKey)

          if (cached) {
            const data: StoredPaymentData = JSON.parse(cached) as StoredPaymentData
            data.status = status
            data.metadata = metadata

            await this.redis!.setEx(
              redisKey,
              status === "processing"
                ? this.config.ttl.processing
                : this.config.ttl.active,
              JSON.stringify(data),
            )
          }
        } catch (redisError: unknown) {
          const errMsg: string =
            redisError instanceof Error ? redisError.message : String(redisError)
          console.warn("⚠️  Redis cache update failed:", errMsg)
        }
      }

      // Log status change event
      await this.logEvent(paymentHash, `status_${status}`, "success", metadata)

      console.log(`✅ Updated payment ${paymentHash} status to ${status}`)
    } catch (error: unknown) {
      console.error("❌ Failed to update payment status:", error)
      throw error
    }
  }

  /**
   * Remove tip data (called after successful processing)
   */
  async removeTipData(paymentHash: string): Promise<void> {
    try {
      // Mark as completed in PostgreSQL (don't delete)
      await this.updatePaymentStatus(paymentHash, "completed")

      // Remove from Redis cache
      if (this.isRedisConnected) {
        try {
          const redisKey: string = this.getRedisKey(paymentHash)
          await this.redis!.del(redisKey)
        } catch (redisError: unknown) {
          const errMsg: string =
            redisError instanceof Error ? redisError.message : String(redisError)
          console.warn("⚠️  Redis cache deletion failed:", errMsg)
        }
      }

      console.log(`✅ Removed payment ${paymentHash} from hot storage`)
    } catch (error: unknown) {
      console.error("❌ Failed to remove tip data:", error)
      throw error
    }
  }

  /**
   * Log payment event (audit trail)
   */
  async logEvent(
    paymentHash: string,
    eventType: string,
    eventStatus: string,
    metadata: Record<string, unknown> | null = null,
    errorMessage: string | null = null,
  ): Promise<void> {
    try {
      await this.pg!.query(
        `
        INSERT INTO payment_events (
          payment_hash,
          event_type,
          event_status,
          metadata,
          error_message,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())
      `,
        [
          paymentHash,
          eventType,
          eventStatus,
          metadata ? JSON.stringify(metadata) : null,
          errorMessage,
        ],
      )
    } catch (error: unknown) {
      console.error("❌ Failed to log event:", error)
      // Don't throw - logging failure shouldn't break main flow
    }
  }

  /**
   * Get payment statistics
   */
  async getStats(): Promise<PaymentStats> {
    try {
      const result = await this.pg!.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
          COUNT(*) FILTER (WHERE status = 'processing') as processing_count,
          COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
          COUNT(*) FILTER (WHERE status = 'failed') as failed_count,
          SUM(total_amount) FILTER (WHERE status = 'completed') as total_volume,
          SUM(tip_amount) FILTER (WHERE status = 'completed') as total_tips,
          AVG(tip_amount) FILTER (WHERE status = 'completed' AND tip_amount > 0) as avg_tip
        FROM payment_splits
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `)

      return result.rows[0] as PaymentStats
    } catch (error: unknown) {
      console.error("❌ Failed to get stats:", error)
      throw error
    }
  }

  /**
   * Get active payments (for monitoring)
   */
  async getActivePayments(): Promise<Record<string, unknown>[]> {
    try {
      const result = await this.pg!.query(`
        SELECT * FROM active_payments
        LIMIT 100
      `)

      return result.rows as Record<string, unknown>[]
    } catch (error: unknown) {
      console.error("❌ Failed to get active payments:", error)
      throw error
    }
  }

  /**
   * Expire old pending payments (cleanup job)
   */
  async expireOldPayments(): Promise<number> {
    try {
      const result = await this.pg!.query(`
        UPDATE payment_splits
        SET status = 'expired'
        WHERE status IN ('pending', 'processing')
          AND expires_at < NOW()
        RETURNING payment_hash
      `)

      // Remove from Redis cache
      if (this.isRedisConnected && result.rows.length > 0) {
        try {
          const keys: string[] = result.rows.map((row: Record<string, unknown>): string =>
            this.getRedisKey(row.payment_hash as string),
          )
          if (keys.length > 0) {
            await this.redis!.del(keys)
          }
        } catch (redisError: unknown) {
          const errMsg: string =
            redisError instanceof Error ? redisError.message : String(redisError)
          console.warn("⚠️  Redis cleanup failed:", errMsg)
        }
      }

      console.log(`🧹 Expired ${result.rows.length} old payments`)
      return result.rows.length
    } catch (error: unknown) {
      console.error("❌ Failed to expire old payments:", error)
      return 0
    }
  }

  /**
   * Start background cleanup job
   */
  startCleanupJob(): void {
    // Run every 5 minutes
    this.cleanupInterval = setInterval(
      (): void => {
        this.expireOldPayments().catch((error: unknown): void => {
          console.error("Cleanup job error:", error)
        })
      },
      5 * 60 * 1000,
    )

    console.log("🧹 Started background cleanup job (every 5 minutes)")
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const health: HealthCheckResult = {
      redis: false,
      postgres: false,
      overall: false,
    }

    // Check Redis
    if (this.isRedisConnected) {
      try {
        await this.redis!.ping()
        health.redis = true
      } catch (error: unknown) {
        console.error("Redis health check failed:", error)
      }
    }

    // Check PostgreSQL
    if (this.isPostgresConnected) {
      try {
        const result = await this.pg!.query("SELECT 1")
        health.postgres = result.rows.length === 1
      } catch (error: unknown) {
        console.error("PostgreSQL health check failed:", error)
      }
    }

    // Overall health requires PostgreSQL (Redis is optional)
    health.overall = health.postgres

    return health
  }
}

// Singleton instance
let instance: HybridStore | null = null
let initPromise: Promise<HybridStore> | null = null

/**
 * Register HybridStore cleanup with the centralized shutdown handler.
 */
function registerShutdownHandlers(): void {
  onShutdown("HybridStore", async () => {
    if (instance) {
      await instance.disconnect()
      instance = null
      initPromise = null
    }
  })
}

/**
 * Get singleton instance of HybridStore.
 *
 * Uses a cached promise to prevent TOCTOU race conditions — concurrent
 * callers will await the same initialization promise rather than each
 * creating their own instance.
 */
async function getHybridStore(): Promise<HybridStore> {
  if (instance) {
    return instance
  }
  if (!initPromise) {
    initPromise = (async () => {
      const store = new HybridStore()
      await store.connect()
      instance = store
      registerShutdownHandlers()
      return store
    })()
  }
  return initPromise
}

export { HybridStore, getHybridStore }
export type {
  HybridStoreConfig,
  TipDataInput,
  TipRecipient,
  StoredPaymentData,
  PaymentMetadata,
  StoreResult,
  ClaimResult,
  PaymentStats,
  HealthCheckResult,
}
