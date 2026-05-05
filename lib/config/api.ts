/**
 * Centralized API Configuration
 *
 * Manages environment switching between production and staging for testing.
 *
 * Usage:
 * - Import { getApiUrl } and use instead of hardcoded URLs
 * - Staging is auto-detected from window.location.hostname (any host
 *   containing "staging" maps to the staging environment)
 * - On non-staging hosts, the debug panel (tap logo 5 times on signin)
 *   can override via localStorage
 * - Staging uses signet (not real sats)
 *
 * Staging Documentation: https://dev.blink.sv/self-host/deployment/staging-environment
 */

// =============================================================================
// Types
// =============================================================================

export type EnvironmentName = "production" | "staging"

export interface EnvironmentConfig {
  name: string
  apiUrl: string
  dashboardUrl: string
  payUrl: string
  wsUrl: string
  lnAddressDomain: string
  validDomains: string[]
  description: string
}

export interface EnvironmentDisplayInfo {
  key: EnvironmentName
  name: string
  description: string
  isStaging: boolean
  isProduction: boolean
}

// =============================================================================
// Configuration
// =============================================================================

const ENVIRONMENTS: Record<EnvironmentName, EnvironmentConfig> = {
  production: {
    name: "Production",
    apiUrl: "https://api.blink.sv/graphql",
    dashboardUrl: "https://dashboard.blink.sv",
    payUrl: "https://pay.blink.sv",
    wsUrl: "wss://ws.blink.sv/graphql",
    lnAddressDomain: "blink.sv",
    validDomains: ["blink.sv", "pay.blink.sv", "galoy.io"],
    description: "Live environment with real sats",
  },
  staging: {
    name: "Staging",
    apiUrl: "https://api.staging.blink.sv/graphql",
    dashboardUrl: "https://dashboard.staging.blink.sv",
    payUrl: "https://pay.staging.blink.sv",
    wsUrl: "wss://ws.staging.blink.sv/graphql",
    lnAddressDomain: "pay.staging.blink.sv",
    validDomains: ["staging.blink.sv", "pay.staging.blink.sv"],
    description: "Test environment with signet (not real sats)",
  },
}

const STORAGE_KEY: string = "blink_environment"

// =============================================================================
// Functions
// =============================================================================

/**
 * Returns true when the given hostname indicates a staging deployment.
 * Exported so that unit tests can exercise the detection logic directly
 * without needing to mutate the non-configurable jsdom window.location.
 * @param hostname - window.location.hostname value
 */
export function isHostnameStaging(hostname: string): boolean {
  return hostname.includes("staging")
}

/**
 * Get the current environment name
 * @returns Current environment
 */
export function getEnvironment(): EnvironmentName {
  // Server-side: use env var or default to production
  if (typeof window === "undefined") {
    return (process.env.BLINK_ENVIRONMENT as EnvironmentName) || "production"
  }

  // Client-side: hostname auto-detect takes priority so that staging
  // deployments (e.g. terminal.staging.blinkbtc.com) are never
  // silently pointed at the production API due to a missing or stale
  // localStorage value.
  if (isHostnameStaging(window.location.hostname)) {
    return "staging"
  }

  // localStorage override (debug panel) for non-staging hosts only
  const stored: string | null = localStorage.getItem(STORAGE_KEY)
  if (stored && ENVIRONMENTS[stored as EnvironmentName]) {
    return stored as EnvironmentName
  }

  return "production"
}

/**
 * Set the current environment
 * @param env - Environment to switch to
 * @param reload - Whether to reload the page after switching (default: true)
 */
export function setEnvironment(env: EnvironmentName, reload: boolean = true): void {
  if (!ENVIRONMENTS[env]) {
    console.error(`[API Config] Invalid environment: ${env}`)
    return
  }

  if (typeof window === "undefined") {
    console.warn("[API Config] Cannot set environment on server-side")
    return
  }

  const currentEnv: EnvironmentName = getEnvironment()
  if (currentEnv === env) {
    console.log(`[API Config] Already in ${env} environment`)
    return
  }

  console.log(`[API Config] Switching from ${currentEnv} to ${env}`)
  localStorage.setItem(STORAGE_KEY, env)

  if (reload) {
    // Clear any cached auth state when switching environments
    // This prevents using production tokens in staging or vice versa
    console.log("[API Config] Clearing auth state for environment switch...")

    // Clear Blink-specific auth tokens (but not Nostr identity)
    localStorage.removeItem("blinkpos_api_key")
    localStorage.removeItem("blinkpos_wallet_id")
    localStorage.removeItem("blinkpos_blink_account")

    // Reload to apply changes
    window.location.reload()
  }
}

