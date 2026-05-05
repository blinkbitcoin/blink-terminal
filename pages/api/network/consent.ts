/**
 * Data Sharing Consent API
 *
 * GET: Check user's consent status for a community
 * POST: Submit data sharing consent with API key
 * DELETE: Revoke consent
 */

import type { NextApiRequest, NextApiResponse } from "next"

import AuthManager from "../../../lib/auth"
import BlinkAPI from "../../../lib/blink-api"
import * as db from "../../../lib/network/db"
import { withRateLimit, RATE_LIMIT_WRITE } from "../../../lib/rate-limit"

/**
 * Fetch Blink username using the provided API key
 */
async function fetchBlinkUsername(apiKey: string): Promise<string | null> {
  try {
    const blinkApi = new BlinkAPI(apiKey)
    const me = await blinkApi.getMe()
    return me?.username || null
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error fetching Blink username:", message)
    return null
  }
}

/**
 * Check if user is a member of the community (from database)
 * Super admins can share data with ANY community without being a member
 */
async function isUserMemberOfCommunity(
  userNpub: string,
  communityId: string,
): Promise<boolean> {
  try {
    // Super admins can share data with any community
    const isSuperAdmin = await db.isSuperAdmin(userNpub)
    if (isSuperAdmin) {
      return true
    }

    // Check if user is the community leader
    const community = await db.getCommunityById(communityId)
    if (community && community.leader_npub === userNpub) {
      return true
    }

    // Check if user has approved membership
    const membership = await db.getMembership(communityId, userNpub)
    return !!membership && membership.status === "approved"
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("Error checking membership:", message)
    return false
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userNpub = req.headers["x-user-npub"] as string | undefined

  if (!userNpub) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
    })
  }

  // GET - Check consent status
  if (req.method === "GET") {
    const { communityId } = req.query as { communityId?: string }

    try {
      if (communityId) {
        // Check specific community - use getConsentByUser with correct params
        const consent = await db.getConsentByUser(communityId, userNpub)
        return res.status(200).json({
          success: true,
          hasConsent: consent?.consent_given === true,
          consent: consent
            ? {
                id: consent.id,
                status: consent.consent_given ? "active" : "inactive",
                blink_username: consent.blink_username,
                consented_at: consent.consented_at,
              }
            : null,
        })
      } else {
        // Get all user consents - need to query across all communities
        const memberships = await db.getUserMemberships(userNpub)
        const consents: {
          id: string
          community_id: string
          status: string
          blink_username: string
          consented_at: string
        }[] = []

        for (const membership of memberships) {
          const consent = await db.getConsentByUser(membership.community_id, userNpub)
          if (consent) {
            consents.push({
              id: String(consent.id),
              community_id: String(membership.community_id),
              status: consent.consent_given ? "active" : "inactive",
              blink_username: consent.blink_username ?? "",
              consented_at: consent.consented_at ?? "",
            })
          }
        }

        return res.status(200).json({
          success: true,
          consents,
        })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("Error checking consent:", message)
      return res.status(500).json({
        success: false,
        error: "Failed to check consent status",
      })
    }
  }

  // POST - Submit consent
  if (req.method === "POST") {
    const { communityId, apiKey } = req.body as { communityId: string; apiKey: string }

    if (!communityId) {
      return res.status(400).json({
        success: false,
        error: "Community ID is required",
      })
    }

    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: "API key is required",
      })
    }

    // Validate API key format. Production keys start with "blink_";
    // staging/signet keys start with "galoy_staging_". The downstream
    // API call still verifies the key is valid for the given environment.
    const isValidKeyPrefix =
      apiKey.startsWith("blink_") || apiKey.startsWith("galoy_staging_")
    if (!isValidKeyPrefix) {
      return res.status(400).json({
        success: false,
        error: 'Invalid API key format. Expected "blink_..." or "galoy_staging_..."',
      })
    }

    try {
      // Check if user is a super admin
      const isSuperAdmin = await db.isSuperAdmin(userNpub)

      // Verify user is a member of this community (or super admin)
      const isMember = await isUserMemberOfCommunity(userNpub, communityId)
      if (!isMember) {
        return res.status(403).json({
          success: false,
          error: "You must be a member of this community to share data",
        })
      }

      // Get the membership to get the membershipId
      let membership = await db.getMembership(communityId, userNpub)

      // If super admin without membership, create one automatically
      if (!membership && isSuperAdmin) {
        console.log(
          `[Consent] Creating auto-membership for super admin ${userNpub.substring(0, 20)}...`,
        )
        // Get user's pubkey hex (we'll pass null since we might not have it)
        membership = await db.applyToJoinCommunity(
          communityId,
          userNpub,
          null as unknown as string,
          "Super admin auto-join for data sharing",
        )
        // Auto-approve the super admin
        if (membership) {
          membership = await db.reviewApplication(membership.id, userNpub, true, null)
        }
      }

      if (!membership) {
        return res.status(404).json({
          success: false,
          error: "Membership not found",
        })
      }

      // Check if already has consent
      const existing = await db.getConsentByUser(communityId, userNpub)
      if (existing?.consent_given === true) {
        return res.status(409).json({
          success: false,
          error: "You have already opted in for data sharing",
          consent: {
            blink_username: existing.blink_username,
            consented_at: existing.consented_at,
          },
        })
      }

      // Fetch Blink username to validate API key and get display name
      const blinkUsername = await fetchBlinkUsername(apiKey)
      if (!blinkUsername) {
        return res.status(400).json({
          success: false,
          error: "Invalid API key. Could not verify with Blink API.",
        })
      }

      // Encrypt and store
      const encryptedKey = AuthManager.encryptApiKey(apiKey)

      const consent = await db.createOrUpdateConsent(
        membership.id, // membershipId
        userNpub,
        communityId,
        {
          consentGiven: true,
          blinkApiKeyEncrypted: encryptedKey,
          blinkWalletIds: null, // Will be populated during sync
          blinkUsername: blinkUsername,
          syncFromDate: null, // Will use default (30 days ago)
        },
      )

      console.log(
        `[Consent] User ${userNpub.substring(0, 20)}... opted in for community ${communityId} as ${blinkUsername}`,
      )

      return res.status(200).json({
        success: true,
        message:
          "Data sharing enabled! Your transaction data will be included in community metrics.",
        consent: {
          id: consent.id,
          blink_username: consent.blink_username,
          consented_at: consent.consented_at,
        },
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("Error submitting consent:", message)
      return res.status(500).json({
        success: false,
        error: "Failed to submit consent",
      })
    }
  }

  // DELETE - Revoke consent
  if (req.method === "DELETE") {
    const { communityId } = req.query as { communityId?: string }

    if (!communityId) {
      return res.status(400).json({
        success: false,
        error: "Community ID is required",
      })
    }

    try {
      // Get the membership to get the membershipId
      const membership = await db.getMembership(communityId, userNpub)
      if (!membership) {
        return res.status(404).json({
          success: false,
          error: "Membership not found",
        })
      }

      // Revoke consent by setting consent_given to false
      const consent = await db.createOrUpdateConsent(
        membership.id, // membershipId
        userNpub,
        communityId,
        {
          consentGiven: false,
          blinkApiKeyEncrypted: null,
          blinkWalletIds: null,
          blinkUsername: null,
          syncFromDate: null,
        },
      )

      if (!consent) {
        return res.status(404).json({
          success: false,
          error: "No consent found to revoke",
        })
      }

      console.log(
        `[Consent] User ${userNpub.substring(0, 20)}... revoked consent for community ${communityId}`,
      )

      return res.status(200).json({
        success: true,
        message: "Data sharing disabled. Your API key has been removed.",
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("Error revoking consent:", message)
      return res.status(500).json({
        success: false,
        error: "Failed to revoke consent",
      })
    }
  }

  return res.status(405).json({ error: "Method not allowed" })
}

export default withRateLimit(handler, RATE_LIMIT_WRITE)
