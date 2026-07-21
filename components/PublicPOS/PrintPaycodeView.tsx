import { useRouter } from "next/router"
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react"
import { useMemo, useState } from "react"

import { getAppUrl, getLnAddressDomain } from "../../lib/config/api"
import { usePublicPOSValidation } from "../../lib/hooks/usePublicPOSValidation"
import { useTheme } from "../../lib/hooks/useTheme"
import { buildStaticPaycode } from "../../lib/paycode-lnurl"

// Bitcoin logo (orange-ring ₿) embedded in the QR center, matching the
// pay.blink.sv printable paycode.
const QR_LOGO_SRC = "/logos/blink-qr-logo.png"

// Center-logo settings shared by the on-screen and print QR codes. `excavate`
// clears QR modules under the logo; error-correction level H (30%) keeps the
// code scannable despite the logo and the longer wrapped value.
const qrImageSettings = (size: number) => ({
  src: QR_LOGO_SRC,
  height: Math.round(size * 0.22),
  width: Math.round(size * 0.22),
  excavate: true,
})

/**
 * PrintPaycodeView - Printable static QR view for a Blink username.
 *
 * Single source of truth for the paycode UI. Rendered in THREE places:
 *  1. Standalone route `/[username]/print` (no `onBack` — the Back button
 *     navigates to the payee's public POS page `/[username]`).
 *  2. Authenticated Settings → Paycodes overlay (`onBack` = close overlay).
 *  3. Public POS side-menu → Paycodes overlay (`onBack` = close overlay).
 *
 * Renders a static (variable-amount) LNURL-pay QR that works for both custodial
 * and self-custodial (Spark) usernames, with browser-print (full-page poster)
 * and PDF download actions.
 *
 * The QR's LNURL resolves against the Blink Lightning-address endpoint
 * (getLnAddressDomain(), e.g. blink.sv) — which handles both custodial and
 * self-custodial (Spark) accounts; the human-facing web fallback URL points at
 * the Terminal app origin (getAppUrl(), e.g. terminal.blinkbtc.com).
 *
 * NOTE: amount selection was intentionally removed when the Paycodes menu and
 * the print page were unified — this view is variable-amount only. The
 * fixed-amount LNURL API (`/api/paycode/lnurlp/[username]?amount=`) is retained
 * for possible future reintroduction of fixed amounts.
 */

interface PrintPaycodeViewProps {
  username: string
  /**
   * When provided, the header shows a "‹ Back" button that calls this instead
   * of the standalone navigation. Use in overlay contexts to close the overlay.
   */
  onBack?: () => void
  /** Header title. Defaults to "Printable Paycode". */
  title?: string
  /**
   * Skip the client-side username validation network call. Set true in overlay
   * contexts where the username is already known valid (parent already
   * resolved it). Defaults to false (standalone route validates).
   */
  skipValidation?: boolean
}

