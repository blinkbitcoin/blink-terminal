import { bech32 } from "bech32"
import {
  useState,
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from "react"
import QRCode from "react-qr-code"

import {
  formatDisplayAmount as formatCurrency,
  isBitcoinCurrency,
  CurrencyMetadata,
} from "../lib/currency-utils"

import { ExpiryBadge, formatExpiryDate } from "./ExpirySelector"

// =============================================================================
// Types
// =============================================================================

type VoucherStatus = "ACTIVE" | "CLAIMED" | "CANCELLED" | "EXPIRED"
type StatusFilter = "all" | "active" | "expiring" | "claimed" | "cancelled" | "expired"
type CurrencyFilterType = "all" | "BTC" | "USD"

interface VoucherWallet {
  apiKey?: string
  walletId?: string
  username?: string
  [key: string]: unknown
}

interface VoucherStats {
  total: number
  active: number
  claimed: number
  cancelled: number
  expired: number
  expiringSoon: number
}

interface VoucherData {
  id: string
  shortId: string
  amount: number
  displayAmount?: number
  displayCurrency?: string
  commissionPercent?: number
  expiresAt?: number
  createdAt: number
  claimedAt?: number
  cancelledAt?: number
  status: VoucherStatus
  timeRemaining?: number
  walletCurrency?: string
  usdAmountCents?: number | null
  lnurl?: string
}

interface VoucherManagerProps {
  voucherWallet: VoucherWallet | null
  displayCurrency: string
  currencies: CurrencyMetadata[]
  darkMode: boolean
  theme: string
  cycleTheme: () => void
  soundEnabled: boolean
  onInternalTransition?: () => void
}

export interface VoucherManagerRef {
  getCurrentStep: () => string
  hasValidAmount: () => boolean
  handleDigitPress: () => void
  handleBackspace: () => void
  handleClear: () => void
  handleSubmit: () => void
  isCommissionDialogOpen: () => boolean
  handleCommissionDialogKey: () => void
}

// =============================================================================
// Component
// =============================================================================

const VoucherManager = forwardRef<VoucherManagerRef, VoucherManagerProps>(
  (
    {
      voucherWallet,
      displayCurrency: _displayCurrency,
      currencies,
      darkMode: _darkMode,
      theme: _theme,
      cycleTheme: _cycleTheme,
      soundEnabled: _soundEnabled,
      onInternalTransition,
    },
    ref,
  ) => {
    const [vouchers, setVouchers] = useState<VoucherData[]>([])
    const [stats, setStats] = useState<VoucherStats>({
      total: 0,
      active: 0,
      claimed: 0,
      cancelled: 0,
      expired: 0,
      expiringSoon: 0,
    })
    const [loading, setLoading] = useState<boolean>(true)
    const [error, setError] = useState<string>("")
    const [selectedVoucher, setSelectedVoucher] = useState<VoucherData | null>(null)
    const [filter, setFilter] = useState<StatusFilter>("all")
    const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilterType>("all")
    const [cancelling, setCancelling] = useState<boolean>(false)
    const [reissuing, setReissuing] = useState<boolean>(false)

    const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const qrRef = useRef<HTMLDivElement>(null)

    // Fetch vouchers
    const fetchVouchers = useCallback(async () => {
      try {
        setError("")
        const response = await fetch("/api/voucher/list")
        const data = await response.json()

        if (data.success) {
          setVouchers(data.vouchers)
          if (data.stats) {
            setStats(data.stats)
          }
        } else {
          setError(data.error || "Failed to load vouchers")
        }
      } catch (err: unknown) {
        console.error("Error fetching vouchers:", err)
        setError("Failed to load vouchers")
      } finally {
        setLoading(false)
      }
    }, [])

    // Expose methods for keyboard navigation
    useImperativeHandle(ref, () => ({
      getCurrentStep: () => "list",
      hasValidAmount: () => false,
      handleDigitPress: () => {},
      handleBackspace: () => {},
      handleClear: () => {
        fetchVouchers()
      },
      handleSubmit: () => {},
      isCommissionDialogOpen: () => false,
      handleCommissionDialogKey: () => {},
    }))

    // Cancel voucher
    const cancelVoucher = async (voucherId: string) => {
      if (!voucherId) return

      setCancelling(true)
      try {
        const response = await fetch("/api/voucher/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chargeId: voucherId }),
        })

        const data = await response.json()

        if (data.success) {
          // Refresh vouchers list
          await fetchVouchers()
          setSelectedVoucher(null)
        } else {
          setError(data.error || "Failed to cancel voucher")
        }
      } catch (err: unknown) {
        console.error("Error cancelling voucher:", err)
        setError("Failed to cancel voucher")
      } finally {
        setCancelling(false)
      }
    }

    // Encode LNURL
    const encodeLnurl = (url: string): string => {
      try {
        const bytes = new TextEncoder().encode(url)
        const words = bech32.toWords(bytes)
        const encoded = bech32.encode("lnurl", words, 2000)
        return encoded.toUpperCase()
      } catch (error) {
        console.error("Failed to encode LNURL:", error)
        throw error
      }
    }

    // Get QR code as data URL
    const getQrDataUrl = (qrElement: HTMLDivElement | null): Promise<string> => {
      return new Promise((resolve, reject) => {
        if (!qrElement) {
          reject(new Error("QR element not found"))
          return
        }

        const svg = qrElement.querySelector("svg")
        if (!svg) {
          reject(new Error("SVG element not found"))
          return
        }

        const clonedSvg = svg.cloneNode(true) as SVGSVGElement
        clonedSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg")

        const width = 256
        const height = 256
        clonedSvg.setAttribute("width", String(width))
        clonedSvg.setAttribute("height", String(height))

        const svgData = new XMLSerializer().serializeToString(clonedSvg)
        const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" })
        const svgUrl = URL.createObjectURL(svgBlob)

        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement("canvas")
          canvas.width = width
          canvas.height = height
          const ctx = canvas.getContext("2d")

          ctx!.fillStyle = "#FFFFFF"
          ctx!.fillRect(0, 0, width, height)
          ctx!.drawImage(img, 0, 0, width, height)

          const pngDataUrl = canvas.toDataURL("image/png")
          URL.revokeObjectURL(svgUrl)
          resolve(pngDataUrl)
        }

        img.onerror = () => {
          URL.revokeObjectURL(svgUrl)
          reject(new Error("Failed to load SVG image"))
        }

        img.src = svgUrl
      })
    }

    // Get logo data URL
    const getLogoDataUrl = (): Promise<string | null> => {
      return new Promise((resolve) => {
        const img = new Image()
        img.crossOrigin = "anonymous"
        img.onload = () => {
          const canvas = document.createElement("canvas")
          canvas.width = 300
          canvas.height = 125
          const ctx = canvas.getContext("2d")
          ctx!.fillStyle = "#FFFFFF"
          ctx!.fillRect(0, 0, canvas.width, canvas.height)
          ctx!.drawImage(img, 0, 0, 300, 125)
          resolve(canvas.toDataURL("image/png"))
        }
        img.onerror = () => {
          console.warn("Could not load logo")
          resolve(null)
        }
        img.src = "/blink-logo-black.svg"
      })
    }

    // Generate voucher secret from charge ID
    const generateVoucherSecret = (chargeId: string): string | null => {
      if (!chargeId) return null
      return chargeId.replace(/-/g, "").substring(0, 12)
    }

    // Reissue voucher as PDF with LNURL
    const reissueVoucher = async (voucher: VoucherData) => {
      if (!voucher) return

      setReissuing(true)
      setError("")

      try {
        // Build the LNURL
        const protocol = window.location.protocol
        const host = window.location.host
        const lnurlUrl = `${protocol}//${host}/api/voucher/lnurl/${voucher.id}/${voucher.amount}`
        const lnurl = encodeLnurl(lnurlUrl)

        console.log(
          "📄 Reissuing voucher:",
          voucher.id,
          "LNURL:",
          lnurl.substring(0, 30) + "...",
        )

        // Wait a moment for QR to render
        await new Promise((resolve) => setTimeout(resolve, 100))

        // Get QR code and logo
        const [qrDataUrl, logoDataUrl] = await Promise.all([
          getQrDataUrl(qrRef.current),
          getLogoDataUrl(),
        ])

        if (!qrDataUrl) {
          throw new Error("Could not capture QR code")
        }

        // Build fiat amount string
        let fiatAmount: string | null = null
        if (voucher.displayCurrency && !isBitcoinCurrency(voucher.displayCurrency)) {
          fiatAmount = formatCurrency(
            voucher.displayAmount ?? 0,
            voucher.displayCurrency,
            currencies,
          )
        }

        // Call PDF API with reissue format
        const response = await fetch("/api/voucher/pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vouchers: [
              {
                satsAmount: voucher.amount,
                fiatAmount: fiatAmount,
                qrDataUrl: qrDataUrl,
                logoDataUrl: logoDataUrl,
                identifierCode: voucher.id?.substring(0, 8)?.toUpperCase() || null,
                voucherSecret: generateVoucherSecret(voucher.id),
                commissionPercent: voucher.commissionPercent || 0,
                expiresAt: voucher.expiresAt || null,
                lnurl: lnurl,
                issuedBy: voucherWallet?.username || null,
                // USD voucher fields
                walletCurrency: voucher.walletCurrency || "BTC",
                usdAmountCents: voucher.usdAmountCents || null,
              },
            ],
            format: "reissue",
          }),
        })

        const data = await response.json()

        if (!response.ok || !data.success) {
          throw new Error(data.error || data.message || "Failed to generate PDF")
        }

        // Convert base64 to blob and download
        const byteCharacters = atob(data.pdf)
        const byteNumbers = new Array(byteCharacters.length)
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i)
        }
        const byteArray = new Uint8Array(byteNumbers)
        const blob = new Blob([byteArray], { type: "application/pdf" })

        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")
        link.href = url
        link.download = `blink-voucher-reissue-${voucher.shortId}.pdf`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)

        console.log("✅ Reissue PDF downloaded successfully")
      } catch (err: unknown) {
        console.error("Reissue error:", err)
        setError((err as Error).message || "Failed to reissue voucher")
      } finally {
        setReissuing(false)
      }
    }

    // Initial fetch and polling
    useEffect(() => {
      fetchVouchers()

      // Poll every 10 seconds for updates (skipping ticks while hidden)
      pollingIntervalRef.current = setInterval(() => {
        if (document.visibilityState === "hidden") return
        fetchVouchers()
      }, 10000)

      return () => {
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current)
        }
      }
    }, [fetchVouchers])

    // Format time remaining (handles longer durations)
    const formatTimeRemaining = (ms: number): string => {
      if (!ms || ms <= 0) return "Expired"

      const minutes = Math.floor(ms / 60000)
      const hours = Math.floor(ms / 3600000)
      const days = Math.floor(ms / 86400000)

      if (days > 0) return `${days}d ${hours % 24}h`
      if (hours > 0) return `${hours}h ${minutes % 60}m`

      const secs = Math.floor((ms % 60000) / 1000)
      return `${minutes}:${secs.toString().padStart(2, "0")}`
    }

    // Format date
    const formatDate = (timestamp: number): string => {
      const date = new Date(timestamp)
      const now = new Date()
      const diffMs = now.getTime() - date.getTime()
      const diffMins = Math.floor(diffMs / 60000)
      const diffHours = Math.floor(diffMs / 3600000)
      const diffDays = Math.floor(diffMs / 86400000)

      if (diffMins < 1) return "Just now"
      if (diffMins < 60) return `${diffMins}m ago`
      if (diffHours < 24) return `${diffHours}h ago`
      if (diffDays < 7) return `${diffDays}d ago`
      return date.toLocaleDateString()
    }

    // Get status color classes
    const getStatusColor = (voucher: VoucherData): string => {
      if (voucher.status === "CLAIMED") return "text-green-600 dark:text-green-400"
      if (voucher.status === "CANCELLED") return "text-gray-500 dark:text-gray-500"
      if (voucher.status === "EXPIRED") return "text-red-600 dark:text-red-400"

      // Active voucher - check expiry time
      if (voucher.timeRemaining && voucher.timeRemaining < 60 * 60 * 1000) {
        return "text-red-600 dark:text-red-400" // Less than 1 hour
      }
      if (voucher.timeRemaining && voucher.timeRemaining < 24 * 60 * 60 * 1000) {
        return "text-yellow-600 dark:text-yellow-400" // Less than 24 hours
      }
      return "text-purple-600 dark:text-purple-400" // Normal active
    }

    // Get status indicator color
    const getStatusDotColor = (voucher: VoucherData): string => {
      if (voucher.status === "CLAIMED") return "bg-green-500"
      if (voucher.status === "CANCELLED") return "bg-gray-400"
      if (voucher.status === "EXPIRED") return "bg-red-500"

      // Active - check expiry
      if (voucher.timeRemaining && voucher.timeRemaining < 60 * 60 * 1000) {
        return "bg-red-500 animate-pulse"
      }
      if (voucher.timeRemaining && voucher.timeRemaining < 24 * 60 * 60 * 1000) {
        return "bg-yellow-500 animate-pulse"
      }
      return "bg-purple-500 animate-pulse"
    }

    // Filter vouchers
    const filteredVouchers = vouchers.filter((v) => {
      // Currency filter
      if (currencyFilter !== "all" && (v.walletCurrency || "BTC") !== currencyFilter) {
        return false
      }
      // Status filter
      if (filter === "all") return true
      if (filter === "active") return v.status === "ACTIVE"
      if (filter === "expiring")
        return (
          v.status === "ACTIVE" &&
          v.timeRemaining &&
          v.timeRemaining < 24 * 60 * 60 * 1000
        )
      if (filter === "claimed") return v.status === "CLAIMED"
      if (filter === "cancelled") return v.status === "CANCELLED"
      if (filter === "expired") return v.status === "EXPIRED"
      return true
    })

    // Sort vouchers: most recent activity first, then by soonest expiry for active
    // Activity = claimedAt, cancelledAt, expiresAt (for expired), or expiresAt (soonest first for active)
    const sortedVouchers = [...filteredVouchers].sort((a, b) => {
      // Get the "activity timestamp" for each voucher
      // For non-active: use the timestamp when the status changed (most recent first)
      // For active: use expiresAt (soonest expiry first)
      const getActivityTime = (v: VoucherData): number | null => {
        if (v.status === "CLAIMED" && v.claimedAt) return v.claimedAt
        if (v.status === "CANCELLED" && v.cancelledAt) return v.cancelledAt
        if (v.status === "EXPIRED" && v.expiresAt) return v.expiresAt
        // For ACTIVE, we'll handle separately
        return null
      }

      const aActivity = getActivityTime(a)
      const bActivity = getActivityTime(b)

      // If both have activity times (non-active vouchers), sort by most recent first
      if (aActivity && bActivity) {
        return bActivity - aActivity // Most recent first
      }

      // Non-active vouchers come before active vouchers (they have recent activity)
      if (aActivity && !bActivity) return -1
      if (!aActivity && bActivity) return 1

      // Both are active - sort by soonest expiry first
      const aExpiry = a.expiresAt || Infinity
      const bExpiry = b.expiresAt || Infinity
      return aExpiry - bExpiry // Soonest expiry first
    })

    // Render voucher detail modal
    const renderVoucherDetail = () => {
      if (!selectedVoucher) return null

      const canCancel = selectedVoucher.status === "ACTIVE"
      const canReissue = selectedVoucher.status === "ACTIVE"

      // Build LNURL for the hidden QR code
      const protocol = typeof window !== "undefined" ? window.location.protocol : "https:"
      const host = typeof window !== "undefined" ? window.location.host : ""
      const lnurlUrl = `${protocol}//${host}/api/voucher/lnurl/${selectedVoucher.id}/${selectedVoucher.amount}`
      let lnurl = ""
      try {
        lnurl = encodeLnurl(lnurlUrl)
      } catch (e) {
        console.error("Failed to encode LNURL for reissue:", e)
      }

      return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl max-w-sm w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-4">
              <div>
                <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                  {selectedVoucher.shortId}
                </div>
                <div className={`text-sm font-medium ${getStatusColor(selectedVoucher)}`}>
                  {selectedVoucher.status}
                </div>
              </div>
              <button
                onClick={() => setSelectedVoucher(null)}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
              >
                <svg
                  className="w-5 h-5 text-gray-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="space-y-3">
              {/* Voucher Type */}
              <div
                className={`rounded-lg p-3 ${
                  selectedVoucher.walletCurrency === "USD"
                    ? "bg-green-50 dark:bg-green-900/30"
                    : "bg-orange-50 dark:bg-orange-900/30"
                }`}
              >
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  Voucher Type
                </div>
                <div
                  className={`text-lg font-semibold ${
                    selectedVoucher.walletCurrency === "USD"
                      ? "text-green-600 dark:text-green-400"
                      : "text-orange-500 dark:text-orange-400"
                  }`}
                >
                  {selectedVoucher.walletCurrency === "USD"
                    ? "Dollar Voucher"
                    : "Bitcoin Voucher"}
                </div>
              </div>

              {/* Amount */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  Amount
                </div>
                {selectedVoucher.walletCurrency === "USD" &&
                selectedVoucher.usdAmountCents ? (
                  <>
                    <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                      ${(selectedVoucher.usdAmountCents / 100).toFixed(2)}
                    </div>
                    {selectedVoucher.displayAmount &&
                      selectedVoucher.displayCurrency &&
                      selectedVoucher.displayCurrency !== "USD" && (
                        <div className="text-sm text-gray-600 dark:text-gray-400">
                          {formatCurrency(
                            selectedVoucher.displayAmount,
                            selectedVoucher.displayCurrency,
                            currencies,
                          )}
                        </div>
                      )}
                  </>
                ) : (
                  <>
                    <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                      {selectedVoucher.amount.toLocaleString()} sats
                    </div>
                    {selectedVoucher.displayAmount && selectedVoucher.displayCurrency && (
                      <div className="text-sm text-gray-600 dark:text-gray-400">
                        {formatCurrency(
                          selectedVoucher.displayAmount,
                          selectedVoucher.displayCurrency,
                          currencies,
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {selectedVoucher.commissionPercent &&
                selectedVoucher.commissionPercent > 0 && (
                  <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                    <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Commission
                    </div>
                    <div className="text-lg font-medium text-gray-900 dark:text-gray-100">
                      {selectedVoucher.commissionPercent}%
                    </div>
                  </div>
                )}

              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  Created
                </div>
                <div className="text-sm text-gray-900 dark:text-gray-100">
                  {new Date(selectedVoucher.createdAt).toLocaleString()}
                </div>
              </div>

              {/* Expiry Info */}
              {selectedVoucher.expiresAt && (
                <div
                  className={`rounded-lg p-3 ${
                    selectedVoucher.status === "ACTIVE" &&
                    selectedVoucher.timeRemaining &&
                    selectedVoucher.timeRemaining < 24 * 60 * 60 * 1000
                      ? "bg-yellow-50 dark:bg-yellow-900/30"
                      : "bg-gray-50 dark:bg-gray-800"
                  }`}
                >
                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                    {selectedVoucher.status === "ACTIVE" ? "Expires" : "Expired"}
                  </div>
                  <div className="text-sm text-gray-900 dark:text-gray-100">
                    {formatExpiryDate(selectedVoucher.expiresAt)}
                  </div>
                  {selectedVoucher.status === "ACTIVE" &&
                    selectedVoucher.timeRemaining && (
                      <div className="mt-1">
                        <ExpiryBadge
                          expiresAt={selectedVoucher.expiresAt}
                          status={selectedVoucher.status}
                        />
                      </div>
                    )}
                </div>
              )}

              {/* Claimed At */}
              {selectedVoucher.claimedAt && (
                <div className="bg-green-50 dark:bg-green-900/30 rounded-lg p-3">
                  <div className="text-xs text-green-600 dark:text-green-400 mb-1">
                    Claimed
                  </div>
                  <div className="text-sm text-gray-900 dark:text-gray-100">
                    {new Date(selectedVoucher.claimedAt).toLocaleString()}
                  </div>
                </div>
              )}

              {/* Cancelled At */}
              {selectedVoucher.cancelledAt && (
                <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-3">
                  <div className="text-xs text-gray-500 dark:text-gray-500 mb-1">
                    Cancelled
                  </div>
                  <div className="text-sm text-gray-700 dark:text-gray-300">
                    {new Date(selectedVoucher.cancelledAt).toLocaleString()}
                  </div>
                </div>
              )}

              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  Voucher ID
                </div>
                <div className="text-xs text-gray-600 dark:text-gray-400 font-mono break-all">
                  {selectedVoucher.id}
                </div>
              </div>

              {/* Hidden QR code for reissue PDF generation */}
              {canReissue && lnurl && (
                <div ref={qrRef} className="hidden">
                  <QRCode value={lnurl} size={256} bgColor="#ffffff" fgColor="#000000" />
                </div>
              )}

              {/* Action Buttons */}
              <div className="space-y-2 mt-4">
                {/* Reissue Button - for active vouchers */}
                {canReissue && (
                  <button
                    onClick={() => reissueVoucher(selectedVoucher)}
                    disabled={reissuing}
                    className="w-full px-4 py-3 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    {reissuing ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        Generating PDF...
                      </>
                    ) : (
                      <>
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                          />
                        </svg>
                        Reissue PDF (with LNURL)
                      </>
                    )}
                  </button>
                )}

                {/* Cancel Button */}
                {canCancel && (
                  <button
                    onClick={() => cancelVoucher(selectedVoucher.id)}
                    disabled={cancelling}
                    className="w-full px-4 py-3 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    {cancelling ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        Cancelling...
                      </>
                    ) : (
                      <>
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                        Cancel Voucher
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div
        className="h-full flex flex-col bg-white dark:bg-black"
        style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
      >
        {/* Header Stats */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
          <div className="text-center mb-3">
            <div className="text-2xl font-semibold text-purple-600 dark:text-purple-400">
              Voucher Manager
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {stats.total} total voucher{stats.total !== 1 ? "s" : ""}
            </div>
          </div>

          {/* Expiring Soon Banner */}
          {stats.expiringSoon > 0 && (
            <div className="mb-3 bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-700 rounded-lg px-3 py-2 flex items-center gap-2">
              <svg
                className="w-5 h-5 text-yellow-600 dark:text-yellow-400 flex-shrink-0"
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
              <span className="text-sm text-yellow-700 dark:text-yellow-300 font-medium">
                {stats.expiringSoon} voucher{stats.expiringSoon !== 1 ? "s" : ""} expiring
                within 24 hours
              </span>
              <button
                onClick={() => setFilter("expiring")}
                className="ml-auto text-xs text-yellow-600 dark:text-yellow-400 hover:underline"
              >
                View
              </button>
            </div>
          )}

          {/* Stats Row */}
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-2">
              <div className="text-lg font-semibold text-purple-600 dark:text-purple-400">
                {stats.active}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Active</div>
            </div>
            <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-2">
              <div className="text-lg font-semibold text-green-600 dark:text-green-400">
                {stats.claimed}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Claimed</div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2">
              <div className="text-lg font-semibold text-gray-500 dark:text-gray-400">
                {stats.cancelled}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Cancelled</div>
            </div>
            <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-2">
              <div className="text-lg font-semibold text-red-600 dark:text-red-400">
                {stats.expired}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Expired</div>
            </div>
          </div>
        </div>

        {/* Currency Filter Row */}
        <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-800">
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: "all" as CurrencyFilterType, label: "All", color: null },
              { id: "BTC" as CurrencyFilterType, label: "Bitcoin", color: "orange" },
              { id: "USD" as CurrencyFilterType, label: "Dollar", color: "green" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  if (onInternalTransition) onInternalTransition()
                  setCurrencyFilter(tab.id)
                }}
                className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  currencyFilter === tab.id
                    ? tab.color === "orange"
                      ? "bg-orange-500 text-white"
                      : tab.color === "green"
                        ? "bg-green-500 text-white"
                        : "bg-purple-600 text-white"
                    : tab.color === "orange"
                      ? "bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 hover:bg-orange-200 dark:hover:bg-orange-900/50"
                      : tab.color === "green"
                        ? "bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Filter Tabs - Two rows to avoid horizontal scrolling */}
        <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-800">
          <div className="grid grid-cols-3 gap-2 mb-2">
            {[
              { id: "all" as StatusFilter, label: "All", highlight: false },
              { id: "active" as StatusFilter, label: "Active", highlight: false },
              {
                id: "expiring" as StatusFilter,
                label: "Expiring",
                highlight: stats.expiringSoon > 0,
              },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  if (onInternalTransition) onInternalTransition()
                  setFilter(tab.id)
                }}
                className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  filter === tab.id
                    ? tab.highlight
                      ? "bg-yellow-500 text-white"
                      : "bg-purple-600 text-white"
                    : tab.highlight
                      ? "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 hover:bg-yellow-200 dark:hover:bg-yellow-900/50"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                {tab.label}
                {tab.id === "expiring" && stats.expiringSoon > 0 && (
                  <span className="ml-1">({stats.expiringSoon})</span>
                )}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-4 gap-2">
            {[
              { id: "claimed" as StatusFilter, label: "Claimed" },
              { id: "cancelled" as StatusFilter, label: "Cancelled" },
              { id: "expired" as StatusFilter, label: "Expired" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  if (onInternalTransition) onInternalTransition()
                  setFilter(tab.id)
                }}
                className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  filter === tab.id
                    ? "bg-purple-600 text-white"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                {tab.label}
              </button>
            ))}

            {/* Refresh button */}
            <button
              onClick={() => {
                if (onInternalTransition) onInternalTransition()
                fetchVouchers()
              }}
              className="p-1.5 rounded-full bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors flex items-center justify-center"
            >
              <svg
                className={`w-4 h-4 text-gray-600 dark:text-gray-400 ${loading ? "animate-spin" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Voucher List */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {error && (
            <div className="mb-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 px-3 py-2 rounded-lg text-sm">
              {error}
            </div>
          )}

          {loading && vouchers.length === 0 ? (
            <div className="flex items-center justify-center h-40">
              <div className="animate-spin w-8 h-8 border-3 border-purple-600 border-t-transparent rounded-full"></div>
            </div>
          ) : sortedVouchers.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-500 dark:text-gray-400">
              <svg
                className="w-12 h-12 mb-2 opacity-50"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                  d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"
                />
              </svg>
              <div className="text-sm">
                {filter === "all" ? "No vouchers yet" : `No ${filter} vouchers`}
              </div>
              <div className="text-xs mt-1">
                Create vouchers from the Voucher or Multi-Voucher screens
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {sortedVouchers.map((voucher) => (
                <button
                  key={voucher.id}
                  onClick={() => {
                    if (onInternalTransition) onInternalTransition()
                    setSelectedVoucher(voucher)
                  }}
                  className="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-3 text-left hover:border-purple-400 dark:hover:border-purple-500 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {/* Status indicator */}
                      <div
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${getStatusDotColor(voucher)}`}
                      ></div>

                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 dark:text-gray-100">
                            {voucher.walletCurrency === "USD" && voucher.usdAmountCents
                              ? `$${(voucher.usdAmountCents / 100).toFixed(2)}`
                              : `${voucher.amount.toLocaleString()} sats`}
                          </span>
                          {voucher.commissionPercent && voucher.commissionPercent > 0 && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              +{voucher.commissionPercent}%
                            </span>
                          )}
                          {/* Currency indicator badge */}
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded ${
                              voucher.walletCurrency === "USD"
                                ? "bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400"
                                : "bg-orange-100 dark:bg-orange-900/30 text-orange-500 dark:text-orange-400"
                            }`}
                          >
                            {voucher.walletCurrency === "USD" ? "$" : "₿"}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                          {voucher.shortId}
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className={`text-sm font-medium ${getStatusColor(voucher)}`}>
                        {voucher.status}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {voucher.status === "ACTIVE" && voucher.timeRemaining
                          ? formatTimeRemaining(voucher.timeRemaining)
                          : voucher.status === "CLAIMED" && voucher.claimedAt
                            ? formatDate(voucher.claimedAt)
                            : formatDate(voucher.createdAt)}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Voucher Detail Modal */}
        {renderVoucherDetail()}
      </div>
    )
  },
)

VoucherManager.displayName = "VoucherManager"
export default VoucherManager
