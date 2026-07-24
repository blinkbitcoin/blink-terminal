import type { NextApiRequest, NextApiResponse } from "next"

import * as boltcard from "../../../lib/boltcard"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"

/**
 * API endpoint for Boltcard statistics
 *
 * GET /api/boltcard/stats
 *
 * Returns aggregate statistics about all boltcards
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const stats = await boltcard.store.getStats()

    // Get pending top-ups count
    const pendingTopUps = await boltcard.lnurlp.getAllPendingTopUps()

    res.status(200).json({
      success: true,
      stats: {
        ...stats,
        pendingTopUps: pendingTopUps.length,
      },
      timestamp: Date.now(),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Boltcard stats error:", error)
    res.status(500).json({
      error: "Failed to get stats",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "boltcard/stats")
