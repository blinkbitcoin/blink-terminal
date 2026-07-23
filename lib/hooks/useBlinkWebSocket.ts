import { useCallback, useEffect, useRef, useState } from "react"

import { getWsUrl } from "../config/api"
import { parseTxTimestamp } from "../time-utils"

/**
 * Payment data structure from WebSocket transaction events.
 *
 * `amount`/`currency` are the settlement values (sats / "BTC") shown on the
 * success animation. The optional fields below carry the richer context
 * available at payment-success time (from the client-held invoice + auth
 * context) so the success screen and printed receipt can show a formatted
 * fiat amount, merchant, payment hash, tip breakdown, etc.
 */
export interface PaymentData {
  amount: number
  currency: string
  memo?: string
  isForwarded?: boolean

  // Sats total (mirrors `amount` when currency is BTC; kept explicit for receipts)
  satAmount?: number

  // Fiat display values
  displayAmount?: number
  displayCurrency?: string

  // Identifiers / metadata for the receipt
  paymentHash?: string
  paymentRequest?: string
  timestamp?: number
  merchant?: string

  // Tip breakdown (structured, not just embedded in memo)
  tipAmount?: number
  tipCurrency?: string
  tipPercent?: number
}

/**
 * Return type for useBlinkWebSocket hook
 */
export interface UseBlinkWebSocketReturn {
  connected: boolean
  lastPayment: PaymentData | null
  showAnimation: boolean
  hideAnimation: () => void
  triggerPaymentAnimation: (data: PaymentData) => void
  manualReconnect: () => void
  reconnectAttempts: number
}

