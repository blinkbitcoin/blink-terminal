/**
 * User Sync API
 *
 * Unified endpoint for cross-device sync of all user data:
 * - Blink API Key wallets (encrypted)
 * - Blink Lightning Address wallets
 * - npub.cash wallets (Cashu ecash via LNURL-pay)
 * - NWC connections (encrypted)
 * - Voucher Wallet (encrypted API key)
 * - UI preferences
 *
 * This complements the existing endpoints:
 * - /api/split-profiles (Split Payment Profiles)
 *
 * SECURITY: All requests require NIP-98 session authentication.
 * Pubkey-only access has been removed to prevent API key theft.
 *
 * Endpoints:
 * - GET: Retrieve all synced data for user
 * - POST: Save/update synced data
 * - PATCH: Partial update (specific fields only)
 */

import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"
import StorageManager from "../../../lib/storage"

/** Blink API account shape for sync */
interface BlinkApiAccount {
  id: string
  label: string
  username: string
  apiKey: string
  defaultCurrency?: string
  isActive?: boolean
  createdAt?: string
  lastUsed?: string
}

/** NWC connection shape for sync */
interface NWCConnection {
  uri: string
  [key: string]: unknown
}

/** Blink Lightning Address wallet shape */
interface BlinkLnAddressWallet {
  id: string
  label: string
  username: string
  lightningAddress: string
  walletId: string
  isActive?: boolean
  createdAt?: string
  lastUsed?: string
}

/** npub.cash wallet shape */
interface NpubCashWallet {
  id: string
  label: string
  address: string
  lightningAddress?: string
  localpart?: string
  isNpub?: boolean
  pubkey?: string
  isActive?: boolean
  createdAt?: string
  lastUsed?: string
}

/** User preferences shape */
interface UserPreferences {
  soundEnabled?: boolean
  soundTheme?: string
  darkMode?: boolean
  displayCurrency?: string
  tipsEnabled?: boolean
  tipPresets?: number[]
  voucherCurrencyMode?: string
  [key: string]: unknown
}

/** Voucher wallet shape */
interface VoucherWalletData {
  label?: string
  username?: string
  userId?: string
  walletId?: string
  apiKey?: string
  displayCurrency?: string
  scopes?: string[]
  createdAt?: string
  lastUsed?: string
}

/** Split profile shape */
interface _SplitProfile {
  id: string
  label: string
  recipients: Array<{ username: string; share?: number }>
  createdAt?: string
  updatedAt?: string
}

/**
 * Verify request has valid NIP-98 session
 * SECURITY: No longer accepts pubkey-only authentication
 */
function verifySession(req: NextApiRequest): {
  valid: boolean
  pubkey?: string
  username?: string
  error?: string
} {
  const token = req.cookies?.["auth-token"]

  if (!token) {
    return { valid: false, error: "Authentication required - no session token" }
  }

  const session = AuthManager.verifySession(token)

  if (!session) {
    return { valid: false, error: "Invalid or expired session" }
  }

  if (!session.username?.startsWith("nostr:")) {
    return { valid: false, error: "Not a Nostr session" }
  }

  const pubkey = session.username.replace("nostr:", "")
  return { valid: true, pubkey, username: session.username }
}

/**
 * Encrypt sensitive data (NWC URIs, API keys)
 */
function encryptSensitiveData(data: string | null | undefined): string | null {
  if (!data) return null
  return AuthManager.encryptApiKey(data)
}

/**
 * Decrypt sensitive data (NWC URIs, API keys)
 */
function decryptSensitiveData(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null
  return AuthManager.decryptApiKey(encrypted)
}

// Aliases for backwards compatibility
const encryptNWCUri = encryptSensitiveData
const decryptNWCUri = decryptSensitiveData

