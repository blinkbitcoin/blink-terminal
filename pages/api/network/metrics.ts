/**
 * Community Metrics API with Period Filtering
 *
 * GET: Get metrics for a community with optional period filter
 *
 * Uses DATABASE for all data - not in-memory stores
 */

import type { NextApiRequest, NextApiResponse } from "next"

import * as db from "../../../lib/network/db"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"

/**
 * Get date range for a period
 */
function getDateRange(period: string): { start: Date; end: Date; label: string } {
  const now = new Date()
  let start: Date, end: Date, label: string

  switch (period) {
    case "current_week": {
      // Monday of current week at 00:00:00
      const dayOfWeek = now.getDay()
      const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1 // Monday = 0
      start = new Date(now)
      start.setDate(now.getDate() - diff)
      start.setHours(0, 0, 0, 0)
      // Sunday of current week at 23:59:59
      end = new Date(start)
      end.setDate(start.getDate() + 6)
      end.setHours(23, 59, 59, 999)
      const weekNum = getWeekNumber(start)
      label = `Week ${weekNum.year}/${String(weekNum.week).padStart(2, "0")}`
      break
    }
    case "last_week": {
      // Monday of last week
      const dayOfWeek = now.getDay()
      const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1
      start = new Date(now)
      start.setDate(now.getDate() - diff - 7)
      start.setHours(0, 0, 0, 0)
      // Sunday of last week
      end = new Date(start)
      end.setDate(start.getDate() + 6)
      end.setHours(23, 59, 59, 999)
      const weekNum = getWeekNumber(start)
      label = `Week ${weekNum.year}/${String(weekNum.week).padStart(2, "0")}`
      break
    }
    case "current_month": {
      // First day of current month
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
      // Last day of current month
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
      label = start.toLocaleDateString("en-US", { month: "long", year: "numeric" })
      break
    }
    case "last_month": {
      // First day of last month
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0)
      // Last day of last month
      end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
      label = start.toLocaleDateString("en-US", { month: "long", year: "numeric" })
      break
    }
    case "all":
    default:
      start = new Date(0)
      end = new Date(8640000000000000) // Max date
      label = "All Time"
  }

  return { start, end, label }
}

/**
 * Get ISO week number
 */
function getWeekNumber(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return { year: d.getUTCFullYear(), week: weekNo }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const { communityId, period = "current_week" } = req.query as {
    communityId?: string
    period?: string
  }

  if (!communityId) {
    return res.status(400).json({
      success: false,
      error: "Community ID is required",
    })
  }

  // Validate period
  const validPeriods = ["current_week", "last_week", "current_month", "last_month", "all"]
  if (!validPeriods.includes(period)) {
    return res.status(400).json({
      success: false,
      error: `Invalid period. Valid options: ${validPeriods.join(", ")}`,
    })
  }

  try {
    // Get date range for the selected period
    const periodRange = getDateRange(period)

    // Calculate metrics for the period from database
    const metrics = await db.calculateMetricsForPeriod(
      communityId,
      periodRange.start,
      periodRange.end,
    )

    // Get data coverage info from database
    const dataCoverage = await db.getDataCoverage(communityId)

    // Get Bitcoin Preference metric (latest snapshot)
    let bitcoinPreference: {
      has_data: boolean
      btc_preference_pct: number | null
      total_btc_sats: number
      total_stablesats_sats: number
      total_balance_sats: number
      members_with_balance: number
    } | null = null
    try {
      bitcoinPreference = await db.getCommunityBitcoinPreference(communityId)
    } catch (btcPrefError: unknown) {
      // Table might not exist yet if migration 012 hasn't run
      const message =
        btcPrefError instanceof Error ? btcPrefError.message : "Unknown error"
      console.log("Bitcoin preference not available:", message)
    }

    // Check if selected period extends beyond our data coverage
    let coverageWarning: {
      type: string
      message: string
      data_starts?: string
      period_starts?: string
      data_ends?: string
      period_ends?: string
    } | null = null
    if (dataCoverage.oldest && dataCoverage.newest) {
      const dataStart = new Date(dataCoverage.oldest).getTime()
      const dataEnd = new Date(dataCoverage.newest).getTime()
      const periodStart = periodRange.start.getTime()
      const periodEnd = periodRange.end.getTime()

      // Check if period starts before our oldest data
      if (periodStart < dataStart) {
        coverageWarning = {
          type: "incomplete",
          message: `Data only available from ${new Date(dataCoverage.oldest).toLocaleDateString()}`,
          data_starts: dataCoverage.oldest,
          period_starts: periodRange.start.toISOString(),
        }
      }
      // Check if period ends after our newest data (and period is in the past)
      else if (periodEnd < Date.now() && periodEnd > dataEnd) {
        coverageWarning = {
          type: "incomplete",
          message: `Data only available until ${new Date(dataCoverage.newest).toLocaleDateString()}`,
          data_ends: dataCoverage.newest,
          period_ends: periodRange.end.toISOString(),
        }
      }
    } else if (period !== "all") {
      coverageWarning = {
        type: "no_data",
        message: "No transaction data synced yet",
      }
    }

    // Get available periods info
    const periods = validPeriods.map((p) => {
      const range = getDateRange(p)
      return {
        value: p,
        label: range.label,
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      }
    })

    // Build response with period info
    const responseMetrics = {
      community_id: communityId,
      period: period,
      period_label: periodRange.label,
      period_start: periodRange.start.toISOString(),
      period_end: periodRange.end.toISOString(),
      ...metrics,
      total_synced_txs: dataCoverage.total_transactions,
      // Bitcoin Preference metric (from balance snapshots)
      bitcoin_preference: bitcoinPreference?.has_data
        ? {
            btc_preference_pct: bitcoinPreference.btc_preference_pct,
            total_btc_sats: bitcoinPreference.total_btc_sats,
            total_stablesats_sats: bitcoinPreference.total_stablesats_sats,
            total_balance_sats: bitcoinPreference.total_balance_sats,
            members_with_balance: bitcoinPreference.members_with_balance,
          }
        : null,
    }

    return res.status(200).json({
      success: true,
      metrics: responseMetrics,
      data_coverage: {
        oldest_transaction: dataCoverage.oldest,
        newest_transaction: dataCoverage.newest,
        total_synced_transactions: dataCoverage.total_transactions,
      },
      coverage_warning: coverageWarning,
      available_periods: periods,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error calculating metrics:", message)
    return res.status(500).json({
      success: false,
      error: "Failed to calculate metrics",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "network/metrics")
