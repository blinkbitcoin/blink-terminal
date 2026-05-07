/**
 * useNostrAuth - React hook for Nostr-based authentication
 *
 * Provides:
 * - Sign-in with browser extension (NIP-07)
 * - Sign-in with external signer (NIP-55)
 * - Sign-in with Nostr Connect (NIP-46)
 * - NIP-98 server session establishment
 * - Profile management
 * - Authentication state
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  createContext,
  useContext,
} from "react"

import NostrAuthService, {
  type SignInMethod,
  type AuthResult,
  type ChallengeFlowData,
  type Nip98LoginResult,
  type ServerSessionResult,
  type EncryptedNsecData,
} from "../nostr/NostrAuthService"
import { type ConnectionResult } from "../nostr/NostrConnectService"
import NostrProfileService, { type NostrProfile } from "../nostr/NostrProfileService"
import CryptoUtils, { type EncryptedData } from "../storage/CryptoUtils"
import ProfileStorage, {
  type StoredProfile,
  type StoredBlinkAccount,
} from "../storage/ProfileStorage"
import { AUTH_VERSION_FULL, logAuth, logAuthError, logAuthWarn } from "../version"

// ============= Helper Types =============

interface AuthActionResult {
  success: boolean
  profile?: StoredProfile
  publicKey?: string
  error?: string
  pending?: boolean
  errorType?: string
}

interface SyncResult {
  synced: boolean
  error?: string
  alreadyExists?: boolean
  account?: StoredBlinkAccount
}

interface PendingFlowResult {
  success?: boolean
  pending?: boolean
  needsManualStep2?: boolean
  pubkey?: string
  challenge?: string
  profile?: StoredProfile
  error?: string
}

interface BlinkAccountSyncResponse {
  hasAccount?: boolean
  blinkUsername?: string
  apiKey?: string
  accountLabel?: string
  preferredCurrency?: string
}

// ============= Interfaces =============

export interface NostrAuthState {
  loading: boolean
  isAuthenticated: boolean
  publicKey: string | null
  method: string | null
  profile: StoredProfile | null
  activeBlinkAccount: StoredBlinkAccount | null
  hasServerSession: boolean
  nostrProfile: NostrProfile | null
  error: string | null
}

interface NostrConnectSignInOptions {
  onProgress?: (stage: string, message: string) => void
  timeout?: number
}

export interface NostrAuthContextValue extends NostrAuthState {
  // Computed
  availableMethods: SignInMethod[]
  hasExtension: boolean
  isMobile: boolean

  // Actions
  signInWithExtension: () => Promise<AuthActionResult>
  signInWithExternalSigner: () => Promise<AuthActionResult>
  signInWithNostrConnect: (
    publicKey: string,
    options?: NostrConnectSignInOptions,
  ) => Promise<AuthActionResult>
  signOut: () => Promise<void>
  refreshProfile: () => void
  checkPendingSignerFlow: () => Promise<PendingFlowResult>
  establishServerSession: () => Promise<{ success: boolean; error?: string }>
  syncBlinkAccountFromServer: () => Promise<SyncResult>
  createAccountWithPassword: (password: string) => Promise<AuthActionResult>
  signInWithPassword: (password: string) => Promise<AuthActionResult>
}

interface NostrAuthProviderProps {
  children: React.ReactNode
}

const NostrAuthContext = createContext<NostrAuthContextValue | null>(null)

/**
 * NostrAuthProvider - Provides Nostr authentication context
 */
