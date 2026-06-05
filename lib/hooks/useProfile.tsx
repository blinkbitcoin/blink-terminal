/**
 * useProfile - React hook for profile and credential management
 *
 * Provides:
 * - Blink account management
 * - NWC connection management
 * - Settings management
 * - Profile switching
 * - Cross-device sync via server storage
 *
 * IMPORTANT: ProfileProvider MUST be nested inside NostrAuthProvider.
 * Example in _app.js:
 *   <NostrAuthProvider>
 *     <ProfileProvider>
 *       <Component {...pageProps} />
 *     </ProfileProvider>
 *   </NostrAuthProvider>
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  createContext,
  useContext,
  useRef,
} from "react"

import CryptoUtils, { type EncryptedData } from "../storage/CryptoUtils"
import ProfileStorage, {
  type StoredBlinkAccount,
  type StoredNWCConnection,
  type StoredTippingSettings,
  type StoredPreferences,
  type StoredProfile,
  type ProfileExportData,
} from "../storage/ProfileStorage"

import { mergeProfileData } from "./profileMerge"
import { useNostrAuth } from "./useNostrAuth"

// ============= Server Response Types =============

interface ServerBlinkApiAccount {
  id: string
  label: string
  username?: string
  apiKey?: string
  defaultCurrency?: string
  isActive: boolean
  createdAt: string
  lastUsed?: string
}

interface ServerLnAddressWallet {
  id: string
  label: string
  username?: string
  lightningAddress?: string
  walletId?: string
  isActive: boolean
  createdAt: string
  lastUsed?: string
}

interface ServerNpubCashWallet {
  id: string
  label: string
  address?: string
  lightningAddress?: string
  localpart?: string
  isNpub?: boolean
  pubkey?: string
  isActive: boolean
  createdAt?: string
  lastUsed?: string
}

// ============= Local Type Definitions =============

/**
 * Local account shape — different from the global BlinkAccount in nostr.d.ts
 * because the local version may carry extra fields from different wallet types
 * (ln-address, npub-cash, API-key).
 */
export interface LocalBlinkAccount {
  id: string
  label: string
  apiKey?: EncryptedData // Encrypted blob from CryptoUtils
  username?: string
  defaultCurrency?: string
  isActive: boolean
  createdAt?: number | string
  lastUsed?: number | null
  type?: string // 'ln-address' | 'npub-cash' | undefined (for API key accounts)
  lightningAddress?: string
  walletId?: string
  walletCurrency?: string
  localpart?: string
  isNpub?: boolean
  pubkey?: string
  address?: string
  source?: string
  addedAt?: string
}

interface ProfileState {
  loading: boolean
  error: string | null
  blinkAccounts: LocalBlinkAccount[]
  nwcConnections: StoredNWCConnection[]
  tippingSettings: StoredTippingSettings | null
  preferences: StoredPreferences | null
  serverSynced: boolean
}

interface ProfileProviderProps {
  children: React.ReactNode
}

export interface ProfileContextValue {
  // State
  loading: boolean
  error: string | null

  // Profile data
  blinkAccounts: LocalBlinkAccount[]
  nwcConnections: StoredNWCConnection[]
  tippingSettings: StoredTippingSettings | null
  preferences: StoredPreferences | null

  // Computed
  activeBlinkAccount: LocalBlinkAccount | null
  activeNWCConnection: StoredNWCConnection | null
  hasBlinkAccount: boolean
  hasNWCConnection: boolean
  hasNpubCashWallet: boolean
  npubCashWallets: LocalBlinkAccount[]
  activeNpubCashWallet: LocalBlinkAccount | null

  // Blink account actions
  addBlinkAccount: (params: {
    label: string
    apiKey: string
    username: string
    defaultCurrency?: string
  }) => Promise<{ success: boolean; account?: StoredBlinkAccount; error?: string }>
  addBlinkLnAddressAccount: (params: {
    label: string
    username: string
    walletId: string
    walletCurrency?: string
    lightningAddress: string
  }) => Promise<{ success: boolean; account?: StoredBlinkAccount; error?: string }>
  addNpubCashAccount: (params: {
    lightningAddress: string
    label?: string
  }) => Promise<{ success: boolean; wallet?: StoredBlinkAccount; error?: string }>
  getBlinkApiKey: (accountId: string) => Promise<string | null>
  getActiveBlinkApiKey: () => Promise<string | null>
  setActiveBlinkAccount: (accountId: string) => void
  updateBlinkAccount: (
    accountId: string,
    updates: Partial<LocalBlinkAccount>,
  ) => Promise<{ success: boolean; error?: string }>
  removeBlinkAccount: (accountId: string) => Promise<{ success: boolean; error?: string }>

  // NWC connection actions
  addNWCConnection: (params: {
    label: string
    uri: string
    capabilities?: string[]
  }) => Promise<{ success: boolean; connection?: StoredNWCConnection; error?: string }>
  getNWCUri: (connectionId: string) => Promise<string>
  getActiveNWCUri: () => Promise<string | null>
  setActiveNWCConnection: (connectionId: string) => void
  removeNWCConnection: (connectionId: string) => { success: boolean; error?: string }

  // Settings actions
  updateTippingSettings: (settings: Partial<StoredTippingSettings>) => {
    success: boolean
    error?: string
  }
  updatePreferences: (preferences: Partial<StoredPreferences>) => {
    success: boolean
    error?: string
  }

