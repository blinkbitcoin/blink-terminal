/**
 * Voucher Expiry Configuration
 *
 * Defines expiry presets and constants for the voucher system.
 * Designed for easy migration to PostgreSQL later.
 */

interface ExpiryPreset {
  id: string
  label: string
  ms: number
}

type VoucherStatusString = "NOT_FOUND" | "CLAIMED" | "CANCELLED" | "EXPIRED" | "ACTIVE"

interface VoucherForStatus {
  claimed?: boolean
  cancelledAt?: number | null
  expiresAt?: number | null
}

// Expiry preset options
const EXPIRY_PRESETS: ExpiryPreset[] = [
  // Short options (shown in UI)
  { id: "15m", label: "15 min", ms: 15 * 60 * 1000 },
  { id: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { id: "3h", label: "3 hours", ms: 3 * 60 * 60 * 1000 },
  { id: "12h", label: "12 hours", ms: 12 * 60 * 60 * 1000 },
  // Current options (shown in UI)
  { id: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { id: "72h", label: "72 hours", ms: 72 * 60 * 60 * 1000 },
  { id: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { id: "90d", label: "90 days", ms: 90 * 24 * 60 * 60 * 1000 },
  { id: "6mo", label: "6 months", ms: 180 * 24 * 60 * 60 * 1000 },
]

// Default expiry for new vouchers
const DEFAULT_EXPIRY_ID: string = "24h"

// Maximum unclaimed vouchers per wallet (prevents runaway creation)
const MAX_UNCLAIMED_PER_WALLET: number = 1000

// How long to keep claimed vouchers in history (30 days)
const CLAIMED_RETENTION_MS: number = 30 * 24 * 60 * 60 * 1000

// How long to keep cancelled vouchers in history (30 days)
const CANCELLED_RETENTION_MS: number = 30 * 24 * 60 * 60 * 1000

// How long to keep expired unclaimed vouchers in history (7 days grace period)
const EXPIRED_RETENTION_MS: number = 7 * 24 * 60 * 60 * 1000

/**
 * Get expiry preset by ID
 * @param id - Preset ID (e.g., '6mo', '24h')
 * @returns Preset object or null if not found
 */
function getExpiryPreset(id: string): ExpiryPreset | null {
  return EXPIRY_PRESETS.find((preset: ExpiryPreset) => preset.id === id) || null
}

/**
 * Get expiry milliseconds by ID
 * @param id - Preset ID
 * @returns Milliseconds, defaults to 7 days if invalid
 */
function getExpiryMs(id: string): number {
  const preset: ExpiryPreset | null = getExpiryPreset(id)
  if (preset) return preset.ms
  // Default to 7 days if invalid ID
  const defaultPreset: ExpiryPreset | null = getExpiryPreset(DEFAULT_EXPIRY_ID)
  return defaultPreset ? defaultPreset.ms : 7 * 24 * 60 * 60 * 1000
}

/**
 * Get default expiry preset
 * @returns Default preset object
 */
function getDefaultExpiry(): ExpiryPreset | null {
  return getExpiryPreset(DEFAULT_EXPIRY_ID)
}

/**
 * Validate expiry ID
 * @param id - Preset ID to validate
 * @returns True if valid
 */
function isValidExpiryId(id: string): boolean {
  return EXPIRY_PRESETS.some((preset: ExpiryPreset) => preset.id === id)
}

/**
 * Format expiry date for display
 * @param expiresAt - Timestamp
 * @returns Formatted date string
 */
function formatExpiryDate(expiresAt: number | null | undefined): string {
  if (!expiresAt) return "No expiry"
  const date: Date = new Date(expiresAt)
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/**
 * Get voucher status based on its state
 * @param voucher - Voucher object
 * @returns Status: ACTIVE, CLAIMED, CANCELLED, EXPIRED, NOT_FOUND
 */
function getVoucherStatus(
  voucher: VoucherForStatus | null | undefined,
): VoucherStatusString {
  if (!voucher) return "NOT_FOUND"
  if (voucher.claimed) return "CLAIMED"
  if (voucher.cancelledAt) return "CANCELLED"
  if (voucher.expiresAt && voucher.expiresAt < Date.now()) return "EXPIRED"
  return "ACTIVE"
}

export {
  EXPIRY_PRESETS,
  DEFAULT_EXPIRY_ID,
  MAX_UNCLAIMED_PER_WALLET,
  CLAIMED_RETENTION_MS,
  CANCELLED_RETENTION_MS,
  EXPIRED_RETENTION_MS,
  getExpiryPreset,
  getExpiryMs,
  getDefaultExpiry,
  isValidExpiryId,
  formatExpiryDate,
  getVoucherStatus,
}

export type { ExpiryPreset, VoucherStatusString, VoucherForStatus }
