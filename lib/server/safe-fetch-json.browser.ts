/**
 * Browser build of safe-fetch-json (swapped in for client bundles by
 * next.config.js). Requests made from the user's browser are not an SSRF risk
 * and node:https / node:dns are unavailable there, so this uses window.fetch
 * while keeping the same API and https-only / size-cap / error semantics.
 * Server code always gets ./safe-fetch-json.ts.
 */

const DEFAULT_MAX_BODY_BYTES = 16 * 1024
const DEADLINE_MS = 15_000

export class SafeFetchError extends Error {}

export type SafeFetchJsonOptions = { maxBodyBytes?: number }

type SafeFetchJsonResponse = { data: unknown; url: string }

export const safeFetchJsonResponse = async (
  input: string,
  { maxBodyBytes = DEFAULT_MAX_BODY_BYTES }: SafeFetchJsonOptions = {},
): Promise<SafeFetchJsonResponse> => {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new SafeFetchError("invalid URL")
  }
  if (url.protocol !== "https:") throw new SafeFetchError("only https URLs are allowed")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS)
  try {
    let response: Response
    try {
      response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
    } catch {
      throw new SafeFetchError(
        controller.signal.aborted
          ? "upstream request timed out"
          : "upstream request failed",
      )
    }
    if (!response.ok)
      throw new SafeFetchError(`upstream returned HTTP ${response.status}`)

    const text = await response.text()
    if (text.length > maxBodyBytes) throw new SafeFetchError("response too large")
    try {
      return { data: JSON.parse(text), url: response.url || url.toString() }
    } catch {
      throw new SafeFetchError("invalid JSON from upstream")
    }
  } finally {
    clearTimeout(timer)
  }
}

export const safeFetchJson = async (
  input: string,
  options?: SafeFetchJsonOptions,
): Promise<unknown> => (await safeFetchJsonResponse(input, options)).data
