/**
 * Cart Items API
 *
 * Stores and retrieves user's saved cart items (product catalog)
 * Items are saved per-user and synced cross-device.
 *
 * Each item has:
 * - id: unique identifier
 * - name: item name (e.g., "Ice Cream")
 * - price: price in user's display currency (e.g., 1.00)
 * - currency: the display currency used when creating the item (e.g., "USD")
 * - createdAt: timestamp
 *
 * SECURITY: All requests require NIP-98 session authentication.
 * Pubkey-only access has been removed for consistency.
 *
 * Endpoints:
 * - GET: Retrieve all cart items for user
 * - POST: Add a new cart item
 * - DELETE: Remove a cart item by id
 * - PATCH: Update an existing cart item
 */

import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"
import StorageManager from "../../../lib/storage"

/** Cart item shape */
interface CartItem {
  id: string
  name: string
  price: number
  currency: string
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
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

async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log("[cart-items] Request method:", req.method)

  // SECURITY: Require NIP-98 session authentication
  const verification = verifySession(req)

  if (!verification.valid) {
    const attemptedPubkey = (req.query?.pubkey || req.body?.pubkey) as string | undefined
    if (attemptedPubkey) {
      console.warn(
        "[cart-items] BLOCKED: Unauthenticated access attempt for pubkey:",
        attemptedPubkey?.substring(0, 8),
      )
    }
    return res.status(401).json({ error: verification.error })
  }

  const { pubkey, username } = verification
  console.log("[cart-items] Authenticated user:", username)

  try {
    switch (req.method) {
      case "GET":
        return handleGet(req, res, pubkey!, username!)
      case "POST":
        return handlePost(req, res, pubkey!, username!)
      case "DELETE":
        return handleDelete(req, res, pubkey!, username!)
      case "PATCH":
        return handlePatch(req, res, pubkey!, username!)
      default:
        return res.status(405).json({ error: "Method not allowed" })
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[cart-items] Error:", error)
    return res.status(500).json({
      error: "Server error",
      details: process.env.NODE_ENV === "development" ? message : undefined,
    })
  }
}

/**
 * GET - Retrieve all cart items
 */
async function handleGet(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  console.log("[cart-items] GET for user:", username)

  const userData = await StorageManager.loadUserData(username)

  const cartItems = userData?.cartItems || []

  return res.status(200).json({
    success: true,
    cartItems,
  })
}

/**
 * POST - Add a new cart item
 */
async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  console.log("[cart-items] POST for user:", username)

  const { name, price, currency } = req.body as {
    name: string
    price: number | string
    currency: string
  }

  // Validate required fields
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return res.status(400).json({ error: "Item name is required" })
  }

  if (
    price === undefined ||
    price === null ||
    isNaN(parseFloat(String(price))) ||
    parseFloat(String(price)) <= 0
  ) {
    return res.status(400).json({ error: "Valid price is required" })
  }

  if (!currency || typeof currency !== "string") {
    return res.status(400).json({ error: "Currency is required" })
  }

  // Load existing data
  const userData = (await StorageManager.loadUserData(username)) || {}
  const cartItems = (userData.cartItems || []) as CartItem[]

  // Create new item
  const newItem = {
    id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: name.trim(),
    price: parseFloat(String(price)),
    currency: currency.toUpperCase(),
    createdAt: new Date().toISOString(),
  }

  // Add to cart items
  cartItems.push(newItem)

  // Save
  const saveResult = await StorageManager.saveUserData(username, {
    ...userData,
    cartItems,
    lastSynced: new Date().toISOString(),
  })

  if (!saveResult) {
    return res.status(500).json({ error: "Failed to save cart item" })
  }

  console.log("[cart-items] ✓ Item added:", newItem.id)

  return res.status(201).json({
    success: true,
    item: newItem,
  })
}

/**
 * DELETE - Remove a cart item
 */
async function handleDelete(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  console.log("[cart-items] DELETE for user:", username)

  const { itemId } = req.body as { itemId: string }

  if (!itemId) {
    return res.status(400).json({ error: "Item ID is required" })
  }

  // Load existing data
  const userData = (await StorageManager.loadUserData(username)) || {}
  const cartItems = (userData.cartItems || []) as CartItem[]

  // Find and remove item
  const itemIndex = cartItems.findIndex((item: { id: string }) => item.id === itemId)

  if (itemIndex === -1) {
    return res.status(404).json({ error: "Item not found" })
  }

  cartItems.splice(itemIndex, 1)

  // Save
  const saveResult = await StorageManager.saveUserData(username, {
    ...userData,
    cartItems,
    lastSynced: new Date().toISOString(),
  })

  if (!saveResult) {
    return res.status(500).json({ error: "Failed to delete cart item" })
  }

  console.log("[cart-items] ✓ Item deleted:", itemId)

  return res.status(200).json({
    success: true,
    deletedId: itemId,
  })
}

/**
 * PATCH - Update an existing cart item
 */
async function handlePatch(
  req: NextApiRequest,
  res: NextApiResponse,
  pubkey: string,
  username: string,
) {
  console.log("[cart-items] PATCH for user:", username)

  const { itemId, name, price, currency } = req.body as {
    itemId: string
    name?: string
    price?: number | string
    currency?: string
  }

  if (!itemId) {
    return res.status(400).json({ error: "Item ID is required" })
  }

  // Load existing data
  const userData = (await StorageManager.loadUserData(username)) || {}
  const cartItems = (userData.cartItems || []) as CartItem[]

  // Find item
  const itemIndex = cartItems.findIndex((item: { id: string }) => item.id === itemId)

  if (itemIndex === -1) {
    return res.status(404).json({ error: "Item not found" })
  }

  // Update fields if provided
  if (name !== undefined && name.trim().length > 0) {
    cartItems[itemIndex].name = name.trim()
  }

  if (
    price !== undefined &&
    !isNaN(parseFloat(String(price))) &&
    parseFloat(String(price)) > 0
  ) {
    cartItems[itemIndex].price = parseFloat(String(price))
  }

  if (currency !== undefined && currency.trim().length > 0) {
    cartItems[itemIndex].currency = currency.toUpperCase()
  }

  cartItems[itemIndex].updatedAt = new Date().toISOString()

  // Save
  const saveResult = await StorageManager.saveUserData(username, {
    ...userData,
    cartItems,
    lastSynced: new Date().toISOString(),
  })

  if (!saveResult) {
    return res.status(500).json({ error: "Failed to update cart item" })
  }

  console.log("[cart-items] ✓ Item updated:", itemId)

  return res.status(200).json({
    success: true,
    item: cartItems[itemIndex],
  })
}

export default withRateLimit(handler, RATE_LIMIT_READ, "user/cart-items")
