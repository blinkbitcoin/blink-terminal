import type { NextApiRequest, NextApiResponse } from "next"

import { requireTrustedMutation } from "../../../lib/auth/mutation-guard"
import * as boltcardCrypto from "../../../lib/boltcard/crypto"
import * as lnurlp from "../../../lib/boltcard/lnurlp"
import * as lnurlw from "../../../lib/boltcard/lnurlw"
import { requireSessionPubkey } from "../../../lib/boltcard/owner-auth"
import boltcardStore from "../../../lib/boltcard/store"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"
import {
  getOwnedWallets,
  OWNERSHIP_UNAVAILABLE,
  toEnvironment,
} from "../../../lib/wallet-ownership"

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
 *   ownerPubkey?: string,   // Optional; must equal the session pubkey if sent
 *   walletId: string,       // Blink wallet ID (must match walletCurrency)
 *   apiKey: string,         // Blink API key that currently owns walletId
 *   name?: string,          // User-friendly card name
 *   walletCurrency?: string,// 'BTC' or 'USD' (default: 'BTC')
 *   maxTxAmount?: number,   // Per-transaction limit (sats/cents)
 *   dailyLimit?: number,    // Daily spending limit (sats/cents)
 *   initialBalance?: number,// Initial balance (sats/cents)
 *   environment?: string    // 'production' or 'staging'
 * }
 *
 * Requires the owner's Nostr session (auth-token cookie); the card's owner is
 * always the session pubkey. Card keys are only ever returned to that session
 * (direct flow) or via the single-use, expiring keys link (deeplink flow).
 */

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  // The owner is the authenticated Nostr session, never a request field.
  const ownerPubkey = requireSessionPubkey(req, res)
  if (!ownerPubkey) return
  // Cookie-authenticated mutation: same CSRF boundary as the network routes
  if (!requireTrustedMutation(req, res)) return

  try {
    const {
      cardUid,
      ownerPubkey: requestedOwnerPubkey,
      walletId,
      apiKey,
      name,
      walletCurrency = "BTC",
      maxTxAmount,
      dailyLimit,
      initialBalance = 0,
      environment: requestedEnvironment,
    } = (req.body ?? {}) as {
      cardUid?: string
      ownerPubkey?: string
      walletId?: string
      apiKey?: string
      name?: string
      walletCurrency?: string
      maxTxAmount?: string | number
      dailyLimit?: string | number
      initialBalance?: string | number
      environment?: unknown
    }
    const environment = toEnvironment(requestedEnvironment)

    if (
      requestedOwnerPubkey !== undefined &&
      String(requestedOwnerPubkey).toLowerCase() !== ownerPubkey
    ) {
      return res.status(403).json({ error: "ownerPubkey does not match the session" })
    }

    // Validate required fields
    if (
      !walletId ||
      !apiKey ||
      typeof walletId !== "string" ||
      typeof apiKey !== "string"
    ) {
      return res.status(400).json({
        error: "Missing required fields: walletId, apiKey",
      })
    }

    // Validate wallet currency
    if (walletCurrency !== "BTC" && walletCurrency !== "USD") {
      return res.status(400).json({
        error: "walletCurrency must be BTC or USD",
      })
    }

    // The API key (which the card will spend with) must currently own the
    // wallet, and the wallet must be of the card's currency. Checked live.
    const ownership = await getOwnedWallets(apiKey, environment)
    if (!ownership.ok) {
      return ownership.reason === "invalid"
        ? res.status(403).json({ error: "API key is not valid for this wallet" })
        : res.status(OWNERSHIP_UNAVAILABLE.status).json(OWNERSHIP_UNAVAILABLE.body)
    }
    const ownedWallet = ownership.wallets.get(walletId)
    if (!ownedWallet) {
      return res.status(403).json({ error: "API key is not valid for this wallet" })
    }
    const actualWalletCurrency = ownedWallet.walletCurrency
    if (actualWalletCurrency !== walletCurrency) {
      return res.status(400).json({ error: "walletCurrency does not match the wallet" })
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

      // The registration id / keys URL is a single-use capability: don't log it.
      console.log("Boltcard pending registration created:", {
        name: pending.name,
        walletCurrency: pending.walletCurrency,
        environment,
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
