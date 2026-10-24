/**
 * Guard for react-pdf `<Image src>` values.
 *
 * react-pdf fetches any non-data `src` server-side — plain URLs and
 * `{ uri, method, headers, body }` objects alike — so a caller-controlled
 * `src` is an SSRF. Only inline base64 PNG/JPEG/WebP data URLs are accepted.
 */
export const IMAGE_DATA_URL_REGEX =
  /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/

export const isSafeImageDataUrl = (value: unknown): value is string =>
  typeof value === "string" && IMAGE_DATA_URL_REGEX.test(value)

/** Returns `value` if it is a safe inline image data URL, otherwise `undefined`. */
export const safeImageSrc = (value: unknown): string | undefined =>
  isSafeImageDataUrl(value) ? value : undefined

/**
 * Width/height from a PNG data URL's IHDR header, or null if it is not a
 * well-formed PNG. Lets callers bound decode cost before rendering: a tiny,
 * highly compressible PNG can declare huge dimensions (decompression bomb).
 */
export const pngDataUrlDimensions = (
  value: string,
): { width: number; height: number } | null => {
  const prefix = "data:image/png;base64,"
  if (!value.startsWith(prefix)) return null
  // Signature (8) + IHDR length/type (8) + width (4) + height (4) = 24 bytes.
  const head = Buffer.from(value.slice(prefix.length, prefix.length + 32), "base64")
  if (
    head.length < 24 ||
    head.readUInt32BE(0) !== 0x89504e47 ||
    head.readUInt32BE(4) !== 0x0d0a1a0a ||
    head.toString("latin1", 12, 16) !== "IHDR"
  ) {
    return null
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}
