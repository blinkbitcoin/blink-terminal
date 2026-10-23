/* eslint-disable @typescript-eslint/no-require-imports --
   Plain CommonJS on purpose: the app (via lib/auth.ts), jest and the
   operator scripts (scripts/reencrypt-secrets.js, reconcile-voucher-claims.js)
   all load this one implementation. Types: keyring.d.ts. */

/**
 * Rotatable encryption for secrets at rest (blink-wip#1587).
 *
 * Format v2:  v2.<kid>.<base64(iv | tag | ciphertext)>
 *   AES-256-GCM (authenticated), key = HKDF-SHA256(passphrase). `kid` is a
 *   64-bit fingerprint of the passphrase, so decryption selects the key that
 *   wrote the value instead of trying keys. The kid is never trusted on its
 *   own: inspect() reports a value as current only after the current key
 *   has authenticated it.
 *
 * Legacy:     CryptoJS.AES.encrypt(plaintext, passphrase) — base64 of
 *   "Salted__" | salt | AES-256-CBC ciphertext, i.e. starting "U2FsdGVkX1",
 *   key/IV from OpenSSL EVP_BytesToKey (MD5). Unauthenticated. Decrypted here
 *   with node:crypto, which (unlike CryptoJS) validates PKCS#7 padding, and a
 *   fatal UTF-8 decoder, so a wrong key yields null rather than garbage in
 *   all but negligible cases. Still never tried against several keys: every
 *   legacy value predates this module and was written by the key in use
 *   before the first rotation — the oldest configured key.
 *
 * Keys:  ENCRYPTION_KEY (current: all writes) and ENCRYPTION_KEY_PREVIOUS
 *   (comma-separated, newest first: read-only during a rotation). Read at call
 *   time, not at module load.
 *
 * Write format (ENCRYPTION_WRITE_FORMAT), a reader-first rollout:
 *   legacy (default)  read both formats, WRITE legacy — the format every
 *                     earlier release reads, so rolling the image back stays
 *                     safe. Byte-compatible with CryptoJS.AES.encrypt.
 *   v2                write v2. Enable only once a release with this module
 *                     is fully deployed; from then on that release is the
 *                     minimum rollback version.
 * Legacy writes during a rotation (ENCRYPTION_KEY_PREVIOUS set) are refused:
 * a legacy value written under the new key would be read with the oldest key.
 * Misconfiguration refuses writes only; reads keep working.
 *
 * Rotation runbook: docs/encryption-key-rotation.md.
 */

const nodeCrypto = require("crypto")

const V2_PREFIX = "v2."
const LEGACY_PREFIX = "U2FsdGVkX1" // base64("Salted__")
const IV_LENGTH = 12
const TAG_LENGTH = 16
// 64-bit key id: a fingerprint, not a secret. Collisions between configured
// keys are rejected outright and every read is authenticated, so the id only
// routes a value to its key; it never decides that a value is valid.
const KID_LENGTH = 16

/** @param {string} passphrase */
function keyId(passphrase) {
  return nodeCrypto
    .createHash("sha256")
    .update(`blink-terminal/keyring/kid:${passphrase}`)
    .digest("hex")
    .substring(0, KID_LENGTH)
}

/** @type {Map<string, Buffer>} */
const derived = new Map()

/** @param {string} passphrase */
function aesKey(passphrase) {
  let key = derived.get(passphrase)
  if (!key) {
    key = Buffer.from(
      nodeCrypto.hkdfSync(
        "sha256",
        passphrase,
        "blink-terminal/keyring/v2",
        "aes-256-gcm",
        32,
      ),
    )
    derived.set(passphrase, key)
  }
  return key
}

/**
 * OpenSSL EVP_BytesToKey with MD5, one iteration — CryptoJS's passphrase KDF.
 * @param {Buffer} passphrase @param {Buffer} salt
 */
function evpBytesToKey(passphrase, salt) {
  const out = []
  let block = Buffer.alloc(0)
  let length = 0
  while (length < 48) {
    block = nodeCrypto
      .createHash("md5")
      .update(Buffer.concat([block, passphrase, salt]))
      .digest()
    out.push(block)
    length += block.length
  }
  const material = Buffer.concat(out)
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) }
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true })

/**
 * Decrypt a legacy CryptoJS value. Throws on bad padding or invalid UTF-8.
 * @param {string} value @param {string} passphrase
 */
function decryptLegacy(value, passphrase) {
  const raw = Buffer.from(value, "base64")
  if (raw.length < 32 || raw.subarray(0, 8).toString("latin1") !== "Salted__") {
    throw new Error("not a legacy ciphertext")
  }
  const { key, iv } = evpBytesToKey(Buffer.from(passphrase, "utf8"), raw.subarray(8, 16))
  const decipher = nodeCrypto.createDecipheriv("aes-256-cbc", key, iv) // validates padding
  const plain = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()])
  return strictUtf8.decode(plain)
}

/**
 * Legacy (CryptoJS-compatible) encryption: "Salted__" | salt | AES-256-CBC,
 * key/IV from EVP_BytesToKey(MD5). Only for the reader-first rollout phase.
 * @param {string} plaintext @param {string} passphrase
 */
function encryptLegacy(plaintext, passphrase) {
  const salt = nodeCrypto.randomBytes(8)
  const { key, iv } = evpBytesToKey(Buffer.from(passphrase, "utf8"), salt)
  const cipher = nodeCrypto.createCipheriv("aes-256-cbc", key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ])
  return Buffer.concat([Buffer.from("Salted__", "latin1"), salt, ciphertext]).toString(
    "base64",
  )
}

const WRITE_FORMATS = new Set(["legacy", "v2"])

