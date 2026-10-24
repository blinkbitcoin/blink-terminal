/**
 * Whitelist Check API - Check user's role in the network
 *
 * GET: Check if the authenticated user is:
 *      - Super admin (can create communities, whitelist leaders)
 *      - Whitelisted leader (can manage their community)
 *      - Regular user
 */

import type { NextApiRequest, NextApiResponse } from "next"

import { requireSessionNpub } from "../../../../lib/auth/session-pubkey"
import * as db from "../../../../lib/network/db"
import { withRateLimit, RATE_LIMIT_READ } from "../../../../lib/rate-limit"

// Roles come from the database (super_admins, community_leader_whitelist),
// the same source every /api/network route authorizes against
// (blink-wip#1679). A hard-coded copy here had drifted: leaders added by
// later migrations were reported as plain users, hiding leader features the
// API would allow.

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  // Identity comes from the verified Nostr session only (blink-wip#1679) —
  // the unsigned X-User-Npub header is no longer accepted.
  const userNpub = requireSessionNpub(req, res)
  if (!userNpub) return

  try {
    const [isSuperAdmin, isWhitelistedLeader] = await Promise.all([
      db.isSuperAdmin(userNpub),
      db.isLeaderWhitelisted(userNpub),
    ])

    // Super admin is also considered whitelisted (can do everything)
    const isWhitelisted = isSuperAdmin || isWhitelistedLeader

    return res.status(200).json({
      success: true,
      isSuperAdmin,
      isWhitelisted,
      role: isSuperAdmin
        ? "super_admin"
        : isWhitelistedLeader
          ? "community_leader"
          : "user",
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error checking whitelist:", message)
    return res.status(500).json({
      success: false,
      error: "Failed to check whitelist status",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "network/whitelist/check")
