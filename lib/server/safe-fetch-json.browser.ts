/**
 * Browser build of safe-fetch-json (swapped in for client bundles by
 * next.config.js). Requests made from the user's browser are not an SSRF risk
 * and node:https / node:dns are unavailable there, so this uses window.fetch
 * while keeping the same API, error codes and https-only / byte-size-cap
 * semantics. Server code always gets ./safe-fetch-json.ts.
 *
 * Intentional differences from the server build:
 * - No private-address check / DNS pinning (the browser is the client's own
 *   network position; there is nothing to protect).
 * - Redirects are followed by the browser (its own redirect limit applies);
 *   the final URL must still be https.
 * - The single deadline covers the whole request (no separate per-hop timeout);
 *   it is reported as TIMEOUT so callers retry it like a server socket timeout.
 */

const DEFAULT_MAX_BODY_BYTES = 16 * 1024
const DEADLINE_MS = 15_000

export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "NOT_HTTPS"
  | "BLOCKED_ADDRESS"
  | "REDIRECT"
  | "HTTP_STATUS"
  | "TOO_LARGE"
  | "INVALID_JSON"
  | "TIMEOUT"
  | "DEADLINE"
  | "NETWORK"

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode

  constructor(message: string, code: SafeFetchErrorCode) {
    super(message)
    this.name = "SafeFetchError"
    this.code = code
  }
}

export type SafeFetchJsonOptions = { maxBodyBytes?: number }

type SafeFetchJsonResponse = { data: unknown; url: string }

const parseHttpsUrl = (input: string): URL => {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new SafeFetchError("invalid URL", "INVALID_URL")
  }
  if (url.protocol !== "https:") {
    throw new SafeFetchError("only https URLs are allowed", "NOT_HTTPS")
  }
  return url
}

/** Browser builds do not DNS-check. Server builds reject non-public hosts. */
export const resolvePublicAddresses = async (
  _hostname: string,
): Promise<Array<{ address: string; family: number }>> => []

export const assertPublicHostname = async (_hostname: string): Promise<void> => {}

export const safeFetchJsonResponse = async (
  input: string,
  { maxBodyBytes = DEFAULT_MAX_BODY_BYTES }: SafeFetchJsonOptions = {},
): Promise<SafeFetchJsonResponse> => {
  const url = parseHttpsUrl(input)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS)
  try {
    let response: Response
    try {
      response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        redirect: "follow",
        signal: controller.signal,
      })
    } catch {
      throw controller.signal.aborted
        ? new SafeFetchError("upstream request timed out", "TIMEOUT")
        : new SafeFetchError("upstream request failed", "NETWORK")
    }

    const finalUrl = response.url || url.toString()
    if (!finalUrl.startsWith("https:")) {
      throw new SafeFetchError("only https URLs are allowed", "NOT_HTTPS")
    }

    if (!response.ok) {
      throw new SafeFetchError(`upstream returned HTTP ${response.status}`, "HTTP_STATUS")
    }

    const declaredLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      throw new SafeFetchError("response too large", "TOO_LARGE")
    }

    let body: ArrayBuffer
    try {
      body = await response.arrayBuffer()
    } catch {
      throw controller.signal.aborted
        ? new SafeFetchError("upstream request timed out", "TIMEOUT")
        : new SafeFetchError("upstream request failed", "NETWORK")
    }
    if (body.byteLength > maxBodyBytes) {
      throw new SafeFetchError("response too large", "TOO_LARGE")
    }

    try {
      return { data: JSON.parse(new TextDecoder().decode(body)), url: finalUrl }
    } catch {
      throw new SafeFetchError("invalid JSON from upstream", "INVALID_JSON")
    }
  } finally {
    clearTimeout(timer)
  }
}

export const safeFetchJson = async (
  input: string,
  options?: SafeFetchJsonOptions,
): Promise<unknown> => (await safeFetchJsonResponse(input, options)).data
