/**
 * Leader Profiles API - Get Nostr profiles for community leaders
 *
 * GET: Get Nostr profile for a specific npub
 *
 * This endpoint is used to fetch profile pictures and metadata for community leaders.
 * Uses server-side caching to avoid repeated relay queries.
 */

import { bech32 } from "bech32"
import type { NextApiRequest, NextApiResponse } from "next"
import type WebSocket from "ws"

import { withRateLimit, RATE_LIMIT_READ } from "../../../lib/rate-limit"

// Default relays to query
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://purplepag.es"]

// Server-side cache for profiles
if (!global._networkProfileCache) {
  global._networkProfileCache = new Map()
}
const profileCache: Map<string, { profile: Record<string, unknown>; timestamp: number }> =
  global._networkProfileCache!
const CACHE_TTL = 10 * 60 * 1000 // 10 minutes

/**
 * Convert npub to hex pubkey
 */
function npubToHex(npub: string): string | null {
  if (!npub || !npub.startsWith("npub1")) {
    return null
  }

  try {
    const decoded = bech32.decode(npub)
    const pubkeyBytes = bech32.fromWords(decoded.words)
    return Buffer.from(pubkeyBytes).toString("hex")
  } catch (e: unknown) {
    console.error("[Profiles] Failed to decode npub:", e)
    return null
  }
}

/**
 * Fetch profile from Nostr relay
 */
async function fetchProfileFromRelay(
  pubkeyHex: string,
  relayUrl: string,
  timeoutMs: number = 5000,
): Promise<Record<string, unknown> | null> {
  // Dynamic import for WebSocket in Node.js
  let WSConstructor: typeof import("ws").WebSocket
  try {
    const wsModule = await import("ws")
    WSConstructor = wsModule.default ?? wsModule.WebSocket
  } catch (_e: unknown) {
    return null
  }

  return new Promise((resolve) => {
    let ws: WebSocket | undefined
    const timeout = setTimeout(() => {
      if (ws) ws.close()
      resolve(null)
    }, timeoutMs)

    try {
      const socket: WebSocket = new WSConstructor(relayUrl) as unknown as WebSocket
      ws = socket

      socket.on("open", () => {
        // Subscribe to kind 0 (metadata) events for this pubkey
        const subId = `profile_${Date.now()}`
        const filter = {
          kinds: [0],
          authors: [pubkeyHex],
          limit: 1,
        }
        socket.send(JSON.stringify(["REQ", subId, filter]))
      })

      socket.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg[0] === "EVENT" && msg[2]?.kind === 0) {
            const content = JSON.parse(msg[2].content)
            clearTimeout(timeout)
            socket.close()
            resolve(content)
          } else if (msg[0] === "EOSE") {
            // End of stored events - no profile found
            clearTimeout(timeout)
            socket.close()
            resolve(null)
          }
        } catch (_e: unknown) {
          // Ignore parse errors
        }
      })

      socket.on("error", () => {
        clearTimeout(timeout)
        resolve(null)
      })
    } catch (_e: unknown) {
      clearTimeout(timeout)
      resolve(null)
    }
  })
}

/**
 * Fetch profile from multiple relays
 */
async function fetchProfile(pubkeyHex: string): Promise<Record<string, unknown> | null> {
  // Try relays in sequence, return first success
  for (const relay of RELAYS) {
    try {
      const profile = await fetchProfileFromRelay(pubkeyHex, relay, 3000)
      if (profile) {
        return profile
      }
    } catch (_e: unknown) {
      // Continue to next relay
    }
  }
  return null
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const { npub } = req.query as { npub?: string }

  if (!npub) {
    return res.status(400).json({
      success: false,
      error: "npub parameter is required",
    })
  }

  try {
    // Check cache first
    const cached = profileCache.get(npub)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return res.status(200).json({
        success: true,
        profile: cached.profile,
        cached: true,
      })
    }

    // Convert npub to hex
    const pubkeyHex = npubToHex(npub)
    if (!pubkeyHex) {
      return res.status(400).json({
        success: false,
        error: "Invalid npub format",
      })
    }

    console.log(`[Profiles] Fetching profile for ${npub.substring(0, 20)}...`)

    // Fetch from relays
    const profile = await fetchProfile(pubkeyHex)

    // Cache the result (even if null, to avoid repeated queries)
    profileCache.set(npub, {
      profile: profile || {},
      timestamp: Date.now(),
    })

    return res.status(200).json({
      success: true,
      profile: profile || {},
      cached: false,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[Profiles] Error fetching profile:", message)
    return res.status(500).json({
      success: false,
      error: "Failed to fetch profile",
    })
  }
}

export default withRateLimit(handler, RATE_LIMIT_READ, "network/profiles")
