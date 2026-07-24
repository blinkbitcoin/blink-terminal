/**
 * Memberships API - Get user's community memberships
 *
 * GET: Get all memberships for the authenticated user
 */

import type { NextApiRequest, NextApiResponse } from "next"

import type { MembershipRow, CommunityRow } from "../../../lib/network/db"
import * as db from "../../../lib/network/db"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"

/** Extended membership including synthetic admin entries (id may be null) */
interface MembershipEntry {
  id: number | null
  community_id: number
  community_name?: string
  community_slug?: string
  user_npub: string
  role: string
  status: string
  member_count?: number
  data_sharing_member_count?: number
  applied_at: string | null
  approved_at: string | null
  consent_given?: boolean
  sync_status?: string | null
  last_sync_at?: string | null
}

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
    // Fetch memberships from database
    const dbMemberships: MembershipRow[] = await db.getUserMemberships(userNpub)
    const memberships: MembershipEntry[] = dbMemberships.map((m) => ({
      id: m.id,
      community_id: m.community_id,
      community_name: m.community_name,
      community_slug: m.community_slug,
      user_npub: m.user_npub,
      role: m.role,
      status: m.status,
      member_count: m.member_count,
      data_sharing_member_count: m.data_sharing_member_count,
      applied_at: m.applied_at,
      approved_at: m.approved_at,
      consent_given: m.consent_given,
    }))

    // Check if user is super admin
    const isSuperAdmin = await db.isSuperAdmin(userNpub)

    // If super admin, also show all communities they don't already have membership in
    if (isSuperAdmin) {
      const allCommunities: CommunityRow[] = await db.listCommunities()
      const memberCommunityIds = new Set(memberships.map((m) => m.community_id))

      // Add admin view for communities they're not already a member of
      allCommunities.forEach((community) => {
        if (!memberCommunityIds.has(community.id)) {
          memberships.push({
            id: null, // No membership record yet
            community_id: community.id,
            community_name: community.name,
            community_slug: community.slug,
            user_npub: userNpub,
            role: "admin",
            status: "approved",
            member_count: community.member_count || community.member_count_live || 0,
            data_sharing_member_count: community.data_sharing_member_count || 0,
            applied_at: null,
            approved_at: null,
            consent_given: false,
          })
        }
      })
    }

    // Get consent status for each membership
    const membershipsWithConsent = await Promise.all(
      memberships.map(async (membership) => {
        if (!membership.id) {
          // Admin view without actual membership
          return membership
        }

        const consent = await db.getConsent(membership.id)
        return {
          ...membership,
          consent_given: consent?.consent_given || false,
          sync_status: consent?.sync_status || null,
          last_sync_at: consent?.last_sync_at || null,
        }
      }),
    )

    return res.status(200).json({
      success: true,
      memberships: membershipsWithConsent,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error fetching memberships:", message)
    return res.status(500).json({
      success: false,
      error: "Failed to fetch memberships",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "network/memberships")
