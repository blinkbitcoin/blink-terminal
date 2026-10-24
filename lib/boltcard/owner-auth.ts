/**
 * Bolt Card owner authorization (server-side).
 *
 * Every card management route requires the caller's Nostr session
 * (`auth-token` cookie, username `nostr:<pubkey>`). The owner pubkey is taken
 * from the session ONLY — never from the request — and a card is only
 * visible to the session whose pubkey owns it. Someone else's card answers
 * 404, exactly like a card that doesn't exist (no existence oracle).
 *
 * Card-protocol endpoints called by wallets / the NFC Programmer app (LNURL
 * top-up, tap-verified balance and reset, single-use key links) authenticate
 * differently and do not use this module.
 */

import type { NextApiRequest, NextApiResponse } from "next"

import { requireSessionPubkey } from "../auth/session-pubkey"

import boltcardStore from "./store"

export { getSessionPubkey, requireSessionPubkey } from "../auth/session-pubkey"

type OwnedCard = NonNullable<Awaited<ReturnType<typeof boltcardStore.getCard>>>

/**
 * The card `cardId` if it belongs to the session's pubkey. Otherwise answers
 * 401 (no session) or 404 (missing or not owned) and returns null.
 */
export async function requireOwnedCard(
  req: NextApiRequest,
  res: NextApiResponse,
  cardId: string,
  { includeKeys = false }: { includeKeys?: boolean } = {},
): Promise<{ card: OwnedCard; pubkey: string } | null> {
  const pubkey = requireSessionPubkey(req, res)
  if (!pubkey) return null

  const card = await boltcardStore.getCard(cardId, includeKeys)
  if (!card || card.ownerPubkey?.toLowerCase() !== pubkey) {
    res.status(404).json({ error: "Card not found" })
    return null
  }
  return { card, pubkey }
}
