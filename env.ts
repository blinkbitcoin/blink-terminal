/**
 * Type-safe environment variable validation
 *
 * Aligned with blink/apps/pay convention: @t3-oss/env-nextjs + Zod.
 * All environment variables used in the app are validated here at startup.
 * Import `env` instead of accessing `process.env` directly.
 *
 * @see https://github.com/GaloyMoney/blink/blob/main/apps/pay/env.ts
 * @module env
 */

import { createEnv } from "@t3-oss/env-nextjs"
import { z } from "zod"

export const env = createEnv({
  /**
   * Skip validation during `next build` (server vars aren't available at
   * build time) or in CI where secrets aren't injected.
   */
  skipValidation: process.env.SKIP_ENV_VALIDATION === "true" || process.env.CI === "true",

  server: {
    // --- Blink API / Wallet ---
    BLINK_API_URL: z.string().url().optional(),
    BLINK_ENVIRONMENT: z.enum(["production", "staging"]).default("production"),
    BLINKPOS_API_KEY: z.string().min(1).optional(),
    BLINKPOS_BTC_WALLET_ID: z.string().min(1).optional(),
    BLINK_WEBHOOK_SECRET: z.string().min(1).optional(),
    BLINK_STAGING_WEBHOOK_SECRET: z.string().min(1).optional(),

    // --- Database (PostgreSQL) ---
    DATABASE_URL: z.string().url().optional(),
    POSTGRES_HOST: z.string().default("localhost"),
    POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
    POSTGRES_DB: z.string().default("blinkpos"),
    POSTGRES_USER: z.string().default("blinkpos"),
    POSTGRES_PASSWORD: z.string().default("blinkpos_dev_password"),

    // --- Redis ---
    REDIS_HOST: z.string().default("localhost"),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_DB: z.coerce.number().int().min(0).default(0),

    // --- Auth / Security ---
    JWT_SECRET: z.string().min(1),
    ENCRYPTION_KEY: z.string().min(1),
    NETWORK_ENCRYPTION_KEY: z.string().min(1).optional(),

    // --- External Services ---
    CITRUSRATE_API_KEY: z.string().min(1).optional(),
    CITRUSRATE_BASE_URL: z.string().url().optional(),

    // --- Feature Flags ---
    ENABLE_HYBRID_STORAGE: z.enum(["true", "false"]).default("false"),

    // --- Logging ---
    LOGLEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),

    // --- Observability (OpenTelemetry) ---
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    TRACING_SERVICE_NAME: z.string().default("bbt"),
  },

  client: {
    NEXT_PUBLIC_BASE_URL: z.string().url().optional(),
    NEXT_PUBLIC_GIT_COMMIT: z.string().optional(),
    NEXT_PUBLIC_USE_NDK_NIP46: z.enum(["true", "false"]).optional(),
  },

  runtimeEnv: {
    // Blink API
    BLINK_API_URL: process.env.BLINK_API_URL,
    BLINK_ENVIRONMENT: process.env.BLINK_ENVIRONMENT,
    BLINKPOS_API_KEY: process.env.BLINKPOS_API_KEY,
    BLINKPOS_BTC_WALLET_ID: process.env.BLINKPOS_BTC_WALLET_ID,
    BLINK_WEBHOOK_SECRET: process.env.BLINK_WEBHOOK_SECRET,
    BLINK_STAGING_WEBHOOK_SECRET: process.env.BLINK_STAGING_WEBHOOK_SECRET,

    // Database
    DATABASE_URL: process.env.DATABASE_URL,
    POSTGRES_HOST: process.env.POSTGRES_HOST,
    POSTGRES_PORT: process.env.POSTGRES_PORT,
    POSTGRES_DB: process.env.POSTGRES_DB,
    POSTGRES_USER: process.env.POSTGRES_USER,
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,

    // Redis
    REDIS_HOST: process.env.REDIS_HOST,
    REDIS_PORT: process.env.REDIS_PORT,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD,
    REDIS_DB: process.env.REDIS_DB,

    // Auth / Security
    JWT_SECRET: process.env.JWT_SECRET,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    NETWORK_ENCRYPTION_KEY: process.env.NETWORK_ENCRYPTION_KEY,

    // External Services
    CITRUSRATE_API_KEY: process.env.CITRUSRATE_API_KEY,
    CITRUSRATE_BASE_URL: process.env.CITRUSRATE_BASE_URL,

    // Feature Flags
    ENABLE_HYBRID_STORAGE: process.env.ENABLE_HYBRID_STORAGE,

    // Logging
    LOGLEVEL: process.env.LOGLEVEL,

    // Observability (OpenTelemetry)
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    TRACING_SERVICE_NAME: process.env.TRACING_SERVICE_NAME,

    // Client
    NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
    NEXT_PUBLIC_GIT_COMMIT: process.env.NEXT_PUBLIC_GIT_COMMIT,
    NEXT_PUBLIC_USE_NDK_NIP46: process.env.NEXT_PUBLIC_USE_NDK_NIP46,
  },
})