export function NostrAuthProvider({
  children,
}: NostrAuthProviderProps): React.JSX.Element {
  // Generate unique ID to track provider instances
  const providerInstanceId = useRef<string>(Math.random().toString(36).substring(7))

  // DIAGNOSTIC: Log provider mount
  useEffect(() => {
    console.log("[useNostrAuth] PROVIDER MOUNTED, instance:", providerInstanceId.current)
    return () => {
      console.log(
        "[useNostrAuth] PROVIDER UNMOUNTED, instance:",
        providerInstanceId.current,
      )
    }
  }, [])

  const [state, setState] = useState<NostrAuthState>({
    loading: true,
    isAuthenticated: false,
    publicKey: null,
    method: null,
    profile: null,
    activeBlinkAccount: null,
    hasServerSession: false,
    nostrProfile: null, // Nostr profile metadata (name, picture, etc.)
    error: null,
  })

  // Track extension availability separately - extensions inject window.nostr asynchronously
  const [hasExtension, setHasExtension] = useState<boolean>(
    NostrAuthService.isExtensionAvailable(),
  )

  // Track if auth check has been initiated to handle React Strict Mode
  const authCheckInitiated = useRef<boolean>(false)

  // Track if challenge flow is being handled to prevent duplicate processing
  const challengeFlowHandling = useRef<boolean>(false)

  // Re-check extension availability after short delay (extensions may inject asynchronously)
  useEffect(() => {
    // Immediate check
    setHasExtension(NostrAuthService.isExtensionAvailable())

    // Check again after delays (some extensions take time to inject)
    const timeouts: ReturnType<typeof setTimeout>[] = [100, 500, 1000, 2000].map(
      (delay) =>
        setTimeout(() => {
          const available: boolean = NostrAuthService.isExtensionAvailable()
          if (available) {
            console.log("[useNostrAuth] Extension detected after", delay, "ms")
            setHasExtension(true)
          }
        }, delay),
    )

    return () => timeouts.forEach(clearTimeout)
  }, [])

  /**
   * Update state helper with tracing for auth state changes
   */
  const updateState = useCallback((updates: Partial<NostrAuthState>) => {
    setState((prev) => {
      const newState: NostrAuthState = { ...prev, ...updates }

      // DIAGNOSTIC: Trace auth state changes
      if (
        Object.prototype.hasOwnProperty.call(updates, "isAuthenticated") ||
        newState.isAuthenticated !== prev.isAuthenticated
      ) {
        console.log("[useNostrAuth] AUTH STATE CHANGE:", {
          from: prev.isAuthenticated,
          to: newState.isAuthenticated,
          updateKeys: Object.keys(updates),
          stack: new Error().stack?.split("\n").slice(2, 5).join(" <- "),
        })
      }

      return newState
    })
  }, [])

  /**
   * Fetch Nostr profile metadata from relays
   */
  const fetchNostrProfile = useCallback(
    async (publicKey: string): Promise<NostrProfile | null> => {
      if (!publicKey) return null

      try {
        console.log(
          "[useNostrAuth] Fetching Nostr profile for:",
          publicKey.slice(0, 8) + "...",
        )
        const nostrProfile: NostrProfile | null =
          await NostrProfileService.fetchProfile(publicKey)

        if (nostrProfile) {
          console.log(
            "[useNostrAuth] ✓ Fetched Nostr profile:",
            nostrProfile.display_name || nostrProfile.name || "No name",
          )
          updateState({ nostrProfile })
          return nostrProfile
        }
      } catch (error: unknown) {
        console.warn("[useNostrAuth] Failed to fetch Nostr profile:", error)
      }

      return null
    },
    [updateState],
  )

  /**
   * Load profile for a public key
   * Creates profile if it doesn't exist (for manual pubkey entry flow)
   */
  const loadProfile = useCallback(
    (
      publicKey: string,
      method: string = "externalSigner",
    ): {
      profile: StoredProfile | null
      activeBlinkAccount: StoredBlinkAccount | null
    } => {
      if (!publicKey) return { profile: null, activeBlinkAccount: null }

      let profile = ProfileStorage.getProfileByPublicKey(publicKey)

      // If no profile exists, create one (supports manual pubkey entry)
      if (!profile) {
        console.log(
          "[useNostrAuth] Creating profile for pubkey:",
          publicKey.substring(0, 8) + "...",
        )
        profile = ProfileStorage.createProfile(publicKey, method)
        ProfileStorage.setActiveProfile(profile.id)
      }

      const activeBlinkAccount: StoredBlinkAccount | null =
        profile.blinkAccounts.find((a) => a.isActive) || null
      return { profile, activeBlinkAccount }
    },
    [],
  )

  /**
   * Sync Blink account from server (for cross-device consistency)
   * Called after NIP-98 session is established
   */
  const syncBlinkAccountFromServer = useCallback(async (): Promise<SyncResult> => {
    try {
      const response: Response = await fetch("/api/auth/nostr-blink-account", {
        method: "GET",
        credentials: "include",
      })

      if (!response.ok) {
        console.log("No server Blink account to sync")
        return { synced: false }
      }

      const data: BlinkAccountSyncResponse = await response.json()

      if (data.hasAccount && data.blinkUsername && data.apiKey) {
        console.log("[useNostrAuth] Found Blink account on server:", data.blinkUsername)

        // Get current profile - reload from storage to avoid stale closure
        const activeProfileId = ProfileStorage.getActiveProfileId()
        const currentProfile: StoredProfile | null = activeProfileId
          ? ProfileStorage.getProfileById(activeProfileId)
          : state.profile

        if (!currentProfile) {
          console.warn("[useNostrAuth] No local profile found for sync")
          return { synced: false, error: "No local profile" }
        }

        console.log(
          "[useNostrAuth] Current profile has",
          currentProfile.blinkAccounts?.length || 0,
          "accounts",
        )

        // Check if we already have this account locally
        const existingAccount = currentProfile.blinkAccounts.find(
          (a) => a.username === data.blinkUsername,
        )

        if (existingAccount) {
          console.log("[useNostrAuth] Blink account already exists locally")
          return { synced: false, alreadyExists: true }
        }

        // Add the server account to local profile WITH the API key
        // Encrypt the API key before storing locally
        const encryptedApiKey: EncryptedData = await CryptoUtils.encryptWithDeviceKey(
          data.apiKey,
        )
        const serverAccount: StoredBlinkAccount = {
          id: `server-${Date.now()}`,
          label: data.accountLabel || data.blinkUsername, // Use stored label if available
          username: data.blinkUsername,
          apiKey: encryptedApiKey, // Encrypted for local storage
          defaultCurrency: data.preferredCurrency || "BTC",
          isActive: currentProfile.blinkAccounts.length === 0, // Make active if no other accounts
          createdAt: Date.now(),
          lastUsed: null,
        }

        // Update local profile
        console.log("[useNostrAuth] Adding synced account to local profile...")
        const updatedAccounts: StoredBlinkAccount[] = [
          ...currentProfile.blinkAccounts,
          serverAccount,
        ]
        const updatedProfile: StoredProfile = {
          ...currentProfile,
          blinkAccounts: updatedAccounts,
        }

        ProfileStorage.updateProfile(updatedProfile)

        // Update state
        const activeBlinkAccount: StoredBlinkAccount | null = serverAccount.isActive
          ? serverAccount
          : updatedAccounts.find((a) => a.isActive) || null

        console.log("[useNostrAuth] ✓ Synced Blink account from server (NIP-98)")

        updateState({
          profile: updatedProfile,
          activeBlinkAccount,
        })

        console.log("[useNostrAuth] ✓ Synced Blink account from server")
        return { synced: true, account: serverAccount }
      } else if (data.hasAccount && !data.apiKey) {
        console.warn("[useNostrAuth] Server has account but no API key returned")
      }

      return { synced: false }
    } catch (error: unknown) {
      const err = error as Error
      console.error("[useNostrAuth] Failed to sync Blink account from server:", error)
      return { synced: false, error: err.message }
    }
  }, [state.profile, updateState])

  /**
   * Check authentication status on mount
   */
  useEffect(() => {
    const checkAuth = async (): Promise<void> => {
      // VERSION CHECK - this log confirms which build is running
      logAuth("useNostrAuth", `BUILD VERSION: ${AUTH_VERSION_FULL}`)
      logAuth(
        "useNostrAuth",
        "checkAuth() ENTRY - instance:",
        providerInstanceId.current,
        "authCheckInitiated:",
        authCheckInitiated.current,
        "challengeFlowHandling:",
        challengeFlowHandling.current,
      )

      try {
        // Check for pending challenge-based flow first (new secure flow for external signers)
        console.log("[useNostrAuth] Checking hasPendingChallengeFlow...")
        const hasPending: boolean = NostrAuthService.hasPendingChallengeFlow()
        console.log("[useNostrAuth] hasPendingChallengeFlow result:", hasPending)

        if (hasPending) {
          console.log(
            "[useNostrAuth] INSIDE pending challenge block, challengeFlowHandling.current =",
            challengeFlowHandling.current,
          )

          // Prevent duplicate processing of the same challenge flow
          if (challengeFlowHandling.current) {
            console.log(
              "[useNostrAuth] Challenge flow already being handled, skipping duplicate call",
            )
            return
          }

          console.log("[useNostrAuth] Setting challengeFlowHandling.current = true")
          challengeFlowHandling.current = true
          console.log(
            "[useNostrAuth] challengeFlowHandling.current is now:",
            challengeFlowHandling.current,
          )

          console.log("[useNostrAuth] Handling pending challenge flow...")

          // Check URL to determine which step of challenge flow
          console.log("[useNostrAuth] About to create URLSearchParams...")
          const urlParams = new URLSearchParams(window.location.search)
          console.log("[useNostrAuth] URLSearchParams created")
          const nostrReturn: string | null = urlParams.get("nostr_return")
          console.log("[useNostrAuth] Got nostr_return:", nostrReturn?.substring(0, 50))

          // DETAILED DEBUG LOGGING
          console.log("[useNostrAuth] DEBUG: Full URL:", window.location.href)
          console.log("[useNostrAuth] DEBUG: nostr_return value:", nostrReturn)
          console.log("[useNostrAuth] DEBUG: nostr_return length:", nostrReturn?.length)
          console.log(
            "[useNostrAuth] DEBUG: startsWith challenge:",
            nostrReturn?.startsWith("challenge"),
          )
          console.log(
            "[useNostrAuth] DEBUG: startsWith signed:",
            nostrReturn?.startsWith("signed"),
          )

          const flow: ChallengeFlowData | null =
            NostrAuthService.getPendingChallengeFlow()
          console.log("[useNostrAuth] DEBUG: Current flow:", JSON.stringify(flow))

          let result: AuthResult
          try {
            // Note: Amber concatenates results directly, so we get "challenge{pubkey}" or "signed{event}"
            if (nostrReturn?.startsWith("challenge")) {
              console.log(
                "[useNostrAuth] DEBUG: Taking challenge branch, calling handleChallengeFlowReturn...",
              )
              result = await NostrAuthService.handleChallengeFlowReturn()
              console.log(
                "[useNostrAuth] DEBUG: handleChallengeFlowReturn returned:",
                JSON.stringify(result),
              )
            } else if (nostrReturn?.startsWith("signed")) {
              console.log("[useNostrAuth] DEBUG: Taking signed branch...")
              result = await NostrAuthService.handleChallengeSignReturn()
              console.log(
                "[useNostrAuth] DEBUG: handleChallengeSignReturn returned:",
                JSON.stringify(result),
              )
            } else {
              console.log("[useNostrAuth] DEBUG: Taking else branch...")
              // Check if we need to continue signing
              if (flow?.step === "awaitingSignedChallenge") {
                console.log(
                  "[useNostrAuth] DEBUG: Flow says awaitingSignedChallenge, calling handleChallengeSignReturn...",
                )
                result = await NostrAuthService.handleChallengeSignReturn()
                console.log(
                  "[useNostrAuth] DEBUG: handleChallengeSignReturn returned:",
                  JSON.stringify(result),
                )
              } else {
                console.log("[useNostrAuth] DEBUG: Unknown state, flow step:", flow?.step)
                result = { success: false, error: "Unknown challenge flow state" }
              }
            }
          } catch (flowError: unknown) {
            const err = flowError as Error
            console.error("[useNostrAuth] DEBUG: Challenge flow error:", flowError)
            challengeFlowHandling.current = false
            result = { success: false, error: err.message }
          }

          if (result.pending) {
            // Still in flow, redirect will happen
            // Keep the flag set - we're still handling the flow
            updateState({ loading: false })
            return
          }

          // Flow completed (success or failure) - reset the flag
          challengeFlowHandling.current = false

          if (result.success && result.publicKey) {
            const profile: StoredProfile = ProfileStorage.createProfile(
              result.publicKey,
              result.method || "externalSigner",
            )
            ProfileStorage.setActiveProfile(profile.id)

            const { activeBlinkAccount } = loadProfile(result.publicKey)

            updateState({
              loading: false,
              isAuthenticated: true,
              publicKey: result.publicKey,
              method: result.method || "externalSigner",
              profile,
              activeBlinkAccount,
              hasServerSession: result.hasServerSession || false,
              nostrProfile: null,
              error: null,
            })

            // Fetch Nostr profile metadata from relays (in background)
            fetchNostrProfile(result.publicKey)

            // If we have server session, sync data from server
            if (result.hasServerSession) {
              console.log(
                "[useNostrAuth] External signer: Session established, syncing data...",
              )
              setTimeout(async () => {
                const syncResult = await syncBlinkAccountFromServer()
                console.log("[useNostrAuth] Sync result:", syncResult)
              }, 100)
            }

            return
          } else {
            updateState({
              loading: false,
              error: result.error || "Failed to complete sign-in",
            })
            return
          }
        }

        // Check for pending external signer flow (legacy flow for pubkey-only)
        if (NostrAuthService.hasPendingExternalSignerFlow()) {
          const result: AuthResult = await NostrAuthService.handleExternalSignerReturn()

          if (result.success && result.publicKey) {
            const profile: StoredProfile = ProfileStorage.createProfile(
              result.publicKey,
              result.method || "externalSigner",
            )
            ProfileStorage.setActiveProfile(profile.id)

            const { activeBlinkAccount } = loadProfile(result.publicKey)

            updateState({
              loading: false,
              isAuthenticated: true,
              publicKey: result.publicKey,
              method: result.method || "externalSigner",
              profile,
              activeBlinkAccount,
              nostrProfile: null,
              error: null,
            })

            // Fetch Nostr profile metadata from relays (in background)
            fetchNostrProfile(result.publicKey)

            // For legacy flow, try to establish session via challenge
            console.log(
              "[useNostrAuth] External signer return: Attempting to establish session via challenge...",
            )

            return
          } else {
            updateState({
              loading: false,
              error: result.error || "Failed to complete sign-in",
            })
            return
          }
        }

        // Check stored auth data
        const { publicKey, method }: { publicKey: string | null; method: string | null } =
          NostrAuthService.getStoredAuthData()

        if (publicKey && method) {
          // Verify extension is still available if using extension method
          if (method === "extension" && !NostrAuthService.isExtensionAvailable()) {
            // Extension was removed - clear auth
            NostrAuthService.clearAuthData()
            updateState({
              loading: false,
              isAuthenticated: false,
              publicKey: null,
              method: null,
              profile: null,
              activeBlinkAccount: null,
              hasServerSession: false,
              error: null,
            })
            return
          }

          // For generated accounts, session private key is required for signing
          // If the app was closed and reopened, the session key is lost
          // User needs to sign in with password again
          if (method === "generated" && !NostrAuthService.getSessionPrivateKey()) {
            console.log(
              "[useNostrAuth] Generated account detected but no session key - requiring password re-entry",
            )
            // Don't clear auth data - keep the encrypted nsec stored
            // Just don't mark as authenticated so they see the login form
            updateState({
              loading: false,
              isAuthenticated: false,
              publicKey: null,
              method: null,
              profile: null,
              activeBlinkAccount: null,
              hasServerSession: false,
              error: null,
            })
            return
          }

          const { profile, activeBlinkAccount } = loadProfile(publicKey, method)

          updateState({
            loading: false,
            isAuthenticated: true,
            publicKey,
            method,
            profile,
            activeBlinkAccount,
            hasServerSession: false,
            nostrProfile: null,
            error: null,
          })

          // Fetch Nostr profile metadata from relays (in background)
          fetchNostrProfile(publicKey)

          // Try to establish server session in background
          // For external signers, check if we already have a session first
          if (method === "externalSigner") {
            // Check if we already have a valid server session
            console.log(
              "[useNostrAuth] External signer: Checking for existing server session...",
            )
            setTimeout(async () => {
              try {
                const sessionCheck: ServerSessionResult =
                  await NostrAuthService.verifyServerSession()
                if (sessionCheck.hasSession && sessionCheck.pubkey === publicKey) {
                  console.log(
                    "[useNostrAuth] ✓ External signer: Existing server session found",
                  )
                  updateState({ hasServerSession: true })
                  // Sync data from server
                  const syncResult = await syncBlinkAccountFromServer()
                  console.log("[useNostrAuth] Sync result:", syncResult)
                } else {
                  console.log(
                    "[useNostrAuth] External signer: No server session. User can use challenge-based auth to establish session.",
                  )
                }
              } catch (e: unknown) {
                console.warn("[useNostrAuth] Session check failed:", e)
              }
            }, 100)
            return
          }

          // For Nostr Connect, restore the relay session first before NIP-98
          if (method === "nostrConnect") {
            console.log("[useNostrAuth] Nostr Connect: Restoring relay session...")
            setTimeout(async () => {
              try {
                // Dynamic import to avoid circular dependency
                const NostrConnectServiceModule = (
                  await import("../nostr/NostrConnectService")
                ).default as { restoreSession: () => Promise<ConnectionResult> }

                const restoreResult: ConnectionResult =
                  await NostrConnectServiceModule.restoreSession()

                if (!restoreResult.success) {
                  console.warn(
                    "[useNostrAuth] Nostr Connect: Failed to restore session:",
                    restoreResult.error,
                  )
                  console.log("[useNostrAuth] Nostr Connect: User needs to reconnect")
                  // Don't clear auth - let user see they're "logged in" but need to reconnect
                  // They can reconnect via the Nostr Connect modal
                  return
                }

                console.log("[useNostrAuth] ✓ Nostr Connect: Relay session restored")

                // Now attempt NIP-98 login
                console.log("[useNostrAuth] Nostr Connect: Starting NIP-98 login...")
                const sessionResult: Nip98LoginResult =
                  await NostrAuthService.nip98Login()
                console.log(
                  "[useNostrAuth] Nostr Connect: NIP-98 login result:",
                  sessionResult,
                )

                if (sessionResult.success) {
                  console.log(
                    "[useNostrAuth] ✓ Nostr Connect: Server session established",
                  )
                  updateState({ hasServerSession: true })

                  // Sync data from server
                  const syncResult = await syncBlinkAccountFromServer()
                  console.log("[useNostrAuth] Nostr Connect: Sync result:", syncResult)
                } else {
                  console.warn(
                    "[useNostrAuth] Nostr Connect: NIP-98 login failed:",
                    sessionResult.error,
                  )
                }
              } catch (e: unknown) {
                console.error("[useNostrAuth] Nostr Connect: Session restore error:", e)
              }
            }, 100)
            return
          }

          // For extension and generated methods, establish NIP-98 server session
          setTimeout(async () => {
            console.log("[useNostrAuth] Starting background NIP-98 login...")
            try {
              const sessionResult: Nip98LoginResult = await NostrAuthService.nip98Login()
              console.log("[useNostrAuth] NIP-98 login result:", sessionResult)

              if (sessionResult.success) {
                updateState({ hasServerSession: true })
                console.log("[useNostrAuth] ✓ Server session established")

                // Sync Blink account from server (for cross-device consistency)
                try {
                  console.log(
                    "[useNostrAuth] Checking server for existing Blink account...",
                  )
                  const syncResponse: Response = await fetch(
                    "/api/auth/nostr-blink-account",
                    {
                      method: "GET",
                      credentials: "include",
                    },
                  )

                  console.log(
                    "[useNostrAuth] Server response status:",
                    syncResponse.status,
                  )

                  if (syncResponse.ok) {
                    const data: BlinkAccountSyncResponse = await syncResponse.json()
                    console.log("[useNostrAuth] Server data:", data)

                    if (data.hasAccount && data.blinkUsername) {
                      console.log(
                        "[useNostrAuth] Found Blink account on server:",
                        data.blinkUsername,
                      )

                      // Get current profile from storage
                      const currentProfile: StoredProfile | null =
                        ProfileStorage.loadProfile(publicKey)
                      console.log(
                        "[useNostrAuth] Current profile:",
                        currentProfile?.id,
                        "Blink accounts:",
                        currentProfile?.blinkAccounts?.length,
                      )

                      if (currentProfile) {
                        // Check if we already have this account locally
                        const existingAccount = currentProfile.blinkAccounts.find(
                          (a) => a.username === data.blinkUsername,
                        )

                        if (!existingAccount && data.apiKey) {
                          console.log(
                            "[useNostrAuth] Adding server Blink account to local profile...",
                          )
                          // Encrypt the API key before storing locally
                          const encryptedApiKey: EncryptedData =
                            await CryptoUtils.encryptWithDeviceKey(data.apiKey)
                          // Add the server account to local profile
                          const serverAccount: StoredBlinkAccount = {
                            id: `server-${Date.now()}`,
                            label: data.accountLabel || data.blinkUsername, // Use stored label if available
                            username: data.blinkUsername,
                            apiKey: encryptedApiKey, // Encrypted for local storage
                            defaultCurrency: data.preferredCurrency || "BTC",
                            isActive: currentProfile.blinkAccounts.length === 0,
                            createdAt: Date.now(),
                            lastUsed: null,
                          }

                          const updatedAccounts: StoredBlinkAccount[] = [
                            ...currentProfile.blinkAccounts,
                            serverAccount,
                          ]
                          const updatedProfile: StoredProfile = {
                            ...currentProfile,
                            blinkAccounts: updatedAccounts,
                          }

                          ProfileStorage.updateProfile(updatedProfile)

                          const newActiveBlinkAccount: StoredBlinkAccount | null =
                            serverAccount.isActive
                              ? serverAccount
                              : updatedAccounts.find((a) => a.isActive) || null

                          updateState({
                            profile: updatedProfile,
                            activeBlinkAccount: newActiveBlinkAccount,
                          })

                          console.log("[useNostrAuth] ✓ Synced Blink account from server")
                        } else {
                          console.log(
                            "[useNostrAuth] Blink account already exists locally",
                          )
                        }
                      }
                    } else {
                      console.log("[useNostrAuth] No Blink account found on server")
                    }
                  } else {
                    console.warn(
                      "[useNostrAuth] Server returned non-OK status:",
                      syncResponse.status,
                    )
                  }
                } catch (syncError: unknown) {
                  console.warn("[useNostrAuth] Blink account sync failed:", syncError)
                }
              } else {
                console.warn("[useNostrAuth] NIP-98 login failed:", sessionResult.error)
              }
            } catch (e: unknown) {
              console.warn("[useNostrAuth] Background NIP-98 login exception:", e)
            }
          }, 100)
        } else {
          updateState({
            loading: false,
            isAuthenticated: false,
            publicKey: null,
            method: null,
            profile: null,
            activeBlinkAccount: null,
            error: null,
          })
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Auth check failed:", error)
        updateState({
          loading: false,
          isAuthenticated: false,
          error: err.message,
        })
      }
    }

    // Only run on client side
    if (typeof window !== "undefined") {
      console.log(
        "[useNostrAuth] useEffect running, authCheckInitiated.current =",
        authCheckInitiated.current,
      )
      // In React Strict Mode, effects run twice. Only initiate auth check once.
      if (authCheckInitiated.current) {
        console.log("[useNostrAuth] authCheckInitiated is true, SKIPPING checkAuth()")
        return
      }
      console.log(
        "[useNostrAuth] Setting authCheckInitiated.current = true, calling checkAuth()",
      )
      authCheckInitiated.current = true
      checkAuth()
    } else {
      console.log("[useNostrAuth] Not in browser, setting loading false")
      updateState({ loading: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only run on mount - dependencies are stable refs/callbacks

  /**
   * Establish NIP-98 server session
   * Creates a signed NIP-98 event and sends to server for session establishment
   */
  const establishServerSession = useCallback(async (): Promise<{
    success: boolean
    error?: string
  }> => {
    if (!state.isAuthenticated) {
      return { success: false, error: "Not authenticated" }
    }

    try {
      const result: Nip98LoginResult = await NostrAuthService.nip98Login()

      if (result.success) {
        updateState({ hasServerSession: true })
        return { success: true }
      } else {
        console.warn("NIP-98 login failed:", result.error)
        return { success: false, error: result.error }
      }
    } catch (error: unknown) {
      const err = error as Error
      console.error("Server session establishment failed:", error)
      return { success: false, error: err.message }
    }
  }, [state.isAuthenticated, updateState])

  /**
   * Sync Blink account by pubkey (for external signers like Amber)
   *
   * SECURITY: This function has been disabled.
   * The unauthenticated pubkey-based API endpoint was a security vulnerability
   * that allowed anyone to retrieve API keys just by knowing a user's pubkey.
   *
   * External signers now use localStorage only. To sync across devices,
   * users must re-add their Blink account on the new device.
   *
   * @deprecated This function is no longer functional for security reasons
   */
  const _syncBlinkAccountByPubkey = useCallback(
    async (_publicKey: string): Promise<SyncResult> => {
      console.warn(
        "[useNostrAuth] syncBlinkAccountByPubkey is disabled for security reasons",
      )
      console.log("[useNostrAuth] External signers now use localStorage only")
      return { synced: false, error: "Pubkey-based sync disabled for security" }
    },
    [],
  )

  /**
   * Sign in with browser extension (NIP-07)
   */
  const signInWithExtension = useCallback(async (): Promise<AuthActionResult> => {
    updateState({ loading: true, error: null })

    try {
      const result: AuthResult = await NostrAuthService.signInWithExtension()

      if (result.success && result.publicKey) {
        // Create or get profile
        const profile: StoredProfile = ProfileStorage.createProfile(
          result.publicKey,
          "extension",
        )
        ProfileStorage.setActiveProfile(profile.id)

        const activeBlinkAccount: StoredBlinkAccount | null =
          profile.blinkAccounts.find((a) => a.isActive) || null

        updateState({
          loading: false,
          isAuthenticated: true,
          publicKey: result.publicKey,
          method: "extension",
          profile,
          activeBlinkAccount,
          hasServerSession: false,
          nostrProfile: null,
          error: null,
        })

        // Fetch Nostr profile metadata from relays (in background)
        fetchNostrProfile(result.publicKey)

        // Automatically establish server session via NIP-98
        // Do this in the background - don't block the sign-in
        setTimeout(async () => {
          console.log(
            "[useNostrAuth] Starting background NIP-98 login after extension sign-in...",
          )
          try {
            const sessionResult: Nip98LoginResult = await NostrAuthService.nip98Login()
            console.log("[useNostrAuth] NIP-98 login result:", sessionResult)
            if (sessionResult.success) {
              console.log(
                "[useNostrAuth] ✓ Server session established via extension sign-in",
              )
              updateState({ hasServerSession: true })
              // After server session is established, sync Blink account from server
              // This enables cross-device account persistence
              console.log("[useNostrAuth] Now syncing Blink account from server...")
              const syncResult = await syncBlinkAccountFromServer()
              console.log("[useNostrAuth] Sync result:", syncResult)
            } else {
              console.warn(
                "[useNostrAuth] Background NIP-98 login failed:",
                sessionResult.error,
                sessionResult.details,
              )
            }
          } catch (err: unknown) {
            console.error("[useNostrAuth] Background NIP-98 login exception:", err)
          }
        }, 100)

        return { success: true, profile }
      } else {
        updateState({
          loading: false,
          error: result.error,
        })
        return { success: false, error: result.error }
      }
    } catch (error: unknown) {
      const err = error as Error
      console.error("Extension sign-in failed:", error)
      updateState({
        loading: false,
        error: err.message,
      })
      return { success: false, error: err.message }
    }
  }, [updateState, syncBlinkAccountFromServer, fetchNostrProfile])

  /**
   * Sign in with external signer (NIP-55 / Amber)
   * Uses challenge-based authentication for secure session establishment
   */
  const signInWithExternalSigner = useCallback(async (): Promise<AuthActionResult> => {
    updateState({ loading: true, error: null })

    try {
      // Use the new challenge-based flow for secure authentication
      const result: AuthResult =
        await NostrAuthService.signInWithExternalSignerChallenge()

      if (result.pending) {
        // The page will redirect to external signer
        // Reset loading state - the redirect may fail or user may cancel
        // When user returns, checkAuth will handle the completion
        updateState({ loading: false })
        return { success: true, pending: true }
      }

      if (!result.success) {
        updateState({
          loading: false,
          error: result.error,
        })
        return { success: false, error: result.error }
      }

      // If we got here with success and no pending, the full flow completed
      if (result.publicKey) {
        const profile: StoredProfile = ProfileStorage.createProfile(
          result.publicKey,
          "externalSigner",
        )
        ProfileStorage.setActiveProfile(profile.id)

        const activeBlinkAccount: StoredBlinkAccount | null =
          profile.blinkAccounts.find((a) => a.isActive) || null

        updateState({
          loading: false,
          isAuthenticated: true,
          publicKey: result.publicKey,
          method: "externalSigner",
          profile,
          activeBlinkAccount,
          hasServerSession: result.hasServerSession || false,
          nostrProfile: null,
          error: null,
        })

        // Fetch Nostr profile metadata from relays (in background)
        fetchNostrProfile(result.publicKey)

        // If we have server session, sync data
        if (result.hasServerSession) {
          setTimeout(async () => {
            const syncResult = await syncBlinkAccountFromServer()
            console.log("[useNostrAuth] Sync result:", syncResult)
          }, 100)
        }

        return { success: true, profile }
      }

      return { success: true }
    } catch (error: unknown) {
      const err = error as Error
      console.error("External signer sign-in failed:", error)
      updateState({
        loading: false,
        error: err.message,
      })
      return { success: false, error: err.message }
    }
  }, [updateState, fetchNostrProfile, syncBlinkAccountFromServer])

  /**
   * Check for pending external signer flow (called on page focus)
   * Handles both legacy flow and new challenge-based flow
   */
  const checkPendingSignerFlow = useCallback(async (): Promise<PendingFlowResult> => {
    console.log(
      "[useNostrAuth] checkPendingSignerFlow() called, challengeFlowHandling:",
      challengeFlowHandling.current,
    )

    // Check for challenge-based flow first (new secure flow)
    if (NostrAuthService.hasPendingChallengeFlow()) {
      // Prevent duplicate processing - same guard as checkAuth()
      if (challengeFlowHandling.current) {
        console.log(
          "[useNostrAuth] checkPendingSignerFlow: Challenge flow already being handled, skipping",
        )
        return { pending: true } // Return pending to indicate flow is in progress
      }
      challengeFlowHandling.current = true
      console.log(
        "[useNostrAuth] checkPendingSignerFlow: Set challengeFlowHandling = true",
      )

      const urlParams = new URLSearchParams(window.location.search)
      const nostrReturn: string | null = urlParams.get("nostr_return")
      const flow: ChallengeFlowData | null = NostrAuthService.getPendingChallengeFlow()

      // Detailed logging for debugging
      console.log(
        "[useNostrAuth] checkPendingSignerFlow - nostrReturn:",
        nostrReturn?.substring(0, 30) || "null",
      )
      console.log(
        "[useNostrAuth] checkPendingSignerFlow - flow.step:",
        flow?.step || "none",
      )
      console.log(
        "[useNostrAuth] checkPendingSignerFlow - flow.pubkey:",
        flow?.pubkey?.substring(0, 16) || "none",
      )

      updateState({ loading: true })

      let result: AuthResult
      // Note: Amber concatenates results directly, so we get "challenge{pubkey}" or "signed{event}"
      if (nostrReturn?.startsWith("challenge")) {
        console.log(
          "[useNostrAuth] checkPendingSignerFlow - BRANCH: challenge return (Step 1 complete)",
        )
        result = await NostrAuthService.handleChallengeFlowReturn()
        console.log(
          "[useNostrAuth] checkPendingSignerFlow - handleChallengeFlowReturn result:",
          JSON.stringify(result),
        )
      } else if (nostrReturn?.startsWith("signed")) {
        console.log(
          "[useNostrAuth] checkPendingSignerFlow - BRANCH: signed return (Step 2 complete)",
        )
        result = await NostrAuthService.handleChallengeSignReturn()
        console.log(
          "[useNostrAuth] checkPendingSignerFlow - handleChallengeSignReturn result:",
          JSON.stringify(result),
        )
      } else {
        // No nostr_return in URL - check what state we're in
        console.log(
          "[useNostrAuth] checkPendingSignerFlow - BRANCH: no nostr_return in URL",
        )
        if (flow?.step === "awaitingSignedChallenge") {
          // We're waiting for the signed challenge but URL doesn't have it
          // This means user returned from Amber after Step 1 (pubkey granted)
          // Instead of auto-redirecting (which fails on some devices),
          // return a flag so UI can show a manual "Continue to Amber" button
          console.log(
            "[useNostrAuth] checkPendingSignerFlow - Flow is awaitingSignedChallenge but no signed event in URL",
          )
          console.log(
            "[useNostrAuth] checkPendingSignerFlow - Returning needsManualStep2 for user-initiated navigation",
          )

          // Reset the handling flag since we're returning control to UI
          challengeFlowHandling.current = false
          updateState({ loading: false })

          return {
            needsManualStep2: true,
            pubkey: flow.pubkey,
            challenge: flow.challenge,
            pending: true,
          }
        } else if (flow?.step === "awaitingPubkey") {
          // Waiting for pubkey but no challenge return in URL - stale flow
          console.log(
            "[useNostrAuth] checkPendingSignerFlow - Stale flow in awaitingPubkey state, clearing",
          )
          NostrAuthService.clearPendingChallengeFlow()
          result = { success: false, error: "Stale challenge flow, please try again" }
        } else {
          console.log(
            "[useNostrAuth] checkPendingSignerFlow - Unknown flow state:",
            flow?.step,
          )
          result = { success: false, error: "Unknown challenge flow state" }
        }
      }

      if (result.pending) {
        // Keep the flag set - we're still in the flow (redirect happening)
        console.log(
          "[useNostrAuth] checkPendingSignerFlow - Result is pending, keeping challengeFlowHandling = true",
        )
        updateState({ loading: false })
        return { pending: true }
      }

      // Flow completed (success or failure) - reset the flag
      challengeFlowHandling.current = false
      console.log(
        "[useNostrAuth] checkPendingSignerFlow: Reset challengeFlowHandling = false (flow completed)",
      )

      if (result.success && result.publicKey) {
        const profile: StoredProfile = ProfileStorage.createProfile(
          result.publicKey,
          "externalSigner",
        )
        ProfileStorage.setActiveProfile(profile.id)

        const activeBlinkAccount: StoredBlinkAccount | null =
          profile.blinkAccounts.find((a) => a.isActive) || null

        updateState({
          loading: false,
          isAuthenticated: true,
          publicKey: result.publicKey,
          method: "externalSigner",
          profile,
          activeBlinkAccount,
          hasServerSession: result.hasServerSession || false,
          nostrProfile: null,
          error: null,
        })

        fetchNostrProfile(result.publicKey)

        if (result.hasServerSession) {
          setTimeout(async () => {
            const syncResult = await syncBlinkAccountFromServer()
            console.log("[useNostrAuth] Sync result:", syncResult)
          }, 100)
        }

        return { success: true, profile }
      }

      // Flow failed - flag already reset above
      updateState({ loading: false, error: result.error })
      return { success: false, error: result.error }
    }

    // Legacy flow (pubkey-only, no server session)
    if (!NostrAuthService.hasPendingExternalSignerFlow()) {
      return { pending: false }
    }

    updateState({ loading: true })

    const result: AuthResult = await NostrAuthService.handleExternalSignerReturn()

    if (result.success && result.publicKey) {
      const profile: StoredProfile = ProfileStorage.createProfile(
        result.publicKey,
        "externalSigner",
      )
      ProfileStorage.setActiveProfile(profile.id)

      const activeBlinkAccount: StoredBlinkAccount | null =
        profile.blinkAccounts.find((a) => a.isActive) || null

      updateState({
        loading: false,
        isAuthenticated: true,
        publicKey: result.publicKey,
        method: "externalSigner",
        profile,
        activeBlinkAccount,
        hasServerSession: false,
        nostrProfile: null,
        error: null,
      })

      // Fetch Nostr profile metadata from relays (in background)
      fetchNostrProfile(result.publicKey)

      // Legacy flow: No server session, using localStorage only
      console.log("[useNostrAuth] Legacy external signer flow: Using localStorage only")
      console.log("[useNostrAuth] To enable cross-device sync, use challenge-based auth")

      return { success: true, profile }
    }

    updateState({
      loading: false,
      error: result.error,
    })

    return { success: false, error: result.error }
  }, [updateState, fetchNostrProfile, syncBlinkAccountFromServer, loadProfile])

  /**
   * Sign out
   */
  const signOut = useCallback(async (): Promise<void> => {
    try {
      // Call server logout endpoint
      await fetch("/api/auth/logout", { method: "POST" })
    } catch (error: unknown) {
      console.error("Server logout failed:", error)
    }

    // Clear local auth data
    NostrAuthService.clearAuthData()

    updateState({
      loading: false,
      isAuthenticated: false,
      publicKey: null,
      method: null,
      profile: null,
      activeBlinkAccount: null,
      error: null,
    })
  }, [updateState])

  /**
   * Refresh profile data
   */
  const refreshProfile = useCallback((): void => {
    if (state.publicKey) {
      const { profile, activeBlinkAccount } = loadProfile(state.publicKey)
      updateState({ profile, activeBlinkAccount })
    }
  }, [state.publicKey, loadProfile, updateState])

  /**
   * Create a new account with password (in-app key generation)
   * Generates keypair, encrypts with password, stores locally, and signs in
   */
  const createAccountWithPassword = useCallback(
    async (password: string): Promise<AuthActionResult> => {
      updateState({ loading: true, error: null })

      try {
        // Validate password
        if (!password || password.length < 8) {
          updateState({ loading: false, error: "Password must be at least 8 characters" })
          return { success: false, error: "Password must be at least 8 characters" }
        }

        // Generate new keypair
        const { privateKey, publicKey }: { privateKey: string; publicKey: string } =
          NostrAuthService.generateKeypair()
        console.log(
          "[useNostrAuth] Generated new keypair, pubkey:",
          publicKey.slice(0, 8) + "...",
        )

        // Encrypt private key with password
        const encryptedNsec: EncryptedData = await CryptoUtils.encryptWithPassword(
          privateKey,
          password,
        )

        // Store encrypted nsec locally
        NostrAuthService.storeEncryptedNsec(encryptedNsec as unknown as EncryptedNsecData)
        console.log("[useNostrAuth] Stored encrypted nsec")

        // Sign in with the new keys (this sets session private key)
        const result: AuthResult = NostrAuthService.signInWithGeneratedKeys(
          publicKey,
          privateKey,
        )

        if (!result.success) {
          updateState({ loading: false, error: result.error })
          return { success: false, error: result.error }
        }

        // Create or get profile
        const profile: StoredProfile = ProfileStorage.createProfile(
          publicKey,
          "generated",
        )
        ProfileStorage.setActiveProfile(profile.id)

        const activeBlinkAccount: StoredBlinkAccount | null =
          profile.blinkAccounts.find((a) => a.isActive) || null

        // Update state - no reload needed!
        updateState({
          loading: false,
          isAuthenticated: true,
          publicKey: publicKey.toLowerCase(),
          method: "generated",
          profile,
          activeBlinkAccount,
          hasServerSession: false,
          nostrProfile: null,
          error: null,
        })

        // Fetch Nostr profile metadata from relays (in background)
        fetchNostrProfile(publicKey)

        // Establish server session via NIP-98 in background
        setTimeout(async () => {
          console.log(
            "[useNostrAuth] Starting background NIP-98 login after account creation...",
          )
          try {
            const sessionResult: Nip98LoginResult = await NostrAuthService.nip98Login()
            console.log("[useNostrAuth] NIP-98 login result:", sessionResult)
            if (sessionResult.success) {
              console.log(
                "[useNostrAuth] ✓ Server session established for generated account",
              )
              updateState({ hasServerSession: true })
              const syncResult = await syncBlinkAccountFromServer()
              console.log("[useNostrAuth] Sync result:", syncResult)
            } else {
              console.warn("[useNostrAuth] NIP-98 login failed:", sessionResult.error)
            }
          } catch (err: unknown) {
            console.error("[useNostrAuth] NIP-98 login exception:", err)
          }
        }, 100)

        return { success: true, profile, publicKey }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Create account failed:", error)
        updateState({ loading: false, error: err.message })
        return { success: false, error: err.message }
      }
    },
    [updateState, fetchNostrProfile, syncBlinkAccountFromServer],
  )

  /**
   * Sign in with password (for returning users with stored encrypted nsec)
   */
  const signInWithPassword = useCallback(
    async (password: string): Promise<AuthActionResult> => {
      updateState({ loading: true, error: null })

      try {
        // Get stored encrypted nsec
        const encryptedNsec: EncryptedNsecData | null =
          NostrAuthService.getStoredEncryptedNsec()

        if (!encryptedNsec) {
          updateState({ loading: false, error: "No account found on this device" })
          return { success: false, error: "No account found on this device" }
        }

        // Decrypt with password
        let privateKey: string
        try {
          privateKey = await CryptoUtils.decryptWithPassword(
            encryptedNsec as unknown as EncryptedData,
            password,
          )
        } catch (_decryptError: unknown) {
          updateState({ loading: false, error: "Incorrect password" })
          return { success: false, error: "Incorrect password" }
        }

        // Sign in with decrypted key (this sets session private key)
        const result: AuthResult = NostrAuthService.signInWithDecryptedKey(privateKey)

        if (!result.success) {
          updateState({ loading: false, error: result.error })
          return { success: false, error: result.error }
        }

        const publicKey: string = result.publicKey!

        // Create or get profile
        const profile: StoredProfile = ProfileStorage.createProfile(
          publicKey,
          "generated",
        )
        ProfileStorage.setActiveProfile(profile.id)

        const activeBlinkAccount: StoredBlinkAccount | null =
          profile.blinkAccounts.find((a) => a.isActive) || null

        // Update state - no reload needed!
        updateState({
          loading: false,
          isAuthenticated: true,
          publicKey,
          method: "generated",
          profile,
          activeBlinkAccount,
          hasServerSession: false,
          nostrProfile: null,
          error: null,
        })

        // Fetch Nostr profile metadata from relays (in background)
        fetchNostrProfile(publicKey)

        // Establish server session via NIP-98 in background
        setTimeout(async () => {
          console.log(
            "[useNostrAuth] Starting background NIP-98 login after password sign-in...",
          )
          try {
            const sessionResult: Nip98LoginResult = await NostrAuthService.nip98Login()
            console.log("[useNostrAuth] NIP-98 login result:", sessionResult)
            if (sessionResult.success) {
              console.log(
                "[useNostrAuth] ✓ Server session established for generated account",
              )
              updateState({ hasServerSession: true })
              const syncResult = await syncBlinkAccountFromServer()
              console.log("[useNostrAuth] Sync result:", syncResult)
            } else {
              console.warn("[useNostrAuth] NIP-98 login failed:", sessionResult.error)
            }
          } catch (err: unknown) {
            console.error("[useNostrAuth] NIP-98 login exception:", err)
          }
        }, 100)

        return { success: true, profile, publicKey }
      } catch (error: unknown) {
        const err = error as Error
        console.error("Password sign-in failed:", error)
        updateState({ loading: false, error: err.message })
        return { success: false, error: err.message }
      }
    },
    [updateState, fetchNostrProfile, syncBlinkAccountFromServer],
  )

  /**
   * Sign in with NIP-46 Nostr Connect (remote signer via relay)
   *
   * BLOCKING flow - waits for NIP-98 session establishment before setting isAuthenticated.
   * This fixes the race condition where dashboard fetched data before session cookie was set.
   *
   * @param publicKey - Public key from connected remote signer
   * @param options - Optional configuration
   * @returns Promise with success/failure result
   */
  const signInWithNostrConnect = useCallback(
    async (
      publicKey: string,
      options: NostrConnectSignInOptions = {},
    ): Promise<AuthActionResult> => {
      const { onProgress, timeout = 30000 } = options

      logAuth(
        "useNostrAuth",
        "signInWithNostrConnect called, pubkey:",
        publicKey?.slice(0, 16) + "...",
      )
      // Note: Don't set loading state here - modal handles its own UI

      try {
        // Step 1: Register with NostrAuthService (local state only)
        const result: AuthResult = NostrAuthService.signInWithNostrConnect(publicKey)

        if (!result.success) {
          return { success: false, error: result.error }
        }

        // Step 2: Create profile (local storage)
        const profile: StoredProfile = ProfileStorage.createProfile(
          publicKey,
          "nostrConnect",
        )
        ProfileStorage.setActiveProfile(profile.id)
        const activeBlinkAccount: StoredBlinkAccount | null =
          profile.blinkAccounts.find((a) => a.isActive) || null

        // Step 3: NIP-98 login (this is the slow part - relay signing)
        logAuth("useNostrAuth", "Starting NIP-98 login (blocking)...")
        onProgress?.("signing", "Signing authentication event...")

        const sessionResult: Nip98LoginResult = await Promise.race([
          NostrAuthService.nip98Login(),
          new Promise<never>(
            (_: (value: never) => void, reject: (reason: Error) => void) =>
              setTimeout(() => reject(new Error("TIMEOUT")), timeout),
          ),
        ])

        if (!sessionResult.success) {
          logAuthWarn("useNostrAuth", "NIP-98 login failed:", sessionResult.error)
          return {
            success: false,
            error: sessionResult.error || "Failed to establish session",
            errorType: "session",
          }
        }

        logAuth("useNostrAuth", "Server session established")

        // Step 4: Sync data from server
        logAuth("useNostrAuth", "Syncing data from server...")
        onProgress?.("syncing", "Loading your data...")

        try {
          const syncResult = await syncBlinkAccountFromServer()
          logAuth("useNostrAuth", "Sync result:", syncResult)
        } catch (syncError: unknown) {
          // Soft failure - don't block sign-in for sync issues
          logAuthWarn("useNostrAuth", "Sync failed (non-blocking):", syncError)
        }

        // Step 5: NOW set authenticated state (after session is established)
        logAuth("useNostrAuth", "Setting authenticated state...")
        updateState({
          loading: false,
          isAuthenticated: true,
          publicKey: publicKey.toLowerCase(),
          method: "nostrConnect",
          profile,
          activeBlinkAccount,
          hasServerSession: true,
          nostrProfile: null,
          error: null,
        })

        // Fetch Nostr profile metadata in background (non-blocking)
        fetchNostrProfile(publicKey)

        onProgress?.("complete", "Done!")
        logAuth("useNostrAuth", "Nostr Connect sign-in complete")
        return { success: true, profile, publicKey }
      } catch (error: unknown) {
        const err = error as Error
        logAuthError("useNostrAuth", "Nostr Connect sign-in failed:", error)

        // Handle timeout specifically
        if (err.message === "TIMEOUT") {
          return {
            success: false,
            error: "Signing timed out. Make sure Amber is open and approve the request.",
            errorType: "timeout",
          }
        }

        return { success: false, error: err.message, errorType: "unknown" }
      }
    },
    [updateState, fetchNostrProfile, syncBlinkAccountFromServer],
  )

  /**
   * Get available sign-in methods
   */
  const availableMethods: SignInMethod[] = NostrAuthService.getAvailableMethods()

  const value: NostrAuthContextValue = {
    // State
    ...state,

    // Computed
    availableMethods,
    hasExtension, // Uses state that re-checks after mount for async extensions
    isMobile: NostrAuthService.isMobileDevice(),

    // Actions
    signInWithExtension,
    signInWithExternalSigner,
    signInWithNostrConnect,
    signOut,
    refreshProfile,
    checkPendingSignerFlow,
    establishServerSession,
    syncBlinkAccountFromServer,
    createAccountWithPassword,
    signInWithPassword,
  }

  return <NostrAuthContext.Provider value={value}>{children}</NostrAuthContext.Provider>
}

/**
 * useNostrAuth hook - Access Nostr authentication context
 */
export function useNostrAuth(): NostrAuthContextValue {
  const context = useContext(NostrAuthContext)

  if (!context) {
    throw new Error("useNostrAuth must be used within a NostrAuthProvider")
  }

  return context
}

export default useNostrAuth
