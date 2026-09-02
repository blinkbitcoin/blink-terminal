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
  /**
   * True while the connection has been ESTABLISHED (the signer sent its connect-ack, so we
   * know signerPubkey + relays) but the user pubkey has not been confirmed yet — persisted
   * early in waitForConnection so a same-device deeplink backgrounding that kills the socket
   * mid-handshake (before getPublicKey resolves) is recoverable: restoreSession rebuilds via
   * fromBunker and completes getPublicKey on a fresh socket, with no pubkey-match to enforce.
   */
  pending?: boolean
  /**
   * The connection secret (unique per generateConnectionURI) of the attempt that wrote this
   * PENDING record. It binds the record to a specific attempt: a stalled fresh connect (signer
   * B) must NOT adopt a leftover pending record from a previous attempt (signer A) — since a
   * pending record skips the user-pubkey match, adopting a foreign one would authenticate the
   * wrong signer (PR #66 review). Only set on pending records; dropped on finalize.
   */
  secret?: string
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
  /** See NIP46Session.pending. */
  pending?: boolean
  /** See NIP46Session.secret. */
  secret?: string
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
// Both the client and the signer use the relays advertised in the nostrconnect:// URI, so
// this list is the shared rendezvous for the whole NIP-46 exchange (connect-ack AND
// sign_event responses). On-device testing (2026-09-02) showed same-device sign-in timing out
// when 2 of 3 relays were transiently down on the phone's network (damus 503, primal DNS
// failure) — the sign request reached only one relay and the signer's response never routed
// back. Extra reliable relays add rendezvous redundancy so a couple of flaky ones no longer
// break the exchange. Keep this modest — every relay is a fan-out socket the mobile browser
// must open on a backgrounding-prone tab.
const DEFAULT_NIP46_RELAYS: string[] = [
  "wss://nos.lol", // Good uptime
  "wss://relay.damus.io", // Very reliable general relay
  "wss://relay.primal.net", // Primal relay
  "wss://relay.nostr.band", // High-uptime aggregator (rendezvous redundancy)
]

// Storage keys
const NIP46_SESSION_KEY = "blinkpos_nip46_session"
const NIP46_CLIENT_KEY = "blinkpos_nip46_clientkey"
const NIP46_PENDING_KEY = "blinkpos_nip46_pending"

/**
 * Extract the per-attempt connection secret from a nostrconnect:// URI. The URI is the single
 * IMMUTABLE source of attempt identity — unlike the mutable `blinkpos_nip46_pending`
 * sessionStorage record, which a reconnect's disconnect() wipes and an overlapping attempt
 * overwrites (PR #66 review). Returns undefined if the URI has no secret.
 */
