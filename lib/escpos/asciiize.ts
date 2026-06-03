/**
 * asciiizeReceiptText — transliterate text to printer-safe 7-bit ASCII.
 *
 * Thermal printers default to the CP437 code page, but our ESC/POS text is
 * emitted as UTF-8. Multi-byte characters (smart quotes, em/en dashes,
 * ellipses, accented letters) therefore print as mojibake (e.g. an em-dash
 * `—` shows up as `ΓÇö`). This helper maps the typographic/Latin characters we
 * actually see in receipt content (quotes, names, history facts) down to ASCII
 * equivalents, and strips anything else above 0x7F as a last resort.
 *
 * It is intentionally lossy — receipts are plain monospace output, so "Maréchal"
 * → "Marechal" and `—` → `-` are acceptable. Apply it to any free-text that
 * reaches the printer (footer body/heading/caption, memo, etc.).
 *
 * @module lib/escpos/asciiize
 */

/** Explicit overrides for punctuation/symbols NFKD doesn't reduce to ASCII. */
const OVERRIDES: Record<string, string> = {
  // Single quotes / apostrophes
  "\u2018": "'", // ‘ left single
  "\u2019": "'", // ’ right single (also apostrophe)
  "\u201A": "'", // ‚ single low
  "\u201B": "'", // ‛ single high-reversed
  "\u2032": "'", // ′ prime
  "\u0060": "'", // ` grave accent used as quote
  "\u00B4": "'", // ´ acute accent used as quote
  // Double quotes
  "\u201C": '"', // “ left double
  "\u201D": '"', // ” right double
  "\u201E": '"', // „ double low
  "\u201F": '"', // ‟ double high-reversed
  "\u2033": '"', // ″ double prime
  "\u00AB": '"', // « left guillemet
  "\u00BB": '"', // » right guillemet
  // Dashes / hyphens
  "\u2010": "-", // ‐ hyphen
  "\u2011": "-", // ‑ non-breaking hyphen
  "\u2012": "-", // ‒ figure dash
  "\u2013": "-", // – en dash
  "\u2014": "-", // — em dash
  "\u2015": "-", // ― horizontal bar
  "\u2212": "-", // − minus sign
  // Ellipsis
  "\u2026": "...", // …
  // Spaces
  "\u00A0": " ", // non-breaking space
  "\u2009": " ", // thin space
  "\u202F": " ", // narrow no-break space
  // Ligatures
  "\uFB01": "fi", // ﬁ
  "\uFB02": "fl", // ﬂ
  "\u0153": "oe", // œ
  "\u0152": "OE", // Œ
  "\u00E6": "ae", // æ
  "\u00C6": "AE", // Æ
  "\u00DF": "ss", // ß
  // Latin letters that NFKD does not decompose
  "\u0142": "l", // ł
  "\u0141": "L", // Ł
  "\u00F8": "o", // ø
  "\u00D8": "O", // Ø
  "\u0111": "d", // đ
  "\u0110": "D", // Đ
  // Common symbols
  "\u2022": "*", // • bullet
  "\u2122": "(TM)", // ™
  "\u00A9": "(C)", // ©
  "\u00AE": "(R)", // ®
  "\u20AC": "EUR", // €
  "\u00A3": "GBP", // £
  "\u00A5": "JPY", // ¥
}

/**
 * Convert a string to printer-safe ASCII.
 *
 * 1. Apply explicit overrides for punctuation/ligatures/symbols.
 * 2. NFKD-normalize and strip combining diacritics (é → e, ü → u, ö → o, ...).
 * 3. Drop any remaining non-ASCII (> 0x7F) characters.
 */
export function asciiizeReceiptText(input: string): string {
  if (!input) return input

  // 1. Explicit overrides.
  let out = ""
  for (const ch of input) {
    out += OVERRIDES[ch] ?? ch
  }

  // 2. Decompose accents and remove combining marks.
  out = out.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")

  // 3. Strip anything still outside printable ASCII (keep \n and \t).
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[^\x09\x0a\x20-\x7e]/g, "")

  return out
}

export default asciiizeReceiptText
