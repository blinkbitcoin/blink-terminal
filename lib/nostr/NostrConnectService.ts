/**
 * NostrConnectService - NIP-46 (Nostr Connect) implementation
 *
 * Provides relay-based remote signing via the nostr-tools BunkerSigner.
 * This is the recommended method for web apps to communicate with external
 * signers like Amber, as it doesn't rely on unreliable URL schemes.
 *
 * Note: NDK alternative available (see NostrConnectServiceNDK.ts)
 * Set NEXT_PUBLIC_USE_NDK_NIP46=true to use NDK implementation instead.
 * NDK handles NIP-46 more robustly, especially with nsec.app on iOS Safari.
 * This file remains as legacy/fallback implementation.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/46.md
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
// @ts-expect-error -- nostr-tools subpath exports require moduleResolution:"bundler", works at runtime via webpack
import { BunkerSigner, createNostrConnectURI, parseBunkerInput } from "nostr-tools/nip46"
// @ts-expect-error -- nostr-tools subpath exports require moduleResolution:"bundler", works at runtime via webpack
import { SimplePool } from "nostr-tools/pool"
// @ts-expect-error -- nostr-tools subpath exports require moduleResolution:"bundler", works at runtime via webpack
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"

// =====================================================================
// Type definitions
// =====================================================================

/** Connection lifecycle states */
type ConnectionState = "disconnected" | "connecting" | "connected"

/** Persisted NIP-46 session data */
interface NIP46Session {
  publicKey: string
  signerPubkey: string
  relays: string[]
  connectedAt: number
}

/** Result returned by every connection attempt */
interface ConnectionResult {
  success: boolean
  publicKey?: string
  error?: string
  /** Set when the bunker URL is missing a secret (security rejection) */
  securityRejection?: boolean
  /** Set when there is no secret in the bunker URL */
  noSecret?: boolean
  /** Set when the remote signer needs user approval (nsec.app) */
  needsApproval?: boolean
  /** Whether an auth URL was opened during the attempt */
  authUrlOpened?: boolean
  /** Whether the same bunker URL can be re-used for a retry */
  canRetryWithSameUrl?: boolean
  /** True when this is the first "invalid secret" attempt */
  isFirstAttempt?: boolean
}

/** Unsigned Nostr event template passed to signEvent */
interface UnsignedEvent {
  kind: number
  content: string
  tags: string[][]
  created_at: number
  [key: string]: unknown
}

/** Signed Nostr event returned from the remote signer */
interface SignedEvent extends UnsignedEvent {
  id: string
  pubkey: string
  sig: string
}

/** Result returned from signEvent */
interface SignEventResult {
  success: boolean
  event?: SignedEvent
  error?: string
}

/** Options for generateConnectionURI */
interface GenerateURIOptions {
  relays?: string[]
}

/** Pending connection params stored in sessionStorage */
interface PendingConnectionParams {
  secret: string
  relays: string[]
  uri: string
  timestamp: number
}

/** Session data written to localStorage via storeSession */
interface StoreSessionData {
  publicKey: string
  signerPubkey: string
  relays: string[]
  connectedAt?: number
}

/**
 * Minimal typing for the BunkerSigner internals we access.
 * The real type can't be imported because nostr-tools/nip46 is a subpath export
 * that doesn't resolve under moduleResolution:"node".
 */
interface BunkerSignerInstance {
  getPublicKey(): Promise<string>
  signEvent(event: UnsignedEvent): Promise<SignedEvent>
  connect(): Promise<void>
  close(): Promise<void>
  ping(): Promise<void>
  bp: {
    pubkey?: string
    secret?: string
    relays?: string[]
  }
}

/**
 * Minimal typing for SimplePool.
 * Same subpath-export resolution issue as BunkerSigner.
 */
interface SimplePoolInstance {
  close(relays: string[]): void
}

// =====================================================================
// Constants
// =====================================================================

// Default relays for NIP-46 connections
// These relays are known to support NIP-46 well
const DEFAULT_NIP46_RELAYS: string[] = [
  "wss://relay.nsec.app", // Popular NIP-46 relay
  "wss://relay.damus.io", // Very reliable general relay
  "wss://nos.lol", // Good uptime backup
  "wss://relay.getportal.cc", // Portal relay
  "wss://offchain.pub", // Offchain relay
]

// Storage keys
const NIP46_SESSION_KEY = "blinkpos_nip46_session"
const NIP46_CLIENT_KEY = "blinkpos_nip46_clientkey"
const NIP46_PENDING_KEY = "blinkpos_nip46_pending"

// Connection timeout (2 minutes)
const CONNECTION_TIMEOUT = 120000

// Bunker connect timeout (30 seconds - shorter than overall timeout)
const BUNKER_CONNECT_TIMEOUT = 30000

// Post-connect stabilization delay (helps prevent first signing attempt failures)
// Some signers need a moment after connect() before they're ready for sign requests
const POST_CONNECT_DELAY = 500

// v49: Track connection attempt number to detect stale responses
let connectionAttemptCounter = 0

// Auth URL callback - set by UI components to handle nsec.app approval flow
let authUrlCallback: ((url: string) => void) | null = null

