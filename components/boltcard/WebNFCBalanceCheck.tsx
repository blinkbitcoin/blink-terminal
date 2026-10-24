/**
 * WebNFCBalanceCheck - Web NFC-based balance checker for Boltcards
 *
 * Allows Android Chrome users to tap their Boltcard on a web page
 * to check their balance without logging in.
 *
 * How it works:
 * 1. User opens the balance check page
 * 2. Web NFC reads the card's NDEF URL when tapped
 * 3. Component extracts cardId, p, c params from the URL
 * 4. Calls /api/boltcard/balance/{cardId}?p=...&c=... to get balance
 * 5. Displays balance using CardholderBalance component
 *
 * Browser Support:
 * - Chrome on Android (HTTPS required)
 * - Not supported on iOS, desktop browsers, or other mobile browsers
 */

import { QRCodeSVG } from "qrcode.react"
import { useState, useEffect, useRef, useCallback } from "react"

import CardholderBalance, { type CardholderBalanceData } from "./CardholderBalance"

// ============================================================================
// Types & Interfaces
// ============================================================================

/**
 * Component states as a const object (mirrors the JS pattern)
 */
const State = {
  CHECKING: "checking", // Checking Web NFC support
  SUPPORTED: "supported", // Web NFC available, ready to scan
  NOT_SUPPORTED: "not_supported", // Web NFC not available
  SCANNING: "scanning", // Actively scanning for NFC
  LOADING: "loading", // Loading balance from API
  SUCCESS: "success", // Balance loaded successfully
  ERROR: "error", // Error occurred
} as const

type StateValue = (typeof State)[keyof typeof State]

