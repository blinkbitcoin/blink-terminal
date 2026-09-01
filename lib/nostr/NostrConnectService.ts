/**
 * NostrConnectService - NIP-46 (Nostr Connect) implementation
 *
 * Provides relay-based remote signing via the nostr-tools BunkerSigner.
 * This is the recommended method for web apps to communicate with external
 * signers like Amber, as it doesn't rely on unreliable URL schemes.
 *
 * Only the client-initiated nostrconnect:// flow is supported (QR on desktop,
 * "Open in Amber" deeplink on mobile). The signer-initiated bunker:// paste flow
 * and the NDK alternative were removed (nsec.app is discontinued; the bunker
 * flow had no users and was the source of the dual-service ambiguity that drove
 * repeated review rounds).
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/46.md
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
// @ts-expect-error -- nostr-tools subpath exports require moduleResolution:"bundler", works at runtime via webpack
import { BunkerSigner, createNostrConnectURI } from "nostr-tools/nip46"
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
// Kept at parity with the Blink nostr-login plugin's defaults
// (btcpay-nostr-login NostrLoginService.DefaultRelays); relay.nsec.app was dropped
// with the discontinued signer it fronted.
const DEFAULT_NIP46_RELAYS: string[] = [
  "wss://nos.lol", // Good uptime
  "wss://relay.damus.io", // Very reliable general relay
  "wss://relay.primal.net", // Primal relay
]

// Storage keys
const NIP46_SESSION_KEY = "blinkpos_nip46_session"
const NIP46_CLIENT_KEY = "blinkpos_nip46_clientkey"
const NIP46_PENDING_KEY = "blinkpos_nip46_pending"

// Connection timeout (2 minutes)
const CONNECTION_TIMEOUT = 120000

// Post-connect stabilization delay (helps prevent first signing attempt failures)
// Some signers need a moment after connect() before they're ready for sign requests
const POST_CONNECT_DELAY = 500

// v49: Track connection attempt number to detect stale responses
let connectionAttemptCounter = 0

// =====================================================================
// Service class
// =====================================================================
//
// ATTEMPT-OWNERSHIP CONTRACT (v65/v66) — read before adding any method that
// mutates the shared statics (signer/pool/connectionState/userPublicKey/session).
// Every writer MUST follow the protocol the three existing writers implement
// (waitForConnection, restoreSession, disconnect):
//
//   1. Take a ticket: `connectionAttemptCounter++` and capture it in
//      `const thisAttempt = connectionAttemptCounter`.
//      (disconnect only increments — invalidating every pending attempt.)
//   2. Work on LOCAL candidates only (signer/pool). Never touch the shared
//      statics before ownership is confirmed.
//   3. Re-check currency (`thisAttempt === connectionAttemptCounter`)
//      IMMEDIATELY BEFORE any shared-state publish — that is the invariant the
//      tests pin. Extra checks after long awaits are an optimization (fail
//      fast, close candidates sooner), not the guarantee.
//   4. If superseded: close the local candidates, return without touching
//      shared state.
//   5. Publish the in-memory statics together at a single success point
//      (signer + pool + state + pubkey, no awaits in between). Session
//      persistence via storeSession() follows the publish; it is synchronous
//      but NOT atomic with it — a storage failure after publish leaves a live
//      connection with no stored session (fails toward re-auth, never toward
//      a stale session).
//   6. On teardown: detach synchronously (null the statics before any await),
//      then close the detached resources.
//
// The race-scenario tests in tests/unit/nostr-connect-service.spec.ts pin this
// behavior; a writer that skips the protocol will resurrect the interleaving
// bugs that took PR #61 seven review rounds to kill.

class NostrConnectService {
  /** Active BunkerSigner instance (runtime type from nostr-tools/nip46) */
  static signer: BunkerSignerInstance | null = null

  /** Shared SimplePool instance (runtime type from nostr-tools/pool) */
  static pool: SimplePoolInstance | null = null

  static connectionState: ConnectionState = "disconnected"

  static userPublicKey: string | null = null

  // NOTE: the former getPool(forceNew)/closePool() helpers were removed (Copilot review).
  // Both mutated the SHARED pool from whatever context called them — the opposite of the
  // attempt-ownership contract. Every writer (waitForConnection, restoreSession) now builds
  // its pool LOCALLY and publishes it detach-then-replace at its single success point;
  // disconnect() closes its detached pool inline.

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

    // Hoisted so the catch/mismatch paths can close them — a failed restore must not leak the
    // candidate's sockets (round-5 review). The pool is LOCAL too (Copilot review): the shared
    // `this.pool` is never touched before this restore has confirmed ownership, so a restore
    // that is superseded or fails can never clobber a newer connection's live pool.
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
      const clientSecretKey: Uint8Array = this.getOrCreateClientKey()

      // Reconstruct bunker pointer from session
      const bunkerPointer: { pubkey: string; relays: string[]; secret: null } = {
        pubkey: session.signerPubkey,
        relays: session.relays,
        secret: null, // No secret needed for reconnection
      }

      this.connectionState = "connecting"

      // v49: fresh pool for session restore to avoid stale subscription issues — built
      // locally and published only at the success point below.
      candidatePool = new SimplePool() as unknown as SimplePoolInstance
      console.log("[NostrConnect] v49: Using fresh SimplePool for session restore")

      const created: BunkerSignerInstance = BunkerSigner.fromBunker(
        clientSecretKey,
        bunkerPointer,
        { pool: candidatePool },
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
        await closeCandidate()
        return { success: false, error: "Restore attempt superseded" }
      }

      if (publicKey !== session.publicKey) {
        console.warn("[NostrConnect] Public key mismatch, clearing session")
        this.clearSession()
        this.connectionState = "disconnected"
        this.signer = null
        // Close the mismatched candidate — its sockets must not leak (round-5 review).
        await closeCandidate()
        return { success: false, error: "Session invalid" }
      }

      // Single atomic publish point. The pool is detach-then-replace: the previous shared
      // pool is captured, the fresh one installed, and only then is the old one closed —
      // so closing it can never touch state this restore does not own.
      const previousPool: SimplePoolInstance | null = this.pool
      this.pool = candidatePool
      candidatePool = null // ownership transferred to the singleton
      this.signer = created
      candidate = null // ownership transferred to the singleton
      this.connectionState = "connected"
      this.userPublicKey = publicKey
      if (previousPool) {
        try {
          previousPool.close([])
        } catch (e: unknown) {
          console.warn("[NostrConnect] Error closing previous pool:", e)
        }
      }

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
      // The LOCAL candidate + pool are ours either way — close them so their sockets never
      // leak (round-5 review; e.g. a current-attempt ping/getPublicKey failure). Both are
      // nulled at the publish point, so a post-publish throw cannot close the live resources.
      await closeCandidate()
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
   * Get default relays.
   */
  static getDefaultRelays(): string[] {
    return [...DEFAULT_NIP46_RELAYS]
  }
}

export default NostrConnectService
export type { ConnectionResult }
