/**
 * Communities API - List and create communities
 *
 * GET: List all active communities
 * POST: Create a new community (super-admin only, assigns leader)
 */

import type { NextApiRequest, NextApiResponse } from "next"

import * as db from "../../../lib/network/db"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"

interface CommunityRecord {
  id: string
  name: string
  slug: string
  description: string
  country_code: string
  region: string
  city: string
  latitude: string
  longitude: string
  leader_npub: string
  member_count?: number
  member_count_live?: number
  data_sharing_member_count?: number
  status: string
  created_at: string
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    try {
      // Fetch communities from database
      const communities = await db.listCommunities()

      // Get latest metrics for each community
      const communitiesWithMetrics = await Promise.all(
        (communities as unknown as CommunityRecord[]).map(
          async (community: CommunityRecord) => {
            const metrics = await db.getLatestMetrics(community.id)

            // Get Bitcoin Preference metric (may fail if migration 012 hasn't run)
            let btcPreference = null
            try {
              btcPreference = await db.getCommunityBitcoinPreference(community.id)
            } catch (_btcPrefError: unknown) {
              // Table doesn't exist yet - that's OK
            }

            return {
              id: community.id,
              name: community.name,
              slug: community.slug,
              description: community.description,
              country_code: community.country_code,
              region: community.region,
              city: community.city,
              latitude: parseFloat(community.latitude),
              longitude: parseFloat(community.longitude),
              leader_npub: community.leader_npub,
              member_count: community.member_count || community.member_count_live || 1,
              data_sharing_member_count: community.data_sharing_member_count || 0,
              status: community.status,
              created_at: community.created_at,
              // Add metrics if available
              transaction_count: metrics?.transaction_count || 0,
              transaction_volume_sats: metrics?.total_volume_sats || 0,
              intra_community_count: metrics?.intra_community_count || 0,
              intra_volume_sats: metrics?.intra_volume_sats || 0,
              closed_loop_ratio: metrics?.closed_loop_ratio || 0,
              velocity: metrics?.velocity || 0,
              avg_tx_size: metrics?.avg_tx_size || 0,
              period_start: metrics?.period_start || null,
              period_end: metrics?.period_end || null,
              metrics_last_updated: metrics?.created_at || null,
              // Bitcoin Preference metric
              bitcoin_preference: btcPreference?.has_data
                ? {
                    btc_preference_pct: btcPreference.btc_preference_pct,
                    total_btc_sats: btcPreference.total_btc_sats,
                    total_stablesats_sats: btcPreference.total_stablesats_sats,
                    members_with_balance: btcPreference.members_with_balance,
                  }
                : null,
            }
          },
        ),
      )

      return res.status(200).json({
        success: true,
        communities: communitiesWithMetrics,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("Error fetching communities:", message)
      return res.status(500).json({
        success: false,
        error: "Failed to fetch communities",
      })
    }
  }

  if (req.method === "POST") {
    try {
      // Create community - SUPER ADMIN ONLY
      const userNpub = req.headers["x-user-npub"] as string | undefined

      if (!userNpub) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
        })
      }

      // Verify super admin
      const isSuperAdmin = await db.isSuperAdmin(userNpub)
      if (!isSuperAdmin) {
        return res.status(403).json({
          success: false,
          error: "Only super admin can create new communities",
        })
      }

      const {
        name,
        slug,
        description,
        countryCode,
        region,
        city,
        latitude,
        longitude,
        leaderNpub,
        leaderPubkeyHex,
      } = req.body as {
        name: string
        slug: string
        description: string
        countryCode: string
        region: string
        city: string
        latitude: number
        longitude: number
        leaderNpub: string
        leaderPubkeyHex: string
      }

      if (!name || !slug || !leaderNpub) {
        return res.status(400).json({
          success: false,
          error: "Name, slug, and leader npub are required",
        })
      }

      // Check if leader is already whitelisted
      const isWhitelisted = await db.isLeaderWhitelisted(leaderNpub)

      // If not whitelisted, add them
      if (!isWhitelisted) {
        await db.addToWhitelist(
          leaderNpub,
          leaderPubkeyHex,
          name + " Leader",
          userNpub,
          `Community leader for ${name}`,
        )
      }

      // Create community
      const community = await db.createCommunity({
        name,
        slug,
        description,
        countryCode,
        region,
        city,
        latitude,
        longitude,
        leaderNpub,
        leaderPubkeyHex,
        settings: {
          visibility: "public",
          show_metrics: true,
          require_approval: true,
          show_member_count: true,
          data_sharing_required: false,
        },
      })

      return res.status(201).json({
        success: true,
        community,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("Error creating community:", message)
      return res.status(500).json({
        success: false,
        error: message || "Failed to create community",
      })
    }
  }

  return res.status(405).json({ error: "Method not allowed" })
}

export default withRateLimit(handler, RATE_LIMIT_READ, "network/communities")
