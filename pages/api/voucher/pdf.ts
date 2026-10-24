import type { NextApiRequest, NextApiResponse } from "next"

/**
 * Voucher PDF Generation API — DISABLED.
 *
 * This route rendered caller-supplied `qrDataUrl` / `logoDataUrl` values as
 * react-pdf `<Image src>`. react-pdf fetches non-data `src` values server-side
 * (including `{ uri, method, headers, body }` objects), which made the route an
 * unauthenticated server-side request forgery (SSRF).
 *
 * The route stays off until it is re-reviewed. Re-enabling it requires, at
 * minimum, strict data-URL validation of every image field (see
 * `lib/pdf/safe-image-src.ts`) and egress restrictions on the terminal pods.
 * The original implementation is in git history.
 */
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store")
  return res.status(503).json({
    error: "Voucher PDF generation is temporarily disabled",
  })
}

// Never parse (or buffer) the request body.
export const config = {
  api: {
    bodyParser: false,
  },
}