  // Export/Import
  exportProfile: () => ProfileExportData
  exportAllProfiles: () => ProfileExportData
  importProfiles: (
    data: ProfileExportData,
    merge?: boolean,
  ) => { success: boolean; error?: string }

  // Refresh
  refreshProfile: () => Promise<void>
}

// Server sync debounce
const SERVER_SYNC_DEBOUNCE_MS = 1000

const ProfileContext = createContext<ProfileContextValue | null>(null)

/**
 * ProfileProvider - Provides profile management context
 *
 * NOTE: This provider requires NostrAuthProvider as an ancestor.
 * Ensure the provider hierarchy is: NostrAuthProvider > ProfileProvider
 */
export function ProfileProvider({ children }: ProfileProviderProps): React.JSX.Element {
  // This hook requires NostrAuthProvider - will throw if not wrapped correctly
  const {
    isAuthenticated,
    publicKey,
    profile: authProfile,
    refreshProfile: refreshAuthProfile,
    hasServerSession,
  } = useNostrAuth() as {
    isAuthenticated: boolean
    publicKey: string | null
    profile: StoredProfile | null
    refreshProfile: () => void
    hasServerSession: boolean
  }

  const [state, setState] = useState<ProfileState>({
    loading: false,
    error: null,
    blinkAccounts: [],
    nwcConnections: [],
    tippingSettings: null,
    preferences: null,
    serverSynced: false,
  })

  // Server sync debounce timer
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Update state helper
   */
  const updateState = useCallback((updates: Partial<ProfileState>) => {
    setState((prev) => ({ ...prev, ...updates }))
  }, [])

  /**
   * Sync Blink API accounts to server (debounced)
   */
  const syncBlinkApiAccountsToServer = useCallback(
    async (accounts: LocalBlinkAccount[]) => {
      if (!publicKey) return

      // Clear existing timer
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current)
      }

      // Debounce the sync
      syncTimerRef.current = setTimeout(async () => {
        try {
          // Filter only API key accounts (not ln-address type)
          const apiAccounts = accounts.filter(
            (a: LocalBlinkAccount) => a.type !== "ln-address" && a.apiKey,
          )

          if (apiAccounts.length === 0) {
            console.log("[useProfile] No Blink API accounts to sync")
            return
          }

          console.log(
            "[useProfile] Syncing",
            apiAccounts.length,
            "Blink API accounts to server...",
          )

          // Decrypt API keys before sending to server (server will re-encrypt)
          const accountsWithDecryptedKeys = await Promise.all(
            apiAccounts.map(async (account: LocalBlinkAccount) => {
              let apiKey: string | null = null
              try {
                // API key is stored encrypted locally - decrypt it
                apiKey = await CryptoUtils.decryptWithDeviceKey(account.apiKey!)
              } catch (err: unknown) {
                console.error(
                  "[useProfile] Failed to decrypt API key for account:",
                  account.id,
                  err,
                )
              }

              return {
                id: account.id,
                label: account.label,
                username: account.username,
                apiKey,
                defaultCurrency: account.defaultCurrency || "BTC",
                isActive: account.isActive,
                createdAt: new Date(account.createdAt || Date.now()).toISOString(),
                lastUsed: account.lastUsed
                  ? new Date(account.lastUsed).toISOString()
                  : undefined,
              }
            }),
          )

          // Filter out accounts where decryption failed
          const validAccounts = accountsWithDecryptedKeys.filter((a) => a.apiKey)

          if (validAccounts.length === 0) {
            console.log("[useProfile] No valid Blink API accounts after decryption")
            return
          }

          const response = await fetch("/api/user/sync", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pubkey: publicKey,
              field: "blinkApiAccounts",
              data: validAccounts,
            }),
          })

          if (response.ok) {
            console.log("[useProfile] ✓ Blink API accounts synced to server")
            updateState({ serverSynced: true })
          } else {
            console.error("[useProfile] Server sync failed:", response.status)
          }
        } catch (err: unknown) {
          console.error("[useProfile] Server sync error:", err)
        }
      }, SERVER_SYNC_DEBOUNCE_MS)
    },
    [publicKey, updateState],
  )

  /**
   * Sync npub.cash wallets to server (debounced)
   */
  const syncNpubCashWalletsToServer = useCallback(
    async (accounts: LocalBlinkAccount[]) => {
      if (!publicKey) return

      // Clear existing timer
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current)
      }

      // Debounce the sync
      syncTimerRef.current = setTimeout(async () => {
        try {
          // Filter only npub.cash wallets
          const npubCashWallets = accounts.filter(
            (a: LocalBlinkAccount) => a.type === "npub-cash",
          )

          if (npubCashWallets.length === 0) {
            console.log("[useProfile] No npub.cash wallets to sync")
            return
          }

          console.log(
            "[useProfile] Syncing",
            npubCashWallets.length,
            "npub.cash wallets to server...",
          )

          const walletsToSync = npubCashWallets.map((wallet: LocalBlinkAccount) => ({
            id: wallet.id,
            label: wallet.label,
            address: wallet.lightningAddress || wallet.address,
            lightningAddress: wallet.lightningAddress || wallet.address,
            localpart: wallet.localpart,
            isNpub: wallet.isNpub,
            pubkey: wallet.pubkey,
            isActive: wallet.isActive,
            createdAt: new Date(wallet.createdAt || Date.now()).toISOString(),
            lastUsed: wallet.lastUsed
              ? new Date(wallet.lastUsed).toISOString()
              : undefined,
          }))

          const response = await fetch("/api/user/sync", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pubkey: publicKey,
              field: "npubCashWallets",
              data: walletsToSync,
            }),
          })

          if (response.ok) {
            console.log("[useProfile] ✓ npub.cash wallets synced to server")
            updateState({ serverSynced: true })
          } else {
            console.error("[useProfile] Server sync failed:", response.status)
          }
        } catch (err: unknown) {
          console.error("[useProfile] Server sync error:", err)
        }
      }, SERVER_SYNC_DEBOUNCE_MS)
    },
    [publicKey, updateState],
  )

  /**
   * Sync LN Address wallets to server (debounced)
   */
  const syncLnAddressWalletsToServer = useCallback(
    async (wallets: LocalBlinkAccount[]) => {
      if (!publicKey) return

      // Clear existing timer
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current)
      }

      // Debounce the sync
      syncTimerRef.current = setTimeout(async () => {
        try {
          // Filter only LN Address wallets
          const lnAddressWallets = wallets.filter(
            (w: LocalBlinkAccount) => w.type === "ln-address",
          )

          if (lnAddressWallets.length === 0) return

          console.log(
            "[useProfile] Syncing",
            lnAddressWallets.length,
            "LN Address wallets to server...",
          )

          const response = await fetch("/api/user/sync", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pubkey: publicKey,
              field: "blinkLnAddressWallets",
              data: lnAddressWallets.map((w: LocalBlinkAccount) => ({
                id: w.id,
                label: w.label,
                username: w.username,
                lightningAddress: w.lightningAddress,
                walletId: w.walletId,
                isActive: w.isActive,
                createdAt: new Date(w.createdAt as string | number).toISOString(),
                lastUsed: w.lastUsed ? new Date(w.lastUsed).toISOString() : undefined,
              })),
            }),
          })

          if (response.ok) {
            console.log("[useProfile] ✓ LN Address wallets synced to server")
            updateState({ serverSynced: true })
          } else {
            console.error("[useProfile] Server sync failed:", response.status)
          }
        } catch (err: unknown) {
          console.error("[useProfile] Server sync error:", err)
        }
      }, SERVER_SYNC_DEBOUNCE_MS)
    },
    [publicKey, updateState],
  )

  /**
   * Sync npub.cash wallets to server IMMEDIATELY (no debounce, for deletions)
   */
  const syncNpubCashWalletsToServerImmediate = useCallback(
    async (accounts: LocalBlinkAccount[]) => {
      if (!publicKey) return

      try {
        const npubCashWallets = accounts.filter(
          (a: LocalBlinkAccount) => a.type === "npub-cash",
        )

        console.log(
          "[useProfile] IMMEDIATE sync:",
          npubCashWallets.length,
          "npub.cash wallets to server",
        )

        const walletsToSync = npubCashWallets.map((wallet: LocalBlinkAccount) => ({
          id: wallet.id,
          label: wallet.label,
          address: wallet.lightningAddress || wallet.address,
          lightningAddress: wallet.lightningAddress || wallet.address,
          localpart: wallet.localpart,
          isNpub: wallet.isNpub,
          pubkey: wallet.pubkey,
          isActive: wallet.isActive,
          createdAt: new Date(wallet.createdAt || Date.now()).toISOString(),
          lastUsed: wallet.lastUsed ? new Date(wallet.lastUsed).toISOString() : undefined,
        }))

        const response = await fetch("/api/user/sync", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pubkey: publicKey,
            field: "npubCashWallets",
            data: walletsToSync,
          }),
        })

        if (response.ok) {
          console.log("[useProfile] ✓ npub.cash wallets synced immediately")
          updateState({ serverSynced: true })
        } else {
          console.error("[useProfile] Immediate sync failed:", response.status)
        }
      } catch (err: unknown) {
        console.error("[useProfile] Immediate sync error:", err)
      }
    },
    [publicKey, updateState],
  )

  /**
   * Sync LN Address wallets to server IMMEDIATELY (no debounce, for deletions)
   */
  const syncLnAddressWalletsToServerImmediate = useCallback(
    async (wallets: LocalBlinkAccount[]) => {
      if (!publicKey) return

      try {
        const lnAddressWallets = wallets.filter(
          (w: LocalBlinkAccount) => w.type === "ln-address",
        )

        console.log(
          "[useProfile] IMMEDIATE sync:",
          lnAddressWallets.length,
          "LN Address wallets to server",
        )

        const response = await fetch("/api/user/sync", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pubkey: publicKey,
            field: "blinkLnAddressWallets",
            data: lnAddressWallets.map((w: LocalBlinkAccount) => ({
              id: w.id,
              label: w.label,
              username: w.username,
              lightningAddress: w.lightningAddress,
              walletId: w.walletId,
              isActive: w.isActive,
              createdAt: new Date(w.createdAt || Date.now()).toISOString(),
              lastUsed: w.lastUsed ? new Date(w.lastUsed).toISOString() : undefined,
            })),
          }),
        })

        if (response.ok) {
          console.log("[useProfile] ✓ LN Address wallets synced immediately")
          updateState({ serverSynced: true })
        }
      } catch (err: unknown) {
        console.error("[useProfile] Immediate sync error:", err)
      }
    },
    [publicKey, updateState],
  )

  /**
   * Sync Blink API accounts to server IMMEDIATELY (no debounce, for deletions)
   */
  const syncBlinkApiAccountsToServerImmediate = useCallback(
    async (accounts: LocalBlinkAccount[]) => {
      if (!publicKey) return

      try {
        const apiAccounts = accounts.filter(
          (a: LocalBlinkAccount) =>
            a.type !== "ln-address" && a.type !== "npub-cash" && a.apiKey,
        )

        console.log(
          "[useProfile] IMMEDIATE sync:",
          apiAccounts.length,
          "Blink API accounts to server",
        )

        const accountsWithDecryptedKeys = await Promise.all(
          apiAccounts.map(async (account: LocalBlinkAccount) => {
            let apiKey: string | null = null
            try {
              apiKey = await CryptoUtils.decryptWithDeviceKey(account.apiKey!)
            } catch (_decryptErr: unknown) {
              console.warn("[useProfile] Could not decrypt API key for", account.username)
            }
            return {
              id: account.id,
              label: account.label,
              username: account.username,
              apiKey,
              defaultCurrency: account.defaultCurrency || "BTC",
              isActive: account.isActive,
              createdAt: new Date(account.createdAt || Date.now()).toISOString(),
              lastUsed: account.lastUsed
                ? new Date(account.lastUsed).toISOString()
                : undefined,
            }
          }),
        )

        const validAccounts = accountsWithDecryptedKeys.filter((a) => a.apiKey)

        const response = await fetch("/api/user/sync", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pubkey: publicKey,
            field: "blinkApiAccounts",
            data: validAccounts,
          }),
        })

        if (response.ok) {
          console.log("[useProfile] ✓ Blink API accounts synced immediately")
          updateState({ serverSynced: true })
        }
      } catch (err: unknown) {
        console.error("[useProfile] Immediate sync error:", err)
      }
    },
    [publicKey, updateState],
  )

  /**
   * Sync NWC connections to the server (immediate).
   *
   * NWC URIs are bearer secrets stored device-encrypted locally; the server
   * stores them re-encrypted with the server key. We decrypt each URI with the
   * device key, send plaintext, and the server re-encrypts on write. Connection
   * `id`s are preserved so the records round-trip across devices.
   */
  const syncNWCConnectionsToServer = useCallback(
    async (connections: StoredNWCConnection[]) => {
      if (!publicKey) return

      try {
        const connectionsToSync = (
          await Promise.all(
            connections.map(async (conn: StoredNWCConnection) => {
              let uri: string | null = null
              try {
                uri = await CryptoUtils.decryptWithDeviceKey(conn.uri)
              } catch (err: unknown) {
                console.warn(
                  "[useProfile] Could not decrypt NWC URI for connection:",
                  conn.id,
                  err,
                )
              }
              if (!uri) return null
              return {
                id: conn.id,
                label: conn.label,
                uri,
                capabilities: conn.capabilities || [],
                isActive: conn.isActive,
                createdAt: conn.createdAt,
              }
            }),
          )
        ).filter((c): c is NonNullable<typeof c> => c !== null)

        const response = await fetch("/api/user/sync", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pubkey: publicKey,
            field: "nwcConnections",
            data: connectionsToSync,
          }),
        })

        if (response.ok) {
          console.log("[useProfile] ✓ NWC connections synced to server")
          updateState({ serverSynced: true })
        } else {
          console.error("[useProfile] NWC sync failed:", response.status)
        }
      } catch (err: unknown) {
        console.error("[useProfile] NWC sync error:", err)
      }
    },
    [publicKey, updateState],
  )

  /**
   * Fetch all Blink data from server (API accounts + LN Address wallets)
   * NOTE: This requires hasServerSession to be true - caller must check
   */
  const fetchBlinkDataFromServer = useCallback(async (): Promise<{
    blinkApiAccounts: ServerBlinkApiAccount[]
    blinkLnAddressWallets: ServerLnAddressWallet[]
    npubCashWallets: ServerNpubCashWallet[]
    nwcConnections: StoredNWCConnection[]
    /**
     * Whether this result reflects an authoritative read of the server.
     * `false` means the fetch was skipped or failed (e.g. the session was not
     * yet established), and the empty arrays do NOT mean "the server has no
     * data". Callers MUST NOT treat a non-authoritative result as a signal to
     * overwrite/delete server-side data — doing so clobbers wallets that other
     * devices added (the cross-device divergence bug).
     */
    authoritative: boolean
  }> => {
    const empty = {
      blinkApiAccounts: [],
      blinkLnAddressWallets: [],
      npubCashWallets: [],
      nwcConnections: [],
    }

    if (!publicKey) return { ...empty, authoritative: false }

    // IMPORTANT: Don't fetch from server if session isn't established yet
    // This prevents 401 errors during the auth race condition. The result is
    // marked non-authoritative so the merge does not push local state up.
    if (!hasServerSession) {
      console.log(
        "[useProfile] Skipping server fetch - no session yet (hasServerSession:",
        hasServerSession,
        ")",
      )
      return { ...empty, authoritative: false }
    }

    try {
      console.log("[useProfile] Fetching Blink data from server (session established)...")
      const response = await fetch(`/api/user/sync?pubkey=${publicKey}`)

      if (!response.ok) {
        console.error("[useProfile] Server fetch failed:", response.status)
        return { ...empty, authoritative: false }
      }

      const data = await response.json()
      console.log("[useProfile] Server returned:", {
        blinkApiAccounts: data.blinkApiAccounts?.length || 0,
        blinkLnAddressWallets: data.blinkLnAddressWallets?.length || 0,
        npubCashWallets: data.npubCashWallets?.length || 0,
        nwcConnections: data.nwcConnections?.length || 0,
      })

      return {
        blinkApiAccounts: data.blinkApiAccounts || [],
        blinkLnAddressWallets: data.blinkLnAddressWallets || [],
        npubCashWallets: data.npubCashWallets || [],
        nwcConnections: data.nwcConnections || [],
        authoritative: true,
      }
    } catch (err: unknown) {
      console.error("[useProfile] Server fetch error:", err)
      return { ...empty, authoritative: false }
    }
  }, [publicKey, hasServerSession])

  /**
   * Fetch LN Address wallets from server (backwards compatibility)
   */
  const _fetchLnAddressWalletsFromServer = useCallback(async (): Promise<
    ServerLnAddressWallet[]
  > => {
    const data = await fetchBlinkDataFromServer()
    return data.blinkLnAddressWallets
  }, [fetchBlinkDataFromServer])

  /**
   * Load profile data (with server sync for all Blink wallets)
   */
  const loadProfileData = useCallback(async (): Promise<void> => {
    if (!isAuthenticated || !authProfile) {
      updateState({
        blinkAccounts: [],
        nwcConnections: [],
        tippingSettings: null,
        preferences: null,
      })
      return
    }

    // Load from localStorage first
    const localAccounts: LocalBlinkAccount[] = authProfile.blinkAccounts || []

    updateState({
      blinkAccounts: localAccounts,
      nwcConnections: authProfile.nwcConnections || [],
      tippingSettings: authProfile.tippingSettings || null,
      preferences: authProfile.preferences || null,
    })

    // Fetch all Blink data from server for cross-device sync
    const serverData = await fetchBlinkDataFromServer()

    // CROSS-DEVICE SYNC CORRECTNESS:
    // If the read was NOT authoritative (session not yet established, or the
    // request failed) the empty arrays do not mean "the server has no data".
    // In that case we keep the local view as-is and DO NOT merge or push
    // anything up — pushing a partial/empty local set would overwrite wallets
    // that other devices added (the root cause of devices showing different
    // wallet sets). We'll re-run once the session is ready.
    if (!serverData.authoritative) {
      console.log(
        "[useProfile] Non-authoritative server read - keeping local view, no sync-up",
      )
      return
    }

    // Server-authoritative merge of local + server data. Pure logic lives in
    // lib/hooks/profileMerge.ts so it can be unit-tested in isolation; the hook
    // owns all I/O (state, localStorage, server PATCHes).
    const {
      mergedAccounts,
      mergedNwcConnections,
      needsLocalUpdate,
      needsServerSyncApi,
      needsServerSyncLnAddr,
      needsServerSyncNpubCash,
      needsServerSyncNwc,
    } = await mergeProfileData({
      localAccounts,
      localNwcConnections: authProfile.nwcConnections || [],
      server: {
        blinkApiAccounts: serverData.blinkApiAccounts || [],
        blinkLnAddressWallets: serverData.blinkLnAddressWallets || [],
        npubCashWallets: serverData.npubCashWallets || [],
        nwcConnections: serverData.nwcConnections || [],
      },
      encryptWithDeviceKey: CryptoUtils.encryptWithDeviceKey.bind(CryptoUtils),
    })

    // Update localStorage with merged data if needed
    if (needsLocalUpdate && authProfile.id) {
      console.log("[useProfile] Updating localStorage with merged accounts")
      const profile = ProfileStorage.getProfileById(authProfile.id)
      if (profile) {
        profile.blinkAccounts = mergedAccounts as StoredBlinkAccount[]
        profile.nwcConnections = mergedNwcConnections
        ProfileStorage.updateProfile(profile)
      }
    }

    updateState({
      blinkAccounts: mergedAccounts,
      nwcConnections: mergedNwcConnections,
      serverSynced: true,
    })

    // Sync local-only items to server
    if (needsServerSyncApi) {
      syncBlinkApiAccountsToServer(mergedAccounts)
    }
    if (needsServerSyncLnAddr) {
      syncLnAddressWalletsToServer(mergedAccounts)
    }
    if (needsServerSyncNpubCash) {
      syncNpubCashWalletsToServer(mergedAccounts)
    }
    if (needsServerSyncNwc) {
      syncNWCConnectionsToServer(mergedNwcConnections)
    }
  }, [
    isAuthenticated,
    authProfile,
    updateState,
    fetchBlinkDataFromServer,
    syncBlinkApiAccountsToServer,
    syncLnAddressWalletsToServer,
    syncNpubCashWalletsToServer,
    syncNWCConnectionsToServer,
  ])

  // Load profile data when auth changes
  useEffect(() => {
    loadProfileData()
  }, [loadProfileData])

  // Cleanup sync timer on unmount
  useEffect(() => {
    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current)
      }
    }
  }, [])

  // ============= Blink Account Management =============

  /**
   * Add a new Blink account (via API key)
   */
  const addBlinkAccount = useCallback(
    async ({
      label,
      apiKey,
      username,
      defaultCurrency,
    }: {
      label: string
      apiKey: string
      username: string
      defaultCurrency?: string
    }): Promise<{ success: boolean; account?: StoredBlinkAccount; error?: string }> => {
      if (!authProfile) throw new Error("Not authenticated")

      const profileId: string = authProfile.id
      updateState({ loading: true, error: null })

      try {
        const account = await ProfileStorage.addBlinkAccount(
          profileId,
          label,
          apiKey,
          username,
          defaultCurrency,
        )

        // Refresh auth profile state
        refreshAuthProfile()

        // Load data directly from storage to avoid stale closure issues
        const freshProfile = ProfileStorage.getProfileById(profileId)
        if (freshProfile) {
          const _activeAccount: StoredBlinkAccount | null =
            freshProfile.blinkAccounts.find((a: StoredBlinkAccount) => a.isActive) || null
          updateState({
            loading: false,
            blinkAccounts: freshProfile.blinkAccounts,
          })

          // Sync Blink API accounts to server for cross-device sync
          syncBlinkApiAccountsToServer(freshProfile.blinkAccounts)
        } else {
          updateState({ loading: false })
        }

        return { success: true, account }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Failed to add Blink account:", error)
        updateState({ loading: false, error: err.message })
        return { success: false, error: err.message }
      }
    },
    [authProfile, refreshAuthProfile, updateState, syncBlinkApiAccountsToServer],
  )

  /**
   * Add a new Blink account via Lightning Address (no API key)
   */
  const addBlinkLnAddressAccount = useCallback(
    async ({
      label,
      username,
      walletId,
      walletCurrency,
      lightningAddress,
    }: {
      label: string
      username: string
      walletId: string
      walletCurrency?: string
      lightningAddress: string
    }): Promise<{ success: boolean; account?: StoredBlinkAccount; error?: string }> => {
      if (!authProfile) throw new Error("Not authenticated")

      const profileId: string = authProfile.id
      updateState({ loading: true, error: null })

      try {
        const account = await ProfileStorage.addBlinkLnAddressAccount(profileId, {
          label,
          username,
          walletId,
          walletCurrency: walletCurrency as string,
          lightningAddress,
        })

        // Refresh auth profile state
        refreshAuthProfile()

        // Load data directly from storage to avoid stale closure issues
        const freshProfile = ProfileStorage.getProfileById(profileId)
        if (freshProfile) {
          const _activeAccount: StoredBlinkAccount | null =
            freshProfile.blinkAccounts.find((a: StoredBlinkAccount) => a.isActive) || null
          updateState({
            loading: false,
            blinkAccounts: freshProfile.blinkAccounts,
          })

          // Sync LN Address wallets to server
          syncLnAddressWalletsToServer(freshProfile.blinkAccounts)
        } else {
          updateState({ loading: false })
        }

        return { success: true, account }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Failed to add Blink LN Address account:", error)
        updateState({ loading: false, error: err.message })
        return { success: false, error: err.message }
      }
    },
    [authProfile, refreshAuthProfile, updateState, syncLnAddressWalletsToServer],
  )

  /**
   * Add npub.cash wallet
   * npub.cash wallets receive payments as Cashu ecash tokens
   */
  const addNpubCashAccount = useCallback(
    async ({
      lightningAddress,
      label,
    }: {
      lightningAddress: string
      label?: string
    }): Promise<{ success: boolean; wallet?: StoredBlinkAccount; error?: string }> => {
      if (!authProfile) throw new Error("Not authenticated")

      const profileId: string = authProfile.id
      updateState({ loading: true, error: null })

      try {
        const wallet = await ProfileStorage.addNpubCashAccount(profileId, {
          lightningAddress,
          label: label as string,
        })

        // Refresh auth profile state
        refreshAuthProfile()

        // Load data directly from storage to avoid stale closure issues
        const freshProfile = ProfileStorage.getProfileById(profileId)
        if (freshProfile) {
          const _activeAccount: StoredBlinkAccount | null =
            freshProfile.blinkAccounts.find((a: StoredBlinkAccount) => a.isActive) || null
          updateState({
            loading: false,
            blinkAccounts: freshProfile.blinkAccounts,
          })

          // Sync npub.cash wallets to server
          syncNpubCashWalletsToServer(freshProfile.blinkAccounts)
        } else {
          updateState({ loading: false })
        }

        return { success: true, wallet }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Failed to add npub.cash wallet:", error)
        updateState({ loading: false, error: err.message })
        return { success: false, error: err.message }
      }
    },
    [authProfile, refreshAuthProfile, updateState, syncNpubCashWalletsToServer],
  )

  /**
   * Get decrypted API key for an account
   */
  const getBlinkApiKey = useCallback(
    async (accountId: string): Promise<string | null> => {
      if (!authProfile) throw new Error("Not authenticated")

      try {
        return await ProfileStorage.getBlinkApiKey(authProfile.id, accountId)
      } catch (error: unknown) {
        console.error("Failed to get API key:", error)
        throw error
      }
    },
    [authProfile],
  )

  /**
   * Get API key for active Blink account
   */
  const getActiveBlinkApiKey = useCallback(async (): Promise<string | null> => {
    if (!authProfile) return null

    try {
      return await ProfileStorage.getActiveBlinkApiKey(authProfile.id)
    } catch (error: unknown) {
      console.error("Failed to get active API key:", error)
      return null
    }
  }, [authProfile])

  /**
   * Set active Blink account
   */
  const setActiveBlinkAccount = useCallback(
    (accountId: string): void => {
      if (!authProfile) throw new Error("Not authenticated")

      const profileId: string = authProfile.id

      try {
        ProfileStorage.setActiveBlinkAccount(profileId, accountId)

        // Refresh auth profile state
        refreshAuthProfile()

        // Load data directly from storage to avoid stale closure issues
        const freshProfile = ProfileStorage.getProfileById(profileId)
        if (freshProfile) {
          const _activeAccount: StoredBlinkAccount | null =
            freshProfile.blinkAccounts.find((a: StoredBlinkAccount) => a.isActive) || null
          updateState({
            blinkAccounts: freshProfile.blinkAccounts,
          })
        }
      } catch (error: unknown) {
        console.error("Failed to set active account:", error)
        throw error
      }
    },
    [authProfile, refreshAuthProfile, updateState],
  )

  /**
   * Update a Blink account
   */
  const updateBlinkAccount = useCallback(
    async (
      accountId: string,
      updates: Partial<LocalBlinkAccount>,
    ): Promise<{ success: boolean; error?: string }> => {
      if (!authProfile) throw new Error("Not authenticated")

      const profileId: string = authProfile.id
      updateState({ loading: true, error: null })

      try {
        await ProfileStorage.updateBlinkAccount(
          profileId,
          accountId,
          updates as Partial<StoredBlinkAccount>,
        )

        // Refresh auth profile state
        refreshAuthProfile()

        // Load data directly from storage to avoid stale closure issues
        const freshProfile = ProfileStorage.getProfileById(profileId)
        if (freshProfile) {
          const _activeAccount: StoredBlinkAccount | null =
            freshProfile.blinkAccounts.find((a: StoredBlinkAccount) => a.isActive) || null
          updateState({
            loading: false,
            blinkAccounts: freshProfile.blinkAccounts,
          })
        } else {
          updateState({ loading: false })
        }

        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Failed to update account:", error)
        updateState({ loading: false, error: err.message })
        return { success: false, error: err.message }
      }
    },
    [authProfile, refreshAuthProfile, updateState],
  )

  /**
   * Remove a Blink account
   */
  const removeBlinkAccount = useCallback(
    async (accountId: string): Promise<{ success: boolean; error?: string }> => {
      if (!authProfile) throw new Error("Not authenticated")

      try {
        // Get the account type before removing
        const account: LocalBlinkAccount | undefined = authProfile.blinkAccounts.find(
          (a: LocalBlinkAccount) => a.id === accountId,
        )
        const accountType: string | undefined = account?.type

        ProfileStorage.removeBlinkAccount(authProfile.id, accountId)
        refreshAuthProfile()

        // Get the updated profile and sync to server IMMEDIATELY to persist the deletion
        const freshProfile = ProfileStorage.getProfileById(authProfile.id)
        if (freshProfile) {
          // Sync the appropriate wallet type to server IMMEDIATELY (not debounced)
          // This prevents the deleted wallet from being re-added on next load
          if (accountType === "npub-cash") {
            await syncNpubCashWalletsToServerImmediate(freshProfile.blinkAccounts)
          } else if (accountType === "ln-address") {
            await syncLnAddressWalletsToServerImmediate(freshProfile.blinkAccounts)
          } else {
            await syncBlinkApiAccountsToServerImmediate(freshProfile.blinkAccounts)
          }
        }

        // Update local state without reloading from server (which would re-add the deleted wallet)
        updateState({
          blinkAccounts: freshProfile?.blinkAccounts || [],
          serverSynced: true, // Already synced
        })

        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Failed to remove account:", error)
        return { success: false, error: err.message }
      }
    },
    [
      authProfile,
      refreshAuthProfile,
      updateState,
      syncBlinkApiAccountsToServerImmediate,
      syncLnAddressWalletsToServerImmediate,
      syncNpubCashWalletsToServerImmediate,
    ],
  )

  // ============= NWC Connection Management =============

  /**
   * Add an NWC connection
   */
  const addNWCConnection = useCallback(
    async ({
      label,
      uri,
      capabilities,
    }: {
      label: string
      uri: string
      capabilities?: string[]
    }): Promise<{
      success: boolean
      connection?: StoredNWCConnection
      error?: string
    }> => {
      if (!authProfile) throw new Error("Not authenticated")

      updateState({ loading: true, error: null })

      try {
        const connection = await ProfileStorage.addNWCConnection(
          authProfile.id,
          label,
          uri,
          capabilities,
        )

        refreshAuthProfile()
        loadProfileData()
        updateState({ loading: false })

        return { success: true, connection }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Failed to add NWC connection:", error)
        updateState({ loading: false, error: err.message })
        return { success: false, error: err.message }
      }
    },
    [authProfile, refreshAuthProfile, loadProfileData, updateState],
  )

  /**
   * Get decrypted NWC URI
   */
  const getNWCUri = useCallback(
    async (connectionId: string): Promise<string> => {
      if (!authProfile) throw new Error("Not authenticated")

      try {
        return await ProfileStorage.getNWCUri(authProfile.id, connectionId)
      } catch (error: unknown) {
        console.error("Failed to get NWC URI:", error)
        throw error
      }
    },
    [authProfile],
  )

  /**
   * Get active NWC URI
   */
  const getActiveNWCUri = useCallback(async (): Promise<string | null> => {
    if (!authProfile) return null

    try {
      return await ProfileStorage.getActiveNWCUri(authProfile.id)
    } catch (error: unknown) {
      console.error("Failed to get active NWC URI:", error)
      return null
    }
  }, [authProfile])

  /**
   * Set active NWC connection
   */
  const setActiveNWCConnection = useCallback(
    (connectionId: string): void => {
      if (!authProfile) throw new Error("Not authenticated")

      try {
        ProfileStorage.setActiveNWCConnection(authProfile.id, connectionId)
        refreshAuthProfile()
        loadProfileData()
      } catch (error: unknown) {
        console.error("Failed to set active NWC connection:", error)
        throw error
      }
    },
    [authProfile, refreshAuthProfile, loadProfileData],
  )

  /**
   * Remove an NWC connection
   */
  const removeNWCConnection = useCallback(
    (connectionId: string): { success: boolean; error?: string } => {
      if (!authProfile) throw new Error("Not authenticated")

      try {
        ProfileStorage.removeNWCConnection(authProfile.id, connectionId)
        refreshAuthProfile()
        loadProfileData()
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Failed to remove NWC connection:", error)
        return { success: false, error: err.message }
      }
    },
    [authProfile, refreshAuthProfile, loadProfileData],
  )

  // ============= Settings Management =============

  /**
   * Update tipping settings
   */
  const updateTippingSettings = useCallback(
    (settings: Partial<StoredTippingSettings>): { success: boolean; error?: string } => {
      if (!authProfile) throw new Error("Not authenticated")

      try {
        ProfileStorage.updateTippingSettings(authProfile.id, settings)
        refreshAuthProfile()
        loadProfileData()
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Failed to update tipping settings:", error)
        return { success: false, error: err.message }
      }
    },
    [authProfile, refreshAuthProfile, loadProfileData],
  )

  /**
   * Update preferences
   */
  const updatePreferences = useCallback(
    (preferences: Partial<StoredPreferences>): { success: boolean; error?: string } => {
      if (!authProfile) throw new Error("Not authenticated")

      try {
        ProfileStorage.updatePreferences(authProfile.id, preferences)
        refreshAuthProfile()
        loadProfileData()
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Failed to update preferences:", error)
        return { success: false, error: err.message }
      }
    },
    [authProfile, refreshAuthProfile, loadProfileData],
  )

  // ============= Export/Import =============

  /**
   * Export profile data
   */
  const exportProfile = useCallback((): ProfileExportData => {
    if (!authProfile) throw new Error("Not authenticated")

    try {
      return ProfileStorage.exportProfile(authProfile.id)
    } catch (error: unknown) {
      console.error("Failed to export profile:", error)
      throw error
    }
  }, [authProfile])

  /**
   * Export all profiles
   */
  const exportAllProfiles = useCallback((): ProfileExportData => {
    return ProfileStorage.exportAllProfiles()
  }, [])

  /**
   * Import profiles
   */
  const importProfiles = useCallback(
    (
      data: ProfileExportData,
      merge: boolean = true,
    ): { success: boolean; error?: string } => {
      try {
        ProfileStorage.importProfiles(data, merge)
        refreshAuthProfile()
        loadProfileData()
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Failed to import profiles:", error)
        return { success: false, error: err.message }
      }
    },
    [refreshAuthProfile, loadProfileData],
  )

  // Compute derived state with memoization to prevent unnecessary re-renders
  // Without useMemo, these would create new object references on every render,
  // causing downstream useEffect hooks (like in Dashboard) to fire unnecessarily
  // Note: activeBlinkAccount excludes npub.cash wallets (those are handled by activeNpubCashWallet)
  const activeBlinkAccount = useMemo(
    (): LocalBlinkAccount | null =>
      state.blinkAccounts.find(
        (a: LocalBlinkAccount) => a.isActive && a.type !== "npub-cash",
      ) || null,
    [state.blinkAccounts],
  )
  const activeNWCConnection = useMemo(
    (): StoredNWCConnection | null =>
      state.nwcConnections.find((c: StoredNWCConnection) => c.isActive) || null,
    [state.nwcConnections],
  )
  const hasBlinkAccount: boolean = state.blinkAccounts.length > 0
  const hasNWCConnection: boolean = state.nwcConnections.length > 0
  const npubCashWallets = useMemo(
    (): LocalBlinkAccount[] =>
      state.blinkAccounts.filter((a: LocalBlinkAccount) => a.type === "npub-cash"),
    [state.blinkAccounts],
  )
  const hasNpubCashWallet: boolean = npubCashWallets.length > 0
  const activeNpubCashWallet = useMemo(
    (): LocalBlinkAccount | null =>
      npubCashWallets.find((w: LocalBlinkAccount) => w.isActive) || null,
    [npubCashWallets],
  )

  const value: ProfileContextValue = {
    // State
    loading: state.loading,
    error: state.error,

    // Profile data
    blinkAccounts: state.blinkAccounts,
    nwcConnections: state.nwcConnections,
    tippingSettings: state.tippingSettings,
    preferences: state.preferences,

    // Computed
    activeBlinkAccount,
    activeNWCConnection,
    hasBlinkAccount,
    hasNWCConnection,
    hasNpubCashWallet,
    npubCashWallets,
    activeNpubCashWallet,

    // Blink account actions
    addBlinkAccount,
    addBlinkLnAddressAccount,
    addNpubCashAccount,
    getBlinkApiKey,
    getActiveBlinkApiKey,
    setActiveBlinkAccount,
    updateBlinkAccount,
    removeBlinkAccount,

    // NWC connection actions
    addNWCConnection,
    getNWCUri,
    getActiveNWCUri,
    setActiveNWCConnection,
    removeNWCConnection,

    // Settings actions
    updateTippingSettings,
    updatePreferences,

    // Export/Import
    exportProfile,
    exportAllProfiles,
    importProfiles,

    // Refresh
    refreshProfile: loadProfileData,
  }

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}

/**
 * useProfile hook - Access profile management context
 */
export function useProfile(): ProfileContextValue {
  const context = useContext(ProfileContext)

  if (!context) {
    throw new Error("useProfile must be used within a ProfileProvider")
  }

  return context
}

export default useProfile
