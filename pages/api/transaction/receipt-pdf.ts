import fs from "fs"
import path from "path"

import { renderToBuffer } from "@react-pdf/renderer"
import type { NextApiRequest, NextApiResponse } from "next"
import React from "react"

import AuthManager from "../../../lib/auth"
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

/**
 * Field length caps (blink-wip#1664). The route used to render
 * caller-supplied strings of ANY length as <Text>; react-pdf's text layout
 * of one unbroken 200 KB id blocked the single Node process for >60 s —
 * an unauthenticated single-request full-service DoS. Every rendered field
 * is now bounded, so layout cost is a small constant regardless of input.
 */
const LIMITS = {
  id: 128, // payment hashes / txids are 64 hex chars
  short: 64, // status, amount, date, currency codes, usernames
  hash: 128, // paymentHash, preImage, transactionHash, address
  memo: 512,
} as const

interface ViaInput {
  __typename?: string
  paymentHash?: string
  preImage?: string
  transactionHash?: string
  address?: string
  counterPartyUsername?: string
}

interface TransactionInput {
  id: string
  direction: string
  status?: string
  amount?: string
  settlementCurrency?: string
  settlementAmount?: number
  settlementFee?: number
  settlementDisplayAmount?: number
  settlementDisplayCurrency?: string
  date?: string
  memo?: string
  initiationVia?: ViaInput
  settlementVia?: ViaInput
}

/** string of at most `max` chars, or null (invalid). undefined stays absent. */
function cappedString(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || value.length > max) return null
  return value
}

function cappedNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return value
}

function sanitizeVia(value: unknown): ViaInput | null | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "object" || Array.isArray(value)) return null

  const via = value as Record<string, unknown>
  const typename = cappedString(via.__typename, LIMITS.short)
  const paymentHash = cappedString(via.paymentHash, LIMITS.hash)
  const preImage = cappedString(via.preImage, LIMITS.hash)
  const transactionHash = cappedString(via.transactionHash, LIMITS.hash)
  const address = cappedString(via.address, LIMITS.hash)
  const counterPartyUsername = cappedString(via.counterPartyUsername, LIMITS.short)
  if (
    [
      typename,
      paymentHash,
      preImage,
      transactionHash,
      address,
      counterPartyUsername,
    ].some((f) => f === null)
  ) {
    return null
  }
  return {
    __typename: typename ?? undefined,
    paymentHash: paymentHash ?? undefined,
    preImage: preImage ?? undefined,
    transactionHash: transactionHash ?? undefined,
    address: address ?? undefined,
    counterPartyUsername: counterPartyUsername ?? undefined,
  }
}

/**
 * Validate and bound the request body into a clean TransactionInput, or
 * return an error string. Unknown fields are dropped; every rendered string
 * is length-capped.
 */
function sanitizeTransaction(body: unknown): TransactionInput | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Missing transaction data"
  }
  const input = (body as Record<string, unknown>).transaction
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "Missing transaction data"
  }

  const tx = input as Record<string, unknown>

  const id = cappedString(tx.id, LIMITS.id)
  if (id === null || id === undefined || id === "") {
    return id === "" || id === undefined
      ? "Missing transaction ID"
      : `Invalid transaction id (string, max ${LIMITS.id} chars)`
  }

  const direction = cappedString(tx.direction, LIMITS.short)
  if (!direction || !["RECEIVE", "SEND"].includes(direction)) {
    return "Invalid direction (RECEIVE or SEND)"
  }

  const fields: [string, unknown, number][] = [
    ["status", tx.status, LIMITS.short],
    ["amount", tx.amount, LIMITS.short],
    ["settlementCurrency", tx.settlementCurrency, LIMITS.short],
    ["settlementDisplayCurrency", tx.settlementDisplayCurrency, LIMITS.short],
    ["date", tx.date, LIMITS.short],
    ["memo", tx.memo, LIMITS.memo],
  ]
  const clean: Record<string, string | undefined> = {}
  for (const [name, value, max] of fields) {
    const capped = cappedString(value, max)
    if (capped === null) return `Invalid ${name} (string, max ${max} chars)`
    clean[name] = capped
  }

  const numbers: [string, unknown][] = [
    ["settlementAmount", tx.settlementAmount],
    ["settlementFee", tx.settlementFee],
    ["settlementDisplayAmount", tx.settlementDisplayAmount],
  ]
  const cleanNumbers: Record<string, number | undefined> = {}
  for (const [name, value] of numbers) {
    const capped = cappedNumber(value)
    if (capped === null) return `Invalid ${name} (finite number)`
    cleanNumbers[name] = capped
  }

  const initiationVia = sanitizeVia(tx.initiationVia)
  if (initiationVia === null) return "Invalid initiationVia"
  const settlementVia = sanitizeVia(tx.settlementVia)
  if (settlementVia === null) return "Invalid settlementVia"

  return {
    id,
    direction,
    status: clean.status,
    amount: clean.amount,
    settlementCurrency: clean.settlementCurrency,
    settlementDisplayCurrency: clean.settlementDisplayCurrency,
    date: clean.date,
    memo: clean.memo,
    settlementAmount: cleanNumbers.settlementAmount,
    settlementFee: cleanNumbers.settlementFee,
    settlementDisplayAmount: cleanNumbers.settlementDisplayAmount,
    initiationVia,
    settlementVia,
  }
}

/**
 * Transaction Receipt PDF Generation API
 *
 * POST /api/transaction/receipt-pdf — POS session required.
 * Body: { transaction: { id, direction, status, amount, ... } }
 * Returns: PDF as base64 string
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
      allowedMethods: ["POST"],
    })
  }

  // The only caller is the authenticated POS (TransactionDetail). The route
  // was unauthenticated, which made the render-cost DoS anonymous
  // (blink-wip#1664).
  const session = AuthManager.verifySession(req.cookies?.["auth-token"])
  if (!session) {
    return res.status(401).json({ error: "Authentication required" })
  }

  try {
    const transaction = sanitizeTransaction(req.body)
    if (typeof transaction === "string") {
      return res.status(400).json({ error: transaction })
    }

    // Never log raw caller input at full length: a 2 MB id went straight to
    // stdout before #1664.
    console.log("📄 Transaction receipt PDF requested:", {
      transactionId: `${transaction.id.slice(0, 16)}…`,
      direction: transaction.direction,
    })

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
    const stack = error instanceof Error ? error.stack : undefined
    console.error("❌ Transaction receipt PDF generation error:", error)
    console.error("❌ Stack trace:", stack)

    // Never echo renderer errors to the caller (they can carry fetched content).
    return res.status(500).json({ error: "Failed to generate receipt PDF" })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "transaction/receipt-pdf")

export const config = {
  api: {
    // Legit transaction objects are a few KB; rendered fields are capped
    // regardless, so a large body is never legitimate.
    bodyParser: {
      sizeLimit: "100kb",
    },
  },
}
