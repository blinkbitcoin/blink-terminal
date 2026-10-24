import type { NextApiRequest, NextApiResponse } from "next"

/**
 * API endpoint for NFC Programmer app to request card keys
 *
 * This endpoint implements the deeplink flow per DEEPLINK.md:
 * 1. User initiates card registration in BlinkPOS
 * 2. BlinkPOS shows QR code with boltcard://program?url=...
 * 3. NFC Programmer app scans QR and POSTs { UID } to this endpoint
 * 4. This endpoint derives keys and returns { LNURLW, K0, K1, K2, K3, K4 }
 * 5. App programs the card with these values
 *
 * POST /api/boltcard/keys/[registrationId]
 * Body: { UID: string } (7 bytes = 14 hex chars)
 *
 * Returns:
 * {
 *   LNURLW: string,  // URL to program into card's NDEF
 *   K0: string,      // AppMasterKey (uppercase hex)
 *   K1: string,      // EncryptionKey (uppercase hex)
 *   K2: string,      // AuthenticationKey (uppercase hex)
 *   K3: string,      // Reserved
 *   K4: string       // Reserved
 * }
 *
 * References:
 * - https://github.com/boltcard/boltcard/blob/main/docs/DEEPLINK.md
 */

import * as boltcardCrypto from "../../../../lib/boltcard/crypto"
import * as lnurlw from "../../../../lib/boltcard/lnurlw"
import boltcardStore, { CARD_ACTIVATION_FAILED } from "../../../../lib/boltcard/store"
import { withRateLimit, RATE_LIMIT_READ } from "../../../../lib/rate-limit"

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Enhanced logging for debugging NFC Programmer app requests
  const requestId = Math.random().toString(36).substring(7)
  const timestamp = new Date().toISOString()

  // Never log headers, body, the registration id or the response: the id is a
  // single-use capability and the response contains the card keys.
  console.log(`[KeysAPI][${requestId}] ${req.method} keys request`)

  // Set CORS headers for NFC Programmer app
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept")

  // Handle preflight
  if (req.method === "OPTIONS") {
    console.log(`[KeysAPI][${requestId}] Responding to OPTIONS preflight`)
    return res.status(200).end()
  }

  // Also allow GET for debugging (returns info about the endpoint)
  if (req.method === "GET") {
    console.log(`[KeysAPI][${requestId}] GET request - returning endpoint info`)
    return res.status(200).json({
      status: "OK",
      message:
        'Boltcard keys endpoint. POST with { UID: "14-hex-chars" } to get card keys.',
      timestamp,
    })
  }

  if (req.method !== "POST") {
    console.log(`[KeysAPI][${requestId}] Method not allowed: ${req.method}`)
    return res.status(405).json({
      status: "ERROR",
      reason: "Method not allowed",
    })
  }

  const registrationId = req.query.registrationId as string | undefined

  if (!registrationId) {
    return res.status(400).json({
      status: "ERROR",
      reason: "Missing registration ID",
    })
  }

  try {
    // Get UID from request body
    // NFC Programmer app sends uppercase hex, but we normalize to lowercase
    const { UID } = req.body as { UID?: string }

    if (!UID) {
      return res.status(400).json({
        status: "ERROR",
        reason: "Missing UID in request body",
      })
    }

    // Normalize UID (remove any separators, lowercase)
    const cardUid = UID.replace(/[:\s-]/g, "").toLowerCase()

    // Validate UID format (14 hex chars = 7 bytes)
    if (!/^[0-9a-fA-F]{14}$/.test(cardUid)) {
      return res.status(400).json({
        status: "ERROR",
        reason: "Invalid UID format: expected 14 hex characters (7 bytes)",
      })
    }

    // Get the pending registration
    const registration = await boltcardStore.getPendingRegistration(registrationId)

    if (!registration) {
      return res.status(404).json({
        status: "ERROR",
        reason: "Registration not found",
      })
    }

    if (registration.status !== "PENDING") {
      // Single-use: an already-used link is indistinguishable from a bad one
      return res.status(404).json({
        status: "ERROR",
        reason: "Registration not found",
      })
    }

    if (registration.expiresAt < Date.now()) {
      return res.status(400).json({
        status: "ERROR",
        reason: "Registration has expired",
      })
    }

    // Complete the registration (creates the card with derived keys)
    const card = await boltcardStore.completePendingRegistration(registrationId, cardUid)

    if (!card) {
      return res.status(500).json({
        status: "ERROR",
        reason: "Failed to create card",
      })
    }

    // Generate LNURL-withdraw URL for the card
    const serverUrl = getServerUrl(req)
    const lnurlwUrl = lnurlw.generateCardUrl(serverUrl, card.id)

    // Build response in format expected by NFC Programmer app
    // Format matches: https://bolt-card-mock-server.vercel.app/api/create
    const keysResponse = boltcardCrypto.generateKeysResponse(
      lnurlwUrl,
      {
        k0: card.k0 ?? "",
        k1: card.k1 ?? "",
        k2: card.k2 ?? "",
        k3: card.k3 ?? "",
        k4: card.k4 ?? "",
      },
      card.name || "Boltcard",
    )

    console.log(`[KeysAPI][${requestId}] Card programmed: ${card.id}`)

    res.status(200).json(keysResponse)
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error(`[KeysAPI][${requestId}] ERROR:`, error)

    // Handle specific errors
    if (error instanceof Error && error.message === CARD_ACTIVATION_FAILED) {
      // No keys: the card row exists but isn't active. Recovery is a fresh
      // registration with the same card (same-owner reprogram).
      return res.status(500).json({
        status: "ERROR",
        reason:
          "Card could not be activated - start a new registration and tap the same card",
      })
    }
    if (error instanceof Error && error.message === "Registration is not pending") {
      return res.status(404).json({ status: "ERROR", reason: "Registration not found" })
    }
    if (error instanceof Error && error.message.includes("already registered")) {
      return res.status(409).json({
        status: "ERROR",
        reason: error.message,
      })
    }

    res.status(500).json({
      status: "ERROR",
      reason: "Failed to process key request",
      details: process.env.NODE_ENV === "development" ? errorMessage : undefined,
    })
  }
}

/**
 * Get the server URL from the request
 */
function getServerUrl(req: NextApiRequest) {
  // Check for X-Forwarded headers (common with proxies/load balancers)
  const forwardedProto = req.headers["x-forwarded-proto"]
  const forwardedHost = req.headers["x-forwarded-host"]

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`
  }

  // Use Host header
  const host = req.headers.host
  const protocol = host?.includes("localhost") ? "http" : "https"

  return `${protocol}://${host}`
}

export default withRateLimit(handler, RATE_LIMIT_READ, "boltcard/keys/[registrationId]")
