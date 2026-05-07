import fs from "fs"
import path from "path"

import { renderToBuffer } from "@react-pdf/renderer"
import type { NextApiRequest, NextApiResponse } from "next"
import React from "react"

import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"

// Dynamic import to avoid issues with font registration at module load time
let pdfModule: typeof import("../../../lib/pdf/TransactionReceiptPDF") | null = null
const getPdfModule = async () => {
  if (!pdfModule) {
    pdfModule = await import("../../../lib/pdf/TransactionReceiptPDF")
  }
  return pdfModule
}

// Load and cache logo as base64 data URL
let logoDataUrl: string | null = null
const getLogoDataUrl = (): string | null => {
  if (logoDataUrl) return logoDataUrl

  try {
    const logoPath = path.join(process.cwd(), "public", "logos", "blink-logo-print.png")
    const logoBuffer = fs.readFileSync(logoPath)
    logoDataUrl = `data:image/png;base64,${logoBuffer.toString("base64")}`
    return logoDataUrl
  } catch (error: unknown) {
    console.error("Failed to load logo:", error)
    return null
  }
}

interface TransactionInput {
  id: string
  direction: string
  status?: string
  amount?: string
  settlementCurrency?: string
  settlementAmount?: number
  settlementFee?: number
  date?: string
  memo?: string
  initiationVia?: Record<string, unknown>
  settlementVia?: Record<string, unknown>
}

/**
 * Transaction Receipt PDF Generation API
 *
 * POST /api/transaction/receipt-pdf
 * Body: {
 *   transaction: {
 *     id: string,
 *     direction: 'RECEIVE' | 'SEND',
 *     status: string,
 *     amount: string (formatted amount e.g., "10,000 sats"),
 *     settlementCurrency: 'BTC' | 'USD',
 *     settlementAmount: number,
 *     settlementFee: number,
 *     date: string,
 *     memo: string,
 *     initiationVia: object,
 *     settlementVia: object
 *   }
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
    const { transaction } = req.body as { transaction: TransactionInput }

    console.log("📄 Transaction Receipt PDF API called:", {
      transactionId: transaction?.id,
      direction: transaction?.direction,
      amount: transaction?.amount,
    })

    // Validate input
    if (!transaction) {
      return res.status(400).json({
        error: "Missing transaction data",
        hint: "Provide a transaction object with id, direction, amount, etc.",
      })
    }

    if (!transaction.id) {
      return res.status(400).json({
        error: "Missing transaction ID",
        hint: "Transaction must have an id field",
      })
    }

    // Dynamically import PDF module
    const { TransactionReceiptDocument } = await getPdfModule()

    // Load logo
    const logo = getLogoDataUrl()

    // Generate timestamp
    const generatedAt = new Date().toLocaleString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    })

    console.log(`📄 Generating transaction receipt PDF for: ${transaction.id}`)

    // Create the document element
    const documentElement = React.createElement(TransactionReceiptDocument, {
      transaction,
      generatedAt,
      logoDataUrl: logo ?? undefined,
    })

    // Render to buffer
    const pdfBuffer = await renderToBuffer(
      documentElement as Parameters<typeof renderToBuffer>[0],
    )

    // Convert to base64
    const pdfBase64 = pdfBuffer.toString("base64")

    console.log(
      `✅ Transaction receipt PDF generated: ${Math.round(pdfBuffer.length / 1024)}KB`,
    )

    return res.status(200).json({
      success: true,
      pdf: pdfBase64,
      transactionId: transaction.id,
      generatedAt,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    const stack = error instanceof Error ? error.stack : undefined
    console.error("❌ Transaction receipt PDF generation error:", error)
    console.error("❌ Stack trace:", stack)

    return res.status(500).json({
      error: "Failed to generate receipt PDF",
      message,
      stack: process.env.NODE_ENV === "development" ? stack : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE)

// Disable body parser limit for safety
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "2mb",
    },
  },
}
