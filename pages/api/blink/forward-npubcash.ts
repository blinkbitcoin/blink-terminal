import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"

/**
 * npub.cash is no longer available. The route stays so old clients get a
 * clear refusal instead of a fetch.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  return res.status(410).json({ error: "npub.cash is no longer available" })
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "blink/forward-npubcash")