// =====================================================================
// Service class
// =====================================================================

class NostrConnectService {
  /** Active BunkerSigner instance (runtime type from nostr-tools/nip46) */
  static signer: BunkerSignerInstance | null = null

  /** Shared SimplePool instance (runtime type from nostr-tools/pool) */
  static pool: SimplePoolInstance | null = null

  static connectionState: ConnectionState = "disconnected"

  static userPublicKey: string | null = null

  /**
   * Get or create the shared SimplePool instance.
   * Per nostr-tools recommendations, we should reuse the same pool.
   *
   * v49: Now creates a FRESH pool for each connection attempt.
   * This prevents old subscriptions from interfering with new ones.
   * The old pool with limit:0 subscriptions was causing relay to send
   * old cached "invalid secret" responses on new connection attempts.
   *
   * @param forceNew - Force creation of a new pool
   */
  static getPool(forceNew: boolean = false): SimplePoolInstance {
    if (forceNew && this.pool) {
      console.log(
        "[NostrConnect] v49: Force closing existing pool before creating new one",
      )
      this.closePool()
    }

    if (!this.pool) {
      console.log("[NostrConnect] v49: Creating new SimplePool instance")
      this.pool = new SimplePool()
    }
    return this.pool!
  }

  /** Close and cleanup the shared pool. */
  static closePool(): void {
    if (this.pool) {
      console.log("[NostrConnect] v49: Closing SimplePool")
      try {
        // Close all relay connections
        this.pool.close([])
      } catch (e: unknown) {
        console.warn("[NostrConnect] Error closing pool:", e)
      }
      this.pool = null
    }
  }

  /**
   * Generate a nostrconnect:// URI for the user to scan in Amber.
   *
   * @param options - Optional relay overrides
   * @returns nostrconnect:// URI string
   */
  static generateConnectionURI(options: GenerateURIOptions = {}): string {
    // Generate or retrieve ephemeral client keypair
    const clientSecretKey: Uint8Array = this.getOrCreateClientKey()
    const clientPubkey: string = getPublicKey(clientSecretKey)

    // Generate random secret for this connection (16 chars)
    const secretBytes: Uint8Array = generateSecretKey()
    const secret: string = bytesToHex(secretBytes).slice(0, 16)

    const relays: string[] = options.relays || DEFAULT_NIP46_RELAYS

    // Determine base URL for assets
    const baseUrl: string =
      typeof window !== "undefined"
        ? window.location.origin
        : "https://terminal.blinkbtc.com"

    const uri: string = createNostrConnectURI({
      clientPubkey: clientPubkey,
      relays: relays,
      secret: secret,
      name: "Blink POS",
      url: baseUrl,
      image: `${baseUrl}/icons/icon-96x96.png`, // App icon for signer apps (NIP-46)
      perms: ["sign_event:27235", "get_public_key"], // NIP-98 auth events + pubkey
    })

    // Store connection params for reference
    this.storeConnectionParams({ secret, relays, uri })

    console.log("[NostrConnect] Generated connection URI")
    console.log("[NostrConnect] Client pubkey:", clientPubkey.slice(0, 16) + "...")
    console.log("[NostrConnect] Relays:", relays)

    return uri
  }