/**
 * @param {{
 *   current?: string | null,
 *   previous?: string | string[] | null,
 *   writeFormat?: string | null,
 *   _keyId?: (passphrase: string) => string,
 * }} keys  `_keyId` is a test-only seam to simulate key-id collisions.
 */
function createKeyring({ current, previous, writeFormat, _keyId } = {}) {
  const kidOf = _keyId || keyId
  const format =
    writeFormat == null || writeFormat === "" ? "legacy" : String(writeFormat)
  const previousKeys = (
    Array.isArray(previous) ? previous : String(previous || "").split(",")
  )
    .map((k) => k.trim())
    .filter(Boolean)

  /** Every configured key, current first, each passphrase once. */
  const keys = [...new Set(current ? [current, ...previousKeys] : previousKeys)]
  // Two different passphrases with the same id would make the id ambiguous:
  // refuse the configuration rather than guess (and never let --check pass
  // on a value only the other key can read).
  const byKid = new Map()
  for (const key of keys) {
    const kid = kidOf(key)
    if (byKid.has(kid)) {
      throw new Error(
        `Configured encryption keys share key id ${kid}: use a different ENCRYPTION_KEY`,
      )
    }
    byKid.set(kid, key)
  }
  /** The key that wrote every legacy value (see header). */
  const oldest = keys.length ? keys[keys.length - 1] : null
  const rotating = keys.some((k) => k !== current)

  /** Why writes are refused, or null. Reads are never affected. */
  const writeError = !WRITE_FORMATS.has(format)
    ? `ENCRYPTION_WRITE_FORMAT must be "legacy" or "v2", got "${format}"`
    : format === "legacy" && rotating
      ? "ENCRYPTION_KEY_PREVIOUS requires ENCRYPTION_WRITE_FORMAT=v2 (a legacy value written under the new key would be read with the old one)"
      : null

  /**
   * Authenticated classification of a stored value.
   * @param {unknown} value
   * @returns {{ status: "current" | "stale" | "undecryptable" | "not-ciphertext", plaintext?: string }}
   */
  function inspect(value) {
    if (typeof value !== "string") return { status: "not-ciphertext" }
    try {
      if (value.startsWith(V2_PREFIX)) {
        const [, kid, payloadB64] = value.split(".")
        const key = kid ? byKid.get(kid) : undefined
        if (!key || !payloadB64) return { status: "undecryptable" }
        const payload = Buffer.from(payloadB64, "base64")
        if (payload.length < IV_LENGTH + TAG_LENGTH) return { status: "undecryptable" }
        const decipher = nodeCrypto.createDecipheriv(
          "aes-256-gcm",
          aesKey(key),
          payload.subarray(0, IV_LENGTH),
        )
        decipher.setAuthTag(payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH))
        const plaintext = Buffer.concat([
          decipher.update(payload.subarray(IV_LENGTH + TAG_LENGTH)),
          decipher.final(),
        ]).toString("utf8")
        return { status: key === current ? "current" : "stale", plaintext }
      }
      if (value.startsWith(LEGACY_PREFIX)) {
        if (!oldest) return { status: "undecryptable" }
        const plaintext = decryptLegacy(value, oldest)
        // A legacy value always needs rewriting to v2, even under the current key.
        return plaintext ? { status: "stale", plaintext } : { status: "undecryptable" }
      }
      return { status: "not-ciphertext" }
    } catch (_err) {
      return { status: "undecryptable" }
    }
  }

  return {
    /** Fingerprint of the current key (null when none is configured). */
    currentKeyId() {
      return current ? kidOf(current) : null
    },

    /** "legacy" or "v2" (null when ENCRYPTION_WRITE_FORMAT is invalid). */
    writeFormat() {
      return WRITE_FORMATS.has(format) ? format : null
    },

    /** @param {string} plaintext */
    encrypt(plaintext) {
      if (!current) throw new Error("ENCRYPTION_KEY environment variable is required")
      if (writeError) throw new Error(writeError)
      if (format === "legacy") return encryptLegacy(plaintext, current)
      const iv = nodeCrypto.randomBytes(IV_LENGTH)
      const cipher = nodeCrypto.createCipheriv("aes-256-gcm", aesKey(current), iv)
      const ciphertext = Buffer.concat([
        cipher.update(String(plaintext), "utf8"),
        cipher.final(),
      ])
      const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
      return `${V2_PREFIX}${kidOf(current)}.${payload.toString("base64")}`
    },

    inspect,

    /**
     * Plaintext, or null when the value is not ours, the key is unknown, or
     * authentication fails. Never throws.
     * @param {unknown} value
     */
    decrypt(value) {
      return inspect(value).plaintext ?? null
    },

    /** True for any value this keyring writes or reads (v2 or legacy). */
    isCiphertext(value) {
      return (
        typeof value === "string" &&
        (value.startsWith(V2_PREFIX) || value.startsWith(LEGACY_PREFIX))
      )
    },

    /**
     * True when the value is readable and should be rewritten under the
     * current key (legacy, or authenticated by a previous key). An
     * undecryptable value is not "needs re-encrypt" — it cannot be.
     */
    needsReencrypt(value) {
      return inspect(value).status === "stale"
    },
  }
}

/** The keyring configured by the environment, read at call time. */
function envKeyring() {
  return createKeyring({
    current: process.env.ENCRYPTION_KEY,
    previous: process.env.ENCRYPTION_KEY_PREVIOUS,
    writeFormat: process.env.ENCRYPTION_WRITE_FORMAT,
  })
}

module.exports = {
  createKeyring,
  envKeyring,
  keyId,
  V2_PREFIX,
  LEGACY_PREFIX,
}
