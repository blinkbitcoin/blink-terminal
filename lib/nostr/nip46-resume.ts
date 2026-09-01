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
  /** Nothing to resume — reset so the user can reopen the signer. */
  | "restart"

export interface ResumeInput {
  /** Modal connection stage at the moment the tab regained foreground. */
  stage: string
  /** Whether the NIP-46 service still reports a live signer connection. */
  connected: boolean
  /** Whether a user pubkey was already obtained from the signer. */
  hasPubkey: boolean
  /** Whether the service has a stored session to restore from. */
  hasSession: boolean
}

const IN_FLIGHT_STAGES: readonly string[] = ["waiting", "connected", "signing"]

/**
 * Decide how to resume an in-flight NIP-46 flow on foreground return.
 *
 * - A flow not in flight (idle/complete/error) is left alone → `null`.
 * - Live connection + known pubkey → re-drive only the NIP-98 sign step.
 * - No live connection but a stored session → restore the signer, then continue.
 * - Neither → restart from idle.
 */
export function decideNip46Resume(input: ResumeInput): ResumeAction | null {
  if (!IN_FLIGHT_STAGES.includes(input.stage)) return null
  if (input.connected && input.hasPubkey) return "resume-signing"
  if (input.hasSession) return "restore-session"
  return "restart"
}
