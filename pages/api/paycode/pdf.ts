import { renderToBuffer } from "@react-pdf/renderer"
import type { NextApiRequest, NextApiResponse } from "next"
import React from "react"

import { isSafeImageDataUrl, pngDataUrlDimensions } from "../../../lib/pdf/safe-image-src"
import { withRateLimit, RATE_LIMIT_PUBLIC } from "../../../lib/rate-limit"

/**
 * Input bounds (blink-wip#1664 follow-up). This route is public and renders
 * in the single Node process: react-pdf's text layout is super-linear (a
 * 100 KB displayAmount took 25 s, starving every other request) and a small
 * PNG can declare huge dimensions (a 198 KB, 6000x6000 PNG took 6 s and
 * ~144 MB to decode). Every rendered value is now bounded.
 */
const LIMITS = {
  displayAmount: 64, // e.g. "$1,000,000.00 USD"
  webUrl: 256,
  maxSats: 21_000_000 * 100_000_000,
  // The app sends a 400x400 PNG QR (components/PublicPOS/PrintPaycodeView.tsx).
  qrDataUrlLength: 256 * 1024,
  qrMaxSide: 1024,
} as const

// Dynamic import to avoid issues with font registration at module load time
let pdfModule: typeof import("../../../lib/pdf/PaycodePDF") | null = null
const getPdfModule = async () => {
  if (!pdfModule) {
    pdfModule = await import("../../../lib/pdf/PaycodePDF")
  }
  return pdfModule
}

/**
 * Paycode PDF Generation API
 *
 * POST /api/paycode/pdf
 * Body: {
 *   lightningAddress: string (e.g., "username@blink.sv"),
 *   qrDataUrl: string (base64 data URL of QR code),
 *   amount: number (optional, sats amount for fixed paycode),
 *   displayAmount: string (optional, formatted display e.g., "$5.00 USD"),
 *   webUrl: string (the web fallback URL)
 * }
 *
 * Returns: PDF as base64 string
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
      allowedMethods: ["POST"],
    })
  }

  try {
    const { lightningAddress, qrDataUrl, amount, displayAmount, webUrl, username } =
      req.body as {
        lightningAddress: string
        qrDataUrl: string
        amount?: number | null
        displayAmount?: string | null
        webUrl?: string | null
        username?: string
      }

    // Validate input. lightningAddress must be a real `localpart@domain` (it is
    // used to render text and to derive the default webUrl/username), so reject
    // anything that isn't — avoids log injection, malformed PDFs, and
    // inconsistent defaults.
    if (
      !lightningAddress ||
      typeof lightningAddress !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,50}@[a-zA-Z0-9.-]{1,253}$/.test(lightningAddress)
    ) {
      return res.status(400).json({
        error: "Missing or invalid lightningAddress",
        hint: "Provide a valid Lightning address (e.g., username@blink.sv)",
      })
    }

    // username is optional; when present it must match the Blink username
    // charset. Fall back to the lightningAddress localpart otherwise.
    if (
      username !== undefined &&
      (typeof username !== "string" || !/^[a-zA-Z0-9_]{1,50}$/.test(username))
    ) {
      return res.status(400).json({
        error: "Invalid username",
        hint: "username must be 1-50 chars of [a-zA-Z0-9_]",
      })
    }

    if (!qrDataUrl || typeof qrDataUrl !== "string") {
      return res.status(400).json({
        error: "Missing or invalid qrDataUrl",
        hint: "Provide a valid base64 data URL of the QR code",
      })
    }

    // SSRF guard: this is a public endpoint and the value is handed to the PDF
    // renderer's <Image src=...>, which will FETCH remote/file URLs. Only accept
    // inline base64 image data URLs so an attacker cannot coerce server-side
    // requests to arbitrary hosts.
    if (!isSafeImageDataUrl(qrDataUrl)) {
      return res.status(400).json({
        error: "Invalid qrDataUrl",
        hint: "qrDataUrl must be an inline data:image/(png|jpeg|webp);base64,... URL",
      })
    }

    const dims = pngDataUrlDimensions(qrDataUrl)
    if (
      qrDataUrl.length > LIMITS.qrDataUrlLength ||
      !dims ||
      dims.width < 1 ||
      dims.height < 1 ||
      dims.width > LIMITS.qrMaxSide ||
      dims.height > LIMITS.qrMaxSide
    ) {
      return res.status(400).json({
        error: "Invalid qrDataUrl",
        hint: `qrDataUrl must be a PNG of at most ${LIMITS.qrMaxSide}x${LIMITS.qrMaxSide} px and ${LIMITS.qrDataUrlLength / 1024} KB`,
      })
    }

    // amount: absent/null, or a positive whole number of sats.
    if (
      amount !== undefined &&
      amount !== null &&
      !(Number.isSafeInteger(amount) && amount > 0 && amount <= LIMITS.maxSats)
    ) {
      return res.status(400).json({
        error: "Invalid amount",
        hint: "amount must be a positive whole number of sats",
      })
    }

    if (
      displayAmount !== undefined &&
      displayAmount !== null &&
      (typeof displayAmount !== "string" || displayAmount.length > LIMITS.displayAmount)
    ) {
      return res.status(400).json({
        error: "Invalid displayAmount",
        hint: `displayAmount must be a string of at most ${LIMITS.displayAmount} chars`,
      })
    }

    if (
      webUrl !== undefined &&
      webUrl !== null &&
      (typeof webUrl !== "string" || webUrl.length > LIMITS.webUrl)
    ) {
      return res.status(400).json({
        error: "Invalid webUrl",
        hint: `webUrl must be a string of at most ${LIMITS.webUrl} chars`,
      })
    }

    // Dynamically import PDF module
    const { PaycodeDocument } = await getPdfModule()

    console.log(`📄 Generating Paycode PDF for ${lightningAddress}`)

    // Create document element (usernames are lowercase; normalize the defaults)
    const localpart = lightningAddress.split("@")[0].toLowerCase()
    const safeUsername = (username || localpart).toLowerCase()
    const documentElement = React.createElement(PaycodeDocument, {
      paycode: {
        lightningAddress,
        qrDataUrl,
        amount: amount || undefined,
        displayAmount: displayAmount || undefined,
        webUrl: webUrl || `https://terminal.blinkbtc.com/${safeUsername}`,
        username: safeUsername,
      },
    })

    // Render to buffer
    const pdfBuffer = await renderToBuffer(
      documentElement as Parameters<typeof renderToBuffer>[0],
    )

    // Convert to base64
    const pdfBase64 = pdfBuffer.toString("base64")

    console.log(`✅ Paycode PDF generated: ${Math.round(pdfBuffer.length / 1024)}KB`)

    return res.status(200).json({
      success: true,
      pdf: pdfBase64,
      lightningAddress,
      hasFixedAmount: !!(amount && amount > 0),
    })
  } catch (error: unknown) {
    const stack = error instanceof Error ? error.stack : undefined
    console.error("❌ Paycode PDF generation error:", error)
    console.error("❌ Stack trace:", stack)

    // Never echo renderer errors to the caller (they can carry fetched content).
    return res.status(500).json({ error: "Failed to generate Paycode PDF" })
  }
}

export default withRateLimit(handler, RATE_LIMIT_PUBLIC, "paycode/pdf")

export const config = {
  api: {
    // The QR data URL is capped at 256 KB and every other field is short, so
    // a larger body is never legitimate.
    bodyParser: {
      sizeLimit: "300kb",
    },
  },
}
