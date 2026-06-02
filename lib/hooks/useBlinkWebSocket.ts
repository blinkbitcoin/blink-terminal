import { useEffect, useRef, useState } from "react"

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
  // Track last user activity without triggering re-renders.
  // Previously this was useState, which caused a full Dashboard re-render on
  // every click/keydown/touchstart because Date.now() always produces a new value.
  const lastActivityRef = useRef<number>(Date.now())

  // Function to create WebSocket connection
  const createConnection = (): WebSocket | null => {
    if (!apiKey || !username) return null

    const wsUrl: string = getWsUrl()
    console.log("🔗 Direct Blink WebSocket: Connecting to", wsUrl, {
      attempts: reconnectAttempts,
    })

    // Connect directly to Blink WebSocket (environment-aware)
    const ws = new WebSocket(wsUrl, "graphql-transport-ws")

    return ws
  }

  // Function to handle reconnection with exponential backoff
  const scheduleReconnect = (): void => {
    // BTCPayServer pattern: Only give up after 10 consecutive failures
    if (reconnectAttempts >= 10) {
      console.log(
        "❌ WebSocket connection abandoned after 10 consecutive failures - possible service outage.",
      )
      const delay = 60000 // 1 minute delay after 10 failures
      console.log(
        `🔄 Scheduling reconnect in ${delay}ms (attempt ${reconnectAttempts + 1}) - service outage mode`,
      )

      setTimeout(() => {
        setReconnectAttempts((prev) => prev + 1)
      }, delay)
      return
    }

    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000) // Max 30 seconds
    console.log(
      `🔄 Scheduling reconnect in ${delay}ms (attempt ${reconnectAttempts + 1})`,
    )

    setTimeout(() => {
      setReconnectAttempts((prev) => prev + 1)
    }, delay)
  }

  useEffect(() => {
    if (!apiKey || !username) return

    const ws = createConnection()
    if (!ws) return

    ws.onopen = () => {
      console.log("🟢 Direct Blink WebSocket: Connected")
      setConnected(true)
      setReconnectAttempts(0) // Reset attempts on successful connection

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
        setReconnectAttempts(0)

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

            const paymentData: PaymentData = {
              amount: transaction.settlementAmount,
              currency: transaction.settlementCurrency,
              memo: transaction.memo,
              satAmount:
                transaction.settlementCurrency === "BTC"
                  ? transaction.settlementAmount
                  : undefined,
              paymentHash: transaction.initiationVia?.paymentHash,
              // createdAt may be Unix seconds (number) or an ISO string; parse
              // robustly and fall back to now if absent/unparseable.
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
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, username])

  // Activity-based reconnection - detect when user becomes active
  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (!document.hidden && !connected && apiKey && username) {
        console.log("🎯 Tab became visible and not connected - triggering reconnect")
        setReconnectAttempts((prev) => prev + 1)
      }
    }

    const handleFocus = (): void => {
      lastActivityRef.current = Date.now()
      if (!connected && apiKey && username) {
        console.log("🎯 Window focused and not connected - triggering reconnect")
        setReconnectAttempts((prev) => prev + 1)
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
  }, [connected, apiKey, username])

  // Manual reconnection function
  const manualReconnect = (): void => {
    console.log("🔄 Manual reconnect triggered")
    setReconnectAttempts((prev) => prev + 1)
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
