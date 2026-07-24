import { bech32 } from "bech32"
import { useState, useEffect, forwardRef, useImperativeHandle, useMemo } from "react"

import type { NostrProfile } from "../lib/nostr/NostrProfileService"

/**
 * Network Component - Bitcoin Circular Economy Dashboard
 *
 * Views:
 * 1. Discovery - Browse and join communities
 * 2. My Communities - View communities user is part of
 * 3. Community Dashboard - Metrics, leaderboard, activity for a community
 * 4. Leader Dashboard - Manage applications (if user is a leader)
 * 5. Create Community - Create new community (whitelisted leaders only)
 */

interface BitcoinPreference {
  btc_preference_pct: number | null
  total_btc_sats: number
  total_stablesats_sats: number
  total_balance_sats?: number
  members_with_balance: number
}

interface NetworkCommunity {
  id: string
  name: string
  slug: string
  description: string | null
  country_code: string | null
  region: string | null
  city: string | null
  latitude: number
  longitude: number
  leader_npub: string
  member_count: number
  data_sharing_member_count: number
  status: string
  created_at: string
  transaction_count: number
  transaction_volume_sats: number
  intra_community_count: number
  intra_volume_sats: number
  closed_loop_ratio: number
  velocity: number
  avg_tx_size: number
  period_start: string | null
  period_end: string | null
  metrics_last_updated: string | null
  bitcoin_preference: BitcoinPreference | null
  oldest_tx_date?: string | null
  newest_tx_date?: string | null
  period_days?: number
  tx_count_growth_percent?: number
}

interface UserMembership {
  id: number | null
  community_id: string
  community_name: string
  community_slug: string
  user_npub?: string
  role: string
  status: string
  member_count?: number
  data_sharing_member_count?: number
  applied_at: string | null
  approved_at: string | null
  consent_given: boolean
  sync_status?: string | null
  last_sync_at?: string | null
}

interface LeaderboardEntry {
  id: string
  name: string
  slug: string
  country_code: string | null
  city: string | null
  leader_npub: string
  member_count: number
  data_sharing_count: number
  transaction_count: number
  transaction_volume_sats: number
  intra_community_count: number
  closed_loop_ratio: number
  velocity: number
  avg_tx_size: number
  btc_preference_pct: number | null
  milestones: Array<{ type: string; threshold: number; badge: string; label: string }>
  rank: number
}

interface PendingApplication {
  id: number
  community_id: string
  user_npub: string
  status: string
  application_note: string | null
  applied_at: string
  reviewed_by?: string | null
  reviewed_at?: string | null
}

interface CommunityMember {
  id: number
  user_npub: string
  role: string
  status: string
  application_note: string | null
  applied_at: string
  approved_at: string | null
  approved_by: string | null
  consent_given: boolean
  blink_username: string | null
  total_transactions_synced: number
}

interface UserConsent {
  id: number
  community_id: string
  status: string
  blink_username: string | null
  consented_at: string | null
}

interface NetworkSyncResult {
  success: boolean
  community_id: string
  members_synced: number
  total_members: number
  total_transactions: number
  new_transactions?: number
  internal_transactions_marked?: number
  metrics: unknown
  message?: string
}

interface PeriodMetricsData {
  community_id: string
  period: string
  period_label: string
  period_start: string
  period_end: string
  transaction_count: number
  total_volume_sats: number
  intra_community_count: number
  intra_volume_sats?: number
  unique_members: number
  closed_loop_ratio: number
  velocity: number
  avg_tx_size?: number
  total_synced_txs: number
  bitcoin_preference: BitcoinPreference | null
}

interface DataCoverage {
  oldest_transaction: string | null
  newest_transaction: string | null
  total_synced_transactions: number
}

interface CoverageWarning {
  type: string
  message: string
  data_starts?: string
  period_starts?: string
  data_ends?: string
  period_ends?: string
}

interface NetworkProps {
  publicKey: string | null
  nostrProfile: NostrProfile | null
  darkMode: boolean
  toggleDarkMode?: () => void
  onInternalTransition?: () => void
  hideHeader?: boolean
}

interface NetworkRef {
  getCurrentView: () => string
  navigateBack: () => boolean
}

/**
 * Fetch Nostr profiles for a list of npubs in parallel.
 * Returns a map of npub -> profile for the successful fetches only, so the
 * caller can merge them into state with a single update.
 */
async function fetchProfilesBatch(
  npubs: string[],
): Promise<Record<string, NostrProfile>> {
  const results = await Promise.all(
    npubs.map(async (npub) => {
      try {
        const response = await fetch(
          `/api/network/profiles?npub=${encodeURIComponent(npub)}`,
        )
        const data = await response.json()
        if (data.success && data.profile) {
          return [npub, data.profile as NostrProfile] as const
        }
      } catch (err: unknown) {
        console.error(`Error fetching profile for ${npub}:`, err)
      }
      return null
    }),
  )

  return Object.fromEntries(results.filter((r) => r !== null))
}

/**
 * Convert hex public key to npub format
 * @param hexPubkey - 64 character hex public key
 * @returns npub encoded key or null if invalid
 */
function hexToNpub(hexPubkey: string | null): string | null {
  if (!hexPubkey || typeof hexPubkey !== "string") return null

  // If already npub format, return as-is
  if (hexPubkey.startsWith("npub1")) return hexPubkey

  // Validate hex format (64 characters)
  if (!/^[0-9a-fA-F]{64}$/.test(hexPubkey)) return null

  try {
    // Convert hex to bytes
    const bytes: number[] = []
    for (let i = 0; i < hexPubkey.length; i += 2) {
      bytes.push(parseInt(hexPubkey.substr(i, 2), 16))
    }

    // Encode as bech32 with 'npub' prefix
    const words = bech32.toWords(new Uint8Array(bytes))
    return bech32.encode("npub", words)
  } catch (e) {
    console.error("Error converting hex to npub:", e)
    return null
  }
}

