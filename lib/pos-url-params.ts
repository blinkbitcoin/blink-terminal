/**
 * lib/pos-url-params.ts
 *
 * Parsing/validation for the public POS URL query params
 * (`terminal.blinkbtc.com/<username>?amount=..&memo=..&display=..`),
 * matching pay.blink.sv semantics (apps/pay `app/[username]/page.tsx`) and the
 * native blink-terminal-app deep-link parser (`app/lib/deeplink/parse.ts`):
 *
 * | Param    | Meaning                                                        |
 * |----------|----------------------------------------------------------------|
 * | display  | Display currency code. Fiat codes (USD, EUR, …) or SAT/BTC.    |
 * | amount   | Number in the display currency's MAJOR units (whole sats when  |
 * |          | the display is bitcoin). Pre-filled but editable.              |
 * | memo     | Lightning invoice memo (free text).                            |
 *
 * Pay uses `display=SAT` for sats; terminal's internal sats currency id is
 * `BTC` (lib/currency-utils.ts SAT_CURRENCY), so SAT/BTC/BTC-BIP177 all
 * normalize to "BTC" here.
 *
 * Everything is pure and SSR-safe so `getServerSideProps` can sanitize before
 * the client ever sees the values.
 */

import { isBitcoinCurrency } from "./currency-utils"

export interface PosUrlParams {
  /** Normalized display currency id (terminal-internal, e.g. "BTC" for sats). */
  display?: string
  /** Amount string in display-currency major units, numpad-ready. */
  amount?: string
  /** Invoice memo, trimmed and length-capped. */
  memo?: string
}

/** Loose shape of Next's `context.query` values. */
type RawQueryValue = string | string[] | undefined

/** Fiat currency code shape (same as the native app's CURRENCY_RE). */
const FIAT_CODE_RE = /^[A-Z]{2,8}$/

/** Matches the native app's MAX_MEMO_LEN so links behave identically on both. */
export const MAX_MEMO_LEN = 200

/** Query values may repeat (`?memo=a&memo=b`); take the first string. */
const firstString = (value: RawQueryValue): string | undefined => {
  if (typeof value === "string") return value
  if (Array.isArray(value) && typeof value[0] === "string") return value[0]
  return undefined
}

/**
 * Normalize the `display` param to a terminal currency id.
 * - SAT / BTC / BTC-BIP177 -> "BTC" (sats display; SAT is pay's id,
 *   BTC-BIP177 shares the same sats units)
 * - fiat-shaped codes pass through uppercased; they are validated against the
 *   loaded currency list client-side (unknown -> USD fallback)
 * - anything else -> undefined (caller falls back to the USD default)
 */
export const normalizePosDisplayParam = (raw: RawQueryValue): string | undefined => {
  const value = firstString(raw)?.trim().toUpperCase()
  if (!value) return undefined
  if (value === "SAT" || value === "BTC" || value === "BTC-BIP177") return "BTC"
  if (FIAT_CODE_RE.test(value)) return value
  return undefined
}

/**
 * Normalize the `amount` param to a numpad-ready string in the display
 * currency's major units. Sats displays round to whole sats; fiat rounds to
 * 2dp (pay clamps the same way via toFixed(2)). Non-numeric, non-positive,
 * and rounds-to-zero values are dropped (pay treats "0"/"0.00" as empty).
 */
export const normalizePosAmountParam = (
  raw: RawQueryValue,
  display: string | undefined,
): string | undefined => {
  const value = firstString(raw)?.trim()
  if (!value) return undefined
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  const normalized =
    display !== undefined && isBitcoinCurrency(display)
      ? Math.round(numeric)
      : Math.round(numeric * 100) / 100
  if (normalized <= 0) return undefined
  return String(normalized)
}

/** Normalize the `memo` param: trim, cap at MAX_MEMO_LEN, drop when empty. */
export const normalizePosMemoParam = (raw: RawQueryValue): string | undefined => {
  const value = firstString(raw)?.trim()
  if (!value) return undefined
  return value.slice(0, MAX_MEMO_LEN)
}

/**
 * Parse the public POS query params from Next's `context.query`. Absent or
 * invalid params come back undefined so the UI keeps its defaults (USD,
 * empty amount, no memo).
 */
export const parsePosUrlParams = (query: {
  display?: RawQueryValue
  amount?: RawQueryValue
  memo?: RawQueryValue
}): PosUrlParams => {
  const display = normalizePosDisplayParam(query.display)
  return {
    display,
    amount: normalizePosAmountParam(query.amount, display),
    memo: normalizePosMemoParam(query.memo),
  }
}
