/**
 * Payout guard helpers
 *
 * Centralizes the security checks that protect the shared BlinkPOS
 * intermediary wallet from being drained when forwarding payments / tips.
 *
 * The intermediary wallet only ever pays out funds that a customer has
 * already paid INTO it for a specific `paymentHash`. These helpers enforce
 * that invariant:
 *
 *   - `assertWithinMaxForward`  — optional absolute ceiling (defense-in-depth).
 *   - `verifyForwardInvoice`    — the BOLT11 we are about to pay must be for the
 *                                 exact expected sat amount, must not be expired,
 *                                 and (for intraledger flows) must be destined for
 *                                 a Blink node so no Lightning routing fees apply.
 *
 * @module lib/payout-guard
 */

import { decodeInvoice, isBlinkNodePubkey } from "./invoice-decoder"

export type GuardResult = { ok: true } | { ok: false; error: string }

/**
 * Optional absolute ceiling on a single forward, in sats.
 * Set `BLINKPOS_MAX_FORWARD_SATS` to enable; unset disables the check.
 */
export function getMaxForwardSats(): number | null {
  const raw = process.env.BLINKPOS_MAX_FORWARD_SATS
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

/**
 * Reject amounts above the configured ceiling. No-op when unset.
 */
export function assertWithinMaxForward(amountSats: number): GuardResult {
  const max = getMaxForwardSats()
  if (max === null) return { ok: true }
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    return { ok: false, error: "Invalid forward amount" }
  }
  if (amountSats > max) {
    return {
      ok: false,
      error: `Forward amount ${amountSats} sats exceeds maximum allowed (${max} sats)`,
    }
  }
  return { ok: true }
}

interface VerifyForwardInvoiceOptions {
  /** The BOLT11 invoice the BlinkPOS wallet is about to pay. */
  invoice: string
  /** The exact amount (sats) we expect to pay, derived from stored data. */
  expectedSats: number
  /**
   * When true, the invoice payee node MUST be a known Blink node. Used for
   * flows that are documented as intraledger / zero-fee (NWC, npub.cash,
   * Blink Lightning Address). Prevents both routing-fee drain and
   * off-network exfiltration.
   */
  requireBlinkNode?: boolean
}

/**
 * Verify that an invoice is safe to pay from the BlinkPOS wallet:
 *   1. Decodes cleanly.
 *   2. Encodes the EXACT expected sat amount (no amountless / mismatched invoices).
 *   3. Is not expired.
 *   4. (optional) Is destined for a Blink node (zero-fee intraledger).
 */
export function verifyForwardInvoice(opts: VerifyForwardInvoiceOptions): GuardResult {
  const { invoice, expectedSats, requireBlinkNode = false } = opts

  if (!Number.isFinite(expectedSats) || expectedSats <= 0) {
    return { ok: false, error: "Invalid expected amount for invoice verification" }
  }

  const decoded = decodeInvoice(invoice)
  if (!decoded.success) {
    return { ok: false, error: `Failed to decode invoice: ${decoded.error}` }
  }

  // 2. Amount must be present and exactly match the expected amount.
  // bolt11 returns `satoshis` as a number (or null for amountless invoices).
  const invoiceSats = decoded.data.satoshis
  if (invoiceSats === null || invoiceSats === undefined) {
    return {
      ok: false,
      error: "Invoice has no amount; refusing to pay amountless invoice",
    }
  }
  if (invoiceSats !== expectedSats) {
    return {
      ok: false,
      error: `Invoice amount (${invoiceSats} sats) does not match expected amount (${expectedSats} sats)`,
    }
  }

  // 3. Reject expired invoices (paying an expired invoice would fail anyway,
  // but we reject early to avoid spending attempts on stale data).
  const expiry = decoded.data.timeExpireDate
  if (typeof expiry === "number" && expiry > 0) {
    const nowSec = Math.floor(Date.now() / 1000)
    if (nowSec >= expiry) {
      return { ok: false, error: "Invoice has expired" }
    }
  }

  // 4. Optionally require a Blink payee node (intraledger / zero-fee).
  if (requireBlinkNode) {
    const payee = decoded.data.payeeNodeKey
    if (!payee) {
      return {
        ok: false,
        error: "Could not determine invoice destination node",
      }
    }
    if (!isBlinkNodePubkey(payee)) {
      return {
        ok: false,
        error: "Invoice destination is not a Blink node; refusing non-intraledger payout",
      }
    }
  }

  return { ok: true }
}
