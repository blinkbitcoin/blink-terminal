/** Rotatable encryption for secrets at rest (blink-wip#1587). See keyring.js. */

export type InspectStatus = "current" | "stale" | "undecryptable" | "not-ciphertext"

export interface Keyring {
  /** Fingerprint of the current key (null when none is configured). */
  currentKeyId(): string | null
  /** v2 ciphertext under the current key. Throws when no key is configured. */
  encrypt(plaintext: string): string
  /** Plaintext, or null (not ours / unknown key / failed authentication). Never throws. */
  decrypt(value: unknown): string | null
  /**
   * Authenticated classification: "current" only when the current key has
   * authenticated the value; "stale" = readable legacy or previous-key value;
   * "undecryptable" = recognized format that no configured key authenticates.
   */
  inspect(value: unknown): { status: InspectStatus; plaintext?: string }
  /** True for v2 or legacy ciphertext. */
  isCiphertext(value: unknown): value is string
  /** True for readable legacy values and v2 values authenticated by a previous key. */
  needsReencrypt(value: unknown): boolean
}

/** Throws when two distinct configured keys share a key id. */
export function createKeyring(keys?: {
  current?: string | null
  previous?: string | string[] | null
  /** Test-only: override the key-id function to simulate collisions. */
  _keyId?: (passphrase: string) => string
}): Keyring

/** Keyring from ENCRYPTION_KEY / ENCRYPTION_KEY_PREVIOUS, read at call time. */
export function envKeyring(): Keyring

export function keyId(passphrase: string): string

export const V2_PREFIX: "v2."
export const LEGACY_PREFIX: "U2FsdGVkX1"
