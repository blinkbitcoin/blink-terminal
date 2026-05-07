import { renderToBuffer } from "@react-pdf/renderer"
import type { NextApiRequest, NextApiResponse } from "next"
import React from "react"

import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"

// Dynamic import to avoid issues with font registration at module load time
let pdfModule: typeof import("../../../lib/pdf/VoucherPDF") | null = null
const getPdfModule = async () => {
  if (!pdfModule) {
    pdfModule = await import("../../../lib/pdf/VoucherPDF")
  }
  return pdfModule
}

interface VoucherInput {
  satsAmount: number
  fiatAmount?: string
  qrDataUrl: string
  identifierCode?: string
  lnurl?: string
  expiresAt?: string
  issuedBy?: string
  voucherSecret?: string
  commissionPercent?: number
  logoDataUrl?: string
}

/**
 * Voucher PDF Generation API
 *
 * POST /api/voucher/pdf
 * Body: {
 *   vouchers: [{
 *     satsAmount: number,
 *     fiatAmount: string (optional, e.g. "$25.00 ARS"),
 *     qrDataUrl: string (base64 data URL of QR code),
 *     identifierCode: string (optional),
 *     lnurl: string (optional, required for reissue format),
 *     expiresAt: number (optional, timestamp),
 *     issuedBy: string (optional, Blink username who issued the voucher)
 *   }],
 *   format: 'a4' | 'letter' | 'thermal-80' | 'thermal-58' | 'reissue',
 *   gridSize: '2x2' | '2x3' | '3x3' | '3x4' (optional, for multi-voucher grid layout)
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
    const {
      vouchers,
      format = "a4",
      gridSize,
    } = req.body as {
      vouchers: VoucherInput[]
      format?: string
      gridSize?: string
    }

    console.log("📄 PDF API called with:", {
      voucherCount: vouchers?.length,
      format,
      gridSize,
      firstVoucher: vouchers?.[0]
        ? {
            satsAmount: vouchers[0].satsAmount,
            fiatAmount: vouchers[0].fiatAmount,
            identifierCode: vouchers[0].identifierCode,
            voucherSecret: vouchers[0].voucherSecret ? "present" : "missing",
            expiresAt: vouchers[0].expiresAt,
            issuedBy: vouchers[0].issuedBy,
            commissionPercent: vouchers[0].commissionPercent,
            hasQr: !!vouchers[0].qrDataUrl,
            hasLogo: !!vouchers[0].logoDataUrl,
          }
        : null,
    })

    // Validate input
    if (!vouchers || !Array.isArray(vouchers) || vouchers.length === 0) {
      return res.status(400).json({
        error: "Missing or invalid vouchers array",
        hint: "Provide an array of voucher objects with satsAmount and qrDataUrl",
      })
    }

    // Dynamically import PDF module
    const {
      SingleVoucherDocument,
      BatchVoucherDocument,
      ThermalVoucherDocument,
      GridVoucherDocument,
      ReissueVoucherDocument,
      PAPER_FORMATS: _PAPER_FORMATS,
      GRID_CONFIGS: _GRID_CONFIGS,
      getAvailableFormats,
      getAvailableGrids,
    } = await getPdfModule()

    // Validate format (reissue is a special format that uses a4 paper)
    const isReissue = format === "reissue"
    const validFormats = [...getAvailableFormats(), "reissue"]
    if (!validFormats.includes(format)) {
      return res.status(400).json({
        error: "Invalid format",
        validFormats,
        hint: "Choose from: a4, letter, thermal-80, thermal-58, reissue",
      })
    }

    // Validate grid size if provided
    if (gridSize) {
      const validGrids = getAvailableGrids()
      if (!validGrids.includes(gridSize)) {
        return res.status(400).json({
          error: "Invalid grid size",
          validGrids,
          hint: "Choose from: 2x2, 2x3, 3x3, 3x4",
        })
      }
    }

    // Validate each voucher
    for (let i = 0; i < vouchers.length; i++) {
      const v = vouchers[i]
      if (typeof v.satsAmount !== "number" || v.satsAmount <= 0) {
        return res.status(400).json({
          error: `Invalid voucher at index ${i}`,
          hint: "satsAmount must be a positive number",
        })
      }
      if (!v.qrDataUrl || typeof v.qrDataUrl !== "string") {
        return res.status(400).json({
          error: `Invalid voucher at index ${i}`,
          hint: "qrDataUrl must be a valid data URL string",
        })
      }
    }

    console.log(
      `📄 Generating PDF: ${vouchers.length} voucher(s), format: ${format}, grid: ${gridSize || "default"}`,
    )

    // Determine which document type to use
    const isThermal = format.startsWith("thermal")
    const isSingle = vouchers.length === 1
    const useGridLayout = gridSize && !isThermal && !isReissue && vouchers.length > 1

    let documentElement

    if (isReissue) {
      // Reissue format - single voucher with full LNURL text for replacement
      if (!vouchers[0].lnurl) {
        return res.status(400).json({
          error: "Reissue format requires lnurl field",
          hint: "Include the full LNURL string in the voucher data",
        })
      }
      documentElement = React.createElement(ReissueVoucherDocument, {
        voucher: vouchers[0],
        format: "a4",
      })
    } else if (isThermal) {
      // Thermal format always generates one voucher per page
      if (isSingle) {
        documentElement = React.createElement(ThermalVoucherDocument, {
          voucher: vouchers[0],
          format,
        })
      } else {
        // For multiple vouchers on thermal, we generate multiple pages
        documentElement = React.createElement(BatchVoucherDocument, {
          vouchers,
          format,
        })
      }
    } else if (useGridLayout) {
      // Use grid layout for multi-voucher with specified grid size
      documentElement = React.createElement(GridVoucherDocument, {
        vouchers,
        gridSize,
        paperFormat: format,
      })
    } else if (isSingle) {
      // Single voucher on standard paper
      documentElement = React.createElement(SingleVoucherDocument, {
        voucher: vouchers[0],
        format,
      })
    } else {
      // Multiple vouchers on standard paper (batch) - default 2x2 grid
      documentElement = React.createElement(BatchVoucherDocument, {
        vouchers,
        format,
      })
    }

    // Render to buffer
    const pdfBuffer = await renderToBuffer(
      documentElement as Parameters<typeof renderToBuffer>[0],
    )

    // Convert to base64
    const pdfBase64 = pdfBuffer.toString("base64")

    console.log(`✅ PDF generated: ${Math.round(pdfBuffer.length / 1024)}KB`)

    return res.status(200).json({
      success: true,
      pdf: pdfBase64,
      format,
      gridSize: gridSize || (isSingle ? null : "2x2"),
      voucherCount: vouchers.length,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    const stack = error instanceof Error ? error.stack : undefined
    console.error("❌ PDF generation error:", error)
    console.error("❌ Stack trace:", stack)

    return res.status(500).json({
      error: "Failed to generate PDF",
      message,
      stack: process.env.NODE_ENV === "development" ? stack : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE)

// Disable body parser limit for large QR data URLs
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
}
