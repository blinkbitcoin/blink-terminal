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
