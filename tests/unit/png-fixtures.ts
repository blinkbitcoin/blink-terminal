/**
 * Real PNG builders for the paycode PDF tests (blink-wip#1664): valid images
 * and the malformed ones the renderer's parser cannot survive.
 */
import zlib from "zlib"

export const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** One chunk with a correct CRC (or a declared length that differs from the data). */
export const chunk = (
  type: string,
  data: Buffer = Buffer.alloc(0),
  declaredLength = data.length,
) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(declaredLength)
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(body))
  return Buffer.concat([len, body, crc])
}

export const ihdr = (
  width: number,
  height: number,
  { bitDepth = 8, colorType = 6, interlace = 0 } = {},
) => {
  const d = Buffer.alloc(13)
  d.writeUInt32BE(width, 0)
  d.writeUInt32BE(height, 4)
  d[8] = bitDepth
  d[9] = colorType
  d[12] = interlace
  return chunk("IHDR", d)
}

/** A valid 8-bit RGBA PNG (white), as raw bytes. */
export const rgbaPng = (width: number, height: number) => {
  const row = Buffer.alloc(1 + width * 4, 0xff)
  row[0] = 0
  const raw = Buffer.alloc(row.length * height)
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length)
  return Buffer.concat([
    SIGNATURE,
    ihdr(width, height),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND"),
  ])
}

export const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`

/** 1x1 RGBA whose single scanline uses filter type 5 (valid are 0..4): png-js throws asynchronously. */
export const badFilterPng = () =>
  Buffer.concat([
    SIGNATURE,
    ihdr(1, 1),
    chunk("IDAT", zlib.deflateSync(Buffer.from([5, 255, 255, 255, 255]))),
    chunk("IEND"),
  ])

/** IHDR 1x1, then a PLTE header claiming 20,000,000 bytes that are absent (41 bytes). */
export const forgedPlteLength = () => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(20_000_000, 0)
  head.write("PLTE", 4, "latin1")
  return Buffer.concat([SIGNATURE, ihdr(1, 1), head])
}
