/**
 * Membership Application API - Apply to join a community
 *
 * POST: Submit an application to join a community
 */

import type { NextApiRequest, NextApiResponse } from "next"

import * as db from "../../../../lib/network/db"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const userNpub = req.headers["x-user-npub"] as string | undefined
  const userPubkeyHex = req.headers["x-user-pubkey"] as string | undefined

  if (!userNpub) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
    })
  }

  const { communityId, applicationNote } = req.body as {
    communityId: string
    applicationNote?: string
  }

  if (!communityId) {
    return res.status(400).json({
      success: false,
      error: "Community ID is required",
    })
  }

  try {
    // Check if user already has a membership for this community
    const existingMembership = await db.getMembership(communityId, userNpub)
    if (existingMembership && existingMembership.status === "pending") {
      return res.status(409).json({
        success: false,
        error: "You already have a pending application for this community",
        existingApplication: existingMembership,
      })
    }

    if (existingMembership && existingMembership.status === "approved") {
      return res.status(409).json({
        success: false,
        error: "You are already a member of this community",
        membership: existingMembership,
      })
    }

    console.log("Membership application received:", {
      communityId,
      userNpub: userNpub.substring(0, 20) + "...",
      applicationNote: applicationNote?.substring(0, 50),
    })

    // Create the application
    const membership = await db.applyToJoinCommunity(
      communityId,
      userNpub,
      userPubkeyHex ?? "",
      applicationNote ?? null,
    )

    return res.status(200).json({
      success: true,
      message:
        "Application submitted successfully. The community leader will review your request.",
      membership: {
        id: membership.id,
        community_id: membership.community_id,
        user_npub: membership.user_npub,
        status: membership.status,
        application_note: membership.application_note,
        applied_at: membership.applied_at,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error submitting application:", message)
    return res.status(500).json({
      success: false,
      error: "Failed to submit application",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "network/memberships/apply")
