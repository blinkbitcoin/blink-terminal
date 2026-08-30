import { useEffect, useRef } from "react"

import { useNFC, type UseNFCReturn } from "../../components/NFCPayment"
import { getApiUrl } from "../config/api"
import { isSplitPaymentsEnabled } from "../config/features"
import { verifyLnurlPayment } from "../lnurl"

import type { PaymentData } from "./useBlinkWebSocket"
import type { SoundTheme } from "./useSoundSettings"

// ─── Types ────────────────────────────────────────────────────────

export interface PaymentPollingInvoice {
  paymentHash?: string
  paymentRequest?: string
  satoshis?: number
  amount?: number
  satAmount?: number
  memo?: string
  displayAmount?: number
  displayCurrency?: string
  tipAmount?: number
  tipCurrency?: string
  tipPercent?: number
  /**
   * LUD-21 verify URL. Present for self-custodial (Spark) direct-receive
   * invoices (no BlinkPOS escrow). When set, settlement is detected by polling
   * this URL instead of /api/payment-status (which keys off the escrow record).
   */
  verifyUrl?: string
}

/** @deprecated Use PaymentData from useBlinkWebSocket instead */
export type PaymentAnimationData = PaymentData

export interface UsePaymentPollingParams {
  currentInvoice: PaymentPollingInvoice | null
  triggerPaymentAnimation: (data: PaymentData) => void
  posPaymentReceivedRef: React.RefObject<(() => void) | null>
  fetchData: () => void
  soundEnabled: boolean
  soundTheme: SoundTheme | string
  /** Merchant username to show on the success screen / receipt */
  merchant?: string
}

export interface UsePaymentPollingReturn {
  nfcState: UseNFCReturn
}

// ─── Constants ────────────────────────────────────────────────────

const POLLING_INTERVAL_MS = 1000 // Poll every 1 second
const POLLING_TIMEOUT_MS = 15 * 60 * 1000 // Stop polling after 15 minutes

// ─── Hook ─────────────────────────────────────────────────────────

/**
 * Hook for polling payment status and managing NFC payments.
 *
 * Extracted from Dashboard.js — contains:
 * - Payment status polling with 1s interval + 15min timeout
 * - NFC setup for Boltcard payments
 *
 * @param {Object} params
 * @param {Object|null} params.currentInvoice - Current invoice object
 * @param {Function} params.triggerPaymentAnimation - Trigger payment animation
 * @param {Object} params.posPaymentReceivedRef - Ref for POS payment received callback
 * @param {Function} params.fetchData - Fetch transaction data
 * @param {boolean} params.soundEnabled - Whether sound is enabled
 * @param {string} params.soundTheme - Current sound theme
 * @returns {Object} { nfcState }
 */
