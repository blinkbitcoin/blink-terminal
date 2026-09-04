/**
 * POST /api/nostr-connect/sessions — start a server-held NIP-46 sign-in.
 *
 * The response body carries the nostrconnect:// URI, and by the time it is
 * written the server is already subscribed to kind-24133 on at least one relay.
 * That ordering is the whole point (issue #70): the signer's connect ack is
 * published exactly once, so handing out the URI before we are listening makes
 * sign-in fail in a way no retry can fix.
 *
 * The response also sets an HttpOnly, SameSite=Strict binding cookie. Every
 * subsequent read/consume/cancel of the session requires it, so the session id
 * on its own is not a login capability.
 *
 * Rate limited on the AUTH tier (10/min), and additionally bounded by the
 * concurrent-session caps in the session manager — request rate alone does not
 * limit how many relay sockets a client can pin open.
 */

import type { NextApiRequest, NextApiResponse } from "next"

import { buildNip46BindingCookie, NIP46_COOKIE_NAME } from "../../../../lib/auth/cookies"
import {
  getNip46SessionManager,
  Nip46CapacityError,
  Nip46RelayUnavailableError,
} from "../../../../lib/nip46-server"
import { sha256Hex } from "../../../../lib/nip46-server/sessionStore"
import { withRateLimit, RATE_LIMIT_AUTH } from "../../../../lib/rate-limit"

import { getClientIp, getRequestOrigin } from "./_shared"

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST")
    res.status(405).json({ error: "Method not allowed" })
    return
  }

  const previousSecret = req.cookies[NIP46_COOKIE_NAME]

  try {
    const created = await getNip46SessionManager().create({
      ip: getClientIp(req),
      origin: getRequestOrigin(req),
      // Supersede this browser's previous attempt instead of stacking sockets.
      previousBindingHash: previousSecret ? sha256Hex(previousSecret) : undefined,
    })

    res.setHeader("Set-Cookie", buildNip46BindingCookie(created.bindingSecret))
    res.status(201).json({
      sessionId: created.sessionId,
      uri: created.uri,
      expiresAt: created.expiresAt,
    })
  } catch (error: unknown) {
    if (error instanceof Nip46RelayUnavailableError) {
      console.warn("[nip46] no relay became ready:", error.message)
      res.status(503).json({
        error: "No Nostr relay is reachable right now. Please try again.",
        reason: "relays_unavailable",
      })
      return
    }
    if (error instanceof Nip46CapacityError) {
      res.status(429).json({
        error: "Too many sign-in sessions in progress. Please wait a moment.",
        reason: "capacity",
      })
      return
    }
    console.error("[nip46] session creation failed:", error)
    res.status(500).json({ error: "Could not start sign-in session" })
  }
}

export default withRateLimit(handler, RATE_LIMIT_AUTH, "nostr-connect/sessions")
