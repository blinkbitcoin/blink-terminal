/**
 * API: POST /api/batch-payments/validate
 *
 * Validates all recipients in a batch payment request.
 * Returns validation results to client (serverless-compatible).
 *
 * Request body:
 * {
 *   csvContent: string    // Raw CSV content
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   summary: { total, valid, invalid, byType },
 *   results: ValidationResult[],
 *   parseErrors?: string[]
 * }
 */

import type { NextApiRequest, NextApiResponse } from "next"

import { parseCSV, quickValidate } from "../../../lib/batch-payments/csv-parser"
import {
  validateAllRecipients,
  type ValidationResult,
} from "../../../lib/batch-payments/recipient-validator"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const { csvContent } = req.body as { csvContent: string }

    // Must provide CSV content
    if (!csvContent) {
      return res.status(400).json({
        error: "csvContent is required",
      })
    }

    // Quick validation first
    const quickCheck = quickValidate(csvContent)
    if (!quickCheck.valid) {
      return res.status(400).json({
        success: false,
        error: quickCheck.error,
      })
    }

    // Full parse
    const parseResult = parseCSV(csvContent)

    if (!parseResult.success && parseResult.records?.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Failed to parse CSV",
        parseErrors: parseResult.errors,
      })
    }

    const recipients = parseResult.records
    const parseErrors = parseResult.errors

    // Validate we have recipients
    if (!recipients || recipients.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No valid recipients found",
      })
    }

    // Check batch limits
    if (recipients.length > 1000) {
      return res.status(400).json({
        success: false,
        error: `Too many recipients (${recipients.length}). Maximum is 1000 per batch.`,
      })
    }

    // Validate all recipients
    const validationResult = await validateAllRecipients(recipients, {
      concurrency: 10,
      delayMs: 100,
    })

    // Calculate totals
    const validRecipients = validationResult.results.filter(
      (r: ValidationResult) => r.valid,
    )
    const totalAmountSats = validRecipients.reduce((sum: number, r: ValidationResult) => {
      return sum + (r.recipient.amountSats || 0)
    }, 0)

    // Return validation results (client stores for execute step)
    return res.status(200).json({
      success: true,
      summary: {
        total: validationResult.summary.total,
        valid: validationResult.summary.valid,
        invalid: validationResult.summary.invalid,
        byType: validationResult.summary.byType,
        totalAmountSats,
      },
      results: validationResult.results.map((r: ValidationResult) => ({
        rowNumber: r.recipient.rowNumber,
        recipient: r.recipient.original,
        type: r.recipient.type,
        normalized: r.recipient.normalized,
        amount: r.recipient.amount,
        amountSats: r.recipient.amountSats,
        currency: r.recipient.currency,
        memo: r.recipient.memo,
        valid: r.valid,
        blinkUsername: r.blinkUsername,
        walletId: r.walletId,
        lnurlData: r.lnurlData,
        error: r.error,
      })),
      parseErrors,
      errorGroups: validationResult.summary.errorGroups,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Batch validation error:", error)
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "batch-payments/validate")