export const secretFromUri = (uri: string): string | undefined => {
  try {
    return new URL(uri).searchParams.get("secret") ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Acquire a Web Storage object, or null if it is unavailable OR inaccessible.
 *
 * A `typeof sessionStorage === "undefined"` check is NOT sufficient: evaluating the identifier
 * invokes the Window storage GETTER, which itself can throw SecurityError when storage is
 * denied (some privacy modes / partitioned third-party contexts). Because that evaluation used
 * to sit outside the callers' try blocks, a denied getter escaped the "non-throwing" cleanup
 * helpers and skipped the caller's socket teardown (PR #66 review). Acquiring the object here —
 * with both the existence check and the getter access inside one try — makes every storage
 * helper total: they get a usable Storage or null, and never see a throw.
 */
const safeStorage = (kind: "session" | "local"): Storage | null => {
  try {
    const storage = kind === "session" ? sessionStorage : localStorage
    return storage ?? null
  } catch (err: unknown) {
    console.warn(`[NostrConnect] ${kind}Storage is inaccessible:`, err)
    return null
  }
}

// Connection timeout (2 minutes)
const CONNECTION_TIMEOUT = 120000

// Post-connect stabilization delay (helps prevent first signing attempt failures)
// Some signers need a moment after connect() before they're ready for sign requests
const POST_CONNECT_DELAY = 500

// v49: Track connection attempt number to detect stale responses
let connectionAttemptCounter = 0

/**
 * Process-lifetime fallback client key, used ONLY when storage is unusable (denied getter,
 * throwing getItem, failing setItem).
 *
 * The client key IS this client's identity: generateConnectionURI embeds its pubkey in the
 * nostrconnect:// URI, and the signer addresses its response to that pubkey. If the storage
 * fallback minted a fresh random key per call, the URI would advertise key A while
 * waitForConnection's fromURI subscribed and decrypted with key B — the signer's reply would be
 * undecryptable and the handshake could never complete (PR #66 review). Caching one key for the
 * page lifetime keeps URI generation, the initial wait, reconnect, and restore on a single
 * identity even with no storage.
 */
let ephemeralClientKey: Uint8Array | null = null

// =====================================================================
// Service class
// =====================================================================
//
// ATTEMPT-OWNERSHIP CONTRACT (v65/v66) — read before adding any method that
// mutates the shared statics (signer/pool/connectionState/userPublicKey/session).
// Every writer MUST follow the protocol the three existing writers implement
// (waitForConnection, restoreSession, disconnect):
//
// "Ownership" here is specifically over the SUCCESS-PUBLICATION FIELDS — the
// signer, the connected connectionState, the userPublicKey, and (restoreSession
// only) the shared pool. These are what a caller reads to treat the connection
// as live, so only the latest attempt may write them.
//
//   1. Take a ticket: `connectionAttemptCounter++` and capture it in
//      `const thisAttempt = connectionAttemptCounter`.
//      (disconnect only increments — invalidating every pending attempt.)
//   2. Work on LOCAL candidates only (signer, and the fresh pool in
//      restoreSession). Do not assign the success-publication fields before
//      ownership is confirmed.
//      EXCEPTION — the provisional status write: both connect writers set
//      `connectionState = "connecting"` before their awaited work, unguarded.
//      That is deliberate and safe: it is cosmetic UI status, not a live
//      connection (no signer is published), and it is overwritten by whichever
//      attempt actually reaches the success point. It is NOT a
//      success-publication field.
//   3. Re-check currency (`thisAttempt === connectionAttemptCounter`)
//      IMMEDIATELY BEFORE publishing the success-publication fields — that is
//      the invariant the tests pin. Extra checks after long awaits are an
//      optimization (fail fast, close candidates sooner), not the guarantee.
//   4. If superseded: close the local candidates, return without publishing.
//   5. Publish the success-publication fields together at a single point, no
//      awaits in between, so no caller observes a signer without a matching
//      connected state:
//        - waitForConnection: signer + connectionState="connected" + pubkey
//          (it never touches this.pool; fromURI manages relays internally).
//        - restoreSession: the same three PLUS swapping in its fresh pool
//          (this.pool = candidatePool), closing the previous pool after.
//      Session persistence via storeSession() follows the publish and is NOT
//      atomic with it, but it is best-effort and fail-safe: it swallows storage
//      failures (logging them) so a throw can never propagate into the caller's
//      catch and tear down the live connection just published. On a write
//      failure it removes any previously stored session so a reload cannot
//      restore it; a stale session can remain ONLY if BOTH the write and that
//      fallback removal throw, and that worst case is warned explicitly. The
//      failure direction is otherwise "connected now, re-auth on reload".
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
    // A fresh attempt begins: supersede any still-pending earlier attempt (Kimi K3 review). A
    // prior waitForConnection awaiting its ack does NOT hold the flow open across URI
    // generation, so bumping the counter makes its late fromURI settle fail isCurrentAttempt()
    // and close itself — it can neither publish nor stamp a pending record with this URI's
    // secret and be mistaken for the new attempt.
    connectionAttemptCounter++
    // Also proactively drop any leftover PENDING record from an earlier, never-finished
    // attempt so it cannot linger. Best-effort tidiness only — correctness rests on the secret
    // binding (hasPendingSessionForCurrentAttempt + restoreSession's mismatch guard), which
    // refuses a foreign pending record even if this clear fails or never runs. A CONFIRMED
    // session is left intact (startup restore needs it).
    if (this.getStoredSession()?.pending === true) {
      this.clearSession()
    }

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
    // Capture the attempt secret from the IMMUTABLE uri up front — not from mutable ambient
    // storage after the await, which a reconnect wipes or an overlapping attempt overwrites
    // (PR #66 review). This binds the pending record to THIS uri regardless of storage churn.
    const attemptSecret: string | undefined = secretFromUri(uri)

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

      // Persist a PENDING session the instant the connection is established (the signer's
      // connect-ack gave us its pubkey + relays), BEFORE the fragile getPublicKey round-trip.
      // On same-device mobile, the deeplink backgrounds this tab right about now and Android
      // suspends the relay socket — often after the ack but before getPublicKey resolves.
      // Without this, that progress is lost and the signer won't re-ack a connection it
      // considers established, so the flow hangs. With it, the foreground-resume path rebuilds
      // via fromBunker and finishes getPublicKey on a fresh socket. The user pubkey is unknown
      // here, so it is left empty and filled in at restore/success.
      // Bind the pending record to THIS attempt's secret (parsed from the uri at entry) so a
      // later stalled attempt cannot mistake a leftover pending record from a previous signer
      // for its own (PR #66 review — stale-pending wrong-signer restore). Sourced from the uri,
      // not ambient storage, so reconnect (which wipes storage) and overlapping attempts (which
      // overwrite it) cannot corrupt the stamp.
      this.storeSession({
        publicKey: "",
        signerPubkey: created.bp.pubkey!,
        relays: created.bp.relays!,
        pending: true,
        secret: attemptSecret,
      })

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
   * Called on app startup (no opts → confirmed session) and by the foreground-resume path,
   * which passes `expectedSecret` (the secret of the uri it is driving) so a PENDING record is
   * only adopted by the attempt that created it, and `expectedPublicKey` (the user pubkey the
   * live flow already established) so a STALE confirmed record cannot replace it.
   */
  static async restoreSession(opts?: {
    expectedSecret?: string
    expectedPublicKey?: string
  }): Promise<ConnectionResult> {
    const session: NIP46Session | null = this.getStoredSession()
    if (!session) {
      console.log("[NostrConnect] No stored session to restore")
      return { success: false, error: "No session found" }
    }

    // Defense-in-depth (PR #66 review): a PENDING record skips the user-pubkey match, so it
    // must only be restored by the attempt that created it. If its bound secret does not match
    // the caller's expected secret (the current uri's secret), it belongs to a PREVIOUS signer
    // — refuse and clear it, so a decision-path bypass cannot authenticate the wrong signer.
    // Restoration is gated on the MATCH (not on a successful removal), so a failed clear still
    // cannot authorize adoption. A confirmed session (no `pending`) is unaffected — startup
    // restore has no current attempt and passes no expectedSecret.
    if (session.pending) {
      const expectedSecret = opts?.expectedSecret
      if (!expectedSecret || session.secret !== expectedSecret) {
        console.warn(
          "[NostrConnect] Pending session belongs to a different attempt — refusing restore",
        )
        this.clearSession()
        return { success: false, error: "Session invalid" }
      }
    } else if (opts?.expectedPublicKey && session.publicKey !== opts.expectedPublicKey) {
      // A CONFIRMED record for a DIFFERENT user than the flow that is asking to be restored.
      // This is reachable when storeSession's write AND its fallback removal both failed, so a
      // previous user A's record survived while user B went live: a bfcache-triggered restore
      // would otherwise rebuild A, pass its own publicKey match, and authenticate the WRONG
      // USER (PR #66 review). Refuse before building any signer, and clear the provably stale
      // record so a later startup restore (which has no expectation to check against) cannot
      // silently log in as A.
      console.warn(
        "[NostrConnect] Stored session belongs to a different user — refusing restore",
      )
      this.clearSession()
      return { success: false, error: "Session invalid" }
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

      // A PENDING session never confirmed a user pubkey (the original handshake was cut off
      // before getPublicKey resolved), so there is nothing to match against — whatever this
      // fresh restore's getPublicKey returns IS the user pubkey. For a confirmed session,
      // enforce the match so a swapped signer can't hijack the session.
      if (!session.pending && publicKey !== session.publicKey) {
        console.warn("[NostrConnect] Public key mismatch, clearing session")
        // clearSession is now non-throwing, so the state cleanup and candidate teardown below
        // always run — a storage failure can no longer escape here and leak the candidate.
        this.clearSession()
        this.connectionState = "disconnected"
        this.signer = null
        this.userPublicKey = null // consistent invalid-state (PR #66 review)
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

      // Finalize the session: stamp the now-confirmed user pubkey, drop the pending flag AND
      // its attempt-bound secret (a fully-established session is no longer attempt-scoped),
      // refreshing the timestamp.
      this.storeSession({
        ...session,
        publicKey,
        connectedAt: Date.now(),
        pending: false,
        secret: undefined,
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
  /**
   * Read the stored client key, tolerating a throwing getItem (denied storage). `onThrow` lets
   * the caller distinguish "no key stored" (null) from "storage is unusable" (threw), which
   * must fall back to the stable ephemeral key rather than minting a fresh one.
   */
  private static readClientKey(storage: Storage, onThrow?: () => void): string | null {
    try {
      return storage.getItem(NIP46_CLIENT_KEY)
    } catch (err: unknown) {
      console.warn("[NostrConnect] getOrCreateClientKey: Failed to read stored key:", err)
      onThrow?.()
      return null
    }
  }

  private static getOrCreateClientKey(): Uint8Array {
    // Server-side, or storage denied (the getter itself can throw): fall back to the
    // process-lifetime key. The connect flow must not fail just because the key cannot be
    // persisted — it simply will not be reused across reloads (PR #66 review).
    const storage = safeStorage("local")
    if (!storage) return this.getEphemeralClientKey("no usable storage")

    // Try to retrieve existing key. readClientKey returns null if getItem THREW (denied
    // storage) as well as if no key is stored — a throw means we cannot trust this storage, so
    // fall back to the stable in-memory key rather than minting a fresh one per call.
    let readFailed = false
    const stored: string | null = this.readClientKey(storage, () => {
      readFailed = true
    })
    if (readFailed) return this.getEphemeralClientKey("stored key unreadable")

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

    // Generate new key and persist it. If the write fails we cannot rely on storage to hand
    // the SAME key back on the next call (URI generation and the waiter each call this), so
    // the key must come from the process-lifetime cache instead (PR #66 review).
    console.log("[NostrConnect] getOrCreateClientKey: Generating new key")
    const newKey: Uint8Array = generateSecretKey()
    const newKeyHex: string = bytesToHex(newKey)
    try {
      storage.setItem(NIP46_CLIENT_KEY, newKeyHex)
    } catch (err: unknown) {
      console.warn("[NostrConnect] getOrCreateClientKey: Failed to persist key:", err)
      return this.getEphemeralClientKey("key not persistable")
    }

    // Verify it was stored correctly
    const verifyStored: string | null = this.readClientKey(storage)
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
   * The process-lifetime fallback key, minted once. Every storage-failure path routes here so
   * URI generation, the initial wait, reconnect, and restore all use ONE identity — otherwise
   * the URI would advertise one pubkey while the waiter decrypted with another.
   */
  private static getEphemeralClientKey(reason: string): Uint8Array {
    if (ephemeralClientKey) return ephemeralClientKey
    const key: Uint8Array = generateSecretKey()
    ephemeralClientKey = key
    console.warn(
      `[NostrConnect] getOrCreateClientKey: ${reason} — using a process-lifetime ` +
        "ephemeral key (not persisted across reloads)",
    )
    return key
  }

  /**
   * Store pending connection parameters.
   */
  private static storeConnectionParams(
    params: Omit<PendingConnectionParams, "timestamp">,
  ): void {
    const storage = safeStorage("session")
    if (!storage) return
    try {
      storage.setItem(
        NIP46_PENDING_KEY,
        JSON.stringify({
          ...params,
          timestamp: Date.now(),
        }),
      )
    } catch (err: unknown) {
      // Best-effort, like every storage path here: the connect flow must proceed even if the
      // params cannot be cached (the uri carries the attempt identity regardless).
      console.warn("[NostrConnect] Failed to store pending connection params:", err)
    }
  }

  /**
   * Get pending connection parameters.
   */
  static getPendingConnection(): PendingConnectionParams | null {
    const storage = safeStorage("session")
    if (!storage) return null
    try {
      const stored: string | null = storage.getItem(NIP46_PENDING_KEY)
      return stored ? (JSON.parse(stored) as PendingConnectionParams) : null
    } catch {
      return null
    }
  }

  /**
   * Clear pending connection.
   */
  static clearPendingConnection(): void {
    // Best-effort and NON-THROWING: both the storage GETTER and removeItem can throw
    // (SecurityError in some privacy modes). A failure to clear must never propagate — callers
    // invoke this on cleanup/failure paths where a throw would skip subsequent socket teardown
    // (PR #66 review).
    const storage = safeStorage("session")
    if (!storage) return
    try {
      storage.removeItem(NIP46_PENDING_KEY)
    } catch (err: unknown) {
      console.warn("[NostrConnect] Failed to clear pending connection:", err)
    }
  }

  /**
   * Store session data for persistence.
   */
  private static storeSession(sessionData: StoreSessionData): void {
    const storage = safeStorage("local")
    if (!storage) return
    const session: NIP46Session = {
      publicKey: sessionData.publicKey,
      signerPubkey: sessionData.signerPubkey,
      relays: sessionData.relays,
      // ?? not || so a legitimate 0 timestamp is not replaced by Date.now().
      connectedAt: sessionData.connectedAt ?? Date.now(),
      pending: sessionData.pending,
      secret: sessionData.secret,
    }

    // Persistence is best-effort: a storage failure must never throw (the caller's catch would
    // tear down the live connection just published) and must never leave a PREVIOUS session on
    // disk for a reload to restore.
    //
    // Web Storage can throw on setItem AND on removeItem (quota, but also access/security
    // failures in some privacy modes). We handle the two independently rather than under one
    // try (a throwing removeItem must not skip the write, per the PR #65 review):
    //
    //  1. Try setItem(new). Success OVERWRITES the same key — the old session is gone, done.
    //  2. If setItem fails, the old session is still on disk, so try removeItem to invalidate
    //     it (fail toward re-auth on reload, never toward a stale session).
    //  3. If removeItem ALSO fails, a stale session may genuinely remain — say so honestly.
    // The connection stays live in every branch.
    try {
      storage.setItem(NIP46_SESSION_KEY, JSON.stringify(session))
      console.log("[NostrConnect] Session stored")
      return
    } catch (writeErr: unknown) {
      try {
        storage.removeItem(NIP46_SESSION_KEY)
        console.warn(
          "[NostrConnect] Session not persisted (write failed); cleared any previous session, " +
            "connection stays live, reload will require re-auth:",
          writeErr,
        )
      } catch (clearErr: unknown) {
        console.warn(
          "[NostrConnect] Session not persisted AND could not clear a previous session; " +
            "connection stays live, but a reload MAY restore a stale session:",
          writeErr,
          clearErr,
        )
      }
    }
  }

  /**
   * Get stored session data.
   */
  private static getStoredSession(): NIP46Session | null {
    const storage = safeStorage("local")
    if (!storage) return null
    try {
      const stored: string | null = storage.getItem(NIP46_SESSION_KEY)
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
   * Whether the stored session is a PENDING record belonging to the CURRENT attempt — i.e. a
   * handshake that reached the signer's connect-ack (signerPubkey + relays known) but was cut
   * off before getPublicKey, AND whose bound secret matches the secret of `currentUri` (the
   * URI of the attempt now in progress).
   *
   * The current secret comes from the IMMUTABLE uri, not mutable sessionStorage: a reconnect
   * wipes that storage and overlapping attempts overwrite it, but the uri the modal is driving
   * is stable (PR #66 review). The secret binding is what makes this attempt-owned rather than
   * merely "some pending record exists": a leftover pending record from a PREVIOUS signer A
   * carries A's secret, so when signer B's fresh attempt stalls before its own ack this
   * returns false and the resume decision reconnects B instead of restoring (and
   * authenticating) A.
   */
  static hasPendingSessionForCurrentAttempt(currentUri: string): boolean {
    const session = this.getStoredSession()
    if (session?.pending !== true) return false
    const currentSecret = secretFromUri(currentUri)
    return Boolean(currentSecret) && session.secret === currentSecret
  }

  /**
   * Clear stored session data.
   */
  private static clearSession(): void {
    // Best-effort and NON-THROWING: clearSession runs on failure/cleanup paths (the
    // restoreSession pubkey-mismatch branch and its catch) where a storage throw would escape
    // the function and skip the candidate socket teardown that follows (PR #66 review). Both
    // the storage GETTER and removeItem can throw (SecurityError in some privacy modes), so
    // acquisition goes through safeStorage and the removal is guarded.
    let cleared = true
    const storage = safeStorage("local")
    if (storage) {
      try {
        storage.removeItem(NIP46_SESSION_KEY)
      } catch (err: unknown) {
        cleared = false
        console.warn("[NostrConnect] Failed to clear stored session:", err)
      }
    } else {
      cleared = false
    }
    this.clearPendingConnection()
    // Only claim success when the removal actually happened — logging "cleared" after a caught
    // failure would mislead operational diagnosis (PR #66 review).
    if (cleared) console.log("[NostrConnect] Session cleared")
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
