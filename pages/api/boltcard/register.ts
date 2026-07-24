import type { NextApiRequest, NextApiResponse } from "next"

import * as boltcardCrypto from "../../../lib/boltcard/crypto"
import * as lnurlp from "../../../lib/boltcard/lnurlp"
import * as lnurlw from "../../../lib/boltcard/lnurlw"
import boltcardStore from "../../../lib/boltcard/store"
import type { EnvironmentName } from "../../../lib/config/api"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"

/**
 * API endpoint to register a new Boltcard
 *
 * Supports two registration flows:
 *
 * 1. DIRECT FLOW (UID known): Card UID is provided upfront
 *    POST with { cardUid, ownerPubkey, walletId, apiKey, ... }
 *    Returns: { success, card, keys, qrCodes }
 *
 * 2. DEEPLINK FLOW (UID unknown): Card UID discovered during programming
 *    POST with { ownerPubkey, walletId, apiKey, ... } (no cardUid)
 *    Returns: { success, pendingRegistration, deeplink, qrPayload }
 *
 *    The deeplink (boltcard://program?url=...) is shown as QR code.
 *    When NFC Programmer app scans it and reads the card, it POSTs
 *    the UID to /api/boltcard/keys/{registrationId} to get keys.
 *
 * POST /api/boltcard/register
 * Body: {
 *   cardUid?: string,       // Card UID (14 hex chars) - OPTIONAL for deeplink flow
 *   ownerPubkey: string,    // Owner's Nostr pubkey
 *   walletId: string,       // Blink wallet ID
 *   apiKey: string,         // Blink API key
 *   name?: string,          // User-friendly card name
 *   walletCurrency?: string,// 'BTC' or 'USD' (default: 'BTC')
 *   maxTxAmount?: number,   // Per-transaction limit (sats/cents)
 *   dailyLimit?: number,    // Daily spending limit (sats/cents)
 *   initialBalance?: number,// Initial balance (sats/cents)
 *   environment?: string    // 'production' or 'staging'
 * }
 */

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const {
      cardUid,
      ownerPubkey,
      walletId,
      apiKey,
      name,
      walletCurrency = "BTC",
      maxTxAmount,
      dailyLimit,
      initialBalance = 0,
      environment = "production",
    } = req.body as {
      cardUid?: string
      ownerPubkey?: string
      walletId?: string
      apiKey?: string
      name?: string
      walletCurrency?: string
      maxTxAmount?: string | number
      dailyLimit?: string | number
      initialBalance?: string | number
      environment?: EnvironmentName
    }

    // Validate required fields
    if (!ownerPubkey || !walletId || !apiKey) {
      return res.status(400).json({
        error: "Missing required fields: ownerPubkey, walletId, apiKey",
      })
    }

    // Validate wallet currency
    if (walletCurrency !== "BTC" && walletCurrency !== "USD") {
      return res.status(400).json({
        error: "walletCurrency must be BTC or USD",
      })
    }

    const serverUrl = getServerUrl(req)
    const options = {
      name,
      walletCurrency,
      maxTxAmount: maxTxAmount ? parseInt(maxTxAmount as string) : null,
      dailyLimit: dailyLimit ? parseInt(dailyLimit as string) : null,
      initialBalance: parseInt(initialBalance as string) || 0,
      environment,
    }

    // =============================================
    // DEEPLINK FLOW: cardUid not provided
    // =============================================
    if (!cardUid) {
      // Create pending registration
      const pending = await boltcardStore.createPendingRegistration(
        {
          ownerPubkey,
          walletId,
          apiKey,
        },
        options,
      )

      // Generate deeplink for NFC Programmer app
      const keysRequestUrl = `${serverUrl}/api/boltcard/keys/${pending.id}`
      const deeplink = boltcardCrypto.generateProgramDeeplink(keysRequestUrl)

      console.log("Boltcard pending registration created:", {
        registrationId: pending.id,
        name: pending.name,
        walletCurrency: pending.walletCurrency,
        environment,
        keysRequestUrl,
        deeplink,
        deeplinkLength: deeplink.length,
      })

      return res.status(200).json({
        success: true,
        flow: "deeplink",
        pendingRegistration: {
          id: pending.id,
          name: pending.name,
          walletCurrency: pending.walletCurrency,
          initialBalance: pending.initialBalance,
          status: pending.status,
          createdAt: pending.createdAt,
          expiresAt: pending.expiresAt,
        },
        // Deeplink for NFC Programmer app
        deeplink,
        keysRequestUrl,
        // QR code should contain the deeplink
        qrPayload: deeplink,
      })
    }

    // =============================================
    // DIRECT FLOW: cardUid provided
    // =============================================

    // Validate card UID format
    if (!/^[0-9a-fA-F]{14}$/.test(cardUid)) {
      return res.status(400).json({
        error: "Invalid cardUid format: expected 14 hex characters",
      })
    }

    // Create the card directly with spec-compliant key derivation
    const card = await boltcardStore.createCard(
      {
        cardUid,
        ownerPubkey,
        walletId,
        apiKey,
      },
      options,
    )

    if (!card) {
      return res.status(500).json({ error: "Failed to create card" })
    }

    // Get card with keys for response
    const cardWithKeys = await boltcardStore.getCard(card.id, true)

    if (!cardWithKeys) {
      return res.status(500).json({ error: "Failed to retrieve created card" })
    }

    // Generate QR codes for programming and top-up
    const qrCodes = generateCardQRs(serverUrl, cardWithKeys)

    console.log("Boltcard registered (direct):", {
      cardId: cardWithKeys.id,
      cardUid: cardWithKeys.cardUid,
      name: cardWithKeys.name,
      walletCurrency: cardWithKeys.walletCurrency,
      environment,
    })

    res.status(200).json({
      success: true,
      flow: "direct",
      card: {
        id: cardWithKeys.id,
        cardUid: cardWithKeys.cardUid,
        cardIdHash: cardWithKeys.cardIdHash,
        name: cardWithKeys.name,
        walletCurrency: cardWithKeys.walletCurrency,
        balance: cardWithKeys.balance,
        maxTxAmount: cardWithKeys.maxTxAmount,
        dailyLimit: cardWithKeys.dailyLimit,
        status: cardWithKeys.status,
        version: cardWithKeys.version,
        createdAt: cardWithKeys.createdAt,
      },
      // Include keys for NFC programmer app
      keys: {
        k0: cardWithKeys.k0,
        k1: cardWithKeys.k1,
        k2: cardWithKeys.k2,
        k3: cardWithKeys.k3,
        k4: cardWithKeys.k4,
      },
      // QR code data
      qrCodes,
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("Boltcard registration error:", error)

    // Handle duplicate card UID
    if (
      error instanceof Error &&
      error.message &&
      error.message.includes("already exists")
    ) {
      return res.status(409).json({
        error: error.message,
      })
    }

    res.status(500).json({
      error: "Failed to register boltcard",
      details: process.env.NODE_ENV === "development" ? errorMessage : undefined,
    })
  }
}

