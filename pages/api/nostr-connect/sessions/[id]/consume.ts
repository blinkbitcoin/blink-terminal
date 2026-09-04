/**
 * POST /api/nostr-connect/sessions/:id/consume — turn an approval into a login.
 *
 * This is the only place where a verified NIP-46 approval becomes a session
 * cookie, and it is exactly-once: the store performs an atomic
 * approved -> consumed transition, so a double-submit cannot mint two sessions.
 *
 * Requires the browser-binding cookie, so an approval belongs to the browser
 * that started the session and cannot be redeemed from anywhere else.
 *
 * The signed kind-27235 event was already verified by the session worker
 * against this exact URL, the POST method and the per-session challenge before
 * the session was marked approved (see lib/nip46-server/sessionManager.ts).
 */

import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../../../lib/auth"
import {
  buildClearNip46BindingCookie,
  buildSessionCookie,
} from "../../../../../lib/auth/cookies"
import { getNip46SessionManager, getSession } from "../../../../../lib/nip46-server"
import {
  getBindingSecret,
  isBoundCaller,
  getSessionId,
} from "../../../../../lib/nip46-server/request"
import { withRateLimit, RATE_LIMIT_AUTH } from "../../../../../lib/rate-limit"

const NOT_FOUND = { error: "Session not found or expired" }

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST")
    res.status(405).json({ error: "Method not allowed" })
    return
  }

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

  const result = await getNip46SessionManager().consume(sessionId, getBindingSecret(req))

  if (!result.ok || !result.pubkey) {
    res.status(409).json({
      error: result.error || "Session could not be completed",
      status: record.status,
    })
    return
  }

  // Same session shape as /api/auth/nostr-login so downstream routes that key
  // off "nostr:<pubkey>" keep working unchanged.
  const sessionUsername = `nostr:${result.pubkey}`
  const token = AuthManager.generateSession(sessionUsername)

  res.setHeader("Set-Cookie", [buildSessionCookie(token), buildClearNip46BindingCookie()])
  res.status(200).json({
    success: true,
    user: {
      pubkey: result.pubkey,
      username: sessionUsername,
      authMethod: "nostr",
    },
  })
}

export default withRateLimit(handler, RATE_LIMIT_AUTH, "nostr-connect/sessions/consume")
