import zlib from "zlib"

import { test, expect } from "@playwright/test"

/**
 * /api/paycode/pdf against the real app and the real PDF renderer
 * (blink-wip#1664). The renderer's PNG parser (png-js) cannot survive
 * malformed images: a forged chunk length exhausts the heap, and a bad
 * scanline filter throws from an async callback, leaving the request
 * hanging. The route builds the QR itself and ignores any qrDataUrl, so
 * these payloads must get a normal PDF back, promptly.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const chunk = (type: string, data: Buffer = Buffer.alloc(0)) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(body))
  return Buffer.concat([len, body, crc])
}
const ihdr1x1 = () => {
  const d = Buffer.alloc(13)
  d.writeUInt32BE(1, 0)
  d.writeUInt32BE(1, 4)
  d[8] = 8
  d[9] = 6
  return chunk("IHDR", d)
}
const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`

const PAYLOADS: [string, string][] = [
  [
    "scanline filter 5 (async throw)",
    dataUrl(
      Buffer.concat([
        SIGNATURE,
        ihdr1x1(),
        chunk("IDAT", zlib.deflateSync(Buffer.from([5, 255, 255, 255, 255]))),
        chunk("IEND"),
      ]),
    ),
  ],
  [
    "PLTE claiming 20 MB (heap OOM)",
    (() => {
      const head = Buffer.alloc(8)
      head.writeUInt32BE(20_000_000, 0)
      head.write("PLTE", 4, "latin1")
      return dataUrl(Buffer.concat([SIGNATURE, ihdr1x1(), head]))
    })(),
  ],
]

test.describe("Paycode PDF (real renderer)", () => {
  test("renders the paycode the app requests", async ({ request }) => {
    const res = await request.post("/api/paycode/pdf", {
      data: { username: "e2e_paycode", environment: "staging" },
      timeout: 15_000,
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Buffer.from(body.pdf, "base64").subarray(0, 5).toString()).toBe("%PDF-")
    expect(body.lightningAddress).toMatch(/^e2e_paycode@/)
  })

  for (const [name, qrDataUrl] of PAYLOADS) {
    test(`a malformed caller PNG is ignored, not rendered: ${name}`, async ({
      request,
    }) => {
      const res = await request.post("/api/paycode/pdf", {
        data: { username: "e2e_paycode", environment: "staging", qrDataUrl },
        timeout: 15_000,
      })
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(Buffer.from(body.pdf, "base64").subarray(0, 5).toString()).toBe("%PDF-")

      // The server still serves the next request (no crash, no wedged process).
      const next = await request.post("/api/paycode/pdf", {
        data: { username: "e2e_paycode", environment: "staging" },
        timeout: 15_000,
      })
      expect(next.status()).toBe(200)
    })
  }
})
