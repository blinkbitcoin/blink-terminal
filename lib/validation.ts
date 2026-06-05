/**
 * Zod input validation schemas for API routes
 *
 * Aligned with blink stack convention: zod@3.23.8.
 * Provides reusable schemas and a `validateBody` helper for API handlers.
 *
 * Usage:
 *   import { validateBody, createInvoiceSchema } from "../../../lib/validation"
 *
 *   const parsed = validateBody(req, res, createInvoiceSchema)
 *   if (!parsed) return // response already sent
 *   const { amount, currency } = parsed
 *
 * @module lib/validation
 */

import type { NextApiRequest, NextApiResponse } from "next"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

/** Blink environment selector. */
export const environmentSchema = z.enum(["production", "staging"]).default("production")

/** Currency code (3-letter ISO 4217 or crypto symbol). */
export const currencySchema = z.string().min(1).max(10)

/** Positive sat amount (string or number input, coerced to number). */
export const satAmountSchema = z.coerce.number().int().positive()

/** Optional positive number for tip amounts. */
export const optionalAmountSchema = z.coerce.number().min(0).optional()

/** Lightning payment hash (hex, 64 chars). */
export const paymentHashSchema = z.string().regex(/^[a-f0-9]{64}$/i, {
  message: "Invalid payment hash format (expected 64 hex characters)",
})

/** Lightning invoice / payment request (lnbc...). */
export const invoiceSchema = z.string().min(1)

/** Nostr hex pubkey (64 chars). */
export const nostrPubkeySchema = z.string().regex(/^[a-f0-9]{64}$/i, {
  message: "Invalid nostr pubkey format",
})

// ---------------------------------------------------------------------------
// Route-specific schemas
// ---------------------------------------------------------------------------

/** POST /api/blink/create-invoice */
export const createInvoiceSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  currency: currencySchema,
  memo: z.string().max(640).optional(),
  walletId: z.string().optional(),
  apiKey: z.string().optional(),
  userWalletId: z.string().optional(),
  displayCurrency: z.string().optional(),
  baseAmount: optionalAmountSchema,
  tipAmount: optionalAmountSchema,
  tipPercent: z.coerce.number().min(0).max(100).optional(),
  tipRecipients: z.array(z.record(z.unknown())).optional().default([]),
  baseAmountDisplay: optionalAmountSchema,
  tipAmountDisplay: optionalAmountSchema,
  nwcActive: z.boolean().optional(),
  nwcConnectionUri: z.string().optional(),
  blinkLnAddress: z.boolean().optional(),
  blinkLnAddressWalletId: z.string().optional(),
  blinkLnAddressUsername: z.string().optional(),
  npubCashActive: z.boolean().optional(),
  npubCashLightningAddress: z.string().optional(),
  environment: environmentSchema,
})

/**
 * POST /api/blink/forward-with-tips
 * Only paymentHash is authoritative; totalAmount/memo are advisory. All money
 * amounts and recipients are read server-side from the stored payment record.
 */
export const forwardWithTipsSchema = z.object({
  paymentHash: paymentHashSchema,
  totalAmount: z.coerce.number().int().positive().optional(),
  memo: z.string().max(640).optional().default(""),
  environment: environmentSchema.optional(),
})

/** POST /api/blink/pay-invoice */
export const payInvoiceSchema = z.object({
  paymentHash: paymentHashSchema,
  invoice: invoiceSchema.optional(),
  paymentRequest: invoiceSchema.optional(),
  memo: z.string().max(640).optional().default(""),
  environment: environmentSchema,
})

/** POST /api/blink/check-payment */
export const checkPaymentSchema = z.object({
  paymentHash: paymentHashSchema,
  environment: environmentSchema,
})

/** POST /api/auth/verify-ownership */
export const verifyOwnershipSchema = z.object({
  signedEvent: z.object({
    kind: z.number(),
    content: z.string(),
    tags: z.array(z.array(z.string())),
    pubkey: nostrPubkeySchema,
    sig: z.string().min(1),
    id: z.string().optional(),
    created_at: z.number().optional(),
  }),
})

/** POST /api/auth/nostr-login */
export const nostrLoginSchema = z.object({
  event: z.object({
    kind: z.literal(27235),
    content: z.string(),
    tags: z.array(z.array(z.string())),
    pubkey: nostrPubkeySchema,
    sig: z.string().min(1),
    id: z.string(),
    created_at: z.number(),
  }),
})

/** POST /api/voucher/create */
export const createVoucherSchema = z.object({
  amount: satAmountSchema,
  currency: currencySchema.optional().default("BTC"),
  memo: z.string().max(640).optional(),
  recipientLnAddress: z.string().optional(),
  expiresInHours: z.coerce.number().int().positive().max(8760).optional(),
})

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Validate the request body against a Zod schema.
 *
 * On success, returns the parsed + typed data.
 * On failure, sends a 400 response with field-level errors and returns `null`.
 */
export function validateBody<T extends z.ZodTypeAny>(
  req: NextApiRequest,
  res: NextApiResponse,
  schema: T,
): z.infer<T> | null {
  const result = schema.safeParse(req.body)

  if (!result.success) {
    const fieldErrors = result.error.flatten().fieldErrors
    res.status(400).json({
      error: "Validation failed",
      details: fieldErrors,
    })
    return null
  }

  return result.data as z.infer<T>
}
