/**
 * Tests for the orange-pill footer rendering in ReceiptBuilder.
 */

import ReceiptBuilder, { type ReceiptData } from "../../lib/escpos/ReceiptBuilder"

/**
 * Decode the printable text out of an ESC/POS byte stream, skipping command
 * sequences (ESC ... and GS ...) so command parameter bytes that happen to be
 * printable (e.g. 'E' = 0x45 in `ESC E n`) don't leak into the decoded text.
 *
 * This is a pragmatic decoder covering only the commands ReceiptBuilder emits.
 */
function decodeText(bytes: Uint8Array): string {
  let out = ""
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]

    if (b === 0x1b) {
      // ESC commands.
      const cmd = bytes[i + 1]
      switch (cmd) {
        case 0x40: // ESC @ (initialize)
          i += 2
          break
        case 0x61: // ESC a n (align)
        case 0x45: // ESC E n (bold)
        case 0x2d: // ESC - n (underline)
        case 0x4d: // ESC M n (font)
        case 0x64: // ESC d n (feed lines)
        case 0x4a: // ESC J n (feed dots)
          i += 3
          break
        default:
          i += 2
      }
      continue
    }

    if (b === 0x1d) {
      // GS commands.
      const cmd = bytes[i + 1]
      if (cmd === 0x21 || cmd === 0x42) {
        // GS ! n (text size), GS B n (invert)
        i += 3
        continue
      }
      if (cmd === 0x56) {
        // GS V m (cut)
        i += 3
        continue
      }
      if (cmd === 0x28 && bytes[i + 2] === 0x6b) {
        // GS ( k — QR code function. pL pH at i+3,i+4 give the payload length.
        const pL = bytes[i + 3]
        const pH = bytes[i + 4]
        const len = pL + pH * 256
        i += 5 + len
        continue
      }
      // Unknown GS command: skip the 2-byte prefix.
      i += 2
      continue
    }

    if (b === 0x0a) {
      out += "\n"
    } else if (b >= 0x20 && b < 0x7f) {
      out += String.fromCharCode(b)
    }
    i += 1
  }
  return out
}

const baseReceipt: ReceiptData = {
  amount: "5,000 sats ($50.00)",
  merchant: "alice",
  memo: "coffee",
  paymentHash: "787ec76dcafd20c1908eb0936a12f",
  timestamp: Date.UTC(2026, 0, 3, 12, 0, 0),
}

describe("ReceiptBuilder footer", () => {
  it("omits footer content when no footer is provided", () => {
    const bytes = ReceiptBuilder.createStandard(baseReceipt, { showLogo: false })
    const text = decodeText(bytes)
    expect(text).toContain("Thank You!")
    expect(text).not.toContain("On this day")
  })

  it("renders heading, body and caption for an event footer", () => {
    const receipt: ReceiptData = {
      ...baseReceipt,
      footer: {
        heading: "On this day, 2009:",
        lines: ["Genesis Block is mined by Satoshi Nakamoto"],
        qr: "https://example.com/genesis",
        caption: "Read: Bitcoin is Time - Gigi",
      },
    }
    const bytes = ReceiptBuilder.createStandard(receipt, { showLogo: false })
    const text = decodeText(bytes)
    expect(text).toContain("On this day, 2009:")
    expect(text).toContain("Genesis Block")
    expect(text).toContain("Read: Bitcoin is Time")
    // Footer must come before the Thank You line.
    expect(text.indexOf("On this day")).toBeLessThan(text.indexOf("Thank You!"))
  })

  it("wraps long body text to the paper width (80mm = 48 cols)", () => {
    const long =
      "Bitcoin is a way to start and fight a political revolution without shooting any bullet and without casting any vote"
    const receipt: ReceiptData = {
      ...baseReceipt,
      footer: { lines: [`"${long}"`], caption: "- Giacomo Zucco" },
    }
    const bytes = ReceiptBuilder.createStandard(receipt, {
      showLogo: false,
      paperWidth: 80,
    })
    const text = decodeText(bytes)
    // Every printed footer line must fit within 48 chars.
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(48)
    }
    expect(text).toContain("Giacomo Zucco")
  })

  it("emits QR code command bytes when qr is set", () => {
    const receipt: ReceiptData = {
      ...baseReceipt,
      footer: { lines: ["Learn more"], qr: "https://www.blink.sv" },
    }
    const bytes = ReceiptBuilder.createStandard(receipt, { showLogo: false })
    // GS ( k  =  0x1d 0x28 0x6b  (QR store/print sequence)
    let found = false
    for (let i = 0; i < bytes.length - 2; i++) {
      if (bytes[i] === 0x1d && bytes[i + 1] === 0x28 && bytes[i + 2] === 0x6b) {
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })

  it("hard-splits an over-long unbroken token", () => {
    const longToken = "x".repeat(120)
    const receipt: ReceiptData = {
      ...baseReceipt,
      footer: { lines: [longToken] },
    }
    const bytes = ReceiptBuilder.createStandard(receipt, {
      showLogo: false,
      paperWidth: 58,
    })
    const text = decodeText(bytes)
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(32)
    }
  })
})
