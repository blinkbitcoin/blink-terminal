/**
 * Unit Tests for lib/paycode-lnurl.ts
 *
 * Tests the pure static-paycode / LNURL-encoding helpers used by the printable
 * paycode page (pages/[blinkusername]/print.tsx).
 */

import { bech32 } from "bech32"

import { buildStaticPaycode, encodeLnurl } from "../../lib/paycode-lnurl"

function decodeLnurl(lnurl: string): string {
  const decoded = bech32.decode(lnurl.toLowerCase(), 1500)
  const bytes = bech32.fromWords(decoded.words)
  return Buffer.from(bytes).toString("utf8")
}

describe("paycode-lnurl", () => {
  describe("encodeLnurl()", () => {
    it("produces an uppercased LNURL that round-trips to the original URL", () => {
      const url = "https://blink.sv/.well-known/lnurlp/alice"
      const lnurl = encodeLnurl(url)

      expect(lnurl).toMatch(/^LNURL1[0-9A-Z]+$/)
      expect(lnurl).toBe(lnurl.toUpperCase())
      expect(decodeLnurl(lnurl)).toBe(url)
    })
  })

  describe("buildStaticPaycode()", () => {
    const domain = "blink.sv"
    const appUrl = "https://terminal.blinkbtc.com"

    it("encodes the LNURL against the Lightning-address domain, NOT the pay host", () => {
      // Regression guard: the encoded LNURL MUST use the LN-address domain
      // (blink.sv), which resolves both custodial and self-custodial (Spark)
      // accounts. pay.blink.sv is custodial-only and returns null for Spark.
      const result = buildStaticPaycode("alice", domain, appUrl)
      expect(result.lnurlPayEndpoint).toBe("https://blink.sv/.well-known/lnurlp/alice")
      expect(result.lnurlPayEndpoint).not.toContain("pay.blink.sv")
      expect(decodeLnurl(result.lnurl)).toBe(result.lnurlPayEndpoint)
    })

    it("uses the Terminal app origin for the web fallback URL", () => {
      const result = buildStaticPaycode("pretyflaco", domain, appUrl)
      expect(result.webUrl).toBe("https://terminal.blinkbtc.com/pretyflaco")
    })

    it("builds the wrapped, uppercased QR value (web URL + ?lightning= LNURL)", () => {
      const result = buildStaticPaycode("twentyone", domain, appUrl)
      expect(result.qrValue).toBe(
        `HTTPS://TERMINAL.BLINKBTC.COM/TWENTYONE?LIGHTNING=${result.lnurl}`,
      )
      // Fully uppercase and contains both the fallback host and the LNURL.
      expect(result.qrValue).toBe(result.qrValue.toUpperCase())
      expect(result.qrValue).toContain("TERMINAL.BLINKBTC.COM/TWENTYONE")
      expect(result.qrValue).toContain("?LIGHTNING=LNURL1")
    })

    it("produces an identically-shaped QR value for custodial and Spark users", () => {
      const spark = buildStaticPaycode("twentyone", domain, appUrl)
      const custodial = buildStaticPaycode("pretyflaco", domain, appUrl)
      const shape = (u: string, lnurl: string) =>
        `HTTPS://TERMINAL.BLINKBTC.COM/${u.toUpperCase()}?LIGHTNING=${lnurl}`
      expect(spark.qrValue).toBe(shape("twentyone", spark.lnurl))
      expect(custodial.qrValue).toBe(shape("pretyflaco", custodial.lnurl))
    })

    it("defaults the web fallback URL to the LN-address domain when webUrlBase omitted", () => {
      const result = buildStaticPaycode("alice", domain)
      expect(result.webUrl).toBe("https://blink.sv/alice")
    })

    it("strips a trailing slash from the webUrlBase", () => {
      const result = buildStaticPaycode("dave", domain, "https://terminal.blinkbtc.com/")
      expect(result.webUrl).toBe("https://terminal.blinkbtc.com/dave")
    })

    it("builds a lowercased lightning address on the given domain", () => {
      const result = buildStaticPaycode("Alice", domain, appUrl)
      expect(result.lightningAddress).toBe("alice@blink.sv")
    })

    it("normalizes a mixed-case username to lowercase for the LNURL and web URL", () => {
      // A paycode's uppercased QR fallback can route back with a mixed-case name;
      // resolution is case-sensitive, so the endpoint/webUrl must be lowercase.
      const result = buildStaticPaycode("ALICE", domain, appUrl)
      expect(result.lnurlPayEndpoint).toBe("https://blink.sv/.well-known/lnurlp/alice")
      expect(result.webUrl).toBe("https://terminal.blinkbtc.com/alice")
      // The QR display value remains uppercase (host case-insensitive).
      expect(result.qrValue).toContain("TERMINAL.BLINKBTC.COM/ALICE?LIGHTNING=")
    })

    it("respects a staging lightning-address domain", () => {
      const result = buildStaticPaycode(
        "bob",
        "pay.staging.blink.sv",
        "https://pay.staging.blink.sv",
      )
      expect(result.lnurlPayEndpoint).toBe(
        "https://pay.staging.blink.sv/.well-known/lnurlp/bob",
      )
      expect(result.webUrl).toBe("https://pay.staging.blink.sv/bob")
      expect(result.lightningAddress).toBe("bob@pay.staging.blink.sv")
    })

    it("resolves both custodial and self-custodial (Spark) users via the same host", () => {
      // twentyone = non-custodial (Spark); pretyflaco = custodial. Both encode
      // the same LN-address host shape; the LUD-16 endpoint routes each type.
      const spark = buildStaticPaycode("twentyone", domain, appUrl)
      const custodial = buildStaticPaycode("pretyflaco", domain, appUrl)

      expect(spark.lnurlPayEndpoint).toBe("https://blink.sv/.well-known/lnurlp/twentyone")
      expect(custodial.lnurlPayEndpoint).toBe(
        "https://blink.sv/.well-known/lnurlp/pretyflaco",
      )
    })
  })
})
