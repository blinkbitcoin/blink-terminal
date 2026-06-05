/**
 * Challenge Generation API
 *
 * Generates a time-limited challenge for pubkey ownership verification.
 * Used by external signers (Amber, Nostash) that can't do inline NIP-98.
 *
 * The challenge must be signed by the user's nsec and returned to
 * /api/auth/verify-ownership to establish a session.
 *
 * Flow:
 * 1. Client requests challenge: GET /api/auth/challenge
 * 2. Server generates and stores challenge with expiry
 * 3. Client asks external signer to sign the challenge
 * 4. Client submits signed challenge to /api/auth/verify-ownership
 * 5. Server verifies and creates session
 *
 * @see /api/auth/verify-ownership for the verification endpoint
 */

import type { NextApiRequest, NextApiResponse } from "next"

import {
  generateChallenge,
  generateChallengeSecret,
  storeChallenge,
} from "../../../lib/auth/challengeStore"
import { buildChallengeCookie } from "../../../lib/auth/cookies"
import { withRateLimit, RATE_LIMIT_AUTH } from "../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only accept GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    // Generate a new challenge plus a high-entropy redemption secret. The secret
    // is handed to THIS browser via an HttpOnly cookie; only its hash is stored.
    // At verify time the browser must present the matching secret, so a signed
    // challenge event is not a bearer artifact that any party can redeem — it can
    // only be redeemed by the browser that requested the challenge. This closes
    // the signer-phishing/session-minting vector.
    //
    // The challenge is intentionally NOT bound to a pubkey at issue time: the
    // external-signer flow fetches the challenge before the signer reveals the
    // pubkey. Pubkey binding happens on first verify (see challengeStore +
    // verify-ownership).
    const challenge = generateChallenge()
    const secret = generateChallengeSecret()

    // Store it for verification (5 minute expiry), bound to the secret's hash.
    await storeChallenge(challenge, 300, secret)

    // Hand the secret to the requesting browser as an HttpOnly cookie.
    res.setHeader("Set-Cookie", buildChallengeCookie(secret))

    // Get the app URL for the relay tag
    const protocol = req.headers["x-forwarded-proto"] || "http"
    const host = req.headers["x-forwarded-host"] || req.headers.host
    const appUrl = `${protocol}://${host}`

    console.log(
      "[auth/challenge] Generated challenge:",
      challenge.substring(0, 30) + "...",
    )

    return res.status(200).json({
      challenge,
      expiresIn: 300, // seconds
      // Provide the event structure the client should sign
      eventTemplate: {
        kind: 22242, // NIP-42 AUTH event kind
        content: challenge,
        tags: [
          ["relay", appUrl],
          ["challenge", challenge],
        ],
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[auth/challenge] Error:", message)
    return res.status(500).json({ error: "Failed to generate challenge" })
  }
}

export default withRateLimit(handler, RATE_LIMIT_AUTH)