/**
 * Get the current environment's configuration
 * @returns Environment configuration object
 */
export function getEnvironmentConfig(): EnvironmentConfig {
  return ENVIRONMENTS[getEnvironment()]
}

/**
 * Get the API URL for the current environment
 * @returns GraphQL API URL
 */
export function getApiUrl(): string {
  return getEnvironmentConfig().apiUrl
}

/**
 * Get the dashboard URL for the current environment
 * @returns Dashboard URL
 */
export function getDashboardUrl(): string {
  return getEnvironmentConfig().dashboardUrl
}

/**
 * Get the pay URL for the current environment
 * @returns Pay URL
 */
export function getPayUrl(): string {
  return getEnvironmentConfig().payUrl
}

/**
 * Get the WebSocket URL for the current environment
 * @returns WebSocket URL
 */
export function getWsUrl(): string {
  return getEnvironmentConfig().wsUrl
}

/**
 * Get the Lightning Address domain for the current environment
 * @returns Lightning Address domain (e.g., 'blink.sv' or 'pay.staging.blink.sv')
 */
export function getLnAddressDomain(): string {
  return getEnvironmentConfig().lnAddressDomain
}

/**
 * Get valid Blink domains for the current environment
 * @returns Array of valid domain names
 */
export function getValidDomains(): string[] {
  return getEnvironmentConfig().validDomains
}

/**
 * Get all valid Blink domains across all environments
 * Used for accepting both production and staging addresses
 * @returns Array of all valid domain names
 */
export function getAllValidDomains(): string[] {
  return [...ENVIRONMENTS.production.validDomains, ...ENVIRONMENTS.staging.validDomains]
}

/**
 * Check if currently in staging environment
 * @returns True if in staging
 */
export function isStaging(): boolean {
  return getEnvironment() === "staging"
}

/**
 * Check if currently in production environment
 * @returns True if in production
 */
export function isProduction(): boolean {
  return getEnvironment() === "production"
}

/**
 * Get all available environments (for UI)
 * @returns All environment configurations
 */
export function getAllEnvironments(): Record<EnvironmentName, EnvironmentConfig> {
  return ENVIRONMENTS
}

/**
 * Get API URL for a specific environment (server-side helper)
 * Use this when environment is passed explicitly (e.g., in API request body)
 * @param env - Environment name
 * @returns GraphQL API URL for the specified environment
 */
export function getApiUrlForEnvironment(env: EnvironmentName): string {
  return ENVIRONMENTS[env]?.apiUrl || ENVIRONMENTS.production.apiUrl
}

/**
 * Get WebSocket URL for a specific environment (server-side helper)
 * @param env - Environment name
 * @returns WebSocket URL for the specified environment
 */
export function getWsUrlForEnvironment(env: EnvironmentName): string {
  return ENVIRONMENTS[env]?.wsUrl || ENVIRONMENTS.production.wsUrl
}

/**
 * Get Pay URL for a specific environment (server-side helper)
 * @param env - Environment name
 * @returns Pay URL for the specified environment
 */
export function getPayUrlForEnvironment(env: EnvironmentName): string {
  return ENVIRONMENTS[env]?.payUrl || ENVIRONMENTS.production.payUrl
}

/**
 * Get environment display info for UI
 * @returns Display info for current environment
 */
export function getEnvironmentDisplayInfo(): EnvironmentDisplayInfo {
  const env: EnvironmentName = getEnvironment()
  const config: EnvironmentConfig = ENVIRONMENTS[env]
  return {
    key: env,
    name: config.name,
    description: config.description,
    isStaging: env === "staging",
    isProduction: env === "production",
  }
}

// Log current environment on module load (client-side only)
if (typeof window !== "undefined") {
  const env: EnvironmentName = getEnvironment()
  const config: EnvironmentConfig = ENVIRONMENTS[env]
  console.log(`[API Config] Environment: ${config.name} (${env})`)
  console.log(`[API Config] API URL: ${config.apiUrl}`)

  if (env === "staging") {
    console.warn("[API Config] ⚠️ STAGING MODE - Using signet, not real sats!")
  }
}

export default {
  isHostnameStaging,
  getEnvironment,
  setEnvironment,
  getEnvironmentConfig,
  getApiUrl,
  getDashboardUrl,
  getPayUrl,
  getWsUrl,
  getLnAddressDomain,
  getValidDomains,
  getAllValidDomains,
  isStaging,
  isProduction,
  getAllEnvironments,
  getEnvironmentDisplayInfo,
  getApiUrlForEnvironment,
  getWsUrlForEnvironment,
  getPayUrlForEnvironment,
}