export function useBlinkWebSocket(
  apiKey: string | null,
  username: string | null,
): UseBlinkWebSocketReturn {
  const [lastPayment, setLastPayment] = useState<PaymentData | null>(null)
  const [showAnimation, setShowAnimation] = useState<boolean>(false)
  const [connected, setConnected] = useState<boolean>(false)
  const [reconnectAttempts, setReconnectAttempts] = useState<number>(0)
  // Bumping this nonce re-runs the connection effect, i.e. actually creates
  // a new WebSocket. (Previously reconnects only incremented
  // reconnectAttempts, which nothing listened to — reconnection was a no-op.)
  const [connectionNonce, setConnectionNonce] = useState<number>(0)
  // Ref mirror of reconnectAttempts so backoff math never reads a stale closure
  const reconnectAttemptsRef = useRef<number>(0)
  // Pending reconnect timer, cleared on new connection attempt / unmount
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track last user activity without triggering re-renders.
  // Previously this was useState, which caused a full Dashboard re-render on
  // every click/keydown/touchstart because Date.now() always produces a new value.
  const lastActivityRef = useRef<number>(Date.now())

  const resetReconnectAttempts = (): void => {
    reconnectAttemptsRef.current = 0
    setReconnectAttempts(0)
  }

  // Force a fresh connection attempt (resets backoff). Stable identity so
  // it can be used in effect deps.
  const forceReconnect = useCallback((): void => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    reconnectAttemptsRef.current = 0
    setReconnectAttempts(0)
    setConnectionNonce((n) => n + 1)
  }, [])

  // Function to handle reconnection with exponential backoff
  const scheduleReconnect = (): void => {
    // A reconnect is already scheduled (e.g. onerror followed by onclose)
    if (reconnectTimeoutRef.current) return

    const attempts = reconnectAttemptsRef.current
    // BTCPayServer pattern: after 10 consecutive failures, back off to 1 min
    const isOutage = attempts >= 10
    const delay = isOutage ? 60000 : Math.min(1000 * Math.pow(2, attempts), 30000) // Max 30 seconds

    if (isOutage) {
      console.log(
        "❌ WebSocket connection failed 10+ consecutive times - possible service outage.",
      )
    }
    console.log(`🔄 Scheduling reconnect in ${delay}ms (attempt ${attempts + 1})`)

    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectTimeoutRef.current = null
      reconnectAttemptsRef.current += 1
      setReconnectAttempts(reconnectAttemptsRef.current)
      setConnectionNonce((n) => n + 1) // re-run the connection effect
    }, delay)
  }

  useEffect(() => {
    if (!apiKey || !username) return

    const wsUrl: string = getWsUrl()
    console.log("🔗 Direct Blink WebSocket: Connecting to", wsUrl, {
      attempts: reconnectAttemptsRef.current,
    })

    // Connect directly to Blink WebSocket (environment-aware)
    const ws = new WebSocket(wsUrl, "graphql-transport-ws")

    ws.onopen = () => {
      console.log("🟢 Direct Blink WebSocket: Connected")
      setConnected(true)
      resetReconnectAttempts() // Reset attempts on successful connection

      // Send connection init with API key
      const initMessage = {
        type: "connection_init",
        payload: {
          "X-API-KEY": apiKey,
        },
      }

      console.log("📤 Direct Blink WebSocket: Sending connection init")
      ws.send(JSON.stringify(initMessage))
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data as string)
        console.log("📨 Direct Blink WebSocket: Message received:", message.type)

        // BTCPayServer pattern: Reset error count on successful message
        resetReconnectAttempts()

        if (message.type === "connection_ack") {
          console.log("✅ Direct Blink WebSocket: Authenticated")

          // Subscribe to transaction updates
          const subscription = {
            id: "1",
            type: "subscribe",
            payload: {
              query: `
                subscription myUpdates {
                  myUpdates {
                    update {
                      ... on LnUpdate {
                        transaction {
                          initiationVia {
                            ... on InitiationViaLn {
                              paymentHash
                            }
                          }
                          direction
                          settlementAmount
                          settlementCurrency
                          status
                          createdAt
                          memo
                        }
                      }
                    }
                  }
                }
              `,
              variables: {},
            },
          }

          console.log("📡 Direct Blink WebSocket: Subscribing to updates")
          ws.send(JSON.stringify(subscription))
        } else if (message.type === "next") {
          console.log("📝 Direct Blink WebSocket: Transaction data:", message.payload)

          const transaction = message.payload?.data?.myUpdates?.update?.transaction
          if (transaction && transaction.direction === "RECEIVE") {
            console.log("🎉 DIRECT PAYMENT DETECTED!", transaction)

            // Blink settlementAmount is in MINOR units of the wallet currency:
            // satoshis for BTC, cents for USD (settlementCurrency is "BTC" | "USD").
            // Normalize so downstream never treats cents as sats: BTC -> satAmount,
            // USD -> fiat displayAmount in dollars (cents / 100).
            const isBtcSettlement = transaction.settlementCurrency === "BTC"
            const isUsdSettlement = transaction.settlementCurrency === "USD"

            const paymentData: PaymentData = {
              amount: transaction.settlementAmount,
              currency: transaction.settlementCurrency,
              memo: transaction.memo,
              satAmount: isBtcSettlement ? transaction.settlementAmount : undefined,
              // USD settlement: settlementAmount is cents -> dollars for display.
              displayAmount: isUsdSettlement
                ? transaction.settlementAmount / 100
                : undefined,
              displayCurrency: isUsdSettlement ? "USD" : undefined,
              paymentHash: transaction.initiationVia?.paymentHash,
              // Blink's Timestamp scalar serializes createdAt as Unix seconds
              // (number). parseTxTimestamp also tolerates ISO strings defensively;
              // fall back to now if absent/unparsable.
              timestamp: (() => {
                if (!transaction.createdAt) return Date.now()
                const ts = parseTxTimestamp(transaction.createdAt)
                return Number.isNaN(ts) ? Date.now() : ts
              })(),
              merchant: username || undefined,
            }

            setLastPayment(paymentData)
            setShowAnimation(true)

            console.log("🎬 TRIGGERING ANIMATION! (Manual dismiss required)")
          }
        }
      } catch (error) {
        console.error("❌ Direct Blink WebSocket: Parse error:", error)
      }
    }

    ws.onclose = (event: CloseEvent) => {
      console.log("🔴 Direct Blink WebSocket: Closed", event.code, event.reason)
      setConnected(false)

      // Only reconnect if it wasn't a manual close (code 1000)
      if (event.code !== 1000 && apiKey && username) {
        console.log("🔄 Connection lost, scheduling reconnect...")
        scheduleReconnect()
      }
    }

    ws.onerror = (error: Event) => {
      console.error("❌ Direct Blink WebSocket: Error:", error)
      setConnected(false)

      // Schedule reconnect on error
      if (apiKey && username) {
        console.log("🔄 Connection error, scheduling reconnect...")
        scheduleReconnect()
      }
    }

    // Cleanup
    return () => {
      // Detach handlers first so a socket torn down by this cleanup can't
      // fire scheduleReconnect / setState after the effect is gone.
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      // Close CONNECTING sockets too (previously leaked)
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000)
      }
      // Any reconnect scheduled by this connection is obsolete
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, username, connectionNonce])

  // Activity-based reconnection - detect when user becomes active
  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (!document.hidden && !connected && apiKey && username) {
        console.log("🎯 Tab became visible and not connected - triggering reconnect")
        forceReconnect()
      }
    }

    const handleFocus = (): void => {
      lastActivityRef.current = Date.now()
      if (!connected && apiKey && username) {
        console.log("🎯 Window focused and not connected - triggering reconnect")
        forceReconnect()
      }
    }

    const handleUserActivity = (): void => {
      lastActivityRef.current = Date.now()
    }

    // Listen for visibility and focus events
    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("focus", handleFocus)

    // Listen for user activity
    window.addEventListener("click", handleUserActivity)
    window.addEventListener("keydown", handleUserActivity)
    window.addEventListener("touchstart", handleUserActivity)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("focus", handleFocus)
      window.removeEventListener("click", handleUserActivity)
      window.removeEventListener("keydown", handleUserActivity)
      window.removeEventListener("touchstart", handleUserActivity)
    }
  }, [connected, apiKey, username, forceReconnect])

  // Manual reconnection function
  const manualReconnect = (): void => {
    console.log("🔄 Manual reconnect triggered")
    forceReconnect()
  }

  // Function to manually trigger payment animation (for forwarded payments)
  const triggerPaymentAnimation = (paymentData: PaymentData): void => {
    setLastPayment(paymentData)
    setShowAnimation(true)
  }

  return {
    connected,
    lastPayment,
    showAnimation,
    hideAnimation: () => setShowAnimation(false),
    triggerPaymentAnimation,
    manualReconnect,
    reconnectAttempts,
  }
}
