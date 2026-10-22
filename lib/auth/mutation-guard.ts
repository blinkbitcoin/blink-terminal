/**
 * Mutation guard for cookie-authenticated routes (PR #92 review).
 *
 * Session auth moved network mutations from an explicit header to ambient
 * cookie authority. The cookie is SameSite=Lax, but SameSite is a *site*
 * boundary: a compromised same-site sibling origin can still get a browser to
 * attach this host's cookie to a cross-origin POST. Two checks close that:
 *
 * 1. `Content-Type: application/json` — HTML forms can only send
 *    urlencoded/multipart/plain, and a cross-origin JSON fetch needs a CORS
 *    preflight these routes never grant.
 * 2. `Origin` host must equal the request host — the origin-level write
 *    boundary SameSite does not provide.
 *
 * These routes are browser-only (only components/Network.tsx calls them), so
 * a missing Origin is rejected rather than tolerated.
 */

import type { NextApiRequest, NextApiResponse } from "next"

/** True if the request may mutate; otherwise the rejection was sent. */
export function requireTrustedMutation(
  req: NextApiRequest,
  res: NextApiResponse,
): boolean {
  const contentType = ((req.headers["content-type"] as string | undefined) ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase()
  if (contentType !== "application/json") {
    res.status(415).json({
      success: false,
      error: "Mutations require Content-Type: application/json",
    })
    return false
  }

  const origin = req.headers.origin
  const host = (
    (req.headers["x-forwarded-host"] as string | undefined) ??
    (req.headers.host as string | undefined)
  )
    ?.split(",")[0]
    .trim()
    .toLowerCase()

  let originHost: string | null = null
  try {
    originHost = origin ? new URL(origin).host.toLowerCase() : null
  } catch (_err: unknown) {
    originHost = null
  }

  if (!origin || !host || originHost !== host) {
    res.status(403).json({ success: false, error: "Untrusted request origin" })
    return false
  }

  return true
}
