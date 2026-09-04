/**
 * Failure modes of session creation, kept in their own module so API routes (and
 * their tests) can branch on them without importing the relay transport — and
 * with it nostr-tools' ESM entry point.
 */

/** Concurrent-session caps (per IP or global) are exhausted. */
export class Nip46CapacityError extends Error {}

/** No relay became ready, so there is nobody to receive the signer's ack. */
export class Nip46RelayUnavailableError extends Error {}