/**
 * Generate QR code data for card programming and top-up
 */
interface CardWithKeys {
  id: string
  cardUid: string
  cardIdHash: string
  name: string | null
  walletCurrency: string
  balance: number
  maxTxAmount: number | null
  dailyLimit: number | null
  status: string
  version: number
  createdAt: string | number
  k0?: string | null
  k1?: string | null
  k2?: string | null
  k3?: string | null
  k4?: string | null
}

function generateCardQRs(serverUrl: string, card: CardWithKeys) {
  // LNURL-withdraw URL (programmed into card)
  const lnurlwUrl = lnurlw.generateCardUrl(serverUrl, card.id)
  const lnurlwEncoded = lnurlw.encodeLnurl(lnurlwUrl)

  // Keys response for NFC Programmer (can be used in alternative flow)
  const keysResponse = boltcardCrypto.generateKeysResponse(lnurlwUrl, {
    k0: card.k0 ?? "",
    k1: card.k1 ?? "",
    k2: card.k2 ?? "",
    k3: card.k3 ?? "",
    k4: card.k4 ?? "",
  })

  // LNURL-pay for top-up
  const topUpQR = lnurlp.generateTopUpQR(serverUrl, card.id)

  return {
    programming: {
      // Keys in format for NFC Programmer app
      keysJson: JSON.stringify(keysResponse),
      // Individual values
      lnurlwUrl,
      keys: keysResponse,
    },
    topUp: topUpQR,
    card: {
      url: lnurlwUrl,
      lnurl: lnurlwEncoded,
    },
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

export default withRateLimit(handler, RATE_LIMIT_WRITE, "boltcard/register")
