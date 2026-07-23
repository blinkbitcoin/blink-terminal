/**
 * Leaderboard API - Get community rankings
 *
 * GET: Get the leaderboard of communities by various metrics
 * Query params:
 *   - sortBy: 'volume' | 'transactions' | 'members' | 'closed_loop' | 'members_volume' (default: 'members_volume')
 *   - period: 'current_week' | 'last_week' | 'current_month' | 'last_month' | 'all' (default: 'current_month')
 */

import type { NextApiRequest, NextApiResponse } from "next"

import * as db from "../../../lib/network/db"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"

/** Community data from database */
interface CommunityData {
  id: string
  name: string
  slug: string
  country_code: string
  city: string
  leader_npub: string
}

/** Milestone badge */
interface MilestoneBadge {
  type: string
  threshold: number
  badge: string
  label: string
}

/** Leaderboard entry with computed metrics */
interface LeaderboardEntry {
  id: string
  name: string
  slug: string
  country_code: string
  city: string
  leader_npub: string
  member_count: number
  data_sharing_count: number
  transaction_count: number
  transaction_volume_sats: number
  intra_community_count: number
  closed_loop_ratio: number
  velocity: number
  avg_tx_size: number
  btc_preference_pct: number
  milestones?: MilestoneBadge[]
  rank?: number
}

// Milestone definitions
const MILESTONES = {
  members: [
    { threshold: 10, badge: "🌱", label: "10 Members" },
    { threshold: 50, badge: "🌿", label: "50 Members" },
    { threshold: 100, badge: "🌳", label: "100 Members" },
    { threshold: 500, badge: "🏆", label: "500 Members" },
  ],
  transactions: [
    { threshold: 100, badge: "⚡", label: "100 Transactions" },
    { threshold: 1000, badge: "⚡⚡", label: "1K Transactions" },
    { threshold: 10000, badge: "⚡⚡⚡", label: "10K Transactions" },
  ],
  volume: [
    { threshold: 100000, badge: "💰", label: "100K sats" },
    { threshold: 1000000, badge: "💰💰", label: "1M sats" },
    { threshold: 10000000, badge: "💰💰💰", label: "10M sats" },
    { threshold: 100000000, badge: "₿", label: "1 BTC" },
  ],
  closed_loop: [
    { threshold: 10, badge: "🔄", label: "10% Closed Loop" },
    { threshold: 25, badge: "🔄🔄", label: "25% Closed Loop" },
    { threshold: 50, badge: "♻️", label: "50% Closed Loop" },
  ],
}

function getMilestones(community: LeaderboardEntry) {
  const badges: MilestoneBadge[] = []

  // Check member milestones
  for (const m of MILESTONES.members) {
    if (community.member_count >= m.threshold) {
      badges.push({ type: "members", ...m })
    }
  }

  // Check transaction milestones
  for (const m of MILESTONES.transactions) {
    if (community.transaction_count >= m.threshold) {
      badges.push({ type: "transactions", ...m })
    }
  }

  // Check volume milestones
  for (const m of MILESTONES.volume) {
    if (community.transaction_volume_sats >= m.threshold) {
      badges.push({ type: "volume", ...m })
    }
  }

  // Check closed loop milestones
  for (const m of MILESTONES.closed_loop) {
    if (community.closed_loop_ratio >= m.threshold) {
      badges.push({ type: "closed_loop", ...m })
    }
  }

  return badges
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const { sortBy = "members_volume", period = "current_month" } = req.query as {
    sortBy?: string
    period?: string
  }

  try {
    // Get all communities from database
    const communitiesData = await db.getAllCommunities()

    // Get date range for the period
    const periodRange = db.getDateRange(period)

    // Build leaderboard with real metrics from database
    const leaderboard: LeaderboardEntry[] = await Promise.all(
      (communitiesData as unknown as CommunityData[]).map(
        async (community: CommunityData) => {
          // Get member count from database
          const memberCount = await db.getMemberCount(community.id)

          // Get data sharing count from database
          const dataSharingCount = await db.getConsentCount(community.id)

          // Calculate metrics for the period from database
          const metrics = await db.calculateMetricsForPeriod(
            community.id,
            periodRange.start,
            periodRange.end,
          )

          // Get BTC preference for the community
          const btcPreference = await db.getCommunityBitcoinPreference(
            community.id,
            periodRange.end,
          )

          return {
            id: community.id,
            name: community.name,
            slug: community.slug,
            country_code: community.country_code,
            city: community.city,
            leader_npub: community.leader_npub,
            member_count: memberCount,
            data_sharing_count: dataSharingCount,
            transaction_count: metrics.transaction_count,
            transaction_volume_sats: metrics.total_volume_sats,
            intra_community_count: metrics.intra_community_count,
            closed_loop_ratio: metrics.closed_loop_ratio,
            velocity: metrics.velocity,
            avg_tx_size: metrics.avg_tx_size,
            btc_preference_pct: btcPreference.btc_preference_pct ?? 0,
          }
        },
      ),
    )

    // Add milestones
    leaderboard.forEach((c: LeaderboardEntry) => {
      c.milestones = getMilestones(c)
    })

    // Sort based on sortBy parameter
    const sortFunctions: Record<
      string,
      (a: LeaderboardEntry, b: LeaderboardEntry) => number
    > = {
      volume: (a, b) => b.transaction_volume_sats - a.transaction_volume_sats,
      transactions: (a, b) => b.transaction_count - a.transaction_count,
      members: (a, b) => b.member_count - a.member_count,
      closed_loop: (a, b) => b.closed_loop_ratio - a.closed_loop_ratio,
      // Primary sort by members, secondary by volume
      members_volume: (a, b) => {
        if (b.member_count !== a.member_count) {
          return b.member_count - a.member_count
        }
        return b.transaction_volume_sats - a.transaction_volume_sats
      },
    }

    const sortFn = sortFunctions[sortBy] || sortFunctions.members_volume
    leaderboard.sort(sortFn)

    // Add rank
    leaderboard.forEach((c: LeaderboardEntry, index: number) => {
      c.rank = index + 1
    })

    return res.status(200).json({
      success: true,
      leaderboard,
      period: {
        value: period,
        label: periodRange.label,
        start: periodRange.start.toISOString(),
        end: periodRange.end.toISOString(),
      },
      sortBy,
      lastUpdated: new Date().toISOString(),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error fetching leaderboard:", message)
    return res.status(500).json({
      success: false,
      error: "Failed to fetch leaderboard",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "network/leaderboard")
