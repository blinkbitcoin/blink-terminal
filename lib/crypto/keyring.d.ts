/** Rotatable encryption for secrets at rest (blink-wip#1587). See keyring.js. */

export interface Keyring {
  /** Fingerprint of the current key (null when none is configured). */
  currentKeyId(): string | null
  /** v2 ciphertext under the current key. Throws when no key is configured. */
  encrypt(plaintext: string): string
  /** Plaintext, or null (not ours / unknown key / failed authentication). Never throws. */
  decrypt(value: unknown): string | null
  /** True for v2 or legacy ciphertext. */
  isCiphertext(value: unknown): value is string
  /** True for legacy values and v2 values under a non-current key. */
  needsReencrypt(value: unknown): boolean
}

export function createKeyring(keys?: {
  current?: string | null
  previous?: string | string[] | null
}): Keyring

/** Keyring from ENCRYPTION_KEY / ENCRYPTION_KEY_PREVIOUS, read at call time. */
export function envKeyring(): Keyring

export function keyId(passphrase: string): string

export const V2_PREFIX: "v2."
export const LEGACY_PREFIX: "U2FsdGVkX1"
