/**
 * Server-held NIP-46 sign-in sessions.
 *
 * See transport.ts for the ordering invariant that makes this work, and
 * sessionManager.ts for the live/persisted split.
 */

export {
  Nip46CapacityError,
  Nip46RelayUnavailableError,
  Nip46StorageError,
} from "./errors"
export { getNip46Relays, DEFAULT_NIP46_RELAYS } from "./relays"
export {
  getBindingSecret,
  getClientIp,
  getRequestOrigin,
  getSessionId,
  isBoundCaller,
} from "./request"
export {
  Nip46Transport,
  Nip46TransportError,
  NOSTR_CONNECT_KIND,
  type PoolLike,
  type RelayLike,
  type RelaySubscriptionLike,
} from "./transport"
export {
  consumeSession,
  createSession,
  deleteSession,
  generateBindingSecret,
  generateSessionChallenge,
  generateSessionId,
  getSession,
  markApproved,
  markFailed,
  sha256Hex,
  SESSION_TTL_SECONDS,
  type ConsumeResult,
  type Nip46FailureReason,
  type Nip46SessionRecord,
  type Nip46SessionStatus,
} from "./sessionStore"
export {
  buildConsumeUrl,
  buildNostrConnectUri,
  getNip46SessionManager,
  Nip46SessionManager,
  RELAY_READY_TIMEOUT_MS,
  type CreatedSession,
  type CreateSessionOptions,
  type SessionStatus,
} from "./sessionManager"