  /**
   * Wait for Amber to connect after user scans QR.
   *
   * @param uri - The nostrconnect:// URI that was displayed
   * @param timeout - Connection timeout in ms (default 2 minutes)
   */
  static async waitForConnection(
    uri: string,
    timeout: number = CONNECTION_TIMEOUT,
  ): Promise<ConnectionResult> {
    const clientSecretKey: Uint8Array = this.getOrCreateClientKey()

    // v65: attempt ownership. This attempt takes the next ticket; only the LATEST attempt may
    // publish signer/session/state into the singleton or clear it on failure. A superseded
    // attempt's late settle (its fromURI resolving after a newer attempt started) closes its
    // candidate signer and returns a "superseded" result WITHOUT touching shared state.
    connectionAttemptCounter++
    const thisAttempt: number = connectionAttemptCounter
    const isCurrentAttempt = (): boolean => thisAttempt === connectionAttemptCounter

    // Hoisted so the catch can close it — a CURRENT attempt failing after the candidate was
    // created must not leak its sockets (round-5 review).
    let candidate: BunkerSignerInstance | null = null

    try {
      this.connectionState = "connecting"
      console.log(
        "[NostrConnect] Waiting for connection (timeout:",
        timeout / 1000,
        "s)...",
      )

      // BunkerSigner.fromURI waits for the connect response from the remote signer.
      // Kept LOCAL: the singleton is assigned only if this attempt is still current.
      // (`created` is the non-null working alias; `candidate` mirrors it for the catch.)
      const created: BunkerSignerInstance = await BunkerSigner.fromURI(
        clientSecretKey,
        uri,
        {
          onauth: (authUrl: string) => {
            // If remote signer needs additional auth (rare for Amber)
            console.log("[NostrConnect] Auth URL requested:", authUrl)
            // Could open authUrl in a popup if needed
          },
        },
        timeout,
      )
      candidate = created

      if (!isCurrentAttempt()) {
        // A newer attempt (or a disconnect/cancel) superseded this one while fromURI was
        // pending. Close the stale candidate's sockets and stay out of the shared state.
        console.warn(
          "[NostrConnect] Superseded connect attempt — closing stale candidate",
        )
        try {
          await created.close()
        } catch {
          // best-effort cleanup
        }
        return { success: false, error: "Connection attempt superseded" }
      }
      // NOTE: the singleton is NOT assigned here. Publishing early left `this.signer`
      // pointing at a closed instance if a later supersede check fired (Copilot review);
      // everything below works on the local `created` and the singleton is published
      // atomically at the single success point with state/pubkey/session.

      console.log("[NostrConnect] Connection established, getting public key...")

      // Get the user's public key from the remote signer
      const publicKey: string = await created.getPublicKey()

      // Re-check currency after the network round-trip: a superseding attempt may have
      // started while getPublicKey was in flight.
      if (!isCurrentAttempt()) {
        console.warn("[NostrConnect] Superseded after connect — closing stale candidate")
        try {
          await created.close()
        } catch {
          // best-effort cleanup
        }
        return { success: false, error: "Connection attempt superseded" }
      }

      // Add stabilization delay to let WebSocket connections settle
      // This helps prevent the first signing attempt from failing
      console.log("[NostrConnect] Adding post-connect stabilization delay...")
      await new Promise<void>((resolve) => setTimeout(resolve, POST_CONNECT_DELAY))

      if (!isCurrentAttempt()) {
        console.warn(
          "[NostrConnect] Superseded during stabilization — closing stale candidate",
        )
        try {
          await created.close()
        } catch {
          // best-effort cleanup
        }
        return { success: false, error: "Connection attempt superseded" }
      }

      // Single atomic publish point: signer, state, pubkey and session land together, so no
      // caller can ever observe a signer without a matching connected state.
      this.signer = created
      this.connectionState = "connected"
      this.userPublicKey = publicKey

      // Store session for persistence
      this.storeSession({
        publicKey,
        signerPubkey: created.bp.pubkey!,
        relays: created.bp.relays!,
      })

      console.log("[NostrConnect] Successfully connected!")
      console.log("[NostrConnect] User pubkey:", publicKey.slice(0, 16) + "...")

      return { success: true, publicKey }
    } catch (err: unknown) {
      // Only the CURRENT attempt may fail the singleton — a superseded attempt's rejection
      // must not mark a newer (possibly healthy) connection disconnected or clear its signer.
      if (isCurrentAttempt()) {
        this.connectionState = "disconnected"
        this.signer = null
      }
      // The LOCAL candidate is ours either way — close it so its sockets never leak
      // (round-5 review; e.g. a current-attempt getPublicKey failure).
      if (candidate) {
        try {
          await candidate.close()
        } catch {
          // best-effort cleanup
        }
      }

      const error = err instanceof Error ? err : new Error(String(err))
      console.error("[NostrConnect] Connection failed:", error)

      // Provide user-friendly error messages
      let errorMessage: string = error.message
      if (error.message.includes("timed out")) {
        errorMessage = "Connection timed out. Please try again."
      } else if (error.message.includes("closed")) {
        errorMessage = "Connection was closed. Please try again."
      }

      return { success: false, error: errorMessage }
    }
  }

