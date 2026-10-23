import type { NextApiRequest, NextApiResponse } from "next"

import * as boltcard from "../../../lib/boltcard"
import { requireSessionPubkey } from "../../../lib/boltcard/owner-auth"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"

/**
 * API endpoint for Boltcard statistics
 *
 * GET /api/boltcard/stats
 *
 * Returns statistics about the authenticated owner's cards only (Nostr
 * session required). Aggregates across other owners are never exposed.
 */
/** Same default as the reconcile scheduler's ops log. */
const WITHDRAWAL_STALE_MINUTES =
  Number(process.env.BOLTCARD_WITHDRAWAL_STALE_MINUTES) || 15

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const ownerPubkey = requireSessionPubkey(req, res)
  if (!ownerPubkey) return

  try {
    const [cards, pendingRegistrations] = await Promise.all([
      boltcard.store.getCardsByOwner(ownerPubkey),
      boltcard.store.getPendingRegistrationsByOwner(ownerPubkey),
    ])

    const count = (predicate: (card: (typeof cards)[number]) => boolean) =>
      cards.filter(predicate).length
    const sum = (currency: string) =>
      cards
        .filter((card) => card.walletCurrency === currency && card.status !== "WIPED")
        .reduce((total, card) => total + (card.balance || 0), 0)

    const cardIds = new Set(cards.map((card) => card.id))
    const pendingTopUps = (await boltcard.lnurlp.getAllPendingTopUps()).filter(
      (topUp: { cardId: string }) => cardIds.has(topUp.cardId),
    )
    // Claimed top-ups whose transfer/credit outcome is unresolved (kept
    // claims are invisible to the pending queries above)
    const needingReview = (await boltcard.store.getTopUpsNeedingReview()).filter(
      (topUp) => cardIds.has(topUp.cardId),
    )
    // Card payments still in flight (deduction kept, Blink outcome not yet
    // final) and the ones unresolved past the ops threshold (blink-wip#1619)
    const ownerCardIds = [...cardIds]
    const [inFlight, stale] =
      ownerCardIds.length > 0
        ? await Promise.all([
            boltcard.store.getStaleWithdrawals(0, ownerCardIds),
            boltcard.store.getStaleWithdrawals(
              WITHDRAWAL_STALE_MINUTES * 60_000,
              ownerCardIds,
            ),
          ])
        : [[], []]

    res.status(200).json({
      success: true,
      stats: {
        total: cards.length,
        pending: count((card) => card.status === "PENDING"),
        active: count((card) => card.status === "ACTIVE"),
        disabled: count((card) => card.status === "DISABLED"),
        wiped: count((card) => card.status === "WIPED"),
        btcCards: count((card) => card.walletCurrency === "BTC"),
        usdCards: count((card) => card.walletCurrency === "USD"),
        totalBtcBalanceSats: sum("BTC"),
        totalUsdBalanceCents: sum("USD"),
        pendingRegistrations: pendingRegistrations.length,
        pendingTopUps: pendingTopUps.length,
        topUpsNeedingReview: needingReview.length,
        withdrawalsInFlight: inFlight.length,
        withdrawalsStale: stale.map((w) => ({
          paymentHash: w.paymentHash,
          cardId: w.cardId,
          amount: w.amount,
          kind: w.kind,
          ageMinutes: Math.floor(w.ageMs / 60_000),
        })),
      },
      timestamp: Date.now(),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("❌ Boltcard stats error:", error)
    res.status(500).json({
      error: "Failed to get stats",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "boltcard/stats")