export default function PrintPaycodeView({
  username,
  onBack,
  title = "Printable Paycode",
  skipValidation = false,
}: PrintPaycodeViewProps) {
  const router = useRouter()
  const { theme } = useTheme()
  const { validationError, validating } = usePublicPOSValidation({
    username,
    enabled: !skipValidation,
  })

  const [generatingPdf, setGeneratingPdf] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)

  // Back navigation: overlay contexts close via `onBack`. The standalone route
  // navigates to the payee's public POS page — a predictable destination that
  // avoids the unreliable window.history.length heuristic (deep-links from
  // wallet in-app browsers would otherwise jump outside the app).
  const handleBack = () => {
    if (onBack) {
      onBack()
      return
    }
    router.push(`/${username}`)
  }

  // Build the static paycode. The LNURL targets the Blink Lightning-address
  // (LUD-16) endpoint on getLnAddressDomain() (blink.sv), which is
  // provider-agnostic — it resolves both custodial wallets and self-custodial
  // (Spark) accounts. The web fallback URL uses the Terminal app origin
  // (getAppUrl()). Both depend on the current environment, so include them in
  // the memo deps to avoid a stale QR/webUrl if the environment changes.
  const lnAddressDomain = getLnAddressDomain()
  const appUrl = getAppUrl()
  const paycode = useMemo(
    () => buildStaticPaycode(username, lnAddressDomain, appUrl),
    [username, lnAddressDomain, appUrl],
  )

  const bgClasses =
    theme === "blink-classic-dark"
      ? "bg-black"
      : theme === "blink-classic-light"
        ? "bg-white"
        : "bg-white dark:bg-black"

  const headerClasses =
    theme === "blink-classic-dark"
      ? "bg-black border-b border-blink-classic-border"
      : theme === "blink-classic-light"
        ? "bg-white border-b border-blink-classic-border-light"
        : "bg-gray-50 dark:bg-blink-dark shadow dark:shadow-black"

  const copyLnurl = async () => {
    // Clipboard API is unavailable in non-secure contexts / some in-app
    // browsers; guard so a failure never breaks the view.
    try {
      await navigator.clipboard?.writeText(paycode.lnurl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error: unknown) {
      console.error("Failed to copy LNURL:", error)
    }
  }

  const generatePdf = async (): Promise<void> => {
    setGeneratingPdf(true)
    setPdfError(null)
    try {
      // Render the QR (wrapped value, level H) to a canvas, then composite the
      // Bitcoin logo into the center so the PDF matches the on-screen/print QR.
      const qrSize = 400
      const qrCanvas = document.createElement("canvas")
      const QRCodeLib = await import("qrcode")
      await QRCodeLib.toCanvas(qrCanvas, paycode.qrValue, {
        width: qrSize,
        margin: 2,
        errorCorrectionLevel: "H",
      })

      const ctx = qrCanvas.getContext("2d")
      if (ctx) {
        const logo = new Image()
        logo.src = QR_LOGO_SRC
        await new Promise<void>((resolve) => {
          logo.onload = () => resolve()
          logo.onerror = () => resolve() // fall back to logo-less QR on error
        })
        if (logo.complete && logo.naturalWidth > 0) {
          const logoSize = Math.round(qrSize * 0.22)
          const pos = Math.round((qrSize - logoSize) / 2)
          const pad = Math.round(logoSize * 0.08)
          // White excavated backing so the logo reads cleanly.
          ctx.fillStyle = "#ffffff"
          ctx.fillRect(pos - pad, pos - pad, logoSize + pad * 2, logoSize + pad * 2)
          ctx.drawImage(logo, pos, pos, logoSize, logoSize)
        }
      }

      const qrDataUrl = qrCanvas.toDataURL("image/png")

      const response = await fetch("/api/paycode/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lightningAddress: paycode.lightningAddress,
          qrDataUrl,
          amount: null,
          displayAmount: null,
          webUrl: paycode.webUrl,
          username,
        }),
      })

      if (!response.ok) {
        throw new Error("Failed to generate PDF")
      }

      const { pdf } = await response.json()

      const link = document.createElement("a")
      link.href = `data:application/pdf;base64,${pdf}`
      link.download = `paycode-${username}.pdf`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch (error: unknown) {
      console.error("Error generating PDF:", error)
      setPdfError("Failed to generate PDF. Please try again.")
    } finally {
      setGeneratingPdf(false)
    }
  }

  // In overlay mode (onBack provided) cover the host dashboard with a
  // full-screen fixed layer; on the standalone route flow with the page.
  const containerClasses = onBack
    ? `fixed inset-0 z-50 overflow-y-auto ${bgClasses}`
    : `min-h-screen ${bgClasses}`

  return (
    <div
      className={containerClasses}
      style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
    >
      {/* Header (hidden when printing) — Back + title */}
      <header className={`${headerClasses} sticky top-0 z-40 print:hidden`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <button
              onClick={handleBack}
              className="flex items-center text-gray-700 dark:text-white hover:text-blink-orange dark:hover:text-blink-orange focus:outline-none"
              aria-label="Back"
            >
              <span className="text-2xl mr-2">‹</span>
              <span className="text-lg">Back</span>
            </button>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">{title}</h1>
            <div className="w-16" />
          </div>
        </div>
      </header>

      {/* On-screen content (hidden when printing) */}
      <main className="max-w-md mx-auto px-4 py-6 print:hidden">
        {validating ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-blink-orange border-t-transparent" />
            <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
              Checking username…
            </p>
          </div>
        ) : validationError ? (
          <div className="py-12 text-center space-y-3">
            <p className="text-lg font-semibold text-red-600 dark:text-red-400">
              {validationError.message}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {validationError.suggestion}
            </p>
          </div>
        ) : (
          <div className="text-center space-y-6">
            {/* Lightning Address Header */}
            <div>
              <p className="text-lg font-semibold text-gray-900 dark:text-white">
                Pay {paycode.lightningAddress}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                Display this static QR code online or in person to allow anybody to pay{" "}
                {username.toLowerCase()}.
              </p>
            </div>

            {/* QR Code (Bitcoin logo embedded in center) */}
            <div className="flex justify-center">
              <div className="bg-white p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                <QRCodeSVG
                  value={paycode.qrValue}
                  size={256}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="H"
                  imageSettings={qrImageSettings(256)}
                />
              </div>
            </div>

            {/* Troubleshooting Note (neutral) */}
            <div className="p-4 rounded-lg bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-800">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                <strong className="text-gray-800 dark:text-gray-200">
                  Having trouble scanning?
                </strong>{" "}
                Some wallets don&apos;t support static QR codes. Scan with your
                phone&apos;s camera app to open a webpage for creating a fresh invoice.
              </p>
            </div>

            {/* Action Buttons */}
            <div className="space-y-3">
              {/* Print (primary — single orange accent) */}
              <button
                onClick={() => window.print()}
                className="w-full py-3 bg-blink-orange hover:bg-orange-600 text-white rounded-lg text-base font-medium transition-colors flex items-center justify-center gap-2"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                  />
                </svg>
                Print QR Code
              </button>

              {/* Download PDF (secondary — neutral) */}
              <button
                onClick={generatePdf}
                disabled={generatingPdf}
                className="w-full py-3 rounded-lg text-base font-medium transition-colors flex items-center justify-center gap-2 border border-gray-300 text-gray-800 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                {generatingPdf ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-gray-500 border-t-transparent" />
                    Generating PDF…
                  </>
                ) : (
                  <>
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                    Download PDF
                  </>
                )}
              </button>

              {/* Copy LNURL (secondary — neutral) */}
              <button
                onClick={copyLnurl}
                className="w-full py-3 rounded-lg text-base font-medium transition-colors flex items-center justify-center gap-2 border border-gray-300 text-gray-800 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                {copied ? "Copied!" : "Copy Paycode LNURL"}
              </button>

              {/* Inline PDF error (replaces alert) */}
              {pdfError && (
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {pdfError}
                </p>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Print-only poster: large centered QR on white, shown only in print. */}
      {!validating && !validationError && (
        <div className="hidden print:flex print:flex-col print:items-center print:justify-center print:min-h-screen print:text-center">
          <p
            style={{
              fontSize: "28px",
              fontWeight: 700,
              margin: "0 0 8px",
              color: "#000",
            }}
          >
            Pay {paycode.lightningAddress}
          </p>
          <p style={{ fontSize: "16px", margin: "0 0 24px", color: "#000" }}>
            Scan to pay {username.toLowerCase()} with any Lightning wallet.
          </p>
          <div style={{ background: "#fff", padding: "16px" }}>
            <QRCodeCanvas
              value={paycode.qrValue}
              size={512}
              bgColor="#ffffff"
              fgColor="#000000"
              level="H"
              imageSettings={qrImageSettings(512)}
            />
          </div>
          <p
            style={{
              fontSize: "13px",
              maxWidth: "520px",
              margin: "24px auto 0",
              color: "#000",
            }}
          >
            Having trouble scanning? Some wallets do not support printed QR codes. Scan
            with your phone&apos;s camera app to open a webpage where you can create a
            fresh invoice for paying from any Lightning wallet.
          </p>
        </div>
      )}
    </div>
  )
}
