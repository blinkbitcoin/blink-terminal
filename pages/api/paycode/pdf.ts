import { renderToBuffer } from "@react-pdf/renderer"
import type { NextApiRequest, NextApiResponse } from "next"
import React from "react"

import { withRateLimit, RATE_LIMIT_PUBLIC } from "../../../lib/rate-limit"

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
        amount?: number
        displayAmount?: string
        webUrl?: string
        username?: string
      }

    console.log("📄 Paycode PDF API called with:", {
      lightningAddress,
      amount,
      displayAmount,
      webUrl,
      qrDataUrlLength: qrDataUrl?.length,
    })

    // Validate input
    if (!lightningAddress || typeof lightningAddress !== "string") {
      return res.status(400).json({
        error: "Missing or invalid lightningAddress",
        hint: "Provide a valid Lightning address (e.g., username@blink.sv)",
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
    if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(qrDataUrl)) {
      return res.status(400).json({
        error: "Invalid qrDataUrl",
        hint: "qrDataUrl must be an inline data:image/(png|jpeg|webp);base64,... URL",
      })
    }

    // Dynamically import PDF module
    const { PaycodeDocument } = await getPdfModule()

    console.log(`📄 Generating Paycode PDF for ${lightningAddress}`)

    // Create document element
    const localpart = lightningAddress.split("@")[0]
    const documentElement = React.createElement(PaycodeDocument, {
      paycode: {
        lightningAddress,
        qrDataUrl,
        amount: amount || undefined,
        displayAmount: displayAmount || undefined,
        webUrl: webUrl || `https://terminal.blinkbtc.com/${localpart}`,
        username: username || localpart,
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
    const message = error instanceof Error ? error.message : "Unknown error"
    const stack = error instanceof Error ? error.stack : undefined
    console.error("❌ Paycode PDF generation error:", error)
    console.error("❌ Stack trace:", stack)

    return res.status(500).json({
      error: "Failed to generate Paycode PDF",
      message,
      stack: process.env.NODE_ENV === "development" ? stack : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_PUBLIC)

// Disable body parser limit for large QR data URLs
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
}
