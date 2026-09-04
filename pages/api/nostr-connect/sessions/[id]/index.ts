/**
 * GET    /api/nostr-connect/sessions/:id — poll the status of a sign-in.
 * DELETE /api/nostr-connect/sessions/:id — cancel it.
 *
 * GET is deliberately non-mutating with respect to authentication: it never
 * mints the session cookie. Approval is turned into a login only by the
 * explicit POST .../consume, so a polling response cannot be replayed into an
 * authenticated session.
 *
 * Both verbs require the browser-binding cookie. A caller without it gets 404,
 * indistinguishable from an unknown session.
 *
 * GET uses the POLL rate-limit tier: the modal polls every ~1.5s for up to five
 * minutes, which the AUTH tier that guards session creation would reject.
 * Keeping them on separate tiers means polling volume can never buy extra
 * session-creation attempts.
 */

import type { NextApiRequest, NextApiResponse } from "next"

import { getNip46SessionManager, getSession } from "../../../../../lib/nip46-server"
import {
  isBoundCaller,
  getSessionId,
  respondToStorageError,
} from "../../../../../lib/nip46-server/request"
import { withRateLimit, RATE_LIMIT_POLL } from "../../../../../lib/rate-limit"

const NOT_FOUND = { error: "Session not found or expired" }

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "DELETE") {
    res.setHeader("Allow", "GET, DELETE")
    res.status(405).json({ error: "Method not allowed" })
    return
  }

  try {
    const sessionId = getSessionId(req)
    if (!sessionId) {
      res.status(404).json(NOT_FOUND)
      return
    }

    const record = await getSession(sessionId)
    if (!record || !isBoundCaller(req, record.bindingHash)) {
      res.status(404).json(NOT_FOUND)
      return
    }

    const manager = getNip46SessionManager()

    if (req.method === "DELETE") {
      await manager.cancel(sessionId)
      // Deliberately does NOT clear the binding cookie. Cancellation's job is releasing the
      // relay sockets; the cookie's lifetime tracks the SESSION — set by POST, replaced by the
      // next POST, expired by TTL. The client fires this DELETE without awaiting it and then
      // creates a replacement session immediately, so this response can land AFTER the new
      // POST has set the replacement's cookie. Clearing here validated against the OLD
      // session's binding but wiped the NEW one, leaving it unbound and 404-ing on every
      // poll (PR #71 review). A stale cookie is harmless: the next read 404s and the client
      // starts fresh.
      res.status(200).json({ status: "cancelled" })
      return
    }

    const status = await manager.resolveStatus(record)
    res.status(200).json({
      sessionId,
      status: status.status,
      // Advisory only — the pubkey is not trusted until consume returns it.
      pubkey: status.pubkey,
      error: status.error,
      expiresAt: status.expiresAt,
    })
  } catch (error: unknown) {
    if (respondToStorageError(res, error)) return
    throw error
  }
}

// DELETE shares this handler, so it also lands on the POLL tier. That is
// intentional: cancellation is cheap, idempotent, and gated by the binding
// cookie, and rate-limiting it aggressively would only strand abandoned relay
// sockets that we want released promptly.

export default withRateLimit(handler, RATE_LIMIT_POLL, "nostr-connect/sessions/status")