  /**
   * Connect using a bunker:// URL provided by the user.
   * Alternative flow if QR scanning isn't working.
   *
   * v49: CRITICAL FIX for iOS Safari "invalid secret"
   * - ROOT CAUSE: nostr-tools subscriptions use limit:0 with no 'since' filter
   * - This causes relay to replay ALL historical events including old error responses
   * - Old "invalid secret" responses from PREVIOUS attempts get replayed
   * - FIX: Create a FRESH pool for each connection to avoid old subscription interference
   * - FIX: On first "invalid secret", assume nsec.app needs approval (show approval UI)
   * - FIX: Only after retry also fails do we mark URL as truly expired
   *
   * @param bunkerUrl - bunker:// URL from Amber/nsec.app
   * @param maxRetries - Maximum retry attempts (default 1 since secrets are single-use)
   * @param forceNewClientKey - Force generation of a new client key
   * @param onAuthUrl - Callback when signer requests auth URL approval (nsec.app)
   */
  static async connectWithBunkerURL(
    bunkerUrl: string,
    maxRetries: number = 1,
    forceNewClientKey: boolean = false,
    onAuthUrl: ((url: string) => void) | null = null,
  ): Promise<ConnectionResult> {
    // v49: Increment connection attempt counter
    // v66 (round-5 review): the ticket is now OWNERSHIP, not just logging — this attempt may
    // publish or clear shared singleton state only while it is still the latest one, exactly
    // like waitForConnection/restoreSession. The candidate signer + pool stay LOCAL until
    // publish; a superseded or failed attempt closes them instead of leaking sockets.
    connectionAttemptCounter++
    const thisAttempt: number = connectionAttemptCounter
    const isCurrentAttempt = (): boolean => thisAttempt === connectionAttemptCounter
    console.log(`[NostrConnect] v49: Connection attempt #${thisAttempt}`)

    let candidate: BunkerSignerInstance | null = null
    let candidatePool: SimplePoolInstance | null = null
    const closeCandidate = async (): Promise<void> => {
      if (candidate) {
        try {
          await candidate.close()
        } catch {
          // best-effort cleanup
        }
        candidate = null
      }
      if (candidatePool) {
        try {
          candidatePool.close([])
        } catch {
          // best-effort cleanup
        }
        candidatePool = null
      }
    }

    try {
      console.log("[NostrConnect] v49: Parsing bunker URL...")
      console.log("[NostrConnect] URL length:", bunkerUrl?.length)
      console.log("[NostrConnect] forceNewClientKey:", forceNewClientKey)
      console.log("[NostrConnect] onAuthUrl callback provided:", !!onAuthUrl)
      console.log("[NostrConnect] maxRetries:", maxRetries)

      const bunkerPointer: {
        pubkey: string
        relays: string[]
        secret?: string | null
      } | null = await parseBunkerInput(bunkerUrl)

      if (!bunkerPointer) {
        return { success: false, error: "Invalid bunker URL format" }
      }

      if (bunkerPointer.relays.length === 0) {
        return { success: false, error: "Bunker URL must include at least one relay" }
      }

      // SECURITY: Require secret in bunker URLs to prevent connection hijacking
      // See: Mike Dilger security disclosure on NIP-46 relay monitoring attacks
      // https://github.com/nostrband/nostrconnect.org - nostrconnect.org recommendations
      if (!bunkerPointer.secret) {
        console.error(
          "[NostrConnect] SECURITY: Bunker URL has no secret - rejecting to prevent hijacking",
        )
        return {
          success: false,
          error:
            "This bunker URL does not contain a verification secret. For your security, please generate a NEW bunker URL from your signer app that includes a secret.",
          securityRejection: true,
          noSecret: true,
        }
      }

      // Enhanced debugging for iOS issue
      console.log("[NostrConnect] Bunker pointer parsed:")
      console.log(
        "[NostrConnect]   - pubkey:",
        bunkerPointer.pubkey?.slice(0, 16) + "...",
      )
      console.log("[NostrConnect]   - secret exists:", !!bunkerPointer.secret)
      console.log("[NostrConnect]   - secret length:", bunkerPointer.secret?.length || 0)
      console.log(
        "[NostrConnect]   - secret preview:",
        bunkerPointer.secret ? bunkerPointer.secret.slice(0, 8) + "..." : "none",
      )
      console.log("[NostrConnect]   - relays count:", bunkerPointer.relays?.length)

      // Force new client key if requested (helps with some edge cases)
      if (forceNewClientKey) {
        console.log("[NostrConnect] Forcing new client key generation...")
        this.clearClientKey()
      }

      const clientSecretKey: Uint8Array = this.getOrCreateClientKey()
      const clientPubkey: string = getPublicKey(clientSecretKey)

      // parseBunkerInput awaited above — a newer attempt may have started since; touch
      // nothing shared if so.
      if (!isCurrentAttempt()) {
        return { success: false, error: "Connection attempt superseded" }
      }

      this.connectionState = "connecting"
      console.log("[NostrConnect] Connecting to bunker...")
      console.log("[NostrConnect] Client pubkey:", clientPubkey.slice(0, 16) + "...")
      console.log(
        "[NostrConnect] Signer pubkey:",
        bunkerPointer.pubkey.slice(0, 16) + "...",
      )
      console.log("[NostrConnect] Relays:", bunkerPointer.relays)

      // Store the auth callback for use in onauth handler
      authUrlCallback = onAuthUrl

      // Track if auth URL was opened (nsec.app approval flow)
      let authUrlOpened = false

      // v49: CRITICAL - Close ANY existing signer AND pool before creating new ones
      // This prevents old subscriptions from interfering.
      // v66: DETACH synchronously (we are the newest attempt right now), then close the
      // detached resources — the awaits below can no longer touch a newer attempt's state.
      const oldSigner: BunkerSignerInstance | null = this.signer
      this.signer = null
      const oldPool: SimplePoolInstance | null = this.pool
      this.pool = null
      if (oldSigner) {
        try {
          console.log("[NostrConnect] v49: Closing previous signer...")
          await oldSigner.close()
        } catch (e: unknown) {
          console.warn("[NostrConnect] v49: Error closing previous signer:", e)
        }
      }
      if (oldPool) {
        try {
          oldPool.close([])
        } catch (e: unknown) {
          console.warn("[NostrConnect] v49: Error closing previous pool:", e)
        }
      }

      // v49: Force a NEW pool to avoid old subscription interference
      // The old pool may have subscriptions with limit:0 that receive old cached events
      // v66: the fresh pool stays LOCAL until this attempt publishes on success.
      console.log(
        "[NostrConnect] v49: Creating FRESH pool to avoid old subscription interference",
      )
      candidatePool = new SimplePool() as unknown as SimplePoolInstance
      const pool: SimplePoolInstance = candidatePool

      // Create signer with onauth callback for nsec.app approval flow
      const signerParams: {
        pool: SimplePoolInstance
        onauth: (authUrl: string) => void
      } = {
        pool,
        onauth: (authUrl: string) => {
          console.log("[NostrConnect] v49: *** ONAUTH CALLBACK TRIGGERED ***")
          console.log(
            "[NostrConnect] v49: Received auth_url from remote signer:",
            authUrl,
          )
          authUrlOpened = true

          if (onAuthUrl) {
            // Let the UI component handle the auth URL
            console.log("[NostrConnect] v49: Calling UI onAuthUrl callback...")
            onAuthUrl(authUrl)
          } else if (authUrlCallback) {
            // Fallback to stored callback
            console.log("[NostrConnect] v49: Calling stored authUrlCallback...")
            authUrlCallback(authUrl)
          } else {
            // Default: open in new window/tab
            console.log("[NostrConnect] v49: Opening auth URL in new window...")
            if (typeof window !== "undefined") {
              const authWindow: Window | null = window.open(
                authUrl,
                "_blank",
                "width=500,height=600,popup=yes",
              )
              if (!authWindow) {
                console.warn("[NostrConnect] Popup blocked, trying location redirect")
                window.open(authUrl, "_blank")
              }
            }
          }
        },
      }

      // v49: Log the exact bunker pointer being used
      console.log("[NostrConnect] v49: Creating BunkerSigner with:")
      console.log("[NostrConnect] v49:   bunkerPointer.pubkey:", bunkerPointer.pubkey)
      console.log("[NostrConnect] v49:   bunkerPointer.secret:", bunkerPointer.secret)
      console.log(
        "[NostrConnect] v49:   bunkerPointer.relays:",
        JSON.stringify(bunkerPointer.relays),
      )
      console.log(
        "[NostrConnect] v49:   clientSecretKey length:",
        clientSecretKey?.length,
      )
      console.log("[NostrConnect] v49:   clientPubkey:", clientPubkey)
      console.log("[NostrConnect] v49:   connectionAttempt:", thisAttempt)

      const created: BunkerSignerInstance = BunkerSigner.fromBunker(
        clientSecretKey,
        bunkerPointer,
        signerParams,
      )
      candidate = created

      console.log(
        "[NostrConnect] v49: BunkerSigner created, signer.bp:",
        JSON.stringify({
          pubkey: created.bp?.pubkey?.slice(0, 16) + "...",
          secret: created.bp?.secret ? "exists" : "none",
          relays: created.bp?.relays,
        }),
      )

      try {
        // Establish connection with the remote signer WITH TIMEOUT
        // nostr-tools signer.connect() has no built-in timeout, so we add one
        console.log("[NostrConnect] v49: Calling signer.connect() with timeout...")
        await this.connectWithTimeout(created, BUNKER_CONNECT_TIMEOUT)
        console.log("[NostrConnect] v49: connect() completed successfully")

        // Small delay to let WebSocket connections stabilize
        console.log("[NostrConnect] Adding post-connect stabilization delay...")
        await new Promise<void>((resolve) => setTimeout(resolve, POST_CONNECT_DELAY))

        // Get user's public key with retry
        console.log("[NostrConnect] Getting public key...")
        const publicKey: string = await this.getPublicKeyWithRetry(created, 3)

        // The network round-trips above are suspension points — publish only if this
        // attempt still owns the singleton (v66).
        if (!isCurrentAttempt()) {
          console.warn(
            "[NostrConnect] Superseded bunker attempt — closing stale candidate",
          )
          await closeCandidate()
          return { success: false, error: "Connection attempt superseded" }
        }

        this.signer = created
        this.pool = candidatePool
        this.connectionState = "connected"
        this.userPublicKey = publicKey

        // Store session for persistence
        this.storeSession({
          publicKey,
          signerPubkey: bunkerPointer.pubkey,
          relays: bunkerPointer.relays,
        })

        console.log("[NostrConnect] v49: Successfully connected via bunker URL!")
        console.log("[NostrConnect] User pubkey:", publicKey.slice(0, 16) + "...")

        // Clear the callback
        authUrlCallback = null

        return { success: true, publicKey }
      } catch (innerErr: unknown) {
        // Handle both Error objects and plain string throws
        const errorMessage: string =
          typeof innerErr === "string"
            ? innerErr
            : innerErr instanceof Error
              ? innerErr.message
              : "no message"

        console.warn(`[NostrConnect] v49: Connection failed:`, errorMessage)
        console.warn(`[NostrConnect] v49: Error type:`, typeof innerErr)
        console.warn(`[NostrConnect] v49: Raw error value:`, innerErr)
        console.warn(`[NostrConnect] v49: authUrlOpened at error time:`, authUrlOpened)

        // v49: Handle "invalid secret" error
        // On first attempt, this likely means nsec.app needs approval
        // nsec.app doesn't send auth_url callback - it shows approval in its own UI
        if (errorMessage.includes("invalid secret")) {
          console.log('[NostrConnect] v49: Got "invalid secret" error')

          // Brief wait in case auth_url is coming (some signers send it)
          await new Promise<void>((resolve) => setTimeout(resolve, 500))

          console.log("[NostrConnect] v49: authUrlOpened:", authUrlOpened)

          // Clean up for retry — shared state only while this attempt still owns it (v66),
          // and always close the failed candidate (the retry creates a fresh one).
          if (isCurrentAttempt()) {
            authUrlCallback = null
            this.connectionState = "disconnected"
          }
          await closeCandidate()

          // v49: ALWAYS show approval UI on first "invalid secret"
          // This could be:
          // 1. nsec.app waiting for user approval (most likely)
          // 2. Old cached response from relay (fixed with fresh pool, but still possible)
          // 3. Actually expired token (we'll find out on retry)
          console.log(
            "[NostrConnect] v49: Showing approval UI - user should check nsec.app",
          )

          return {
            success: false,
            error:
              'Please open nsec.app and approve the connection request for this app, then tap "Retry" to complete sign-in.',
            needsApproval: true,
            authUrlOpened: authUrlOpened,
            canRetryWithSameUrl: true,
            isFirstAttempt: true,
          }
        }

        if (innerErr instanceof Error) {
          console.warn(
            `[NostrConnect] Error details:`,
            JSON.stringify({
              name: innerErr.name,
              message: innerErr.message,
              stack: innerErr.stack?.split("\n").slice(0, 3).join(" | "),
            }),
          )
        }

        // For other errors, provide generic message. Shared state only while current (v66);
        // the candidate is closed regardless so its sockets never leak.
        if (isCurrentAttempt()) {
          authUrlCallback = null
          this.connectionState = "disconnected"
        }
        await closeCandidate()

        let userFriendlyError: string = errorMessage
        if (errorMessage.includes("timed out")) {
          userFriendlyError =
            "Connection timed out. Please ensure nsec.app is open and try with a new bunker URL."
        } else if (errorMessage.includes("closed")) {
          userFriendlyError = "Connection was closed. Please try with a new bunker URL."
        }

        return { success: false, error: userFriendlyError }
      }
    } catch (outerErr: unknown) {
      if (isCurrentAttempt()) {
        this.connectionState = "disconnected"
        authUrlCallback = null
      }
      await closeCandidate()

      const error = outerErr instanceof Error ? outerErr : new Error(String(outerErr))
      console.error("[NostrConnect] Bunker connection failed:", error)
      return { success: false, error: error.message }
    }
  }

