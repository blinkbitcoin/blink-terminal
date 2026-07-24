/**
 * Pending Applications API - Get pending applications for a community
 *
 * GET: Get all pending applications for communities the user leads
 */

import type { NextApiRequest, NextApiResponse } from "next"

import type { MembershipRow } from "../../../../lib/network/db"
import * as db from "../../../../lib/network/db"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const userNpub = req.headers["x-user-npub"] as string | undefined
  const { communityId } = req.query as { communityId?: string }

  if (!userNpub) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
    })
  }

  try {
    const isSuperAdmin = await db.isSuperAdmin(userNpub)

    // If specific community requested
    if (communityId) {
      // Get the community to check if user is the leader
      const community = await db.getCommunityById(communityId)

      if (!community) {
        return res.status(404).json({
          success: false,
          error: "Community not found",
        })
      }

      const isLeader = community.leader_npub === userNpub
      const hasAccess = isSuperAdmin || isLeader

      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          error: "You do not have access to view applications for this community",
        })
      }

      const applications = await db.getPendingApplications(communityId)
      return res.status(200).json({
        success: true,
        applications,
      })
    }

    // No specific community - return all accessible applications
    let applications: MembershipRow[] = []

    if (isSuperAdmin) {
      // Super admin sees all pending applications across all communities
      const allCommunities = await db.listCommunities()
      for (const community of allCommunities) {
        const pending = await db.getPendingApplications(community.id)
        applications = applications.concat(pending)
      }
    } else {
      // Leader sees their community's applications
      const allCommunities = await db.listCommunities()
      for (const community of allCommunities) {
        if (community.leader_npub === userNpub) {
          const pending = await db.getPendingApplications(community.id)
          applications = applications.concat(pending)
        }
      }
    }

    return res.status(200).json({
      success: true,
      applications,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error fetching pending applications:", message)
    return res.status(500).json({
      success: false,
      error: "Failed to fetch pending applications",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "network/memberships/pending")
