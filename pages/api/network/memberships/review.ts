/**
 * Membership Review API - Approve or reject membership applications
 *
 * POST: Review a membership application (approve/reject)
 */

import type { NextApiRequest, NextApiResponse } from "next"

import * as db from "../../../../lib/network/db"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const reviewerNpub = req.headers["x-user-npub"] as string | undefined

  if (!reviewerNpub) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
    })
  }

  const { applicationId, action, rejectionReason } = req.body as {
    applicationId: string
    action: string
    rejectionReason?: string
  }

  if (!applicationId) {
    return res.status(400).json({
      success: false,
      error: "Application ID is required",
    })
  }

  if (!action || !["approve", "reject"].includes(action)) {
    return res.status(400).json({
      success: false,
      error: 'Action must be "approve" or "reject"',
    })
  }

  try {
    // Get the application (membership record)
    const membership = await db.query(
      "SELECT cm.*, c.leader_npub, c.name as community_name FROM community_memberships cm JOIN communities c ON c.id = cm.community_id WHERE cm.id = $1",
      [applicationId],
    )

    if (!membership.rows || membership.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Application not found",
      })
    }

    const application = membership.rows[0]

    if (application.status !== "pending") {
      return res.status(400).json({
        success: false,
        error: `Application has already been ${application.status}`,
      })
    }

    // Check if reviewer has permission for this community
    const isSuperAdmin = await db.isSuperAdmin(reviewerNpub)
    const isCommunityLeader = application.leader_npub === reviewerNpub
    const hasPermission = isSuperAdmin || isCommunityLeader

    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: "You do not have permission to review applications for this community",
      })
    }

    // Update application status
    const approved = action === "approve"
    const updatedMembership = await db.reviewApplication(
      applicationId,
      reviewerNpub,
      approved,
      rejectionReason ?? null,
    )

    if (!updatedMembership) {
      return res.status(500).json({
        success: false,
        error: "Failed to update application",
      })
    }

    console.log(
      `[Review] Application ${applicationId} ${updatedMembership.status} by ${reviewerNpub.substring(0, 20)}...`,
    )

    return res.status(200).json({
      success: true,
      message: approved ? "Member approved successfully!" : "Application rejected",
      membership: updatedMembership,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error reviewing application:", message)
    return res.status(500).json({
      success: false,
      error: "Failed to review application",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "network/memberships/review")
