import { bech32 } from "bech32"

/**
 * Pure helpers for building a static (variable-amount) LNURL-pay paycode for a
 * Blink username.
 *
 * Two distinct hosts are involved:
 * - `lnAddressDomain` — the Blink Lightning-address (LUD-16) domain, e.g.
 *   `blink.sv`. The QR encodes the LNURL-pay endpoint at
 *   `https://{lnAddressDomain}/.well-known/lnurlp/{username}`. This host is
 *   provider-agnostic: it resolves BOTH custodial Blink wallets AND
 *   self-custodial (Spark) accounts (Spark users are routed onward to
 *   `lnurl.blink.sv`). NOTE: the `pay.blink.sv` pay host only resolves
 *   custodial accounts — it returns a null payResponse for Spark users — so it
 *   must NOT be used to build the encoded LNURL. Always use the LN-address
 *   domain here (mirrors `parseLightningAddress` / `receiver-resolver`).
 * - `webUrlBase` — the human-facing web fallback origin (the Terminal app,
 *   e.g. `https://terminal.blinkbtc.com`) opened by plain camera apps that
 *   don't understand LNURL. Defaults to `https://{lnAddressDomain}` when
 *   omitted.
 */

export interface StaticPaycode {
  /** Bech32-encoded, uppercased LNURL (e.g. `LNURL1...`). */
  lnurl: string
  /**
   * The value to encode into the printed QR: the human web-fallback URL with
   * the LNURL attached as a `?lightning=` param, uppercased (e.g.
   * `HTTPS://TERMINAL.BLINKBTC.COM/ALICE?LIGHTNING=LNURL1...`). LNURL-aware
   * wallets read the `lightning=` param; plain camera apps open the web page.
   * Identical shape for custodial and self-custodial (Spark) users.
   */
  qrValue: string
  /** The raw (unencoded) LNURL-pay metadata endpoint. */
  lnurlPayEndpoint: string
  /** Human-reachable web fallback page (opened by plain camera apps). */
  webUrl: string
  /** `username@domain` lightning address. */
  lightningAddress: string
}

// Max bech32 length for LNURL (LUD-01 recommends 1023; Blink uses 1500).
const LNURL_BECH32_LIMIT = 1500

/**
 * Encode an arbitrary URL string as an uppercased bech32 LNURL.
 */
export function encodeLnurl(url: string): string {
  const words = bech32.toWords(Buffer.from(url, "utf8"))
  return bech32.encode("lnurl", words, LNURL_BECH32_LIMIT).toUpperCase()
}

/**
 * Build a static, variable-amount paycode for a username.
 *
 * The encoded LNURL targets the Lightning-address (LUD-16) endpoint on
 * `lnAddressDomain`, which resolves both custodial and self-custodial (Spark)
 * Blink accounts. Do NOT pass the `pay.blink.sv` pay host here — it is
 * custodial-only.
 *
 * @param username - Blink username (already format-validated upstream)
 * @param lnAddressDomain - Lightning-address domain for the current environment,
 *   e.g. `blink.sv`. Use `getLnAddressDomain()`. The QR's LNURL points here.
 * @param webUrlBase - Human-facing web fallback origin (the Terminal app), e.g.
 *   `https://terminal.blinkbtc.com`. Use `getAppUrl()`. Defaults to
 *   `https://{lnAddressDomain}` when omitted.
 */
export function buildStaticPaycode(
  username: string,
  lnAddressDomain: string,
  webUrlBase: string = `https://${lnAddressDomain}`,
): StaticPaycode {
  const normalizedWebBase = webUrlBase.replace(/\/+$/, "")
  const lnurlPayEndpoint = `https://${lnAddressDomain}/.well-known/lnurlp/${username}`
  const lnurl = encodeLnurl(lnurlPayEndpoint)
  const webUrl = `${normalizedWebBase}/${username}`

  return {
    lnurl,
    // Wrapped fallback URL, uppercased (QR alphanumeric mode + Blink-mobile
    // compatibility). Same shape for custodial and self-custodial users.
    qrValue: `${webUrl}?lightning=${lnurl}`.toUpperCase(),
    lnurlPayEndpoint,
    webUrl,
    lightningAddress: `${username.toLowerCase()}@${lnAddressDomain}`,
  }
}