const Network = forwardRef<NetworkRef, NetworkProps>(
  (
    {
      publicKey, // Nostr public key (hex or npub format)
      nostrProfile: _nostrProfile, // Nostr profile with picture, name, display_name
      darkMode: _darkMode,
      toggleDarkMode: _toggleDarkMode,
      onInternalTransition,
      hideHeader = false,
    },
    ref,
  ) => {
    // Convert publicKey (hex) to npub format for API calls
    const npubKey = useMemo(() => hexToNpub(publicKey), [publicKey])

    // View state
    const [currentView, setCurrentView] = useState<string>("discovery") // discovery, my-communities, most-active, community, leader, create
    const [selectedCommunity, setSelectedCommunity] = useState<NetworkCommunity | null>(
      null,
    )

    // Data state
    const [communities, setCommunities] = useState<NetworkCommunity[]>([])
    const [myMemberships, setMyMemberships] = useState<UserMembership[]>([])
    const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
    const [pendingApplications, setPendingApplications] = useState<PendingApplication[]>(
      [],
    )
    const [leaderProfiles, setLeaderProfiles] = useState<Record<string, NostrProfile>>({}) // npub -> profile data
    const [userConsents, setUserConsents] = useState<Record<string, UserConsent>>({}) // communityId -> consent data

    // UI state
    const [loading, setLoading] = useState<boolean>(true)
    const [error, setError] = useState<string>("")
    const [searchQuery, setSearchQuery] = useState<string>("")

    // Consent modal state
    const [showConsentModal, setShowConsentModal] = useState<boolean>(false)
    const [consentCommunity, setConsentCommunity] = useState<NetworkCommunity | null>(
      null,
    )
    const [consentApiKey, setConsentApiKey] = useState<string>("")
    const [submittingConsent, setSubmittingConsent] = useState<boolean>(false)

    // Sync state
    const [syncing, setSyncing] = useState<boolean>(false)
    const [syncResult, setSyncResult] = useState<NetworkSyncResult | null>(null)

    // Period filter state
    const [selectedPeriod, setSelectedPeriod] = useState<string>("current_week")
    const [periodMetrics, setPeriodMetrics] = useState<PeriodMetricsData | null>(null)
    const [dataCoverage, setDataCoverage] = useState<DataCoverage | null>(null)
    const [coverageWarning, setCoverageWarning] = useState<CoverageWarning | null>(null)
    const [loadingMetrics, setLoadingMetrics] = useState<boolean>(false)

    const [isSuperAdmin, setIsSuperAdmin] = useState<boolean>(false)
    const [_isWhitelistedLeader, setIsWhitelistedLeader] = useState<boolean>(false)
    const [_userRole, setUserRole] = useState<string>("user") // super_admin, community_leader, user

    // Application form state
    const [showApplyModal, setShowApplyModal] = useState<boolean>(false)
    const [applicationNote, setApplicationNote] = useState<string>("")
    const [applyingTo, setApplyingTo] = useState<NetworkCommunity | null>(null)
    const [submitting, setSubmitting] = useState<boolean>(false)

    // Member management state (for leaders)
    const [communityMembers, setCommunityMembers] = useState<CommunityMember[]>([])
    const [memberProfiles, setMemberProfiles] = useState<Record<string, NostrProfile>>({}) // npub -> profile data
    const [loadingMembers, setLoadingMembers] = useState<boolean>(false)
    const [removingMemberId, setRemovingMemberId] = useState<number | null>(null)
    const [showRemoveConfirm, setShowRemoveConfirm] = useState<number | null>(null) // membership id to confirm removal

    // Fetch communities on mount
    useEffect(() => {
      fetchCommunities()
      if (npubKey) {
        fetchMyMemberships()
        checkWhitelistStatus()
        fetchPendingApplications() // For leaders to see pending applications
        fetchUserConsents() // Check user's data sharing consents
      }
    }, [npubKey])

    // Fetch leaderboard data
    useEffect(() => {
      fetchLeaderboard()
    }, [])

    // Fetch period metrics when community or period changes
    useEffect(() => {
      if (selectedCommunity?.id && currentView === "community") {
        fetchPeriodMetrics(selectedCommunity.id, selectedPeriod)
      }
    }, [selectedCommunity?.id, selectedPeriod, currentView])

    // Fetch community members when viewing leader dashboard
    useEffect(() => {
      if (selectedCommunity?.id && currentView === "leader") {
        fetchCommunityMembers(selectedCommunity.id)
      }
    }, [selectedCommunity?.id, currentView])

    const fetchCommunities = async () => {
      try {
        setLoading(true)
        const response = await fetch("/api/network/communities")
        const data = await response.json()

        if (data.success) {
          const communitiesList = data.communities || []
          setCommunities(communitiesList)

          // Fetch leader profiles for all communities
          fetchLeaderProfiles(communitiesList)
        } else {
          throw new Error(data.error || "Failed to fetch communities")
        }
      } catch (err: unknown) {
        console.error("Error fetching communities:", err)
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    }

    // Fetch Nostr profiles for community leaders (in parallel, merged in one
    // state update — previously one awaited request + setState per leader)
    const fetchLeaderProfiles = async (communitiesList: NetworkCommunity[]) => {
      const uniqueLeaders = [
        ...new Set(communitiesList.map((c) => c.leader_npub).filter(Boolean)),
      ].filter((npub) => !leaderProfiles[npub])

      const fetched = await fetchProfilesBatch(uniqueLeaders)
      if (Object.keys(fetched).length > 0) {
        setLeaderProfiles((prev) => ({ ...prev, ...fetched }))
      }
    }

    // Fetch user's consent status for all communities
    const fetchUserConsents = async () => {
      if (!npubKey) return

      try {
        const response = await fetch("/api/network/consent", {
          headers: {
            "X-User-Npub": npubKey,
          },
        })
        const data = await response.json()

        if (data.success && data.consents) {
          const consentsMap: Record<string, UserConsent> = {}
          ;(data.consents as UserConsent[]).forEach((c) => {
            consentsMap[c.community_id] = c
          })
          setUserConsents(consentsMap)
        }
      } catch (err: unknown) {
        console.error("Error fetching consents:", err)
      }
    }

    // Submit data sharing consent
    const submitConsent = async () => {
      if (!npubKey || !consentCommunity || !consentApiKey) return

      setSubmittingConsent(true)
      setError("")

      try {
        const response = await fetch("/api/network/consent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Npub": npubKey,
          },
          body: JSON.stringify({
            communityId: consentCommunity.id,
            apiKey: consentApiKey,
          }),
        })

        const data = await response.json()

        if (data.success) {
          // Update local state
          setUserConsents((prev) => ({
            ...prev,
            [consentCommunity.id]: {
              ...data.consent,
              community_id: consentCommunity.id,
              status: "active",
            },
          }))

          setShowConsentModal(false)
          setConsentCommunity(null)
          setConsentApiKey("")
        } else {
          throw new Error(data.error || "Failed to submit consent")
        }
      } catch (err: unknown) {
        console.error("Error submitting consent:", err)
        setError((err as Error).message)
      } finally {
        setSubmittingConsent(false)
      }
    }

    // Revoke data sharing consent
    const revokeConsent = async (communityId: string) => {
      if (!npubKey) return

      try {
        const response = await fetch(`/api/network/consent?communityId=${communityId}`, {
          method: "DELETE",
          headers: {
            "X-User-Npub": npubKey,
          },
        })

        const data = await response.json()

        if (data.success) {
          setUserConsents((prev) => {
            const updated = { ...prev }
            if (updated[communityId]) {
              updated[communityId] = { ...updated[communityId], status: "revoked" }
            }
            return updated
          })
        }
      } catch (err: unknown) {
        console.error("Error revoking consent:", err)
      }
    }

    // Open consent modal
    const openConsentModal = (community: NetworkCommunity) => {
      setConsentCommunity(community)
      setConsentApiKey("")
      setError("")
      setShowConsentModal(true)
    }

    // Fetch metrics for a specific period
    const fetchPeriodMetrics = async (communityId: string, period: string) => {
      if (!communityId) return

      setLoadingMetrics(true)
      try {
        const response = await fetch(
          `/api/network/metrics?communityId=${communityId}&period=${period}`,
        )
        const data = await response.json()

        if (data.success) {
          setPeriodMetrics(data.metrics)
          setDataCoverage(data.data_coverage)
          setCoverageWarning(data.coverage_warning)
        }
      } catch (err: unknown) {
        console.error("Error fetching period metrics:", err)
      } finally {
        setLoadingMetrics(false)
      }
    }

    // Trigger data sync for a community
    const triggerSync = async (communityId: string) => {
      if (!npubKey || syncing) return

      setSyncing(true)
      setSyncResult(null)
      setError("")

      try {
        const response = await fetch("/api/network/sync", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Npub": npubKey,
          },
          body: JSON.stringify({ communityId }),
        })

        const data = await response.json()

        if (data.success) {
          setSyncResult(data)
          // Refresh communities to get updated metrics and update selectedCommunity
          const commResponse = await fetch("/api/network/communities")
          const commData = await commResponse.json()
          if (commData.success) {
            setCommunities(commData.communities || [])
            // Update selectedCommunity with fresh data
            const updated = (commData.communities as NetworkCommunity[]).find(
              (c) => c.id === communityId,
            )
            if (updated) {
              setSelectedCommunity(updated)
            }
          }
        } else {
          throw new Error(data.error || "Sync failed")
        }
      } catch (err: unknown) {
        console.error("Error syncing:", err)
        setError((err as Error).message)
      } finally {
        setSyncing(false)
      }
    }

    // Fetch community members (for leader management)
    const fetchCommunityMembers = async (communityId: string) => {
      if (!npubKey || !communityId) return

      setLoadingMembers(true)
      try {
        const response = await fetch(`/api/network/members?communityId=${communityId}`, {
          headers: {
            "X-User-Npub": npubKey,
          },
        })
        const data = await response.json()

        if (data.success) {
          setCommunityMembers(data.members || [])
          // Fetch Nostr profiles for all members
          fetchMemberProfiles(data.members || [])
        }
      } catch (err: unknown) {
        console.error("Error fetching members:", err)
      } finally {
        setLoadingMembers(false)
      }
    }

    // Fetch Nostr profiles for community members (in parallel, merged in one
    // state update — previously one awaited request + setState per member)
    const fetchMemberProfiles = async (members: Array<{ user_npub: string }>) => {
      const uniqueNpubs = [
        ...new Set(members.map((m) => m.user_npub).filter(Boolean)),
      ].filter((npub) => !memberProfiles[npub])

      const fetched = await fetchProfilesBatch(uniqueNpubs)
      if (Object.keys(fetched).length > 0) {
        setMemberProfiles((prev) => ({ ...prev, ...fetched }))
      }
    }

    // Remove a member from the community
    const removeMember = async (membershipId: number) => {
      if (!npubKey || !selectedCommunity) return

      setRemovingMemberId(membershipId)
      setError("")

      try {
        const response = await fetch(
          `/api/network/members?communityId=${selectedCommunity.id}`,
          {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
              "X-User-Npub": npubKey,
            },
            body: JSON.stringify({ membershipId }),
          },
        )

        const data = await response.json()

        if (data.success) {
          // Remove from local state
          setCommunityMembers((prev) => prev.filter((m) => m.id !== membershipId))
          setShowRemoveConfirm(null)
          // Refresh communities to update member counts
          fetchCommunities()
        } else {
          throw new Error(data.error || "Failed to remove member")
        }
      } catch (err: unknown) {
        console.error("Error removing member:", err)
        setError((err as Error).message)
      } finally {
        setRemovingMemberId(null)
      }
    }

    const fetchMyMemberships = async () => {
      if (!npubKey) return

      try {
        const response = await fetch("/api/network/memberships", {
          headers: {
            "X-User-Npub": npubKey,
          },
        })
        const data = await response.json()

        if (data.success) {
          setMyMemberships(data.memberships || [])
        }
      } catch (err: unknown) {
        console.error("Error fetching memberships:", err)
      }
    }

    const fetchLeaderboard = async (period: string = "current_month") => {
      try {
        const response = await fetch(
          `/api/network/leaderboard?period=${period}&sortBy=members_volume`,
        )
        const data = await response.json()

        if (data.success) {
          setLeaderboard(data.leaderboard || [])
        }
      } catch (err: unknown) {
        console.error("Error fetching leaderboard:", err)
      }
    }

    const checkWhitelistStatus = async () => {
      if (!npubKey) return

      try {
        const response = await fetch("/api/network/whitelist/check", {
          headers: {
            "X-User-Npub": npubKey,
          },
        })
        const data = await response.json()
        setIsSuperAdmin(data.isSuperAdmin || false)
        setIsWhitelistedLeader(data.isWhitelisted || false)
        setUserRole(data.role || "user")
      } catch (err: unknown) {
        console.error("Error checking whitelist status:", err)
      }
    }

    // Fetch pending applications for leaders
    const fetchPendingApplications = async (communityId: string | null = null) => {
      if (!npubKey) return

      try {
        const url = communityId
          ? `/api/network/memberships/pending?communityId=${communityId}`
          : "/api/network/memberships/pending"

        const response = await fetch(url, {
          headers: {
            "X-User-Npub": npubKey,
          },
        })
        const data = await response.json()

        if (data.success) {
          setPendingApplications(data.applications || [])
        }
      } catch (err: unknown) {
        console.error("Error fetching pending applications:", err)
      }
    }

    const handleApplyToJoin = async (community: NetworkCommunity) => {
      setApplyingTo(community)
      setShowApplyModal(true)
      setApplicationNote("")
    }

    const submitApplication = async () => {
      if (!applyingTo || !npubKey) return

      setSubmitting(true)
      setError("")

      try {
        const response = await fetch("/api/network/memberships/apply", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Npub": npubKey,
          },
          body: JSON.stringify({
            communityId: applyingTo.id,
            applicationNote,
          }),
        })

        const data = await response.json()

        if (data.success) {
          // Add the pending membership to local state immediately
          const newMembership: UserMembership = {
            id: data.membership.id,
            community_id: applyingTo.id,
            community_name: applyingTo.name,
            community_slug: applyingTo.slug,
            role: "member",
            status: "pending",
            applied_at: data.membership.applied_at,
            approved_at: null,
            consent_given: false,
          }
          setMyMemberships((prev) => [...prev, newMembership])

          setShowApplyModal(false)
          setApplyingTo(null)
          setApplicationNote("")
        } else if (response.status === 409) {
          // Already has pending application
          setError("You already have a pending application for this community")
        } else {
          throw new Error(data.error || "Failed to submit application")
        }
      } catch (err: unknown) {
        console.error("Error submitting application:", err)
        setError((err as Error).message)
      } finally {
        setSubmitting(false)
      }
    }

    // Review application (approve/reject)
    const [reviewingId, setReviewingId] = useState<number | null>(null)
    const [reviewSuccess, setReviewSuccess] = useState<string | null>(null)

    const reviewApplication = async (applicationId: number, action: string) => {
      if (!npubKey || reviewingId) return

      setReviewingId(applicationId)
      setError("")
      setReviewSuccess(null)

      console.log(
        `[Network] Reviewing application ${applicationId} with action: ${action}`,
      )

      try {
        const response = await fetch("/api/network/memberships/review", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Npub": npubKey,
          },
          body: JSON.stringify({
            applicationId,
            action,
          }),
        })

        console.log(`[Network] Review response status: ${response.status}`)

        const data = await response.json()
        console.log(`[Network] Review response data:`, data)

        if (data.success) {
          // Remove the application from the list
          setPendingApplications((prev) => prev.filter((app) => app.id !== applicationId))

          // Show success feedback
          setReviewSuccess(
            action === "approve" ? "Member approved!" : "Application rejected",
          )
          setTimeout(() => setReviewSuccess(null), 3000)

          console.log(`[Network] Application ${action}ed successfully`)
        } else {
          throw new Error(data.error || `Failed to ${action} application`)
        }
      } catch (err: unknown) {
        console.error(`[Network] Error ${action}ing application:`, err)
        setError((err as Error).message || `Failed to ${action} application`)
      } finally {
        setReviewingId(null)
      }
    }

    const navigateToView = (view: string, community: NetworkCommunity | null = null) => {
      if (onInternalTransition) onInternalTransition()
      setSelectedCommunity(community)
      setCurrentView(view)
    }

    // Expose methods for keyboard navigation
    useImperativeHandle(ref, () => ({
      getCurrentView: () => currentView,
      navigateBack: () => {
        if (currentView !== "discovery") {
          navigateToView("discovery")
          return true
        }
        return false
      },
    }))

    // Filter communities based on search
    const filteredCommunities = communities.filter(
      (c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.city?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.country_code?.toLowerCase().includes(searchQuery.toLowerCase()),
    )

    // Get membership info for a community
    const getMembershipInfo = (communityId: string) => {
      const membership = myMemberships.find((m) => m.community_id === communityId)
      return membership || null
    }

    // Get membership status for a community (backwards compatibility)
    const _getMembershipStatus = (communityId: string) => {
      const membership = getMembershipInfo(communityId)
      return membership?.status || null
    }

    // Get role badge color and text
    const getRoleBadge = (role: string) => {
      switch (role) {
        case "leader":
          return {
            bg: "bg-purple-100 dark:bg-purple-900",
            text: "text-purple-700 dark:text-purple-300",
            label: "Leader",
          }
        case "admin":
          return {
            bg: "bg-blue-100 dark:bg-blue-900",
            text: "text-blue-700 dark:text-blue-300",
            label: "Admin",
          }
        default:
          return {
            bg: "bg-green-100 dark:bg-green-900",
            text: "text-green-700 dark:text-green-300",
            label: "Member",
          }
      }
    }

    // Render loading state
    if (loading && communities.length === 0) {
      return (
        <div
          className="h-full flex flex-col bg-white dark:bg-black"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center">
              <div className="animate-spin rounded-full h-12 w-12 border-4 border-teal-500 border-t-transparent mb-4"></div>
              <div className="text-lg text-gray-600 dark:text-gray-400">
                Loading Network...
              </div>
            </div>
          </div>
        </div>
      )
    }

    // ============================================
    // DISCOVERY VIEW
    // ============================================
    if (currentView === "discovery") {
      return (
        <div
          className="h-full flex flex-col bg-white dark:bg-black overflow-hidden"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          {/* Header */}
          <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700">
            {!hideHeader && (
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                    Bitcoin Circular Economies
                  </h1>
                  {isSuperAdmin && (
                    <span className="text-xs text-purple-600 dark:text-purple-400 font-medium">
                      Super Admin
                    </span>
                  )}
                </div>
                {isSuperAdmin && (
                  <button
                    onClick={() => navigateToView("create")}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium"
                  >
                    + Add Community
                  </button>
                )}
              </div>
            )}
            {/* Super Admin button when header is hidden */}
            {hideHeader && isSuperAdmin && (
              <div className="flex justify-end mb-4">
                <button
                  onClick={() => navigateToView("create")}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium"
                >
                  + Add Community
                </button>
              </div>
            )}

            {/* Tab Navigation */}
            <div className="flex gap-2 mb-4 overflow-x-auto">
              <button
                onClick={() => navigateToView("discovery")}
                className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium whitespace-nowrap"
              >
                Discover
              </button>
              <button
                onClick={() => navigateToView("my-communities")}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
              >
                My Communities (
                {myMemberships.filter((m) => m.status === "approved").length})
              </button>
              <button
                onClick={() => navigateToView("most-active")}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
              >
                Most Active
              </button>
            </div>

            {/* Search */}
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setSearchQuery(e.target.value)
                }
                placeholder="Search communities..."
                className="w-full px-4 py-3 pl-10 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-blink-dark text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              <svg
                className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
          </div>

          {/* Community List */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {error && (
              <div className="mb-4 bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-200 px-4 py-3 rounded-lg">
                {error}
              </div>
            )}

            {filteredCommunities.length === 0 ? (
              <div className="text-center py-12">
                <div className="text-6xl mb-4">🌍</div>
                <p className="text-gray-600 dark:text-gray-400 text-lg">
                  {searchQuery ? "No communities found" : "No communities yet"}
                </p>
                <p className="text-gray-500 dark:text-gray-500 text-sm mt-2">
                  {searchQuery
                    ? "Try a different search term"
                    : "Be the first to create one!"}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {filteredCommunities.map((community) => {
                  const membership = getMembershipInfo(community.id)
                  const membershipStatus = membership?.status || null
                  const roleBadge = membership ? getRoleBadge(membership.role) : null

                  return (
                    <div
                      key={community.id}
                      className="bg-gray-50 dark:bg-blink-dark rounded-lg p-4 border border-gray-200 dark:border-gray-700"
                    >
                      <div className="flex items-start gap-3">
                        {/* Community Leader Avatar */}
                        <div className="flex-shrink-0">
                          {leaderProfiles[community.leader_npub]?.picture ? (
                            <img
                              src={leaderProfiles[community.leader_npub].picture}
                              alt={
                                leaderProfiles[community.leader_npub]?.name ||
                                community.name
                              }
                              className="w-12 h-12 rounded-full object-cover ring-2 ring-purple-500/30"
                              onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                                // Fallback to initial on error
                                const target = e.target as HTMLImageElement
                                target.style.display = "none"
                                ;(
                                  target.nextElementSibling as HTMLElement
                                ).style.display = "flex"
                              }}
                            />
                          ) : null}
                          <div
                            className="w-12 h-12 rounded-full bg-gradient-to-br from-purple-500 to-teal-500 flex items-center justify-center text-white font-bold text-lg"
                            style={{
                              display: leaderProfiles[community.leader_npub]?.picture
                                ? "none"
                                : "flex",
                            }}
                          >
                            {community.name.charAt(0)}
                          </div>
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
                              {community.name}
                            </h3>
                            {membershipStatus === "approved" && roleBadge && (
                              <span
                                className={`px-2 py-0.5 ${roleBadge.bg} ${roleBadge.text} text-xs rounded-full flex-shrink-0`}
                              >
                                {roleBadge.label}
                              </span>
                            )}
                            {membershipStatus === "pending" && (
                              <span className="px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 text-xs rounded-full flex-shrink-0">
                                Pending
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 mb-2">
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                              />
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                              />
                            </svg>
                            <span>
                              {community.city || community.region || "Location not set"}
                            </span>
                            {community.country_code && (
                              <span className="text-gray-400">
                                • {community.country_code}
                              </span>
                            )}
                          </div>

                          {community.description && (
                            <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mb-3">
                              {community.description}
                            </p>
                          )}

                          {/* Stats Row */}
                          <div className="flex items-center gap-4 text-sm">
                            <div className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                              <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth="2"
                                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                                />
                              </svg>
                              <span>{community.member_count || 0} members</span>
                            </div>
                            {community.transaction_volume_sats > 0 && (
                              <div className="flex items-center gap-1 text-teal-600 dark:text-teal-400">
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth="2"
                                    d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                                  />
                                </svg>
                                <span>
                                  {(
                                    community.transaction_volume_sats || 0
                                  ).toLocaleString()}{" "}
                                  sats
                                </span>
                              </div>
                            )}
                            {community.tx_count_growth_percent != null &&
                              community.tx_count_growth_percent > 0 && (
                                <div className="text-green-600 dark:text-green-400 text-sm font-medium">
                                  +{community.tx_count_growth_percent.toFixed(1)}% growth
                                </div>
                              )}
                          </div>

                          {/* Action Button - Inline for mobile-friendly layout */}
                          <div className="mt-3 flex justify-end">
                            {membershipStatus === "approved" ? (
                              <button
                                onClick={() => navigateToView("community", community)}
                                className="px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium"
                              >
                                View
                              </button>
                            ) : membershipStatus === "pending" ? (
                              <button
                                disabled
                                className="px-4 py-2 bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 rounded-lg cursor-not-allowed text-sm font-medium"
                              >
                                Applied
                              </button>
                            ) : (
                              <button
                                onClick={() => handleApplyToJoin(community)}
                                className="px-4 py-2 border-2 border-teal-600 text-teal-600 dark:text-teal-400 rounded-lg hover:bg-teal-50 dark:hover:bg-teal-900 transition-colors text-sm font-medium"
                              >
                                Join
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Apply Modal */}
          {showApplyModal && applyingTo && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
              <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-md w-full p-6">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
                  Join {applyingTo.name}
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mb-4">
                  Your application will be reviewed by the community leader.
                </p>

                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Message to Leader (optional)
                  </label>
                  <textarea
                    value={applicationNote}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                      setApplicationNote(e.target.value)
                    }
                    placeholder="Introduce yourself or explain why you want to join..."
                    rows={3}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-blink-dark text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>

                {error && (
                  <div className="mb-4 text-sm text-red-600 dark:text-red-400">
                    {error}
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setShowApplyModal(false)
                      setApplyingTo(null)
                      setError("")
                    }}
                    className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitApplication}
                    disabled={submitting}
                    className="flex-1 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-50"
                  >
                    {submitting ? "Applying..." : "Apply"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Data Sharing Consent Modal */}
          {showConsentModal && consentCommunity && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
              <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-md w-full p-6">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
                  📊 Share Transaction Data
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mb-4">
                  Help {consentCommunity.name} track community metrics by sharing your
                  Blink transaction history.
                </p>

                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 mb-4">
                  <h4 className="font-medium text-blue-800 dark:text-blue-300 mb-2">
                    What we&apos;ll access:
                  </h4>
                  <ul className="text-sm text-blue-700 dark:text-blue-400 space-y-1">
                    <li>• Transaction amounts and dates</li>
                    <li>• Counterparty info (to detect internal trades)</li>
                    <li>• Used for community metrics only</li>
                  </ul>
                </div>

                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Blink API Key (READ-only)
                  </label>
                  <input
                    type="password"
                    value={consentApiKey}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setConsentApiKey(e.target.value)
                    }
                    placeholder="blink_xxxxx..."
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-blink-dark text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500 font-mono text-sm"
                  />
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Get your API key from{" "}
                    <a
                      href="https://dashboard.blink.sv"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-teal-600 hover:underline"
                    >
                      dashboard.blink.sv
                    </a>{" "}
                    → API Keys
                  </p>
                </div>

                {error && (
                  <div className="mb-4 text-sm text-red-600 dark:text-red-400">
                    {error}
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setShowConsentModal(false)
                      setConsentCommunity(null)
                      setConsentApiKey("")
                      setError("")
                    }}
                    className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitConsent}
                    disabled={submittingConsent || !consentApiKey}
                    className="flex-1 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-50"
                  >
                    {submittingConsent ? "Sharing..." : "Share Data"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )
    }

    // ============================================
    // MY COMMUNITIES VIEW
    // ============================================
    if (currentView === "my-communities") {
      const approvedMemberships = myMemberships.filter((m) => m.status === "approved")
      const pendingMemberships = myMemberships.filter((m) => m.status === "pending")

      return (
        <div
          className="h-full flex flex-col bg-white dark:bg-black overflow-hidden"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          {/* Header */}
          <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700">
            {!hideHeader && (
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                My Communities
              </h1>
            )}

            {/* Tab Navigation */}
            <div className="flex gap-2 overflow-x-auto">
              <button
                onClick={() => navigateToView("discovery")}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
              >
                Discover
              </button>
              <button
                onClick={() => navigateToView("my-communities")}
                className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium whitespace-nowrap"
              >
                My Communities ({approvedMemberships.length})
              </button>
              <button
                onClick={() => navigateToView("most-active")}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
              >
                Most Active
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {/* Pending Applications */}
            {pendingMemberships.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-semibold text-yellow-600 dark:text-yellow-400 mb-3">
                  Pending Applications ({pendingMemberships.length})
                </h3>
                <div className="space-y-3">
                  {pendingMemberships.map((m) => (
                    <div
                      key={m.id}
                      className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-medium text-gray-900 dark:text-white">
                            {m.community_name}
                          </h4>
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            Applied{" "}
                            {m.applied_at
                              ? new Date(m.applied_at).toLocaleDateString()
                              : "Unknown"}
                          </p>
                        </div>
                        <span className="px-3 py-1 bg-yellow-100 dark:bg-yellow-800 text-yellow-700 dark:text-yellow-300 text-sm rounded-full">
                          Pending
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Active Memberships */}
            {approvedMemberships.length === 0 ? (
              <div className="text-center py-12">
                <div className="text-6xl mb-4">🤝</div>
                <p className="text-gray-600 dark:text-gray-400 text-lg">
                  You haven&apos;t joined any communities yet
                </p>
                <button
                  onClick={() => navigateToView("discovery")}
                  className="mt-4 px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors"
                >
                  Browse Communities
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400">
                  Active Memberships
                </h3>
                {approvedMemberships.map((m) => {
                  const roleBadge = getRoleBadge(m.role)
                  const community = communities.find((c) => c.id === m.community_id)
                  const leaderNpub = community?.leader_npub
                  const leaderProfile = leaderNpub ? leaderProfiles[leaderNpub] : null

                  return (
                    <div
                      key={m.id}
                      onClick={() => {
                        navigateToView(
                          "community",
                          community ||
                            ({
                              id: m.community_id,
                              name: m.community_name,
                              slug: m.community_slug,
                            } as NetworkCommunity),
                        )
                      }}
                      className="bg-gray-50 dark:bg-blink-dark rounded-lg p-4 border border-gray-200 dark:border-gray-700 cursor-pointer hover:border-teal-500 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        {/* Community Avatar */}
                        <div className="flex-shrink-0">
                          {leaderProfile?.picture ? (
                            <img
                              src={leaderProfile.picture}
                              alt={leaderProfile?.name || m.community_name}
                              className="w-10 h-10 rounded-full object-cover ring-2 ring-purple-500/30"
                              onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                                const target = e.target as HTMLImageElement
                                target.style.display = "none"
                                ;(
                                  target.nextElementSibling as HTMLElement
                                ).style.display = "flex"
                              }}
                            />
                          ) : null}
                          <div
                            className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-teal-500 flex items-center justify-center text-white font-bold text-sm"
                            style={{ display: leaderProfile?.picture ? "none" : "flex" }}
                          >
                            {m.community_name?.charAt(0) || "?"}
                          </div>
                        </div>

                        <div className="flex-1 min-w-0">
                          <h4 className="font-semibold text-gray-900 dark:text-white truncate">
                            {m.community_name}
                          </h4>
                          <div className="flex items-center gap-3 mt-1 text-sm text-gray-500 dark:text-gray-400">
                            <span>{m.member_count || 0} members</span>
                            <span
                              className={`px-2 py-0.5 ${roleBadge.bg} ${roleBadge.text} text-xs rounded-full`}
                            >
                              {roleBadge.label}
                            </span>
                          </div>
                        </div>

                        <svg
                          className="w-5 h-5 text-gray-400 flex-shrink-0"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )
    }

    // ============================================
    // MOST ACTIVE VIEW (Leaderboard)
    // ============================================
    if (currentView === "most-active") {
      return (
        <div
          className="h-full flex flex-col bg-white dark:bg-black overflow-hidden"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          {/* Header */}
          <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700">
            {!hideHeader && (
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                Most Active Communities
              </h1>
            )}

            {/* Tab Navigation */}
            <div className="flex gap-2 overflow-x-auto">
              <button
                onClick={() => navigateToView("discovery")}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
              >
                Discover
              </button>
              <button
                onClick={() => navigateToView("my-communities")}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 text-sm font-medium whitespace-nowrap"
              >
                My Communities (
                {myMemberships.filter((m) => m.status === "approved").length})
              </button>
              <button
                onClick={() => navigateToView("most-active")}
                className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium whitespace-nowrap"
              >
                Most Active
              </button>
            </div>
          </div>

          {/* Leaderboard Content */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {loading ? (
              <div className="text-center py-12">
                <div className="text-4xl mb-4">⏳</div>
                <p className="text-gray-600 dark:text-gray-400">Loading leaderboard...</p>
              </div>
            ) : leaderboard.length === 0 ? (
              <div className="text-center py-12">
                <div className="text-6xl mb-4">📊</div>
                <p className="text-gray-600 dark:text-gray-400 text-lg">
                  No activity data yet
                </p>
                <p className="text-gray-500 dark:text-gray-500 text-sm mt-2">
                  Communities will appear here once they start recording transactions
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Communities ranked by members and Bitcoin activity
                </p>

                {leaderboard.map((c) => {
                  const leaderProfile = leaderProfiles[c.leader_npub]
                  // Country flag mapping
                  const countryFlags: Record<string, string> = {
                    ZA: "🇿🇦 South Africa",
                    ZM: "🇿🇲 Zambia",
                    ZW: "🇿🇼 Zimbabwe",
                    KE: "🇰🇪 Kenya",
                    HN: "🇭🇳 Honduras",
                    SV: "🇸🇻 El Salvador",
                    GT: "🇬🇹 Guatemala",
                    NG: "🇳🇬 Nigeria",
                    GH: "🇬🇭 Ghana",
                    TZ: "🇹🇿 Tanzania",
                    UG: "🇺🇬 Uganda",
                    US: "🇺🇸 USA",
                    BR: "🇧🇷 Brazil",
                    AR: "🇦🇷 Argentina",
                    MX: "🇲🇽 Mexico",
                    CO: "🇨🇴 Colombia",
                    PE: "🇵🇪 Peru",
                    CL: "🇨🇱 Chile",
                    VE: "🇻🇪 Venezuela",
                    CR: "🇨🇷 Costa Rica",
                    PA: "🇵🇦 Panama",
                  }
                  const countryDisplay =
                    (c.country_code && countryFlags[c.country_code]) ||
                    `🌍 ${c.country_code || "Global"}`

                  return (
                    <div
                      key={c.id}
                      onClick={() => {
                        const community = communities.find((comm) => comm.id === c.id)
                        if (community) {
                          navigateToView("community", community)
                        }
                      }}
                      className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700 cursor-pointer hover:border-teal-500 transition-colors"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          {/* Rank Badge */}
                          <span
                            className={`font-bold text-2xl ${
                              c.rank === 1
                                ? "text-yellow-500"
                                : c.rank === 2
                                  ? "text-gray-400"
                                  : c.rank === 3
                                    ? "text-amber-600"
                                    : "text-gray-500 dark:text-gray-400"
                            }`}
                          >
                            #{c.rank}
                          </span>

                          {/* Leader Profile Photo */}
                          <div className="flex-shrink-0">
                            {leaderProfile?.picture ? (
                              <img
                                src={leaderProfile.picture}
                                alt={leaderProfile?.name || c.name}
                                className="w-12 h-12 rounded-full object-cover ring-2 ring-orange-500/30"
                                onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                                  const target = e.target as HTMLImageElement
                                  target.style.display = "none"
                                  ;(
                                    target.nextElementSibling as HTMLElement
                                  ).style.display = "flex"
                                }}
                              />
                            ) : null}
                            <div
                              className="w-12 h-12 rounded-full bg-gradient-to-br from-orange-500 to-yellow-500 flex items-center justify-center text-white font-bold text-lg"
                              style={{
                                display: leaderProfile?.picture ? "none" : "flex",
                              }}
                            >
                              {c.name.charAt(0)}
                            </div>
                          </div>

                          <div>
                            <h3 className="font-semibold text-gray-800 dark:text-white">
                              {c.name}
                            </h3>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              {c.city}, {countryDisplay}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Metrics Grid - BTC Preference first, then Members */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                        {/* BTC Preference - First and prominent (never round to 100% unless truly 100%) */}
                        <div className="bg-gradient-to-br from-orange-50 to-yellow-50 dark:from-orange-900/20 dark:to-yellow-900/20 rounded-lg p-2 border border-orange-200 dark:border-orange-800/50">
                          <div className="font-bold text-lg text-orange-600 dark:text-orange-400">
                            {c.btc_preference_pct != null
                              ? `${c.btc_preference_pct >= 100 ? 100 : Math.floor(c.btc_preference_pct)}%`
                              : "—"}
                          </div>
                          <div className="text-xs text-orange-700 dark:text-orange-300 font-medium flex items-center justify-center gap-1">
                            <span>₿</span> BTC Pref
                          </div>
                        </div>

                        {/* Members */}
                        <div className="bg-white dark:bg-gray-900 rounded-lg p-2">
                          <div className="font-bold text-lg text-teal-600 dark:text-teal-400">
                            {c.member_count}
                          </div>
                          <div className="text-xs text-gray-500">Members</div>
                        </div>

                        {/* Volume */}
                        <div className="bg-white dark:bg-gray-900 rounded-lg p-2">
                          <div className="font-bold text-lg text-purple-600 dark:text-purple-400">
                            {c.transaction_volume_sats >= 1000000
                              ? `${(c.transaction_volume_sats / 1000000).toFixed(1)}M`
                              : c.transaction_volume_sats >= 1000
                                ? `${(c.transaction_volume_sats / 1000).toFixed(1)}k`
                                : c.transaction_volume_sats}
                          </div>
                          <div className="text-xs text-gray-500">Sats</div>
                        </div>

                        {/* Transactions */}
                        <div className="bg-white dark:bg-gray-900 rounded-lg p-2">
                          <div className="font-bold text-lg text-blue-600 dark:text-blue-400">
                            {c.transaction_count}
                          </div>
                          <div className="text-xs text-gray-500">Txns</div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )
    }

    // ============================================
    // COMMUNITY DASHBOARD VIEW
    // ============================================
    if (currentView === "community" && selectedCommunity) {
      const membership = myMemberships.find(
        (m) => m.community_id === selectedCommunity.id,
      )
      const isLeader = membership?.role === "leader"

      return (
        <div
          className="h-full flex flex-col bg-white dark:bg-black overflow-hidden"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          {/* Header */}
          <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700">
            <button
              onClick={() => navigateToView("my-communities")}
              className="flex items-center text-gray-600 dark:text-gray-400 hover:text-teal-600 dark:hover:text-teal-400 mb-3"
            >
              <svg
                className="w-5 h-5 mr-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              Back
            </button>

            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                {/* Leader Profile Image */}
                <div className="flex-shrink-0">
                  {leaderProfiles[selectedCommunity.leader_npub]?.picture ? (
                    <img
                      src={leaderProfiles[selectedCommunity.leader_npub].picture}
                      alt={
                        leaderProfiles[selectedCommunity.leader_npub]?.name ||
                        selectedCommunity.name
                      }
                      className="w-14 h-14 rounded-full object-cover ring-2 ring-purple-500/30"
                      onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                        const target = e.target as HTMLImageElement
                        target.style.display = "none"
                        ;(target.nextElementSibling as HTMLElement).style.display = "flex"
                      }}
                    />
                  ) : null}
                  <div
                    className="w-14 h-14 rounded-full bg-gradient-to-br from-purple-500 to-teal-500 flex items-center justify-center text-white font-bold text-xl"
                    style={{
                      display: leaderProfiles[selectedCommunity.leader_npub]?.picture
                        ? "none"
                        : "flex",
                    }}
                  >
                    {selectedCommunity.name.charAt(0)}
                  </div>
                </div>

                <div>
                  <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                    {selectedCommunity.name}
                  </h1>
                  <p className="text-gray-500 dark:text-gray-400 text-sm">
                    {selectedCommunity.city || selectedCommunity.region}
                    {selectedCommunity.country_code &&
                      ` • ${selectedCommunity.country_code}`}
                  </p>
                </div>
              </div>
              {isLeader && (
                <button
                  onClick={() => navigateToView("leader", selectedCommunity)}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium"
                >
                  Manage
                </button>
              )}
            </div>
          </div>

          {/* Scrollable Content Area - Everything below header scrolls on mobile */}
          <div className="flex-1 overflow-y-auto">
            {/* Period Selector */}
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                  Period:
                </span>
                <div className="flex gap-1">
                  {[
                    { value: "current_week", label: "This Week" },
                    { value: "last_week", label: "Last Week" },
                    { value: "current_month", label: "This Month" },
                    { value: "last_month", label: "Last Month" },
                  ].map((p) => (
                    <button
                      key={p.value}
                      onClick={() => setSelectedPeriod(p.value)}
                      className={`px-2 py-1 text-xs rounded-lg transition-colors ${
                        selectedPeriod === p.value
                          ? "bg-teal-600 text-white"
                          : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              {periodMetrics && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
                  {periodMetrics.period_label}:{" "}
                  {new Date(periodMetrics.period_start).toLocaleDateString()} -{" "}
                  {new Date(periodMetrics.period_end).toLocaleDateString()}
                </p>
              )}

              {/* Coverage Warning */}
              {coverageWarning && (
                <div className="mt-2 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                  <p className="text-xs text-amber-700 dark:text-amber-300 text-center">
                    ⚠️ {coverageWarning.message}
                  </p>
                </div>
              )}

              {/* Data Coverage Info */}
              {dataCoverage &&
                dataCoverage.oldest_transaction &&
                dataCoverage.newest_transaction && (
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-2 text-center">
                    📊 Synced data:{" "}
                    {new Date(dataCoverage.oldest_transaction).toLocaleDateString()} -{" "}
                    {new Date(dataCoverage.newest_transaction).toLocaleDateString()} (
                    {dataCoverage.total_synced_transactions} txs)
                  </p>
                )}
            </div>

            {/* Stats Cards */}
            <div className="px-4 py-4 grid grid-cols-2 gap-4">
              <div className="bg-teal-50 dark:bg-teal-900/20 rounded-lg p-4">
                <div className="text-3xl font-bold text-teal-600 dark:text-teal-400">
                  {selectedCommunity.member_count || 0}
                </div>
                <div className="text-sm text-teal-700 dark:text-teal-300">Members</div>
              </div>
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
                <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
                  {selectedCommunity.data_sharing_member_count || 0}
                </div>
                <div className="text-sm text-blue-700 dark:text-blue-300">
                  Sharing Data
                </div>
              </div>
              {/* Period-based metrics */}
              {periodMetrics && periodMetrics.transaction_count > 0 ? (
                <>
                  <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
                    <div className="text-3xl font-bold text-green-600 dark:text-green-400">
                      {periodMetrics.transaction_count?.toLocaleString() || 0}
                    </div>
                    <div className="text-sm text-green-700 dark:text-green-300">
                      Transactions
                    </div>
                  </div>
                  <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
                    <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                      {(periodMetrics.total_volume_sats || 0).toLocaleString()}
                    </div>
                    <div className="text-sm text-purple-700 dark:text-purple-300">
                      Volume (sats)
                    </div>
                  </div>
                  <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-4">
                    <div className="text-3xl font-bold text-orange-600 dark:text-orange-400">
                      {periodMetrics.closed_loop_ratio || 0}%
                    </div>
                    <div className="text-sm text-orange-700 dark:text-orange-300">
                      Closed Loop
                    </div>
                  </div>
                  <div className="bg-pink-50 dark:bg-pink-900/20 rounded-lg p-4">
                    <div className="text-3xl font-bold text-pink-600 dark:text-pink-400">
                      {periodMetrics.velocity || 0}
                    </div>
                    <div className="text-sm text-pink-700 dark:text-pink-300">
                      Txs/Member
                    </div>
                  </div>
                  {/* Bitcoin Preference metric */}
                  {periodMetrics.bitcoin_preference && (
                    <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4 relative group">
                      <div className="text-3xl font-bold text-amber-600 dark:text-amber-400">
                        {periodMetrics.bitcoin_preference.btc_preference_pct != null
                          ? `${periodMetrics.bitcoin_preference.btc_preference_pct >= 100 ? 100 : Math.floor(periodMetrics.bitcoin_preference.btc_preference_pct)}`
                          : 0}
                        %
                      </div>
                      <div className="text-sm text-amber-700 dark:text-amber-300 flex items-center gap-1">
                        <span>₿</span> BTC Preference
                      </div>
                      {/* Tooltip */}
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10">
                        <div className="bg-gray-900 text-white text-xs rounded py-2 px-3 whitespace-nowrap shadow-lg">
                          <p className="font-medium mb-1">Bitcoin Preference</p>
                          <p>% of member balances held in BTC vs StableSats</p>
                          <p className="mt-1 text-gray-300">
                            Based on{" "}
                            {periodMetrics.bitcoin_preference.members_with_balance}{" "}
                            member(s)
                          </p>
                          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : periodMetrics && periodMetrics.total_synced_txs > 0 ? (
                <div className="col-span-2 text-center py-4 text-gray-500 dark:text-gray-400">
                  <p className="text-sm">No transactions in this period</p>
                  <p className="text-xs mt-1">
                    ({periodMetrics.total_synced_txs} total synced transactions)
                  </p>
                </div>
              ) : loadingMetrics ? (
                <div className="col-span-2 text-center py-4 text-gray-500 dark:text-gray-400">
                  Loading metrics...
                </div>
              ) : null}
            </div>

            {/* Data Sharing Opt-in Banner */}
            {membership && userConsents[selectedCommunity.id]?.status !== "active" && (
              <div className="mx-4 mb-4 bg-gradient-to-r from-teal-500 to-blue-600 rounded-lg p-4 text-white">
                <div className="flex items-start gap-3">
                  <div className="text-2xl">📊</div>
                  <div className="flex-1">
                    <h3 className="font-semibold mb-1">Help grow community metrics!</h3>
                    <p className="text-sm text-white/90 mb-3">
                      Share your Blink transaction data to contribute to community
                      statistics like volume, velocity, and growth.
                    </p>
                    <button
                      onClick={() => openConsentModal(selectedCommunity)}
                      className="px-4 py-2 bg-white text-teal-600 rounded-lg font-medium text-sm hover:bg-white/90 transition-colors"
                    >
                      Share My Data
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Data Sharing Status */}
            {userConsents[selectedCommunity.id]?.status === "active" && (
              <div className="mx-4 mb-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-green-600 dark:text-green-400">✓</span>
                    <span className="text-green-700 dark:text-green-300 font-medium">
                      Data Sharing Active
                    </span>
                    {userConsents[selectedCommunity.id].blink_username && (
                      <span className="text-green-600 dark:text-green-400 text-sm">
                        (@{userConsents[selectedCommunity.id].blink_username})
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => revokeConsent(selectedCommunity.id)}
                    className="text-sm text-red-600 dark:text-red-400 hover:underline"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            )}

            {/* Content */}
            <div className="px-4 pb-6">
              {selectedCommunity.description && (
                <div className="mb-6">
                  <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-2">
                    About
                  </h3>
                  <p className="text-gray-700 dark:text-gray-300">
                    {selectedCommunity.description}
                  </p>
                </div>
              )}

              {/* Growth Chart Placeholder */}
              <div className="mb-6">
                <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-3">
                  Monthly Growth
                </h3>
                <div className="bg-gray-50 dark:bg-blink-dark rounded-lg p-6 text-center border border-gray-200 dark:border-gray-700">
                  <div className="text-5xl mb-2">📈</div>
                  <p className="text-gray-500 dark:text-gray-400 text-sm">
                    Growth charts will appear as more data is collected
                  </p>
                </div>
              </div>
            </div>
          </div>
          {/* End scrollable content area */}

          {/* Data Sharing Consent Modal */}
          {showConsentModal && consentCommunity && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
              <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-md w-full p-6">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
                  📊 Share Transaction Data
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mb-4">
                  Help {consentCommunity.name} track community metrics by sharing your
                  Blink transaction history.
                </p>

                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 mb-4">
                  <h4 className="font-medium text-blue-800 dark:text-blue-300 mb-2">
                    What we&apos;ll access:
                  </h4>
                  <ul className="text-sm text-blue-700 dark:text-blue-400 space-y-1">
                    <li>• Transaction amounts and dates</li>
                    <li>• Counterparty info (to detect internal trades)</li>
                    <li>• Used for community metrics only</li>
                  </ul>
                </div>

                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Blink API Key (READ-only)
                  </label>
                  <input
                    type="password"
                    value={consentApiKey}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setConsentApiKey(e.target.value)
                    }
                    placeholder="blink_xxxxx..."
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-blink-dark text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500 font-mono text-sm"
                  />
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Get your API key from{" "}
                    <a
                      href="https://dashboard.blink.sv"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-teal-600 hover:underline"
                    >
                      dashboard.blink.sv
                    </a>{" "}
                    → API Keys
                  </p>
                </div>

                {error && (
                  <div className="mb-4 text-sm text-red-600 dark:text-red-400">
                    {error}
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setShowConsentModal(false)
                      setConsentCommunity(null)
                      setConsentApiKey("")
                      setError("")
                    }}
                    className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitConsent}
                    disabled={submittingConsent || !consentApiKey}
                    className="flex-1 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-50"
                  >
                    {submittingConsent ? "Sharing..." : "Share Data"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )
    }

    // ============================================
    // LEADER DASHBOARD VIEW
    // ============================================
    if (currentView === "leader" && selectedCommunity) {
      // Filter applications for this community
      const communityApplications = pendingApplications.filter(
        (app) => app.community_id === selectedCommunity.id,
      )

      // Calculate time ago for applications
      const getTimeAgo = (dateStr: string): string => {
        const applied = new Date(dateStr)
        const now = new Date()
        const hoursAgo = (now.getTime() - applied.getTime()) / (1000 * 60 * 60)
        if (hoursAgo < 1) return "Just now"
        if (hoursAgo < 24) return `${Math.round(hoursAgo)} hours ago`
        return `${Math.round(hoursAgo / 24)} days ago`
      }

      return (
        <div
          className="h-full flex flex-col bg-white dark:bg-black overflow-hidden"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          {/* Header */}
          <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700">
            <button
              onClick={() => navigateToView("community", selectedCommunity)}
              className="flex items-center text-gray-600 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 mb-3"
            >
              <svg
                className="w-5 h-5 mr-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              Back to Dashboard
            </button>

            <div className="flex items-center gap-3">
              {/* Leader Profile Image */}
              <div className="flex-shrink-0">
                {leaderProfiles[selectedCommunity.leader_npub]?.picture ? (
                  <img
                    src={leaderProfiles[selectedCommunity.leader_npub].picture}
                    alt={selectedCommunity.name}
                    className="w-12 h-12 rounded-full object-cover ring-2 ring-purple-500/30"
                    onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                      const target = e.target as HTMLImageElement
                      target.style.display = "none"
                      ;(target.nextElementSibling as HTMLElement).style.display = "flex"
                    }}
                  />
                ) : null}
                <div
                  className="w-12 h-12 rounded-full bg-gradient-to-br from-purple-500 to-teal-500 flex items-center justify-center text-white font-bold text-lg"
                  style={{
                    display: leaderProfiles[selectedCommunity.leader_npub]?.picture
                      ? "none"
                      : "flex",
                  }}
                >
                  {selectedCommunity.name.charAt(0)}
                </div>
              </div>

              <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                  Leader Dashboard
                </h1>
                <p className="text-gray-500 dark:text-gray-400">
                  {selectedCommunity.name}
                </p>
              </div>
            </div>
          </div>

          {/* Pending Applications */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Pending Applications
              </h3>
              <button
                onClick={() => fetchPendingApplications(selectedCommunity.id)}
                className="text-sm text-teal-600 dark:text-teal-400 hover:underline"
              >
                Refresh
              </button>
            </div>

            {/* Success/Error Messages */}
            {reviewSuccess && (
              <div className="mb-4 p-3 bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-700 rounded-lg text-green-700 dark:text-green-300 text-sm">
                ✅ {reviewSuccess}
              </div>
            )}
            {error && (
              <div className="mb-4 p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg text-red-700 dark:text-red-300 text-sm">
                ❌ {error}
              </div>
            )}

            {communityApplications.length === 0 ? (
              <div className="text-center py-8 bg-gray-50 dark:bg-blink-dark rounded-lg">
                <div className="text-4xl mb-2">✅</div>
                <p className="text-gray-500 dark:text-gray-400">
                  No pending applications
                </p>
                <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">
                  New applications will appear here
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {communityApplications.map((app) => {
                  const profile = memberProfiles[app.user_npub]
                  const displayName = profile?.name || profile?.display_name || "Unknown"
                  const shortNpub = app.user_npub
                    ? `${app.user_npub.slice(0, 12)}...${app.user_npub.slice(-8)}`
                    : ""

                  // Fetch profile if not cached
                  if (!profile && app.user_npub && !memberProfiles[app.user_npub]) {
                    fetchMemberProfiles([{ user_npub: app.user_npub }])
                  }

                  return (
                    <div
                      key={app.id}
                      className="bg-gray-50 dark:bg-blink-dark rounded-lg p-4 border border-gray-200 dark:border-gray-700"
                    >
                      <div className="flex items-start gap-3">
                        {/* Profile Photo */}
                        <div className="flex-shrink-0">
                          {profile?.picture ? (
                            <img
                              src={profile.picture}
                              alt={displayName}
                              className="w-12 h-12 rounded-full object-cover ring-2 ring-yellow-400"
                              onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                                const target = e.target as HTMLImageElement
                                target.style.display = "none"
                                ;(
                                  target.nextElementSibling as HTMLElement
                                ).style.display = "flex"
                              }}
                            />
                          ) : null}
                          <div
                            className="w-12 h-12 rounded-full bg-gradient-to-br from-yellow-500 to-orange-500 flex items-center justify-center text-white font-bold text-lg"
                            style={{ display: profile?.picture ? "none" : "flex" }}
                          >
                            {displayName.charAt(0).toUpperCase()}
                          </div>
                        </div>

                        {/* Applicant Info */}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-gray-900 dark:text-white">
                            {displayName}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                            {shortNpub}
                          </p>
                          {app.application_note && (
                            <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 italic bg-gray-100 dark:bg-gray-800 p-2 rounded">
                              &quot;{app.application_note}&quot;
                            </p>
                          )}
                          {!app.application_note && (
                            <p className="text-sm text-gray-400 dark:text-gray-500 mt-2 italic">
                              No message provided
                            </p>
                          )}
                          <p className="text-xs text-gray-500 dark:text-gray-500 mt-2">
                            Applied {getTimeAgo(app.applied_at)}
                          </p>
                        </div>

                        {/* Action Buttons */}
                        <div className="flex gap-2 flex-shrink-0">
                          <button
                            onClick={() => reviewApplication(app.id, "reject")}
                            disabled={reviewingId === app.id}
                            className="px-3 py-1.5 bg-red-100 dark:bg-red-900 text-red-600 dark:text-red-400 rounded-lg text-sm hover:bg-red-200 dark:hover:bg-red-800 disabled:opacity-50"
                          >
                            {reviewingId === app.id ? "..." : "Reject"}
                          </button>
                          <button
                            onClick={() => reviewApplication(app.id, "approve")}
                            disabled={reviewingId === app.id}
                            className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
                          >
                            {reviewingId === app.id ? "..." : "Approve"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Data Sync Section */}
            <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  📊 Transaction Data
                </h3>
                <button
                  onClick={() => triggerSync(selectedCommunity.id)}
                  disabled={syncing}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {syncing ? (
                    <>
                      <svg
                        className="animate-spin h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        ></circle>
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        ></path>
                      </svg>
                      Syncing...
                    </>
                  ) : (
                    <>
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                      </svg>
                      Sync Now
                    </>
                  )}
                </button>
              </div>

              <div className="bg-gray-50 dark:bg-blink-dark rounded-lg p-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Members Sharing Data
                    </p>
                    <p className="text-xl font-bold text-gray-900 dark:text-white">
                      {selectedCommunity.data_sharing_member_count || 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Transactions
                    </p>
                    <p className="text-xl font-bold text-gray-900 dark:text-white">
                      {selectedCommunity.transaction_count || 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">Volume</p>
                    <p className="text-xl font-bold text-gray-900 dark:text-white">
                      {(selectedCommunity.transaction_volume_sats || 0).toLocaleString()}{" "}
                      sats
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Closed Loop
                    </p>
                    <p className="text-xl font-bold text-green-600 dark:text-green-400">
                      {selectedCommunity.closed_loop_ratio || 0}%
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">Txs/Member</p>
                    <p className="text-xl font-bold text-gray-900 dark:text-white">
                      {selectedCommunity.velocity || 0}
                    </p>
                  </div>
                  {/* Bitcoin Preference */}
                  {selectedCommunity.bitcoin_preference && (
                    <div>
                      <p className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-1">
                        <span className="text-amber-500">₿</span> BTC Preference
                      </p>
                      <p className="text-xl font-bold text-amber-600 dark:text-amber-400">
                        {selectedCommunity.bitcoin_preference.btc_preference_pct != null
                          ? `${selectedCommunity.bitcoin_preference.btc_preference_pct >= 100 ? 100 : Math.floor(selectedCommunity.bitcoin_preference.btc_preference_pct)}`
                          : 0}
                        %
                      </p>
                    </div>
                  )}
                </div>

                {syncResult && (
                  <div className="mt-4 p-3 bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-700 rounded-lg text-green-700 dark:text-green-300 text-sm">
                    ✅ Synced {syncResult.members_synced} member(s),{" "}
                    {syncResult.total_transactions} transactions
                  </div>
                )}

                {selectedCommunity.oldest_tx_date && selectedCommunity.newest_tx_date && (
                  <div className="mt-4 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg">
                    <p className="text-xs text-gray-500 dark:text-gray-400 font-medium mb-1">
                      📅 Data Period: {selectedCommunity.period_days || 0} days
                    </p>
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      {new Date(selectedCommunity.oldest_tx_date).toLocaleDateString()} →{" "}
                      {new Date(selectedCommunity.newest_tx_date).toLocaleDateString()}
                    </p>
                  </div>
                )}

                {selectedCommunity.metrics_last_updated && (
                  <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                    Last synced:{" "}
                    {new Date(selectedCommunity.metrics_last_updated).toLocaleString()}
                  </p>
                )}
              </div>
            </div>

            {/* Member Management Section */}
            <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  👥 Community Members ({communityMembers.length})
                </h3>
                <button
                  onClick={() => fetchCommunityMembers(selectedCommunity.id)}
                  className="text-sm text-teal-600 dark:text-teal-400 hover:underline"
                >
                  Refresh
                </button>
              </div>

              {loadingMembers ? (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                  Loading members...
                </div>
              ) : communityMembers.length === 0 ? (
                <div className="text-center py-8 bg-gray-50 dark:bg-blink-dark rounded-lg">
                  <div className="text-4xl mb-2">👥</div>
                  <p className="text-gray-500 dark:text-gray-400">No members yet</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {communityMembers.map((member) => {
                    const profile = memberProfiles[member.user_npub]
                    const isLeaderMember = member.role === "leader"
                    const displayName =
                      profile?.name ||
                      profile?.display_name ||
                      member.blink_username ||
                      "Unknown"
                    const shortNpub = member.user_npub
                      ? `${member.user_npub.slice(0, 12)}...${member.user_npub.slice(-8)}`
                      : ""

                    return (
                      <div
                        key={member.id}
                        className="bg-gray-50 dark:bg-blink-dark rounded-lg p-4 border border-gray-200 dark:border-gray-700"
                      >
                        <div className="flex items-center gap-3">
                          {/* Profile Photo */}
                          <div className="flex-shrink-0">
                            {profile?.picture ? (
                              <img
                                src={profile.picture}
                                alt={displayName}
                                className="w-12 h-12 rounded-full object-cover ring-2 ring-gray-200 dark:ring-gray-700"
                                onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                                  const target = e.target as HTMLImageElement
                                  target.style.display = "none"
                                  ;(
                                    target.nextElementSibling as HTMLElement
                                  ).style.display = "flex"
                                }}
                              />
                            ) : null}
                            <div
                              className="w-12 h-12 rounded-full bg-gradient-to-br from-purple-500 to-teal-500 flex items-center justify-center text-white font-bold text-lg"
                              style={{ display: profile?.picture ? "none" : "flex" }}
                            >
                              {displayName.charAt(0).toUpperCase()}
                            </div>
                          </div>

                          {/* Member Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-medium text-gray-900 dark:text-white truncate">
                                {displayName}
                              </p>
                              {isLeaderMember && (
                                <span className="px-2 py-0.5 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 text-xs rounded-full">
                                  Leader
                                </span>
                              )}
                              {member.consent_given && (
                                <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 text-xs rounded-full">
                                  📊 Sharing
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
                              {shortNpub}
                            </p>
                            {member.blink_username && (
                              <p className="text-xs text-blue-600 dark:text-blue-400">
                                @{member.blink_username}
                              </p>
                            )}
                            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                              Joined{" "}
                              {member.approved_at
                                ? new Date(member.approved_at).toLocaleDateString()
                                : "Unknown"}
                            </p>
                          </div>

                          {/* Actions */}
                          {!isLeaderMember && (
                            <div className="flex-shrink-0">
                              {showRemoveConfirm === member.id ? (
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => setShowRemoveConfirm(null)}
                                    className="px-2 py-1 text-xs text-gray-600 dark:text-gray-400 hover:underline"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={() => removeMember(member.id)}
                                    disabled={removingMemberId === member.id}
                                    className="px-3 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700 disabled:opacity-50"
                                  >
                                    {removingMemberId === member.id ? "..." : "Confirm"}
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setShowRemoveConfirm(member.id)}
                                  className="px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded text-sm"
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )
    }

    // ============================================
    // CREATE COMMUNITY VIEW (Super Admin Only)
    // ============================================
    if (currentView === "create") {
      // Only super admin can access this view
      if (!isSuperAdmin) {
        return (
          <div
            className="h-full flex flex-col bg-white dark:bg-black overflow-hidden"
            style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
          >
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="text-6xl mb-4">🔒</div>
                <p className="text-gray-600 dark:text-gray-400 text-lg">Access Denied</p>
                <p className="text-gray-500 dark:text-gray-500 text-sm mt-2">
                  Only super admin can create new communities
                </p>
                <button
                  onClick={() => navigateToView("discovery")}
                  className="mt-4 px-4 py-2 bg-teal-600 text-white rounded-lg"
                >
                  Go Back
                </button>
              </div>
            </div>
          </div>
        )
      }

      return (
        <div
          className="h-full flex flex-col bg-white dark:bg-black overflow-hidden"
          style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
        >
          {/* Header */}
          <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700">
            <button
              onClick={() => navigateToView("discovery")}
              className="flex items-center text-gray-600 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 mb-3"
            >
              <svg
                className="w-5 h-5 mr-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              Back
            </button>

            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                Add Community
              </h1>
              <span className="px-2 py-0.5 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 text-xs rounded-full">
                Super Admin
              </span>
            </div>
            <p className="text-gray-500 dark:text-gray-400 text-sm">
              Create a new Bitcoin Circular Economy and assign a leader
            </p>
          </div>

          {/* Form */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4 mb-6">
              <h3 className="font-medium text-purple-800 dark:text-purple-300 mb-2">
                How it works
              </h3>
              <ul className="text-sm text-purple-700 dark:text-purple-400 space-y-1">
                <li>• You provide community details and leader&apos;s npub</li>
                <li>• The leader will be whitelisted automatically</li>
                <li>• Leader can then approve member applications</li>
                <li>• Members can opt-in to share transaction data</li>
              </ul>
            </div>

            <div className="text-center py-8 bg-gray-50 dark:bg-blink-dark rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600">
              <div className="text-5xl mb-3">🚧</div>
              <p className="text-gray-600 dark:text-gray-400">
                Community creation form coming soon
              </p>
              <p className="text-gray-500 dark:text-gray-500 text-sm mt-2">
                Run database migrations first to enable this feature
              </p>
            </div>

            {/* Preview of current communities */}
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-3">
                Current Pioneer Communities
              </h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-blink-dark rounded-lg">
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white">
                      Bitcoin Ekasi
                    </span>
                    <span className="text-gray-500 dark:text-gray-400 text-sm ml-2">
                      🇿🇦 South Africa
                    </span>
                  </div>
                  <span className="text-xs text-green-600 dark:text-green-400">
                    Active
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-blink-dark rounded-lg">
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white">
                      Bitcoin Victoria Falls
                    </span>
                    <span className="text-gray-500 dark:text-gray-400 text-sm ml-2">
                      🇿🇼 Zimbabwe
                    </span>
                  </div>
                  <span className="text-xs text-green-600 dark:text-green-400">
                    Active
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )
    }

    // Default fallback
    return null
  },
)

Network.displayName = "Network"
export default Network
