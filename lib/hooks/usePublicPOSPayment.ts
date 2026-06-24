import {
  useState,
  useEffect,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from "react"

import { getApiUrl } from "../config/api"
import { verifyLnurlPayment } from "../lnurl"

import type { PaymentData } from "./useBlinkWebSocket"

// ─── Types ────────────────────────────────────────────────────────

export interface CurrentInvoice {
  paymentRequest?: string
  paymentHash?: string
  satAmount?: number
  amount?: number
  memo?: string
  displayAmount?: number
  displayCurrency?: string
  tipAmount?: number
  tipCurrency?: string
  tipPercent?: number
  /**
   * LUD-21 verify URL. Present for self-custodial (Spark) recipients invoiced
   * via the Lightning-address path. When set, settlement is detected by polling
   * this URL instead of Blink's GraphQL lnInvoicePaymentStatus.
   */
  verifyUrl?: string
}

// Re-export the shared PaymentData type for consumers of this hook
export type { PaymentData }

export interface UsePublicPOSPaymentParams {
  showingInvoice: boolean
  soundEnabled: boolean
  posPaymentReceivedRef: React.RefObject<(() => void) | null>
  /** Merchant username to show on the success screen / receipt */
  merchant?: string
}

export interface UsePublicPOSPaymentReturn {
  currentInvoice: CurrentInvoice | null
  setCurrentInvoice: Dispatch<SetStateAction<CurrentInvoice | null>>
  paymentSuccess: boolean
  paymentData: PaymentData | null
  handleInvoiceChange: (invoice: CurrentInvoice | null) => void
  handlePaymentAnimationHide: () => void
}

// ─── Hook ─────────────────────────────────────────────────────────

/**
 * usePublicPOSPayment - Manages payment state and polling for PublicPOSDashboard
 *
 * Handles:
 * - Current invoice tracking
 * - Payment success state + animation data
 * - Payment status polling (5s interval, 15min timeout)
 * - Invoice change handler
 * - Payment animation dismiss handler
 */
export function usePublicPOSPayment({
  showingInvoice,
  soundEnabled,
  posPaymentReceivedRef,
  merchant,
}: UsePublicPOSPaymentParams): UsePublicPOSPaymentReturn {
  const [currentInvoice, setCurrentInvoice] = useState<CurrentInvoice | null>(null)
  const [paymentSuccess, setPaymentSuccess] = useState<boolean>(false)
  const [paymentData, setPaymentData] = useState<PaymentData | null>(null)

  // Poll for payment status when showing invoice
  useEffect(() => {
    if (!currentInvoice?.paymentRequest || !showingInvoice) return

    let cancelled = false
    let pollCount = 0
    const maxPolls = 180 // 15 minutes at 5 second intervals

    const pollPayment = async (): Promise<void> => {
      if (cancelled || pollCount >= maxPolls) {
        return
      }

      try {
        let paid = false

        if (currentInvoice.verifyUrl) {
          // Self-custodial (Spark) path: poll the LUD-21 verify URL. Note the
          // LNURL server populates `settled` from the Spark SSP webhook (no
          // synchronous Spark status pull), so detection may lag slightly.
          const verifyResult = await verifyLnurlPayment(currentInvoice.verifyUrl)
          paid = verifyResult.settled === true
        } else {
          // Custodial path: query Blink GraphQL for payment status (public query).
          const response = await fetch(getApiUrl(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: `
                query LnInvoicePaymentStatus($input: LnInvoicePaymentStatusInput!) {
                  lnInvoicePaymentStatus(input: $input) {
                    status
                  }
                }
              `,
              variables: {
                input: { paymentRequest: currentInvoice.paymentRequest },
              },
            }),
          })

          const data = await response.json()
          const status: string | undefined = data.data?.lnInvoicePaymentStatus?.status
          paid = status === "PAID"
        }

        if (paid) {
          console.log("✅ Public invoice payment received!")

          // Set payment data for animation with the richer invoice context so
          // the success screen + receipt can show fiat, payment hash, tip, etc.
          setPaymentData({
            amount: currentInvoice.satAmount || currentInvoice.amount || 0,
            currency: "BTC", // Always show sats
            memo: currentInvoice.memo,
            satAmount: currentInvoice.satAmount || currentInvoice.amount || 0,
            displayAmount: currentInvoice.displayAmount,
            displayCurrency: currentInvoice.displayCurrency,
            paymentHash: currentInvoice.paymentHash,
            paymentRequest: currentInvoice.paymentRequest,
            timestamp: Date.now(),
            merchant,
            tipAmount: currentInvoice.tipAmount,
            tipCurrency: currentInvoice.tipCurrency,
            tipPercent: currentInvoice.tipPercent,
          })
          setPaymentSuccess(true)

          // Note: Sound is handled by PaymentAnimation component
          return
        }
      } catch (err: unknown) {
        console.warn("Payment poll error:", err)
      }

      pollCount++
      if (!cancelled) {
        setTimeout(pollPayment, 5000) // Poll every 5 seconds
      }
    }

    // Start polling after a short delay
    const initialDelay = setTimeout(pollPayment, 2000)

    return () => {
      cancelled = true
      clearTimeout(initialDelay)
    }
  }, [currentInvoice, showingInvoice, soundEnabled])

  // Handle invoice changes from POS
  const handleInvoiceChange = useCallback((invoice: CurrentInvoice | null): void => {
    setCurrentInvoice(invoice)
  }, [])

  // Handle payment animation dismiss
  const handlePaymentAnimationHide = useCallback((): void => {
    setPaymentSuccess(false)
    setPaymentData(null)
    setCurrentInvoice(null)
    if (posPaymentReceivedRef?.current) {
      posPaymentReceivedRef.current()
    }
  }, [posPaymentReceivedRef])

  return {
    currentInvoice,
    setCurrentInvoice,
    paymentSuccess,
    paymentData,
    handleInvoiceChange,
    handlePaymentAnimationHide,
  }
}
