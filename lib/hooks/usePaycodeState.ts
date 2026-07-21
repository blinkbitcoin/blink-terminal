/**
 * usePaycodeState Hook
 *
 * Manages visibility state for the authenticated Paycode menu, which renders
 * the shared PrintPaycodeView (identical to the `/[username]/print` page).
 *
 * The paycode UI is variable-amount only and owns its own PDF-generation state
 * internally, so this hook tracks visibility only.
 *
 * NOTE: amount + PDF-generation state were removed when the Paycodes menu and
 * the print page were unified. The fixed-amount LNURL API remains available for
 * possible future reintroduction of fixed amounts.
 *
 * @module lib/hooks/usePaycodeState
 */

import { useState, useCallback } from "react"

// ============================================================================
// Types
// ============================================================================

/** Return type for the usePaycodeState hook */
export interface UsePaycodeStateReturn {
  // Visibility state
  showPaycode: boolean
  setShowPaycode: (show: boolean) => void
  openPaycode: () => void
  closePaycode: () => void
  togglePaycode: () => void
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Hook for managing paycode menu visibility.
 *
 * @returns Paycode visibility state and actions
 *
 * @example
 * ```tsx
 * const { showPaycode, openPaycode, closePaycode } = usePaycodeState();
 *
 * <button onClick={openPaycode}>Paycodes</button>
 * {showPaycode && <PaycodesOverlay username={username} onBack={closePaycode} />}
 * ```
 */
export function usePaycodeState(): UsePaycodeStateReturn {
  const [showPaycode, setShowPaycodeState] = useState<boolean>(false)

  const setShowPaycode = useCallback((show: boolean) => {
    setShowPaycodeState(show)
  }, [])

  const openPaycode = useCallback(() => {
    setShowPaycodeState(true)
  }, [])

  const closePaycode = useCallback(() => {
    setShowPaycodeState(false)
  }, [])

  const togglePaycode = useCallback(() => {
    setShowPaycodeState((prev) => !prev)
  }, [])

  return {
    showPaycode,
    setShowPaycode,
    openPaycode,
    closePaycode,
    togglePaycode,
  }
}

export default usePaycodeState