  /**
   * Get public key with retry logic.
   * @param signer - The candidate signer to query (kept local until published, v66)
   * @param maxRetries - Maximum number of attempts
   */
  private static async getPublicKeyWithRetry(
    signer: BunkerSignerInstance,
    maxRetries: number = 3,
  ): Promise<string> {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const publicKey: string = await signer.getPublicKey()
        return publicKey
      } catch (err: unknown) {
        lastError = err
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[NostrConnect] getPublicKey attempt ${attempt} failed:`, msg)
        if (attempt < maxRetries) {
          await new Promise<void>((resolve) => setTimeout(resolve, 500 * attempt))
        }
      }
    }
    throw lastError || new Error("Failed to get public key")
  }

  /**
   * Connect to bunker with timeout.
   * nostr-tools BunkerSigner.connect() has no built-in timeout, so we wrap it.
   *
   * @param signer - The BunkerSigner instance (typed as any — can't resolve from subpath export)
   * @param timeout - Timeout in milliseconds
   */
  private static async connectWithTimeout(
    signer: BunkerSignerInstance,
    timeout: number = BUNKER_CONNECT_TIMEOUT,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false

      // Set up timeout
      const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
        if (!resolved) {
          resolved = true
          console.error(`[NostrConnect] connect() timed out after ${timeout}ms`)
          reject(
            new Error(
              `Connection timed out after ${timeout / 1000} seconds. The remote signer may not be responding. Please check that the signer app is open and connected to the relay.`,
            ),
          )
        }
      }, timeout)

      // Call the actual connect
      ;(signer.connect() as Promise<void>)
        .then(() => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeoutId)
            resolve()
          }
        })
        .catch((error: unknown) => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeoutId)
            reject(error)
          }
        })
    })
  }

  /**
   * Sign an event using the connected remote signer.
   *
   * @param eventTemplate - Unsigned event (kind, content, tags, created_at)
   * @param maxRetries - Maximum retry attempts
   */
  static async signEvent(
    eventTemplate: UnsignedEvent,
    maxRetries: number = 3,
  ): Promise<SignEventResult> {
    if (!this.signer || this.connectionState !== "connected") {
      console.error("[NostrConnect] Cannot sign: not connected")
      return { success: false, error: "Not connected to remote signer" }
    }

    let lastError: unknown = null
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(
          `[NostrConnect] Requesting signature for event kind: ${eventTemplate.kind} (attempt ${attempt}/${maxRetries})`,
        )

        const signedEvent: SignedEvent = await this.signer!.signEvent(eventTemplate)

        console.log("[NostrConnect] Event signed successfully")
        console.log("[NostrConnect] Event ID:", signedEvent.id.slice(0, 16) + "...")

        return { success: true, event: signedEvent }
      } catch (err: unknown) {
        lastError = err
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[NostrConnect] Signing attempt ${attempt} failed:`, msg)

