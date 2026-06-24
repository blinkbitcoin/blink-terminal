import { useState, useEffect, useRef } from "react"

import { playSound, SOUND_THEMES, type SoundThemeName } from "../lib/audio-utils"

const decodeNDEFRecord = (record: NDEFRecord): string => {
  if (!record.data) {
    console.log("No data found in NFC record")
    return ""
  }

  let buffer: ArrayBuffer
  if (record.data instanceof ArrayBuffer) {
    buffer = record.data
  } else if (record.data instanceof DataView) {
    buffer = record.data.buffer as ArrayBuffer
  } else {
    console.log("Data type not supported")
    return ""
  }

  const decoder = new TextDecoder(record.encoding || "utf-8")
  return decoder.decode(buffer)
}

// Hook to manage NFC state and functionality

interface UseNFCParams {
  paymentRequest: string | null | undefined
  onPaymentSuccess?: (response: Record<string, unknown>) => void
  onPaymentError?: (message: string) => void
  soundEnabled: boolean
  soundTheme?: string
}

export interface UseNFCReturn {
  isNfcSupported: boolean
  hasNFCPermission: boolean
  isProcessing: boolean
  activateNfcScan: () => Promise<void>
}

export const useNFC = ({
  paymentRequest,
  onPaymentSuccess,
  onPaymentError,
  soundEnabled,
  soundTheme = "success",
}: UseNFCParams): UseNFCReturn => {
  const [hasNFCPermission, setHasNFCPermission] = useState<boolean>(false)
  const [nfcMessage, setNfcMessage] = useState<string>("")
  const [isNfcSupported, setIsNfcSupported] = useState<boolean>(false)
  const [isProcessing, setIsProcessing] = useState<boolean>(false)
  const ndefReaderRef = useRef<NDEFReader | null>(null)
  const soundPlayedRef = useRef<boolean>(false)

  const handleNFCScan = async (): Promise<void> => {
    if (typeof window === "undefined" || !("NDEFReader" in window)) {
      console.error("NFC is not supported on this device/browser")
      return
    }

    // If we already have an active reader, don't create a new one
    if (ndefReaderRef.current) {
      console.log("NFC reader already active, skipping new scan setup")
      return
    }

    console.log("NFC is supported, starting scan...")

    const ndef = new NDEFReader()
    ndefReaderRef.current = ndef

    try {
      await ndef.scan()
      console.log("NFC scan started successfully.")

      ndef.onreading = (event: NDEFReadingEvent) => {
        console.log("NFC tag detected and read:", event.message)
        const record = event.message.records[0]
        const text = decodeNDEFRecord(record)
        console.log("Decoded NFC message:", text)
        setNfcMessage(text)
      }

      ndef.onreadingerror = (error: Event) => {
        console.error("Cannot read data from the NFC tag:", error)
        if (onPaymentError) {
          onPaymentError("Cannot read NFC tag. Please try again.")
        }
      }
    } catch (error: unknown) {
      console.error(`Error! Scan failed to start: ${error}`)
      ndefReaderRef.current = null // Reset on error
    }
  }

  const activateNfcScan = async (): Promise<void> => {
    try {
      await handleNFCScan()
      alert(
        "Boltcard is now active. There will be no need to activate it again. Please tap your card to process the payment.",
      )
    } catch (error: unknown) {
      console.error("Failed to activate NFC:", error)
      if (onPaymentError) {
        onPaymentError("Failed to activate NFC. Please try again.")
      }
    }
  }

  // Check NFC support and permissions on mount
  useEffect(() => {
    if (typeof window === "undefined") return

    const nfcSupported = "NDEFReader" in window
    setIsNfcSupported(nfcSupported)
    ;(async () => {
      // Skip the permission query entirely when Web NFC is unsupported (e.g.
      // desktop Chrome). Querying { name: "nfc" } there throws
      // "Web NFC is not enabled", which clutters the dev error overlay.
      if (!nfcSupported) {
        setHasNFCPermission(false)
        return
      }

      if (!("permissions" in navigator)) {
        console.error("Permissions API not supported")
        return
      }

      let result: PermissionStatus
      try {
        // @ts-expect-error NFC permission is not in TypeScript's navigator.permissions
        result = await navigator.permissions.query({ name: "nfc" })
      } catch (err: unknown) {
        console.error("Error querying NFC permission:", err)
        return
      }

      console.log("NFC permission query result:", result)

      if (result.state === "granted") {
        setHasNFCPermission(true)
      } else {
        setHasNFCPermission(false)
      }

      result.onchange = () => {
        if (result.state === "granted") {
          setHasNFCPermission(true)
        } else {
          setHasNFCPermission(false)
        }
      }
    })()
  }, [])

  // Auto-start scanning when permission is granted
  useEffect(() => {
    if (hasNFCPermission) {
      handleNFCScan()
    }

    // Cleanup function
    return () => {
      if (ndefReaderRef.current) {
        console.log("Cleaning up NFC reader")
        // Note: NDEFReader doesn't have a stop() method, but we clear the ref
        ndefReaderRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasNFCPermission])

  // Process NFC message when received
  useEffect(() => {
    ;(async () => {
      if (!nfcMessage) {
        return
      }

      // Validate that it's an LNURL
      if (!nfcMessage.toLowerCase().includes("lnurl")) {
        console.error("Not a compatible Boltcard")
        setNfcMessage("") // Reset for next scan
        return
      }

      // Check if we have a payment request (invoice)
      if (!paymentRequest) {
        console.error("No payment request available for NFC payment")
        setNfcMessage("") // Reset for next scan
        return
      }

      // Play NFC tap sound if enabled (only once per payment, uses shared audio utility for iOS compatibility)
      if (soundEnabled && !soundPlayedRef.current) {
        soundPlayedRef.current = true
        const themeConfig =
          SOUND_THEMES[soundTheme as SoundThemeName] || SOUND_THEMES.success
        playSound(themeConfig.nfc, 0.5)
      }

      setIsProcessing(true)

      try {
        // Call our proxy endpoint to handle the LNURL request
        const result = await fetch("/api/lnurl-proxy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            lnurl: nfcMessage,
            paymentRequest,
          }),
        })

        if (result.ok) {
          const lnurlResponse = await result.json()

          if (lnurlResponse?.status?.toLowerCase() === "ok") {
            console.log("✅ Boltcard payment successful!")
            if (onPaymentSuccess) {
              onPaymentSuccess(lnurlResponse)
            }
          } else {
            // Log error but don't show alert - payment might have succeeded via WebSocket
            console.log(
              "LNURL response status:",
              lnurlResponse.status,
              lnurlResponse.reason,
            )
            // Don't call onPaymentError or show alert - WebSocket will handle success
          }
        } else {
          // Log error but don't show alert - payment might have succeeded via WebSocket
          let errorMessage = ""
          try {
            const decoded = await result.json()
            if (decoded.reason) {
              errorMessage += decoded.reason
            }
            if (decoded.message) {
              errorMessage += decoded.message
            }
          } catch (_e: unknown) {
            errorMessage = "Unknown error"
          }

          // HTTP 400 with "Replayed or expired query" means payment already processed
          console.log(`LNURL withdraw response: ${result.status} - ${errorMessage}`)
          // Don't show alert - the payment likely succeeded via WebSocket already
        }
      } catch (error: unknown) {
        console.error("Error processing Boltcard payment:", error)
        // Don't show alert - payment might have succeeded via WebSocket
        // The catch error is often a network/CORS issue after payment succeeds
      } finally {
        setIsProcessing(false)
        setNfcMessage("") // Reset for next scan
        soundPlayedRef.current = false // Reset sound flag for next payment
      }
    })()
  }, [
    nfcMessage,
    paymentRequest,
    soundEnabled,
    soundTheme,
    onPaymentSuccess,
    onPaymentError,
  ])

  // Return the state and control functions
  return {
    isNfcSupported,
    hasNFCPermission,
    isProcessing,
    activateNfcScan,
  }
}

// Default export for backwards compatibility (though not used anymore)
export default function NFCPayment() {
  return null
}
