/**
 * Tests for orange-pill footer params in the V1 `app=payment` deep link
 * built by CompanionAdapter.
 */

import CompanionAdapter from "../../lib/escpos/adapters/CompanionAdapter"

function parse(url: string): URLSearchParams {
  // url looks like "blink://print?<query>"
  const q = url.slice(url.indexOf("?") + 1)
  return new URLSearchParams(q)
}

const emptyEscpos = new Uint8Array([0x1b, 0x40])

describe("CompanionAdapter payment deep link footer", () => {
  it("includes footer params when a footer is provided", () => {
    const adapter = new CompanionAdapter()
    const url = adapter.getDeepLinkUrl(emptyEscpos, {
      receipt: {
        amount: "5,000 sats ($50.00)",
        merchant: "alice",
        paymentHash: "abc123",
        timestamp: Date.UTC(2026, 0, 3, 12, 0, 0),
        footer: {
          heading: "On this day, 2009:",
          text: "Genesis Block is mined by Satoshi Nakamoto",
          caption: "Read: Bitcoin is Time - Gigi",
          qr: "https://example.com/genesis",
        },
      },
    })

    const p = parse(url)
    expect(p.get("app")).toBe("payment")
    expect(p.get("footerHeading")).toBe("On this day, 2009:")
    expect(p.get("footerText")).toContain("Genesis Block")
    expect(p.get("footerCaption")).toContain("Bitcoin is Time")
    expect(p.get("footerQr")).toBe("https://example.com/genesis")
  })

  it("omits footer params when no footer is provided", () => {
    const adapter = new CompanionAdapter()
    const url = adapter.getDeepLinkUrl(emptyEscpos, {
      receipt: {
        amount: "5,000 sats",
        merchant: "alice",
        paymentHash: "abc123",
      },
    })

    const p = parse(url)
    expect(p.get("app")).toBe("payment")
    expect(p.has("footerHeading")).toBe(false)
    expect(p.has("footerText")).toBe(false)
    expect(p.has("footerCaption")).toBe(false)
    expect(p.has("footerQr")).toBe(false)
  })

  it("caps an over-long footer text", () => {
    const adapter = new CompanionAdapter()
    const long = "word ".repeat(100) // 500 chars
    const url = adapter.getDeepLinkUrl(emptyEscpos, {
      receipt: {
        amount: "5,000 sats",
        footer: { text: long },
      },
    })

    const p = parse(url)
    const text = p.get("footerText") || ""
    expect(text.length).toBeLessThanOrEqual(160)
    expect(text.endsWith("…")).toBe(true)
  })
})
