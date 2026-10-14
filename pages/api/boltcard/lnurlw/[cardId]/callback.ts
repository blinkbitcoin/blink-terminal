import type { NextApiRequest, NextApiResponse } from "next"

import * as boltcard from "../../../../../lib/boltcard"
import { isBoltcardSpendEnabled } from "../../../../../lib/config/features"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../../../lib/rate-limit"

/**
 * LNURL-withdraw callback endpoint
 *
 * POST /api/boltcard/lnurlw/[cardId]/callback
 *
 * Called by wallet to submit an invoice after LNURL-withdraw scan
 *
 * Query/Body parameters:
 * - k1: single-use session returned by the verified tap (required)
 * - pr: BOLT11 invoice to pay (at most the tap-time maximum)
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isBoltcardSpendEnabled()) {
    return res.status(503).json({
      status: "ERROR",
      reason: "Bolt Card payments are temporarily unavailable",
    })
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ status: "ERROR", reason: "Method not allowed" })
  }

  const cardId = req.query.cardId as string | undefined

  if (!cardId) {
    return res.status(400).json({ status: "ERROR", reason: "Missing cardId" })
  }

  try {
    // LNURL-withdraw callback parameters (LUD-03, query or body). k1 is the
    // single-use session from the verified tap — required.
    const k1 = firstString(req.query.k1) ?? firstString(req.body?.k1)
    const pr = firstString(req.query.pr) ?? firstString(req.body?.pr)

    if (!pr) {
      return res.status(400).json({
        status: "ERROR",
        reason: "Missing invoice (pr parameter)",
      })
    }

    const response = await boltcard.lnurlw.handleWithdrawCallback(cardId, k1, pr)

    return res.status(response.status === "OK" ? 200 : 400).json(response)
  } catch (error: unknown) {
    console.error("❌ LNURL-withdraw callback error:", error)
    return res.status(500).json({
      status: "ERROR",
      reason: "Internal server error",
    })
  }
}

const firstString = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined

export default withRateLimit(
  handler,
  RATE_LIMIT_WRITE,
  "boltcard/lnurlw/[cardId]/callback",
)
