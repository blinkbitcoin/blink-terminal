import fs from "fs"
import path from "path"

import { renderToBuffer } from "@react-pdf/renderer"
import type { NextApiRequest, NextApiResponse } from "next"
import { toDataURL } from "qrcode"
import React from "react"

import {
  getAppUrl,
  getEnvironment,
  getLnAddressDomain,
  type EnvironmentName,
} from "../../../lib/config/api"
import { buildStaticPaycode, isValidBlinkUsername } from "../../../lib/paycode-lnurl"
import { withRateLimit, RATE_LIMIT_PUBLIC } from "../../../lib/rate-limit"

/**
 * Input bounds (blink-wip#1664 follow-up). This route is public and renders
 * in the single Node process: react-pdf's text layout is super-linear (a
 * 100 KB displayAmount took 25 s, starving every other request). Every
 * rendered text value is bounded.
 *
 * The QR image is generated HERE, never taken from the caller: the
 * renderer's PNG parser (png-js) trusts chunk lengths, inflates without a
 * limit and throws from async callbacks on bad filter bytes, so any
 * caller-supplied PNG could exhaust the heap or leave the request hanging.
 * A `qrDataUrl` in the body (sent by older clients) is ignored.
 */
const LIMITS = {
  displayAmount: 64, // e.g. "$1,000,000.00 USD"
  maxSats: 21_000_000 * 100_000_000,
} as const

// Same rendering as the client's on-screen QR (components/PublicPOS/PrintPaycodeView.tsx).
const QR_OPTIONS = { width: 400, margin: 2, errorCorrectionLevel: "H" } as const

// The centre logo, a print-sized copy of public/logos/blink-qr-logo.png.
let logoDataUrl: string | null = null
const getLogoDataUrl = (): string => {
  if (!logoDataUrl) {
    const file = path.join(process.cwd(), "public", "logos", "blink-qr-logo-pdf.png")
    logoDataUrl = `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`
  }
  return logoDataUrl
}

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
 *   username: string (Blink username; or derived from lightningAddress),
 *   environment?: "production" | "staging" (default: the server's),
 *   amount?: number (sats, fixed-amount label only),
 *   displayAmount?: string (formatted display e.g., "$5.00 USD"),
 * }
 * The paycode (LNURL, web fallback, lightning address) and its QR are built
 * server-side with lib/paycode-lnurl.ts, exactly as the client builds them.
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
    const { lightningAddress, amount, displayAmount, username, environment } =
      (req.body ?? {}) as {
        lightningAddress?: unknown
        amount?: number | null
        displayAmount?: string | null
        username?: unknown
        environment?: unknown
      }

    // username, or (older clients) the localpart of lightningAddress.
    const rawUsername =
      username !== undefined && username !== null
        ? username
        : typeof lightningAddress === "string"
          ? lightningAddress.split("@")[0]
          : undefined
    if (!isValidBlinkUsername(rawUsername)) {
      return res.status(400).json({
        error: "Missing or invalid username",
        hint: "username must be 3-50 chars of [a-zA-Z0-9_]",
      })
    }

    if (
      environment !== undefined &&
      environment !== null &&
      environment !== "production" &&
      environment !== "staging"
    ) {
      return res.status(400).json({
        error: "Invalid environment",
        hint: 'environment must be "production" or "staging"',
      })
    }
    const env: EnvironmentName =
      environment === "production" || environment === "staging"
        ? environment
        : getEnvironment()

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

    const paycode = buildStaticPaycode(
      rawUsername,
      getLnAddressDomain(env),
      getAppUrl(env),
    )
    const qrDataUrl = await toDataURL(paycode.qrValue, QR_OPTIONS)

    // Dynamically import PDF module
    const { PaycodeDocument } = await getPdfModule()

    console.log(`📄 Generating Paycode PDF for ${paycode.lightningAddress}`)

    const documentElement = React.createElement(PaycodeDocument, {
      paycode: {
        lightningAddress: paycode.lightningAddress,
        qrDataUrl,
        logoDataUrl: getLogoDataUrl(),
        amount: amount || undefined,
        displayAmount: displayAmount || undefined,
        webUrl: paycode.webUrl,
        username: rawUsername.toLowerCase(),
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
      lightningAddress: paycode.lightningAddress,
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
    // Every accepted field is short. Older clients still send a ~10-40 KB
    // qrDataUrl (ignored), so leave room for it.
    bodyParser: {
      sizeLimit: "100kb",
    },
  },
}
