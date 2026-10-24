/** @jest-environment node */

/**
 * PNG decode-cost guard for /api/paycode/pdf (blink-wip#1664).
 *
 * The renderer's PNG parser (png-js via @react-pdf/image / pdfkit) trusts
 * chunk lengths — `read(len)` is `new Array(len)` — and inflates IDAT with no
 * limit. A 41-byte PNG (IHDR 1x1, then a PLTE header claiming 20,000,000
 * bytes that are not there) exhausts the heap. lib/pdf/png-guard.js only
 * lets a structurally valid PNG through whose pixels inflate to exactly the
 * declared, bounded size.
 *
 * The second block runs the REAL production renderer in a child process with
 * a 64 MB heap (it is ESM and cannot load in jest): the reviewer's payload
 * kills it without the guard, the guard rejects every malformed payload, and
 * every image the guard accepts renders.
 */
import { spawnSync } from "child_process"
import path from "path"
import zlib from "zlib"

import { toDataURL } from "qrcode"

import { checkPngDataUrl } from "../../lib/pdf/png-guard"

import { SIGNATURE, chunk, dataUrl, ihdr, rgbaPng } from "./png-fixtures"

const IEND = chunk("IEND")
const whiteRgbaIdat = (w: number, h: number) => {
  const row = Buffer.alloc(1 + w * 4, 0xff)
  row[0] = 0
  return chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(h).fill(row))))
}

/** The reviewer's payload: IHDR 1x1, then a PLTE header claiming 20 MB that is absent. */
const reviewerPayload = (() => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(20_000_000, 0)
  head.write("PLTE", 4, "latin1")
  return Buffer.concat([SIGNATURE, ihdr(1, 1), head])
})()

const MALFORMED: [string, Buffer][] = [
  ["the reviewer's 41-byte PNG (PLTE claims 20 MB that is absent)", reviewerPayload],
  [
    "IDAT claiming 20 MB (pushed byte by byte)",
    Buffer.concat([
      SIGNATURE,
      ihdr(1, 1),
      chunk("IDAT", Buffer.alloc(4), 20_000_000).subarray(0, 12),
    ]),
  ],
  [
    "tEXt claiming 20 MB",
    Buffer.concat([
      SIGNATURE,
      ihdr(1, 1),
      chunk("tEXt", Buffer.alloc(4), 20_000_000).subarray(0, 12),
    ]),
  ],
  [
    "1x1 image with an IDAT decompression bomb (~50 MB of pixels)",
    Buffer.concat([
      SIGNATURE,
      ihdr(1, 1),
      chunk("IDAT", zlib.deflateSync(Buffer.alloc(50 * 1024 * 1024))),
      IEND,
    ]),
  ],
  ["missing IEND", Buffer.concat([SIGNATURE, ihdr(1, 1), whiteRgbaIdat(1, 1)])],
  ["bytes after IEND", Buffer.concat([rgbaPng(1, 1), Buffer.from("trailing")])],
  [
    "bad CRC",
    (() => {
      const b = rgbaPng(1, 1)
      b[b.length - 13] ^= 0xff // last byte of the IDAT CRC
      return b
    })(),
  ],
  [
    "IDAT shorter than declared pixels",
    Buffer.concat([SIGNATURE, ihdr(2, 2), whiteRgbaIdat(1, 1), IEND]),
  ],
  [
    "interlaced",
    Buffer.concat([SIGNATURE, ihdr(1, 1, { interlace: 1 }), whiteRgbaIdat(1, 1), IEND]),
  ],
  [
    "invalid bit depth for RGBA",
    Buffer.concat([SIGNATURE, ihdr(1, 1, { bitDepth: 4 }), whiteRgbaIdat(1, 1), IEND]),
  ],
  [
    "indexed without PLTE",
    Buffer.concat([SIGNATURE, ihdr(1, 1, { colorType: 3 }), whiteRgbaIdat(1, 1), IEND]),
  ],
  ["no IDAT", Buffer.concat([SIGNATURE, ihdr(1, 1), IEND])],
  ["IHDR not first", Buffer.concat([SIGNATURE, whiteRgbaIdat(1, 1), ihdr(1, 1), IEND])],
  ["1025 px wide", rgbaPng(1025, 1)],
]

let clientQr: string
beforeAll(async () => {
  // Exactly what components/PublicPOS/PrintPaycodeView.tsx produces (minus the logo).
  clientQr = await toDataURL(
    "HTTPS://TERMINAL.BLINKBTC.COM/ALICE?LIGHTNING=LNURL1DP68GURN8GHJ7",
    {
      width: 400,
      margin: 2,
      errorCorrectionLevel: "H",
    },
  )
})

describe("checkPngDataUrl", () => {
  it("accepts the client's QR and valid PNG images up to the size limit", () => {
    expect(checkPngDataUrl(clientQr)).toEqual({ ok: true, width: 400, height: 400 })
    expect(checkPngDataUrl(dataUrl(rgbaPng(1024, 1024)))).toEqual({
      ok: true,
      width: 1024,
      height: 1024,
    })
    expect(checkPngDataUrl(dataUrl(rgbaPng(1, 1)))).toEqual({
      ok: true,
      width: 1,
      height: 1,
    })
  })

  it("the reviewer's payload is the 41-byte / 78-char image from the review", () => {
    expect(reviewerPayload.length).toBe(41)
    expect(dataUrl(reviewerPayload).length).toBe(78)
  })

  it.each(MALFORMED)("rejects %s", (_name, png) => {
    expect(checkPngDataUrl(dataUrl(png)).ok).toBe(false)
  })

  it("rejects non-PNG and oversized data URLs", () => {
    expect(checkPngDataUrl("data:image/jpeg;base64,/9j/4AAQ").ok).toBe(false)
    expect(checkPngDataUrl("https://example.com/qr.png").ok).toBe(false)
    expect(checkPngDataUrl(42).ok).toBe(false)
    expect(checkPngDataUrl(dataUrl(rgbaPng(1, 1)), { maxDataUrlLength: 10 }).ok).toBe(
      false,
    )
  })
})

describe("the real renderer (child process, 64 MB heap)", () => {
  const render = (png: string, guard: boolean) => {
    const out = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=64",
        path.join(process.cwd(), "scripts", "png-render-probe.mjs"),
      ],
      {
        input: JSON.stringify({ dataUrl: png, guard }),
        encoding: "utf8",
        timeout: 60_000,
      },
    )
    const line = out.stdout.trim().split("\n").pop() || ""
    let result: Record<string, unknown> = {}
    try {
      result = JSON.parse(line)
    } catch {
      // crashed before printing
    }
    return { status: out.status, signal: out.signal, stderr: out.stderr, result }
  }

  it("control: without the guard, the reviewer's payload kills the renderer (heap OOM)", () => {
    const r = render(dataUrl(reviewerPayload), false)
    expect(r.result.rendered).toBeUndefined()
    expect(r.status === 0 && !r.signal).toBe(false)
    expect(r.stderr).toMatch(/heap/i)
  })

  it.each(MALFORMED)("with the guard: %s is rejected before rendering", (_name, png) => {
    const r = render(dataUrl(png), true)
    expect(r.status).toBe(0)
    expect(r.result.guard).toBe("rejected")
  })

  it("every accepted image renders: the client's QR and a 1024x1024 RGBA PNG", () => {
    for (const png of [clientQr, dataUrl(rgbaPng(1024, 1024))]) {
      const r = render(png, true)
      expect(r.status).toBe(0)
      expect(r.result.rendered).toBeGreaterThan(1000)
    }
  })
})