        if (attempt < maxRetries) {
          // Exponential backoff: 500ms, 1000ms, 1500ms...
          const delay: number = 500 * attempt
          console.log(`[NostrConnect] Retrying signature in ${delay}ms...`)
          await new Promise<void>((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    console.error("[NostrConnect] Signing failed after all retries:", lastError)
    const errMsg =
      lastError instanceof Error
        ? lastError.message
        : typeof lastError === "string"
          ? lastError
          : "Signing failed"
    return { success: false, error: errMsg }
  }

  /**
   * Check if there's an active NIP-46 connection.
   */
  static isConnected(): boolean {
    return this.connectionState === "connected" && this.signer !== null
  }

  /**
   * Get the current connection state.
   */
  static getConnectionState(): ConnectionState {
    return this.connectionState
  }

  /**
   * Get the connected user's public key.
   */
  static getPublicKey(): string | null {
    return this.userPublicKey
  }

  /**
   * Attempt to restore a previous NIP-46 session.
   * Called on app startup to reconnect if session exists.
   */
  static async restoreSession(): Promise<ConnectionResult> {
    const session: NIP46Session | null = this.getStoredSession()
    if (!session) {
      console.log("[NostrConnect] No stored session to restore")
      return { success: false, error: "No session found" }
    }

    console.log("[NostrConnect] Attempting to restore session...")
    console.log("[NostrConnect] Session pubkey:", session.publicKey.slice(0, 16) + "...")

    // v65: attempt ownership — restore takes a ticket like any connect attempt and only
    // publishes/clears singleton state while it is still the latest one. Declared before the
    // try so the catch can consult it.
    connectionAttemptCounter++
    const thisAttempt: number = connectionAttemptCounter
    const isCurrentAttempt = (): boolean => thisAttempt === connectionAttemptCounter

    // Hoisted so the catch/mismatch paths can close it — a failed restore must not leak the
    // candidate's sockets (round-5 review).
    let candidate: BunkerSignerInstance | null = null

    try {
      const clientSecretKey: Uint8Array = this.getOrCreateClientKey()

      // Reconstruct bunker pointer from session
      const bunkerPointer: { pubkey: string; relays: string[]; secret: null } = {
        pubkey: session.signerPubkey,
        relays: session.relays,
        secret: null, // No secret needed for reconnection
      }

      this.connectionState = "connecting"

      // v49: Use fresh pool for session restore to avoid stale subscription issues
      const pool: SimplePoolInstance = this.getPool(true)
      console.log("[NostrConnect] v49: Using fresh SimplePool for session restore")

      const created: BunkerSignerInstance = BunkerSigner.fromBunker(
        clientSecretKey,
        bunkerPointer,
        { pool },
      )
      candidate = created

      // Verify connection is alive with a ping
      console.log("[NostrConnect] Verifying connection with ping...")
      await created.ping()

      // Verify public key matches
      const publicKey: string = await created.getPublicKey()

      // A newer attempt (or disconnect) superseded this restore while the network calls were
      // in flight — close the candidate and publish nothing.
      if (!isCurrentAttempt()) {
        console.warn(
          "[NostrConnect] Superseded restore attempt — closing stale candidate",
        )
        try {
          await created.close()
        } catch {
          // best-effort cleanup
        }
        return { success: false, error: "Restore attempt superseded" }
      }
      this.signer = created

      if (publicKey !== session.publicKey) {
        console.warn("[NostrConnect] Public key mismatch, clearing session")
        this.clearSession()
        this.connectionState = "disconnected"
        this.signer = null
        // Close the mismatched candidate — its sockets must not leak (round-5 review).
        try {
          await created.close()
        } catch {
          // best-effort cleanup
        }
        return { success: false, error: "Session invalid" }
      }

      this.connectionState = "connected"
      this.userPublicKey = publicKey

      // Update session timestamp
      this.storeSession({
        ...session,
        connectedAt: Date.now(),
      })

      console.log("[NostrConnect] Session restored successfully!")
      return { success: true, publicKey }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      console.warn("[NostrConnect] Failed to restore session:", error.message)
      // Only the CURRENT attempt may clear the singleton/session — a superseded restore
      // failing late must not disconnect a newer connection.
      if (isCurrentAttempt()) {
        this.clearSession()
        this.connectionState = "disconnected"
        this.signer = null
      }
      // The LOCAL candidate is ours either way — close it so its sockets never leak
      // (round-5 review; e.g. a current-attempt ping/getPublicKey failure).
      if (candidate) {
        try {
          await candidate.close()
        } catch {
          // best-effort cleanup
        }
      }
      return { success: false, error: "Session expired or invalid" }
    }
  }

  /**
   * Disconnect and clean up the NIP-46 connection.
   */
  static async disconnect(): Promise<void> {
    console.log("[NostrConnect] Disconnecting...")

    // Invalidate any pending connect/restore attempt FIRST: its late settle must see itself
    // superseded and stay out of the singleton (v65 attempt ownership).
    connectionAttemptCounter++

    // v66 (round-5 review): DETACH synchronously, close asynchronously. Every singleton
    // mutation happens in this same microtask — before any await — so a connection B that
    // starts (and even succeeds) while the detached close below is still pending is
    // structurally unreachable from this disconnect: B publishes its own signer/pool/session
    // into fields this disconnect no longer references.
    const ownedSigner: BunkerSignerInstance | null = this.signer
    this.signer = null
    const ownedPool: SimplePoolInstance | null = this.pool
    this.pool = null
    this.connectionState = "disconnected"
    this.userPublicKey = null
    this.clearSession()

    // Close only the DETACHED resources; whenever these awaits settle, they cannot touch a
    // newer attempt's state.
    if (ownedSigner) {
      try {
        await ownedSigner.close()
      } catch (err: unknown) {
        console.warn("[NostrConnect] Error closing signer:", err)
      }
    }
    if (ownedPool) {
      console.log("[NostrConnect] v49: Closing SimplePool")
      try {
        ownedPool.close([])
      } catch (e: unknown) {
        console.warn("[NostrConnect] Error closing pool:", e)
      }
    }

    console.log("[NostrConnect] Disconnected")
  }

  // =============== Private Helper Methods ===============

  /**
   * Get or create the ephemeral client keypair.
   * This key is used to communicate with the remote signer.
   */
  private static getOrCreateClientKey(): Uint8Array {
    if (typeof localStorage === "undefined") {
      // Server-side, generate temporary key
      console.log("[NostrConnect] getOrCreateClientKey: Server-side, generating temp key")
      return generateSecretKey()
    }

    // Try to retrieve existing key
    const stored: string | null = localStorage.getItem(NIP46_CLIENT_KEY)
    console.log("[NostrConnect] getOrCreateClientKey: Stored key exists:", !!stored)
    console.log(
      "[NostrConnect] getOrCreateClientKey: Stored key length:",
      stored?.length || 0,
    )

    if (stored) {
      try {
        const key: Uint8Array = hexToBytes(stored)
        const pubkey: string = getPublicKey(key)
        console.log(
          "[NostrConnect] getOrCreateClientKey: Using existing key, pubkey:",
          pubkey.slice(0, 16) + "...",
        )
        return key
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          "[NostrConnect] getOrCreateClientKey: Invalid stored key, error:",
          msg,
        )
        console.warn("[NostrConnect] getOrCreateClientKey: Generating new one")
      }
    }

    // Generate new ephemeral key
    console.log("[NostrConnect] getOrCreateClientKey: Generating new key")
    const newKey: Uint8Array = generateSecretKey()
    const newKeyHex: string = bytesToHex(newKey)
    localStorage.setItem(NIP46_CLIENT_KEY, newKeyHex)

    // Verify it was stored correctly
    const verifyStored: string | null = localStorage.getItem(NIP46_CLIENT_KEY)
    console.log(
      "[NostrConnect] getOrCreateClientKey: Storage verification:",
      verifyStored === newKeyHex ? "OK" : "MISMATCH",
    )

    const newPubkey: string = getPublicKey(newKey)
    console.log(
      "[NostrConnect] getOrCreateClientKey: New key pubkey:",
      newPubkey.slice(0, 16) + "...",
    )

    return newKey
  }

  /**
   * Store pending connection parameters.
   */
  private static storeConnectionParams(
    params: Omit<PendingConnectionParams, "timestamp">,
  ): void {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(
        NIP46_PENDING_KEY,
        JSON.stringify({
          ...params,
          timestamp: Date.now(),
        }),
      )
    }
  }