async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log("[user/sync] Request method:", req.method)

  // SECURITY: Require NIP-98 session authentication
  // Pubkey-only access has been removed to prevent API key/NWC URI theft
  const verification = verifySession(req)

  if (!verification.valid) {
    // Log attempted unauthenticated access
    const attemptedPubkey = (req.query?.pubkey || req.body?.pubkey) as string | undefined
    if (attemptedPubkey) {
      console.warn(
        "[user/sync] BLOCKED: Unauthenticated access attempt for pubkey:",
        attemptedPubkey?.substring(0, 8),
      )
    }
    return res.status(401).json({ error: verification.error })
  }

  const { pubkey, username } = verification
  console.log("[user/sync] Authenticated user:", username)

  try {
    switch (req.method) {
      case "GET":
        return handleGet(req, res, pubkey!, username!)
      case "POST":
        return handlePost(req, res, pubkey!, username!)
      case "PATCH":
        return handlePatch(req, res, pubkey!, username!)
      default:
        return res.status(405).json({ error: "Method not allowed" })
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[user/sync] Error:", error)
    return res.status(500).json({
      error: "Server error",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "user/sync")

/**
 * GET - Retrieve all synced data
 */
async function handleGet(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  console.log("[user/sync] GET for user:", username)

  const userData = await StorageManager.loadUserData(username)

  if (!userData) {
    return res.status(200).json({
      pubkey,
      blinkApiAccounts: [],
      blinkLnAddressWallets: [],
      npubCashWallets: [],
      nwcConnections: [],
      voucherWallet: null,
      preferences: getDefaultPreferences(),
    })
  }

  // Decrypt Blink API account API keys for the client
  const blinkApiAccounts = ((userData.blinkApiAccounts || []) as BlinkApiAccount[]).map(
    (account: BlinkApiAccount) => ({
      ...account,
      apiKey: decryptSensitiveData(account.apiKey),
    }),
  )

  // Decrypt NWC connection URIs for the client
  const nwcConnections = ((userData.nwcConnections || []) as NWCConnection[]).map(
    (conn: NWCConnection) => ({
      ...conn,
      uri: decryptNWCUri(conn.uri),
    }),
  )

  // Decrypt Voucher Wallet API key for the client
  let voucherWallet = null
  if (userData.voucherWallet) {
    const vw = userData.voucherWallet as VoucherWalletData
    const encryptedApiKey = vw.apiKey
    const decryptedApiKey = decryptSensitiveData(encryptedApiKey)
    console.log(
      "[user/sync] voucherWallet found, encrypted apiKey length:",
      encryptedApiKey?.length || 0,
    )
    console.log(
      "[user/sync] Decrypted apiKey result:",
      decryptedApiKey
        ? `success (${decryptedApiKey.length} chars)`
        : "FAILED - null/empty",
    )

    voucherWallet = {
      ...userData.voucherWallet,
      apiKey: decryptedApiKey,
    }
  } else {
    console.log("[user/sync] No voucherWallet in userData")
  }

  return res.status(200).json({
    pubkey,
    blinkApiAccounts,
    blinkLnAddressWallets: userData.blinkLnAddressWallets || [],
    npubCashWallets: userData.npubCashWallets || [],
    nwcConnections,
    voucherWallet,
    preferences: userData.preferences || getDefaultPreferences(),
    transactionLabels: userData.transactionLabels || {},
    lastSynced: userData.lastSynced || null,
  })
}

/**
 * POST - Save/replace all synced data
 */
async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  console.log("[user/sync] POST for user:", username)

  const { blinkApiAccounts, blinkLnAddressWallets, nwcConnections, preferences } =
    req.body as {
      blinkApiAccounts?: BlinkApiAccount[]
      blinkLnAddressWallets?: BlinkLnAddressWallet[]
      nwcConnections?: NWCConnection[]
      preferences?: UserPreferences
    }

  // Load existing data to preserve non-synced fields
  const existingData = (await StorageManager.loadUserData(username)) || {}

  // Encrypt Blink API account API keys before storage
  const encryptedBlinkApiAccounts = (blinkApiAccounts || []).map(
    (account: BlinkApiAccount) => ({
      id: account.id,
      label: account.label,
      username: account.username,
      apiKey: encryptSensitiveData(account.apiKey),
      defaultCurrency: account.defaultCurrency || "BTC",
      isActive: !!account.isActive,
      createdAt: account.createdAt || new Date().toISOString(),
      lastUsed: account.lastUsed,
    }),
  )

  // Encrypt NWC connection URIs before storage
  const encryptedNWCConnections = (nwcConnections || []).map((conn: NWCConnection) => ({
    ...conn,
    uri: encryptNWCUri(conn.uri),
  }))

  // Validate and sanitize Blink LN Address wallets
  const sanitizedLnAddressWallets = (blinkLnAddressWallets || []).map(
    (wallet: BlinkLnAddressWallet) => ({
      id: wallet.id,
      label: wallet.label,
      username: wallet.username,
      lightningAddress: wallet.lightningAddress,
      walletId: wallet.walletId,
      isActive: !!wallet.isActive,
      createdAt: wallet.createdAt || new Date().toISOString(),
      lastUsed: wallet.lastUsed,
    }),
  )

  // Merge preferences with defaults
  const mergedPreferences = {
    ...getDefaultPreferences(),
    ...(preferences || {}),
  }

  const saveResult = await StorageManager.saveUserData(username, {
    ...existingData,
    blinkApiAccounts: encryptedBlinkApiAccounts,
    blinkLnAddressWallets: sanitizedLnAddressWallets,
    nwcConnections: encryptedNWCConnections,
    preferences: mergedPreferences,
    lastSynced: new Date().toISOString(),
  })

  if (!saveResult) {
    return res.status(500).json({ error: "Failed to save data" })
  }

  console.log("[user/sync] ✓ Data saved successfully")

  return res.status(200).json({
    success: true,
    lastSynced: new Date().toISOString(),
  })
}

/**
 * PATCH - Partial update (specific fields only)
 */
async function handlePatch(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  console.log("[user/sync] PATCH for user:", username)

  const { field, data } = req.body as { field: string; data: unknown }

  const validFields = [
    "blinkApiAccounts",
    "blinkLnAddressWallets",
    "npubCashWallets",
    "nwcConnections",
    "voucherWallet",
    "preferences",
    "transactionLabels",
  ]
  if (!field || !validFields.includes(field)) {
    return res
      .status(400)
      .json({ error: `Invalid field. Must be one of: ${validFields.join(", ")}` })
  }

  // Load existing data
  const existingData = (await StorageManager.loadUserData(username)) || {}

  let processedData = data

  // Special handling for Blink API accounts - encrypt API keys
  if (field === "blinkApiAccounts" && Array.isArray(data)) {
    processedData = (data as BlinkApiAccount[]).map((account) => ({
      id: account.id,
      label: account.label,
      username: account.username,
      apiKey: encryptSensitiveData(account.apiKey),
      defaultCurrency: account.defaultCurrency || "BTC",
      isActive: !!account.isActive,
      createdAt: account.createdAt || new Date().toISOString(),
      lastUsed: account.lastUsed,
    }))
  }

  // Special handling for NWC connections - encrypt URIs
  if (field === "nwcConnections" && Array.isArray(data)) {
    processedData = (data as NWCConnection[]).map((conn) => ({
      ...conn,
      uri: encryptNWCUri(conn.uri),
    }))
  }

  // Special handling for npub.cash wallets - sanitize data
  if (field === "npubCashWallets" && Array.isArray(data)) {
    processedData = (data as NpubCashWallet[]).map((wallet) => ({
      id: wallet.id,
      label: wallet.label,
      address: wallet.address,
      lightningAddress: wallet.lightningAddress || wallet.address,
      localpart: wallet.localpart,
      isNpub: !!wallet.isNpub,
      pubkey: wallet.pubkey,
      isActive: !!wallet.isActive,
      createdAt: wallet.createdAt || new Date().toISOString(),
      lastUsed: wallet.lastUsed,
    }))
  }

  // Special handling for preferences - merge with defaults
  if (field === "preferences") {
    processedData = {
      ...getDefaultPreferences(),
      ...(existingData.preferences || {}),
      ...((data as UserPreferences) || {}),
    }
  }

  // Special handling for voucherWallet - encrypt API key
  if (field === "voucherWallet") {
    if (data === null) {
      // Allow deletion of voucher wallet
      processedData = null
    } else if (data && typeof data === "object") {
      const vw = data as VoucherWalletData
      processedData = {
        label: vw.label || "Voucher Wallet",
        username: vw.username,
        userId: vw.userId,
        walletId: vw.walletId,
        apiKey: encryptSensitiveData(vw.apiKey),
        displayCurrency: vw.displayCurrency || "BTC",
        scopes: vw.scopes || [],
        createdAt: vw.createdAt || new Date().toISOString(),
        lastUsed: vw.lastUsed,
      }
    }
  }

  const saveResult = await StorageManager.saveUserData(username, {
    ...existingData,
    [field]: processedData,
    lastSynced: new Date().toISOString(),
  })

  if (!saveResult) {
    return res.status(500).json({ error: "Failed to save data" })
  }

  console.log(`[user/sync] ✓ Field '${field}' updated successfully`)

  return res.status(200).json({
    success: true,
    field,
    lastSynced: new Date().toISOString(),
  })
}

/**
 * Default preferences
 */
function getDefaultPreferences() {
  return {
    soundEnabled: true,
    soundTheme: "success",
    darkMode: false,
    displayCurrency: "BTC",
    tipsEnabled: false,
    tipPresets: [7.5, 10, 12.5, 20],
    voucherCurrencyMode: "BTC", // 'BTC' for Bitcoin vouchers, 'USD' for Dollar/Stablesats vouchers
  }
}
