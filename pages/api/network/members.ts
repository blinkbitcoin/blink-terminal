/**
 * Community Members API
 *
 * GET: Get all members of a community (leader only)
 * DELETE: Remove a member from community (leader only)
 */

import type { NextApiRequest, NextApiResponse } from "next"

import * as db from "../../../lib/network/db"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"

interface MemberRecord {
  id: string
  user_npub: string
  role: string
  status: string
  application_note?: string
  applied_at: string
  approved_at: string | null
  approved_by: string | null
  consent_given?: boolean
  blink_username?: string | null
  total_transactions_synced?: number
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userNpub = req.headers["x-user-npub"] as string | undefined

  if (!userNpub) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
    })
  }

  const { communityId } = req.query as { communityId?: string }

  if (!communityId) {
    return res.status(400).json({
      success: false,
      error: "Community ID is required",
    })
  }

  // Verify user is leader or super admin
  const community = await db.getCommunityById(communityId)
  if (!community) {
    return res.status(404).json({
      success: false,
      error: "Community not found",
    })
  }

  const isSuperAdmin = await db.isSuperAdmin(userNpub)
  const isLeader = community.leader_npub === userNpub

  if (!isSuperAdmin && !isLeader) {
    return res.status(403).json({
      success: false,
      error: "Only community leader or super admin can manage members",
    })
  }

  // GET - List all members
  if (req.method === "GET") {
    try {
      const { status = "approved" } = req.query as { status?: string }

      const members = await db.getCommunityMembers(communityId, {
        status,
        limit: 500, // Get all members
      })

      return res.status(200).json({
        success: true,
        members: (members as unknown as MemberRecord[]).map((m: MemberRecord) => ({
          id: m.id,
          user_npub: m.user_npub,
          role: m.role,
          status: m.status,
          application_note: m.application_note,
          applied_at: m.applied_at,
          approved_at: m.approved_at,
          approved_by: m.approved_by,
          consent_given: m.consent_given || false,
          blink_username: m.blink_username || null,
          total_transactions_synced: m.total_transactions_synced || 0,
        })),
        total: members.length,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("Error fetching members:", message)
      return res.status(500).json({
        success: false,
        error: "Failed to fetch members",
      })
    }
  }

  // DELETE - Remove a member
  if (req.method === "DELETE") {
    try {
      const { membershipId } = req.body as { membershipId: string }

      if (!membershipId) {
        return res.status(400).json({
          success: false,
          error: "Membership ID is required",
        })
      }

      // Get the membership to check it belongs to this community
      const membership = await db.getMembershipById(membershipId)

      if (!membership) {
        return res.status(404).json({
          success: false,
          error: "Membership not found",
        })
      }

      if (String(membership.community_id) !== String(communityId)) {
        return res.status(403).json({
          success: false,
          error: "Membership does not belong to this community",
        })
      }

      // Don't allow removing the leader
      if (membership.role === "leader") {
        return res.status(403).json({
          success: false,
          error: "Cannot remove the community leader",
        })
      }

      // Remove the member (soft delete by setting status to 'removed')
      await db.removeMember(membershipId, userNpub)

      return res.status(200).json({
        success: true,
        message: "Member removed successfully",
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("Error removing member:", message)
      return res.status(500).json({
        success: false,
        error: "Failed to remove member",
      })
    }
  }

  return res.status(405).json({ error: "Method not allowed" })
}

export default withRateLimit(handler, RATE_LIMIT_READ, "network/members")
