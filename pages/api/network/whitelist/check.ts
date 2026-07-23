/**
 * Whitelist Check API - Check user's role in the network
 *
 * GET: Check if the authenticated user is:
 *      - Super admin (can create communities, whitelist leaders)
 *      - Whitelisted leader (can manage their community)
 *      - Regular user
 */

import type { NextApiRequest, NextApiResponse } from "next"

import { withRateLimit, RATE_LIMIT_READ } from "../../../../lib/rate-limit"

// Super admin - can create communities and whitelist new leaders
const SUPER_ADMIN_NPUB = "npub1flac02t5hw6jljk8x7mec22uq37ert8d3y3mpwzcma726g5pz4lsmfzlk6"

// Whitelisted community leaders
const WHITELISTED_LEADERS = [
  "npub1zkr064avsxmxzaasppamps86ge0npwvft9yu3ymgxmk9umx3xyeq9sk6ec", // Bitcoin Ekasi
  "npub1xxcyzef28e5qcjncwmn6z2nmwaezs2apxc2v2f7unnvxw3r5edfsactfly", // Bitcoin Victoria Falls
  "npub1kk20h7w79xd79nzm9fj9aqugwf57qpx0letx6rncfjecrhd4x4yqn7rq3x", // Bitbiashara - Nairobi, Kenya
]

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const userNpub = req.headers["x-user-npub"] as string | undefined

  if (!userNpub) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
    })
  }

  try {
    // Check role hierarchy
    const isSuperAdmin = userNpub === SUPER_ADMIN_NPUB
    const isWhitelistedLeader = WHITELISTED_LEADERS.includes(userNpub)

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
