/**
 * ExpirySelector Component
 *
 * Minimal dropdown component for selecting voucher expiry duration.
 * Designed to sit on the right side of the Owner/Agent row in voucher screens.
 */

import { useState, useEffect, useRef } from "react"

// Expiry preset options (must match lib/voucher-expiry.ts)

interface ExpiryOption {
  id: string
  label: string
  description: string
}

const EXPIRY_OPTIONS: ExpiryOption[] = [
  { id: "15m", label: "15 min", description: "15 minutes" },
  { id: "1h", label: "1 hour", description: "1 hour" },
  { id: "3h", label: "3 hours", description: "3 hours" },
  { id: "12h", label: "12 hours", description: "12 hours" },
  { id: "24h", label: "24 hours", description: "24 hours" },
  { id: "72h", label: "72 hours", description: "72 hours" },
  { id: "7d", label: "7 days", description: "7 days" },
  { id: "30d", label: "30 days", description: "30 days" },
  { id: "90d", label: "90 days", description: "90 days" },
  { id: "6mo", label: "6 months", description: "6 months" },
]

const DEFAULT_EXPIRY = "24h"

interface ExpirySelectorProps {
  value?: string
  onChange?: (expiryId: string) => void
  className?: string
  disabled?: boolean
}

export default function ExpirySelector({
  value = DEFAULT_EXPIRY,
  onChange,
  className = "",
  disabled = false,
}: ExpirySelectorProps) {
  const [selected, setSelected] = useState<string>(value)
  const [isOpen, setIsOpen] = useState<boolean>(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Sync with external value changes
  useEffect(() => {
    if (value !== selected) {
      setSelected(value)
    }
  }, [value])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside)
      document.addEventListener("touchstart", handleClickOutside)
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
      document.removeEventListener("touchstart", handleClickOutside)
    }
  }, [isOpen])

  const handleSelect = (expiryId: string) => {
    if (disabled) return
    setSelected(expiryId)
    setIsOpen(false)
    if (onChange) {
      onChange(expiryId)
    }
  }

  const selectedOption =
    EXPIRY_OPTIONS.find((o) => o.id === selected) ||
    EXPIRY_OPTIONS[EXPIRY_OPTIONS.length - 1]

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      {/* Dropdown trigger button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors
          ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-purple-100 dark:hover:bg-purple-900/30"}
          text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20
          border border-purple-200 dark:border-purple-800
        `}
      >
        <span>{selectedOption.label}</span>
        <svg
          className={`w-3 h-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[100px] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1">
          {EXPIRY_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => handleSelect(option.id)}
              className={`
                w-full px-3 py-1.5 text-left text-xs transition-colors
                ${
                  selected === option.id
                    ? "bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-medium"
                    : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                }
              `}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * ExpiryBadge - Display expiry status as a colored badge
 */

type VoucherStatus = "ACTIVE" | "CLAIMED" | "CANCELLED" | "EXPIRED"

interface ExpiryBadgeProps {
  expiresAt: number
  status: VoucherStatus
  compact?: boolean
}

export function ExpiryBadge({ expiresAt, status, compact = false }: ExpiryBadgeProps) {
  const now = Date.now()
  const timeRemaining = expiresAt ? expiresAt - now : 0

  // Calculate display values
  let badgeColor = "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
  let label = ""

  if (status === "CLAIMED") {
    badgeColor = "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
    label = "Claimed"
  } else if (status === "CANCELLED") {
    badgeColor = "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500"
    label = "Cancelled"
  } else if (status === "EXPIRED") {
    badgeColor = "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
    label = "Expired"
  } else if (timeRemaining <= 0) {
    badgeColor = "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
    label = "Expired"
  } else if (timeRemaining < 60 * 60 * 1000) {
    // Less than 1 hour
    badgeColor = "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
    const mins = Math.ceil(timeRemaining / (60 * 1000))
    label = `${mins}m left`
  } else if (timeRemaining < 24 * 60 * 60 * 1000) {
    // Less than 24 hours
    badgeColor =
      "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
    const hours = Math.ceil(timeRemaining / (60 * 60 * 1000))
    label = `${hours}h left`
  } else if (timeRemaining < 7 * 24 * 60 * 60 * 1000) {
    // Less than 7 days
    badgeColor =
      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
    const days = Math.ceil(timeRemaining / (24 * 60 * 60 * 1000))
    label = `${days}d left`
  } else {
    // More than 7 days
    badgeColor =
      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
    const date = new Date(expiresAt)
    label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  }

  return (
    <span
      className={`
      inline-flex items-center rounded-full font-medium
      ${compact ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs"}
      ${badgeColor}
    `}
    >
      {label}
    </span>
  )
}

/**
 * Format expiry date for display
 */
export function formatExpiryDate(expiresAt: number): string {
  if (!expiresAt) return "No expiry"
  const date = new Date(expiresAt)
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * Get expiry option by ID
 */
export function getExpiryOption(id: string): ExpiryOption | null {
  return EXPIRY_OPTIONS.find((o) => o.id === id) || null
}

// Export constants for use in other components
export { EXPIRY_OPTIONS, DEFAULT_EXPIRY }