export function usePaymentPolling({
  currentInvoice,
  triggerPaymentAnimation,
  posPaymentReceivedRef,
  fetchData,
  soundEnabled,
  soundTheme,
  merchant,
}: UsePaymentPollingParams): UsePaymentPollingReturn {
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const pollingStartTimeRef = useRef<number | null>(null)

  // Keep latest invoice/callbacks in refs so the poll always reads fresh
  // values without restarting the interval on every render (the effect below
  // only restarts when the invoice identity — hash / verify URL / payment
  // request — actually changes).
  const invoiceRef = useRef(currentInvoice)
  invoiceRef.current = currentInvoice
  const pollDepsRef = useRef({ triggerPaymentAnimation, fetchData, merchant })
  pollDepsRef.current = { triggerPaymentAnimation, fetchData, merchant }

  // Poll for payment status when we have a pending invoice
  useEffect(() => {
    // Clear any existing polling
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }

    const splitsEnabled = isSplitPaymentsEnabled()

    // Set true by the effect cleanup so a stale in-flight request (issued
    // for a previous invoice) cannot settle and clear a replacement invoice.
    let cancelled = false

    // Start polling if we have anything to watch: a payment hash (escrow
    // path), a LUD-21 verify URL (LNURL direct-receive path), or — in direct
    // (no-escrow) mode only — a payment request (some NWC wallets omit the
    // hash). In escrow mode a hash-less invoice has nothing to poll against.
    if (
      currentInvoice?.paymentHash ||
      currentInvoice?.verifyUrl ||
      (!splitsEnabled && currentInvoice?.paymentRequest)
    ) {
      const logTarget = currentInvoice.paymentHash
        ? currentInvoice.paymentHash.substring(0, 16) + "..."
        : currentInvoice.verifyUrl ||
          (currentInvoice.paymentRequest
            ? currentInvoice.paymentRequest.substring(0, 16) + "..."
            : "unknown")
      console.log("🔄 Starting payment status polling for:", logTarget)
      pollingStartTimeRef.current = Date.now()

      // Per-invoice guards (scoped to this effect run):
      // - inFlight prevents overlapping requests on slow networks
      // - settled prevents a second overlapping response from double-firing
      //   the success path (animation, POS clear, fetchData)
      let inFlight = false
      let settled = false

      const pollPaymentStatus = async (): Promise<void> => {
        if (inFlight || settled) {
          return
        }

        // Check if we've exceeded the timeout
        if (Date.now() - (pollingStartTimeRef.current ?? 0) > POLLING_TIMEOUT_MS) {
          console.log("⏱️ Payment polling timeout reached (15 min) - stopping")
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current)
            pollingIntervalRef.current = null
          }
          return
        }

        // Skip network work while the tab is hidden; payment is re-checked
        // on focus/visibility by the POS and on the next visible tick here.
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          return
        }

        inFlight = true
        try {
          let completed = false
          let expired = false

          // Read the live invoice from the ref (not the effect closure) so an
          // in-flight poll always targets the current invoice.
          const pollInvoice = invoiceRef.current ?? currentInvoice
          if (!pollInvoice) {
            return
          }

          if (pollInvoice.verifyUrl) {
            // Self-custodial (Spark) / direct LNURL-pay receive: poll the LUD-21
            // verify URL. (Settlement is populated server-side via the SSP
            // webhook, so it may lag slightly behind the actual payment.)
            const verifyResult = await verifyLnurlPayment(pollInvoice.verifyUrl)
            completed = verifyResult.settled === true
          } else if (!splitsEnabled && pollInvoice.paymentRequest) {
            // Direct (no-escrow) receive for API-key / NWC merchants: the invoice
            // is on the merchant's own wallet, so there is no escrow record to
            // read. Poll Blink's public lnInvoicePaymentStatus query by payment
            // request (same mechanism the public POS uses).
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
                  input: { paymentRequest: pollInvoice.paymentRequest },
                },
              }),
            })
            const data = await response.json()
            completed = data.data?.lnInvoicePaymentStatus?.status === "PAID"
          } else if (pollInvoice.paymentHash) {
            // Legacy escrow path (dormant while Split Payments disabled): read the
            // BlinkPOS forwarding record status.
            const response = await fetch(`/api/payment-status/${pollInvoice.paymentHash}`)
            const data = await response.json()
            completed = data.status === "completed"
            expired = data.status === "expired"
          } else {
            // Nothing to poll for this invoice (e.g. escrow mode with no hash).
            return
          }

          // Ignore a stale response: the effect was cleaned up (invoice
          // switched or component unmounted) while the request was in flight.
          if (cancelled) {
            return
          }

          if (completed) {
            console.log("✅ Payment completed detected via polling!")
            settled = true

            // Stop polling
            if (pollingIntervalRef.current) {
              clearInterval(pollingIntervalRef.current)
              pollingIntervalRef.current = null
            }

            // Read the latest invoice/callbacks from refs (not the effect
            // closure) so the success screen + receipt show current fiat,
            // tip, merchant etc. even if they changed since polling started.
            const invoice = pollInvoice
            const {
              triggerPaymentAnimation: triggerAnimation,
              fetchData: refreshData,
              merchant: currentMerchant,
            } = pollDepsRef.current

            // Trigger payment animation with the richer invoice context so the
            // success screen + receipt can show fiat, payment hash, tip, etc.
            triggerAnimation({
              amount: invoice.satoshis || invoice.amount || 0,
              currency: "BTC",
              memo: invoice.memo || `Payment received`,
              isForwarded: true,
              satAmount: invoice.satAmount || invoice.satoshis || invoice.amount || 0,
              displayAmount: invoice.displayAmount,
              displayCurrency: invoice.displayCurrency,
              paymentHash: invoice.paymentHash,
              paymentRequest: invoice.paymentRequest,
              timestamp: Date.now(),
              merchant: currentMerchant,
              tipAmount: invoice.tipAmount,
              tipCurrency: invoice.tipCurrency,
              tipPercent: invoice.tipPercent,
            })

            // Clear POS invoice
            if (posPaymentReceivedRef.current) {
              posPaymentReceivedRef.current()
            }

            // Refresh transaction data
            refreshData()
          } else if (expired) {
            console.log("⏰ Payment expired")
            if (pollingIntervalRef.current) {
              clearInterval(pollingIntervalRef.current)
              pollingIntervalRef.current = null
            }
          }
          // For 'pending', 'processing', 'not_found' - keep polling
        } catch (error: unknown) {
          console.error("Payment status poll error:", error)
          // Continue polling despite errors
        } finally {
          inFlight = false
        }
      }

      // Poll immediately, then on interval
      pollPaymentStatus()
      pollingIntervalRef.current = setInterval(pollPaymentStatus, POLLING_INTERVAL_MS)
    }

    // Cleanup on unmount or when invoice changes
    return () => {
      cancelled = true
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
    }
    // paymentRequest is part of the key: it uniquely identifies an invoice and
    // is the only field guaranteed present on the direct (no-escrow) path, so a
    // new invoice always restarts polling even without a hash or verify URL.
  }, [
    currentInvoice?.paymentHash,
    currentInvoice?.verifyUrl,
    currentInvoice?.paymentRequest,
  ])

  // Setup NFC for Boltcard payments
  const nfcState: UseNFCReturn = useNFC({
    paymentRequest: currentInvoice?.paymentRequest,
    onPaymentSuccess: () => {
      console.log("🎉 NFC Boltcard payment successful")
      // Payment will be detected via webhook + polling
    },
    onPaymentError: (error: unknown) => {
      console.error("NFC payment error:", error)
    },
    soundEnabled,
    soundTheme,
  })

  return {
    nfcState,
  }
}

export default usePaymentPolling
