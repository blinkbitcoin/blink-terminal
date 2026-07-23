/**
 * Heatmap API - Get community data for map visualization
 *
 * GET: Get all communities with coordinates and activity metrics
 */

import type { NextApiRequest, NextApiResponse } from "next"

import * as db from "../../../lib/network/db"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"

/** Community data from database */
interface CommunityData {
  id: string
  name: string
  slug: string
  latitude: string
  longitude: string
  country_code: string
  city: string
  region?: string
}

/** Metrics for a community over a time period */
interface CommunityMetrics {
  transaction_count: number
  total_volume_sats: number
  closed_loop_ratio: number
}

/** Heatmap community entry */
interface HeatmapCommunity {
  id: string
  name: string
  slug: string
  latitude: number
  longitude: number
  country_code: string
  city: string
  region?: string
  member_count: number
  data_sharing_count: number
  transaction_count: number
  volume_sats: number
  closed_loop_ratio: number
  intensity_score: number
}

/**
 * Calculate intensity score based on activity
 * Score from 0-100, used for marker size/color
 */
function calculateIntensity(metrics: CommunityMetrics, memberCount: number): number {
  let score = 0

  // Base score for having members (0-20)
  score += Math.min(memberCount * 2, 20)

  // Transaction activity (0-30)
  if (metrics.transaction_count > 0) {
    score += Math.min(Math.log10(metrics.transaction_count) * 10, 30)
  }

  // Volume activity (0-30)
  if (metrics.total_volume_sats > 0) {
    score += Math.min(Math.log10(metrics.total_volume_sats) * 5, 30)
  }

  // Closed loop bonus (0-20)
  score += metrics.closed_loop_ratio * 0.2

  return Math.round(Math.min(score, 100))
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const { period = "current_month" } = req.query as { period?: string }

  try {
    // Get all communities from database
    const communitiesData = await db.getAllCommunities()

    // Get date range for the period
    const { start, end } = db.getDateRange(period)

    // Build community data with real metrics
    const communities = await Promise.all(
      (communitiesData as unknown as CommunityData[]).map(
        async (community: CommunityData) => {
          // Get member count from database
          const memberCount = await db.getMemberCount(community.id)

          // Get consent count from database
          const consentCount = await db.getConsentCount(community.id)

          // Calculate metrics from database
          const metrics = await db.calculateMetricsForPeriod(community.id, start, end)

          // Calculate intensity score
          const intensity = calculateIntensity(metrics, memberCount)

          return {
            id: community.id,
            name: community.name,
            slug: community.slug,
            latitude: parseFloat(community.latitude) || 0,
            longitude: parseFloat(community.longitude) || 0,
            country_code: community.country_code,
            city: community.city,
            region: community.region,
            member_count: memberCount,
            data_sharing_count: consentCount,
            transaction_count: metrics.transaction_count,
            volume_sats: metrics.total_volume_sats,
            closed_loop_ratio: metrics.closed_loop_ratio,
            intensity_score: intensity,
          }
        },
      ),
    )

    // Filter out communities without valid coordinates
    const validCommunities = communities.filter(
      (c: HeatmapCommunity) => c.latitude !== 0 && c.longitude !== 0,
    )

    // Calculate bounds to fit all communities
    if (validCommunities.length > 0) {
      const lats = validCommunities.map((c: HeatmapCommunity) => c.latitude)
      const lngs = validCommunities.map((c: HeatmapCommunity) => c.longitude)

      const bounds = {
        north: Math.max(...lats) + 5,
        south: Math.min(...lats) - 5,
        east: Math.max(...lngs) + 5,
        west: Math.min(...lngs) - 5,
      }

      return res.status(200).json({
        success: true,
        communities: validCommunities,
        bounds,
        period,
      })
    }

    // No valid communities
    return res.status(200).json({
      success: true,
      communities: [],
      bounds: { north: 90, south: -90, east: 180, west: -180 },
      period,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error fetching heatmap data:", message)
    return res.status(500).json({
      success: false,
      error: "Failed to fetch heatmap data",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "network/heatmap")
