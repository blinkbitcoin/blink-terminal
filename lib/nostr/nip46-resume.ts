/**
 * NIP-46 foreground-resume decision (same-device mobile sign-in fix).
 *
 * When the browser tab is backgrounded by a nostrconnect:// deep link into a signer app,
 * the NIP-46 client loop (BunkerSigner: connect-ack → get_public_key → sign_event) stalls
 * mid-flight. On returning to the foreground the modal must decide how to resume. This is
 * the pure decision, separated from the component so it is unit-testable without mounting
 * the modal or a relay.
 */

/** Where the connection flow was when the tab was backgrounded. */
export type InFlightStage = "waiting" | "connected" | "signing"

export type ResumeAction =
  /** The signer socket survived backgrounding and we hold the user pubkey: re-run only the
   *  NIP-98 sign step (the challenge that never got driven). */
  | "resume-signing"
  /** The socket died; rebuild the signer from the stored session and continue. */
  | "restore-session"
  /** A fresh connect was still pending (never acked) when the tab was backgrounded by the
   *  deeplink. Its relay subscription was suspended, so the signer's connect-ack (an
   *  ephemeral kind:24133 event) was published to a dead socket and lost, and the pending
   *  fromURI will now hang until its maxWait. Abort it and start a fresh connect so a live
   *  subscription can catch the signer's re-published ack. */
  | "reconnect"
  /** Nothing to resume — reset so the user can reopen the signer. */
  | "restart"

export interface ResumeInput {
  /** Modal connection stage at the moment the tab regained foreground. */
  stage: string
  /**
   * Whether a fresh waitForConnection() attempt is currently pending (its BunkerSigner
   * fromURI promise has not settled). A pending attempt OWNS the flow — it will resolve and
   * drive the connection itself — so the resume must not touch the service UNLESS it stalled
   * across a backgrounding (see connectStalled).
   */
  connectInFlight: boolean
  /**
   * Whether the pending connect was interrupted by a backgrounding — i.e. the tab went
   * hidden (the deeplink launched the signer) while still at the "waiting" stage, before any
   * ack. When true, the pending fromURI subscription is presumed dead (its socket was
   * suspended and the ephemeral connect-ack was lost), so leaving it alone would just hang
   * until maxWait. This distinguishes "still legitimately waiting in the foreground" from
   * "stuck because we were backgrounded".
   */
  connectStalled: boolean
  /** Whether the NIP-46 service still reports a live signer connection. */
  connected: boolean
  /** Whether a user pubkey was already obtained from the signer. */
  hasPubkey: boolean
  /** Whether the service has a stored session to restore from. */
  hasSession: boolean
}

const IN_FLIGHT_STAGES: readonly string[] = ["waiting", "connected", "signing"]
/** Stages where a connection was ESTABLISHED (the signer acked); only these may restore a
 *  dropped session. "waiting" means a fresh attempt is pending — restoring there would
 *  resurrect a PREVIOUS signer's session mid-attempt (the round-2 review race). */
const ESTABLISHED_STAGES: readonly string[] = ["connected", "signing"]

/**
 * Decide how to resume an in-flight NIP-46 flow on foreground return.
 *
 * - A fresh connect pending AND stalled by the backgrounding → reconnect (abort + restart).
 * - A fresh connect pending but NOT stalled (still waiting in the foreground) → leave it
 *   alone: `null`.
 * - A flow not in flight (idle/complete/error) → `null`.
 * - Established session, still live + pubkey known → re-drive only the NIP-98 sign step.
 * - Established session dropped, stored session exists → restore the signer, then continue.
 * - Everything else (including a stalled "waiting" attempt that died without settling) →
 *   restart from idle.
 */
export function decideNip46Resume(input: ResumeInput): ResumeAction | null {
  if (!IN_FLIGHT_STAGES.includes(input.stage)) return null
  if (input.connectInFlight) {
    // A pending connect that was NOT interrupted is still legitimately waiting — leave it.
    if (!input.connectStalled) return null
    // It stalled across the backgrounding. If the handshake got far enough to establish the
    // connection, a (pending) session was persisted: restore rebuilds via fromBunker and
    // finishes getPublicKey on a fresh socket — the signer will not re-ack a connection it
    // considers established, so restoring is the ONLY way forward. Only when nothing was
    // established (no session) do we reconnect from scratch for a fresh ack.
    return input.hasSession ? "restore-session" : "reconnect"
  }
  if (input.connected && input.hasPubkey) return "resume-signing"
  if (ESTABLISHED_STAGES.includes(input.stage) && input.hasSession)
    return "restore-session"
  return "restart"
}
