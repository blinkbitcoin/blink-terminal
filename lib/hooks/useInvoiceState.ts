/**
 * useInvoiceState Hook
 *
 * Manages raw current invoice state for POS payments and NFC.
 * Polling logic remains in Dashboard.js since it depends on triggerPaymentAnimation,
 * posPaymentReceivedRef, fetchData, and other Dashboard-specific concerns.
 *
 * @module lib/hooks/useInvoiceState
 */

import { useState, useCallback } from "react"

// ============================================================================
// Types
// ============================================================================

/** Invoice data structure matching Dashboard.js usage */
export interface InvoiceData {
  /** BOLT11 payment request string */
  paymentRequest: string
  /** Payment hash for status tracking */
  paymentHash: string
  /** Amount in satoshis */
  satoshis?: number
  /** Alternative amount field */
  amount?: number
  /** Invoice description/memo */
  memo?: string
  /**
   * LUD-21 verify URL for self-custodial (Spark) direct-receive invoices.
   * When present, payment polling uses it instead of the escrow status endpoint.
   */
  verifyUrl?: string
}

/** Callback data for payment received events */
export interface PaymentReceivedData {
  amount: number
  currency: string
  memo: string
  paymentHash: string
  timestamp: number
}

/** Return type for the useInvoiceState hook */
export interface UseInvoiceStateReturn {
  // Core state
  currentInvoice: InvoiceData | null
  setCurrentInvoice: (invoice: InvoiceData | null) => void
  clearInvoice: () => void

  // Derived state
  hasInvoice: boolean
}

// Keep for backward compatibility with useDashboardState types
export type UseInvoiceStateOptions = Record<string, never>

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Hook for managing current invoice state
 *
 * @returns Invoice state and setters
 *
 * @example
 * ```tsx
 * const { currentInvoice, setCurrentInvoice, clearInvoice } = useInvoiceState();
 *
 * // POS sets the invoice when created
 * setCurrentInvoice({ paymentRequest: 'lnbc...', paymentHash: 'abc123', satoshis: 1000 });
 *
 * // Dashboard polls for payment using currentInvoice.paymentHash
 * // Dashboard clears invoice on payment success
 * clearInvoice();
 * ```
 */
export function useInvoiceState(
  _options?: UseInvoiceStateOptions,
): UseInvoiceStateReturn {
  const [currentInvoice, setCurrentInvoice] = useState<InvoiceData | null>(null)

  const clearInvoice = useCallback(() => {
    setCurrentInvoice(null)
  }, [])

  const hasInvoice = currentInvoice !== null

  return {
    currentInvoice,
    setCurrentInvoice,
    clearInvoice,
    hasInvoice,
  }
}

export default useInvoiceState
