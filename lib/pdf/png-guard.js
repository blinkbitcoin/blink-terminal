/* eslint-disable @typescript-eslint/no-require-imports --
   CommonJS so scripts/png-render-probe.mjs (plain Node) runs this same code. */
/**
 * Strict PNG check for caller-supplied images, run before the PDF renderer
 * sees them (blink-wip#1664).
 *
 * The renderer's PNG parser (png-js, via @react-pdf/image and pdfkit) trusts
 * every chunk length: `read(len)` does `new Array(len)` and IDAT pushes `len`
 * bytes one by one, and only afterwards notices the file was shorter. A 78-char
 * data URL whose PLTE claims 20,000,000 bytes exhausts the heap. Its pixel
 * decoder also inflates all IDAT data regardless of the declared size, so a
 * 1x1 image can carry a decompression bomb.
 *
 * Accepted: a well-formed, non-interlaced PNG whose every chunk (length, type,
 * data, CRC) lies inside the bytes supplied, ending in IEND, whose IDAT inflates
 * to exactly the size the header declares. Plain JS so the render probe
 * (scripts/png-render-probe.mjs) runs this same code against the real renderer.
 */
const zlib = require("zlib")

const PREFIX = "data:image/png;base64,"
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** colour type -> [channels, allowed bit depths] (PNG spec, IHDR) */
const COLOR_TYPES = {
  0: [1, [1, 2, 4, 8, 16]], // greyscale
  2: [3, [8, 16]], // truecolour
  3: [1, [1, 2, 4, 8]], // indexed
  4: [2, [8, 16]], // greyscale + alpha
  6: [4, [8, 16]], // truecolour + alpha
}

const DEFAULTS = { maxSide: 1024, maxDataUrlLength: 256 * 1024 }

const reject = (reason) => ({ ok: false, reason })

/**
 * @param {unknown} dataUrl
 * @param {{ maxSide?: number, maxDataUrlLength?: number }} [limits]
 * @returns {{ ok: true, width: number, height: number } | { ok: false, reason: string }}
 */
function checkPngDataUrl(dataUrl, limits = {}) {
  const { maxSide, maxDataUrlLength } = { ...DEFAULTS, ...limits }
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PREFIX))
    return reject("not a PNG data URL")
  if (dataUrl.length > maxDataUrlLength) return reject("too large")
  const b64 = dataUrl.slice(PREFIX.length)
  if (!BASE64.test(b64)) return reject("invalid base64")
  const buf = Buffer.from(b64, "base64")
  if (buf.length < SIGNATURE.length || !buf.subarray(0, 8).equals(SIGNATURE)) {
    return reject("bad signature")
  }

  let header = null
  let palette = false
  let ended = false
  const idat = []
  let pos = 8
  while (pos < buf.length) {
    if (ended) return reject("data after IEND")
    if (pos + 12 > buf.length) return reject("truncated chunk")
    const length = buf.readUInt32BE(pos)
    const type = buf.toString("latin1", pos + 4, pos + 8)
    // Length, type, data and CRC must all be inside the supplied bytes.
    if (length > 0x7fffffff || pos + 12 + length > buf.length)
      return reject(`chunk ${type} overruns`)
    if (!/^[A-Za-z]{4}$/.test(type)) return reject("bad chunk type")
    const data = buf.subarray(pos + 8, pos + 8 + length)
    if (
      zlib.crc32(buf.subarray(pos + 4, pos + 8 + length)) !==
      buf.readUInt32BE(pos + 8 + length)
    ) {
      return reject(`chunk ${type} CRC mismatch`)
    }
    pos += 12 + length

    if (!header) {
      if (type !== "IHDR" || length !== 13) return reject("IHDR must come first")
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      }
      continue
    }
    if (type === "IHDR") return reject("duplicate IHDR")
    if (type === "PLTE") {
      if (length === 0 || length > 768 || length % 3 !== 0) return reject("bad PLTE")
      palette = true
    } else if (type === "IDAT") {
      idat.push(data)
    } else if (type === "IEND") {
      if (length !== 0) return reject("bad IEND")
      ended = true
    }
  }
  if (!header) return reject("missing IHDR")
  if (!ended) return reject("missing IEND")
  if (idat.length === 0) return reject("missing IDAT")

  const { width, height, bitDepth, colorType } = header
  if (width < 1 || height < 1 || width > maxSide || height > maxSide)
    return reject("bad dimensions")
  const spec = COLOR_TYPES[colorType]
  if (!spec || !spec[1].includes(bitDepth)) return reject("bad bit depth / colour type")
  if (header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
    return reject("unsupported compression / filter / interlace")
  }
  if (colorType === 3 && !palette) return reject("indexed PNG without PLTE")

  // Each row: one filter byte + the packed pixels. Inflate no further than
  // that: a decompression bomb stops at the limit instead of expanding.
  const expected = height * (1 + Math.ceil((width * spec[0] * bitDepth) / 8))
  let pixels
  try {
    pixels = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected })
  } catch {
    return reject("IDAT does not inflate to the declared size")
  }
  if (pixels.length !== expected)
    return reject("IDAT does not inflate to the declared size")

  return { ok: true, width, height }
}

module.exports = { checkPngDataUrl }
