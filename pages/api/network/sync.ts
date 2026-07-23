/**
 * Transaction Sync API
 *
 * POST: Trigger sync for a community or all communities
 * GET: Get sync status and metrics
 */

import type { NextApiRequest, NextApiResponse } from "next"

import type { MetricsRow } from "../../../lib/network/db"
import * as db from "../../../lib/network/db"
import {
  syncCommunityTransactions,
  syncAllCommunities,
} from "../../../lib/network/syncService"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"

async function canTriggerSync(userNpub: string, communityId?: string): Promise<boolean> {
  try {
    // Check if user is super admin
    const isSuperAdmin = await db.isSuperAdmin(userNpub)
    if (isSuperAdmin) return true

    // Check if user is the community leader
    if (communityId) {
      const community = await db.getCommunityById(communityId)
      if (community && community.leader_npub === userNpub) {
        return true
      }
    }

    return false
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error checking sync permission:", message)
    return false
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userNpub = req.headers["x-user-npub"] as string | undefined

  if (!userNpub) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
    })
  }

  // GET - Get sync status and metrics
  if (req.method === "GET") {
    const { communityId } = req.query as { communityId?: string }

    try {
      if (communityId) {
        // Get metrics for specific community from database
        const metrics = await db.getLatestMetrics(communityId)

        // Count consents
        const consents = await db.query(
          `SELECT COUNT(*) as count FROM data_sharing_consents dsc
           JOIN community_memberships cm ON cm.id = dsc.membership_id
           WHERE cm.community_id = $1 AND dsc.consent_given = true`,
          [communityId],
        )
        const consentCount = parseInt(String(consents.rows[0]?.count ?? 0))

        return res.status(200).json({
          success: true,
          community_id: communityId,
          opted_in_members: consentCount,
          metrics: metrics || {
            transaction_count: 0,
            total_volume_sats: 0,
            intra_community_count: 0,
            unique_members: 0,
            velocity: 0,
            last_updated: null,
          },
        })
      } else {
        // Get metrics for all communities from database
        const communities = await db.listCommunities()
        const metricsArray: MetricsRow[] = []

        for (const community of communities) {
          const metrics = await db.getLatestMetrics(community.id)
          if (metrics) {
            metricsArray.push(metrics)
          }
        }

        return res.status(200).json({
          success: true,
          metrics: metricsArray,
        })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("Error getting sync status:", message)
      return res.status(500).json({
        success: false,
        error: "Failed to get sync status",
      })
    }
  }

  // POST - Trigger sync
  if (req.method === "POST") {
    const { communityId, syncAll } = req.body as {
      communityId?: string
      syncAll?: boolean
    }

    try {
      // Check permissions
      if (syncAll) {
        // Only super admin can sync all
        const isSuperAdmin = await db.isSuperAdmin(userNpub)
        if (!isSuperAdmin) {
          return res.status(403).json({
            success: false,
            error: "Only super admin can trigger full sync",
          })
        }

        console.log(`[Sync API] Super admin triggering full sync`)
        const result = await syncAllCommunities()

        return res.status(200).json({
          ...result,
          success: true,
          message: `Synced ${result.communities_synced} communities with ${result.total_transactions} transactions`,
        })
      } else if (communityId) {
        // Check if user can sync this community
        const canSync = await canTriggerSync(userNpub, communityId)
        if (!canSync) {
          return res.status(403).json({
            success: false,
            error: "You do not have permission to sync this community",
          })
        }

        console.log(
          `[Sync API] User ${userNpub.substring(0, 20)}... triggering sync for community ${communityId}`,
        )
        const result = await syncCommunityTransactions(communityId)

        return res.status(200).json({
          ...result,
          success: true,
          message: `Synced ${result.members_synced} members with ${result.total_transactions} transactions`,
        })
      } else {
        return res.status(400).json({
          success: false,
          error: "Either communityId or syncAll is required",
        })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("Error triggering sync:", message)
      return res.status(500).json({
        success: false,
        error: "Failed to trigger sync: " + message,
      })
    }
  }

  return res.status(405).json({ error: "Method not allowed" })
}

export default withRateLimit(handler, RATE_LIMIT_WRITE, "network/sync")
