/**
 * Nostr Login API Endpoint
 *
 * Authenticates users via NIP-98 HTTP Auth.
 * Creates a server session for verified Nostr users.
 *
 * Flow:
 * 1. Client creates and signs a NIP-98 event (kind 27235)
 * 2. Client sends event in Authorization header
 * 3. Server verifies signature and event parameters
 * 4. Server creates JWT session token
 * 5. Client receives session cookie for subsequent requests
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/98.md
 */

import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import { buildSessionCookie } from "../../../lib/auth/cookies"
import Nip98Verifier from "../../../lib/nostr/Nip98Verifier"
import { withRateLimit, RATE_LIMIT_AUTH } from "../../../lib/rate-limit"

/**
 * Get the full URL of the request
 * @param {Object} req - Next.js request object
 * @returns {string}
 */
function getRequestUrl(req: NextApiRequest): string {
  const protocol = req.headers["x-forwarded-proto"] || "http"
  const host = req.headers["x-forwarded-host"] || req.headers.host
  const path = req.url
  return `${protocol}://${host}${path}`
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only accept POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    // Get Authorization header
    const authHeader = req.headers.authorization

    if (!authHeader) {
      return res.status(401).json({
        error: "Missing Authorization header",
        hint: 'Include NIP-98 token in Authorization header: "Nostr base64EncodedEvent"',
      })
    }

    // Get request URL for verification
    const requestUrl = getRequestUrl(req)

    // Verify NIP-98 token
    const verifyResult = await Nip98Verifier.verify({
      authHeader,
      url: requestUrl,
      method: "POST",
      maxAgeSeconds: 120, // Allow 2 minutes for clock skew and network delay
    })

    if (!verifyResult.valid) {
      console.warn("NIP-98 verification failed:", verifyResult.error)
      return res.status(401).json({
        error: "Invalid NIP-98 token",
        details: verifyResult.error,
      })
    }

    const { pubkey } = verifyResult

    // Generate session token using the pubkey as username
    // Format: nostr:pubkey to distinguish from legacy usernames
    const sessionUsername = `nostr:${pubkey}`
    const token = AuthManager.generateSession(sessionUsername)

    // Set session cookie (centralized attributes)
    res.setHeader("Set-Cookie", buildSessionCookie(token))

    // Return success with user info
    return res.status(200).json({
      success: true,
      user: {
        pubkey,
        username: sessionUsername,
        authMethod: "nostr",
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Nostr login error:", error)
    return res.status(500).json({
      error: "Authentication failed",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_AUTH)
