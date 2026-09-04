/**
 * Failure modes of session creation, kept in their own module so API routes (and
 * their tests) can branch on them without importing the relay transport — and
 * with it nostr-tools' ESM entry point.
 */

/** Concurrent-session caps (per IP or global) are exhausted. */
export class Nip46CapacityError extends Error {}

/** No relay became ready, so there is nobody to receive the signer's ack. */
export class Nip46RelayUnavailableError extends Error {}

/**
 * The session store is configured to use Redis but a command failed.
 *
 * Surfaced rather than swallowed: writing the session to the per-process Map
 * instead would split one session across two backends, so a later read against
 * a healthy Redis would report it as expired while its relay worker was still
 * running. Routes turn this into a retryable 503.
 */
export class Nip46StorageError extends Error {}