  /**
   * Get pending connection parameters.
   */
  static getPendingConnection(): PendingConnectionParams | null {
    if (typeof sessionStorage === "undefined") return null
    try {
      const stored: string | null = sessionStorage.getItem(NIP46_PENDING_KEY)
      return stored ? (JSON.parse(stored) as PendingConnectionParams) : null
    } catch {
      return null
    }
  }

  /**
   * Clear pending connection.
   */
  static clearPendingConnection(): void {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(NIP46_PENDING_KEY)
    }
  }

  /**
   * Store session data for persistence.
   */
  private static storeSession(sessionData: StoreSessionData): void {
    if (typeof localStorage !== "undefined") {
      const session: NIP46Session = {
        publicKey: sessionData.publicKey,
        signerPubkey: sessionData.signerPubkey,
        relays: sessionData.relays,
        connectedAt: sessionData.connectedAt || Date.now(),
      }
      localStorage.setItem(NIP46_SESSION_KEY, JSON.stringify(session))
      console.log("[NostrConnect] Session stored")
    }
  }

  /**
   * Get stored session data.
   */
  private static getStoredSession(): NIP46Session | null {
    if (typeof localStorage === "undefined") return null
    try {
      const stored: string | null = localStorage.getItem(NIP46_SESSION_KEY)
      return stored ? (JSON.parse(stored) as NIP46Session) : null
    } catch {
      return null
    }
  }

  /**
   * Check if a stored session exists.
   */
  static hasStoredSession(): boolean {
    return this.getStoredSession() !== null
  }

  /**
   * Clear stored session data.
   */
  private static clearSession(): void {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(NIP46_SESSION_KEY)
    }
    this.clearPendingConnection()
    console.log("[NostrConnect] Session cleared")
  }

  /**
   * Clear client key (use with caution — will invalidate all sessions).
   */
  static clearClientKey(): void {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(NIP46_CLIENT_KEY)
    }
  }

  /**
   * Get default relays.
   */
  static getDefaultRelays(): string[] {
    return [...DEFAULT_NIP46_RELAYS]
  }
}

export default NostrConnectService
export type { ConnectionResult }