/** Parsed Boltcard URL data */
interface ParsedBoltcardUrl {
  cardId: string
  p: string
  c: string
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Decode NDEF record data to string
 */
function decodeNDEFRecord(record: NDEFRecord): string {
  if (!record.data) {
    console.log("[WebNFC] No data in record")
    return ""
  }

  let buffer: ArrayBufferLike
  if (record.data instanceof ArrayBuffer) {
    buffer = record.data
  } else if (record.data instanceof DataView) {
    buffer = record.data.buffer
  } else {
    console.log("[WebNFC] Unsupported data type")
    return ""
  }

  const decoder = new TextDecoder(record.encoding || "utf-8")
  return decoder.decode(buffer)
}

/**
 * Parse Boltcard URL to extract cardId and auth params
 *
 * Example input: lnurlw://terminal.blinkbtc.com/api/boltcard/lnurlw/95cf01bac29a10c17b7d32794d9421a3?p=A2EF40...&c=F509EE...
 * Returns: { cardId: '95cf01bac29a10c17b7d32794d9421a3', p: 'A2EF40...', c: 'F509EE...' }
 */
function parseBoltcardUrl(url: string): ParsedBoltcardUrl | null {
  try {
    console.log("[WebNFC] Parsing URL:", url)

    // Handle both lnurlw:// and https:// schemes
    const normalizedUrl = url.replace(/^lnurlw:\/\//, "https://")
    const urlObj = new URL(normalizedUrl)

    // Extract cardId from path
    // Path format: /api/boltcard/lnurlw/{cardId}
    const pathParts = urlObj.pathname.split("/")
    const lnurlwIndex = pathParts.indexOf("lnurlw")

    if (lnurlwIndex === -1 || lnurlwIndex >= pathParts.length - 1) {
      console.log("[WebNFC] Could not find cardId in path:", urlObj.pathname)
      return null
    }

    const cardId = pathParts[lnurlwIndex + 1]
    const p = urlObj.searchParams.get("p")
    const c = urlObj.searchParams.get("c")

    if (!cardId || !p || !c) {
      console.log(
        "[WebNFC] Missing required params - cardId:",
        cardId,
        "p:",
        !!p,
        "c:",
        !!c,
      )
      return null
    }

    console.log("[WebNFC] Parsed successfully - cardId:", cardId)
    return { cardId, p, c }
  } catch (error: unknown) {
    console.error("[WebNFC] URL parsing error:", error)
    return null
  }
}

// ============================================================================
// Component
// ============================================================================

/**
 * WebNFCBalanceCheck component
 */
export default function WebNFCBalanceCheck() {
  const [state, setState] = useState<StateValue>(State.CHECKING)
  const [error, setError] = useState<string | null>(null)
  const [balanceData, setBalanceData] = useState<CardholderBalanceData | null>(null)
  const [currentUrl, setCurrentUrl] = useState("")

  const ndefReaderRef = useRef<NDEFReader | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  /**
   * Check if Web NFC is supported
   */
  useEffect(() => {
    if (typeof window === "undefined") return

    // Small delay to allow page to fully load
    const timer = setTimeout(() => {
      if ("NDEFReader" in window) {
        console.log("[WebNFC] Web NFC is supported")
        setState(State.SUPPORTED)
      } else {
        console.log("[WebNFC] Web NFC is NOT supported")
        setState(State.NOT_SUPPORTED)
      }

      // Get current URL for QR code
      setCurrentUrl(window.location.href)
    }, 500)

    return () => clearTimeout(timer)
  }, [])

  /**
   * Fetch balance from API
   */
  const fetchBalance = useCallback(
    async (cardId: string, p: string, c: string): Promise<void> => {
      setState(State.LOADING)
      setError(null)

      try {
        console.log("[WebNFC] Fetching balance for card:", cardId)

        const response = await fetch(
          `/api/boltcard/balance/${cardId}?p=${encodeURIComponent(p)}&c=${encodeURIComponent(c)}`,
        )

        const data: CardholderBalanceData & { reason?: string; message?: string } =
          await response.json()

        if (!response.ok) {
          throw new Error(data.reason || data.message || "Failed to load balance")
        }

        console.log("[WebNFC] Balance loaded successfully")
        setBalanceData(data)
        setState(State.SUCCESS)
      } catch (err: unknown) {
        console.error("[WebNFC] Balance fetch error:", err)
        setError((err as Error).message || "Failed to load balance")
        setState(State.ERROR)
      }
    },
    [],
  )

  /**
   * Handle NFC read event
   */
  const handleNFCRead = useCallback(
    (event: NDEFReadingEvent): void => {
      console.log("[WebNFC] NFC tag detected")

      // Find the URL record
      for (const record of event.message.records) {
        const data = decodeNDEFRecord(record)
        console.log("[WebNFC] Record data:", data)

        // Check if this is a Boltcard URL
        if (data && (data.includes("lnurlw://") || data.includes("/api/boltcard/"))) {
          const parsed = parseBoltcardUrl(data)

          if (parsed) {
            // Stop scanning
            if (abortControllerRef.current) {
              abortControllerRef.current.abort()
              abortControllerRef.current = null
            }

            // Fetch balance
            fetchBalance(parsed.cardId, parsed.p, parsed.c)
            return
          }
        }
      }

      // No valid Boltcard URL found
      console.log("[WebNFC] No valid Boltcard URL found in NFC data")
      setError("This doesn't appear to be a Boltcard. Please try a different card.")
      setState(State.ERROR)
    },
    [fetchBalance],
  )

  /**
   * Start NFC scanning
   */
  const startScanning = useCallback(async (): Promise<void> => {
    if (!("NDEFReader" in window)) {
      setState(State.NOT_SUPPORTED)
      return
    }

    setState(State.SCANNING)
    setError(null)
    setBalanceData(null)

    try {
      // Create abort controller for cleanup
      abortControllerRef.current = new AbortController()

      // Create NFC reader
      const ndef = new NDEFReader()
      ndefReaderRef.current = ndef

      // Start scanning
      await ndef.scan({ signal: abortControllerRef.current.signal })
      console.log("[WebNFC] NFC scan started")

      // Set up read handler
      ndef.onreading = handleNFCRead

      ndef.onreadingerror = (err: Event) => {
        console.error("[WebNFC] Read error:", err)
        setError("Could not read the card. Please try again.")
        setState(State.ERROR)
      }
    } catch (err: unknown) {
      console.error("[WebNFC] Scan error:", err)

      if ((err as DOMException).name === "NotAllowedError") {
        setError("NFC permission denied. Please allow NFC access and try again.")
      } else if ((err as DOMException).name === "NotSupportedError") {
        setState(State.NOT_SUPPORTED)
        return
      } else {
        setError("Failed to start NFC scan. Please try again.")
      }
      setState(State.ERROR)
    }
  }, [handleNFCRead])

  /**
   * Stop NFC scanning
   */
  const stopScanning = useCallback((): void => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    ndefReaderRef.current = null
  }, [])

  /**
   * Reset to initial state
   */
  const reset = useCallback((): void => {
    stopScanning()
    setBalanceData(null)
    setError(null)
    setState(State.SUPPORTED)
  }, [stopScanning])

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      stopScanning()
    }
  }, [stopScanning])

  // ============ RENDER ============

  // Checking support
  if (state === State.CHECKING) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-yellow-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Checking NFC support...</p>
        </div>
      </div>
    )
  }

  // Not supported - show fallback with QR code
  if (state === State.NOT_SUPPORTED) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          {/* Icon */}
          <div className="w-20 h-20 bg-yellow-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg
              className="w-10 h-10 text-yellow-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
              />
            </svg>
          </div>

          {/* Message */}
          <h1 className="text-2xl font-bold text-white mb-3">Android Chrome Required</h1>
          <p className="text-gray-400 mb-8">
            Web NFC is only supported in Chrome on Android devices. Scan the QR code below
            to open this page on your Android phone.
          </p>

          {/* QR Code */}
          {currentUrl && (
            <div className="bg-white p-4 rounded-xl inline-block mb-4">
              <QRCodeSVG value={currentUrl} size={180} level="M" includeMargin={false} />
            </div>
          )}

          <p className="text-gray-500 text-sm">
            Scan with your Android phone&apos;s camera
          </p>

          {/* Alternative */}
          <div className="mt-8 pt-6 border-t border-gray-800">
            <p className="text-gray-500 text-sm">
              On iOS? Ask your card owner for a balance link.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Success - show balance
  if (state === State.SUCCESS && balanceData) {
    return (
      <div>
        <CardholderBalance data={balanceData} />

        {/* Tap another card button */}
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black via-black to-transparent">
          <div className="max-w-md mx-auto">
            <button
              onClick={reset}
              className="w-full py-3 bg-gray-800 hover:bg-gray-700 text-white font-medium rounded-xl transition-colors"
            >
              Check Another Card
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Loading
  if (state === State.LOADING) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-yellow-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Loading balance...</p>
        </div>
      </div>
    )
  }

  // Error state
  if (state === State.ERROR) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-8 h-8 text-red-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-white mb-2">Something Went Wrong</h1>
          <p className="text-gray-400 mb-6">{error}</p>
          <button
            onClick={startScanning}
            className="px-6 py-3 bg-yellow-500 hover:bg-yellow-400 text-black font-medium rounded-xl transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    )
  }

  // Supported / Scanning - main UI
  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="text-center max-w-md">
        {/* NFC Animation */}
        <div className="relative w-32 h-32 mx-auto mb-8">
          {/* Outer rings - pulsing when scanning */}
          <div
            className={`absolute inset-0 rounded-full border-2 border-yellow-500/30 ${state === State.SCANNING ? "animate-ping" : ""}`}
          />
          <div
            className={`absolute inset-4 rounded-full border-2 border-yellow-500/50 ${state === State.SCANNING ? "animate-ping animation-delay-150" : ""}`}
          />

          {/* Center icon */}
          <div className="absolute inset-8 bg-yellow-500/20 rounded-full flex items-center justify-center">
            <svg
              className="w-10 h-10 text-yellow-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
              />
              {/* NFC waves */}
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M8.5 10.5c1-1 2.5-1 3.5 0M7 9c2-2 5-2 7 0"
              />
            </svg>
          </div>
        </div>

        {/* Title */}
        <h1 className="text-2xl font-bold text-white mb-3">
          {state === State.SCANNING ? "Tap Your Card Now" : "Check Your Balance"}
        </h1>

        {/* Instructions */}
        <p className="text-gray-400 mb-8">
          {state === State.SCANNING
            ? "Hold your Boltcard against the back of your phone"
            : "Tap the button below, then tap your Boltcard on your phone to see your balance"}
        </p>

        {/* Action Button */}
        {state === State.SUPPORTED && (
          <button
            onClick={startScanning}
            className="px-8 py-4 bg-yellow-500 hover:bg-yellow-400 text-black font-bold text-lg rounded-xl transition-colors shadow-lg shadow-yellow-500/25"
          >
            Start NFC Scan
          </button>
        )}

        {state === State.SCANNING && (
          <button
            onClick={reset}
            className="px-6 py-3 bg-gray-800 hover:bg-gray-700 text-white font-medium rounded-xl transition-colors"
          >
            Cancel
          </button>
        )}

        {/* Help text */}
        <p className="text-gray-600 text-sm mt-8">
          Works with any Boltcard linked to this service
        </p>
      </div>
    </div>
  )
}
