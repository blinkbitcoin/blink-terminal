/* eslint-disable @typescript-eslint/no-require-imports --
   Plain CommonJS on purpose: the app (via lib/auth.ts), jest and the
   operator scripts (scripts/reencrypt-secrets.js, reconcile-voucher-claims.js)
   all load this one implementation. Types: keyring.d.ts. */

/**
 * Rotatable encryption for secrets at rest (blink-wip#1587).
 *
 * Format v2:  v2.<kid>.<base64(iv | tag | ciphertext)>
 *   AES-256-GCM (authenticated), key = HKDF-SHA256(passphrase). `kid` is a
 *   short fingerprint of the passphrase, so decryption selects the key that
 *   wrote the value instead of trying keys.
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
 * Rotation runbook: docs/encryption-key-rotation.md.
 */

const nodeCrypto = require("crypto")

const V2_PREFIX = "v2."
const LEGACY_PREFIX = "U2FsdGVkX1" // base64("Salted__")
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KID_LENGTH = 8

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
 * @param {{ current?: string | null, previous?: string | string[] | null }} keys
 */
function createKeyring({ current, previous } = {}) {
  const previousKeys = (
    Array.isArray(previous) ? previous : String(previous || "").split(",")
  )
    .map((k) => k.trim())
    .filter(Boolean)

  /** Every configured key, current first. */
  const all = () => (current ? [current, ...previousKeys] : [...previousKeys])
  /** The key that wrote every legacy value (see header). */
  const oldest = () => {
    const keys = all()
    return keys.length ? keys[keys.length - 1] : null
  }

  return {
    /** Fingerprint of the current key (null when none is configured). */
    currentKeyId() {
      return current ? keyId(current) : null
    },

    /** @param {string} plaintext */
    encrypt(plaintext) {
      if (!current) throw new Error("ENCRYPTION_KEY environment variable is required")
      const iv = nodeCrypto.randomBytes(IV_LENGTH)
      const cipher = nodeCrypto.createCipheriv("aes-256-gcm", aesKey(current), iv)
      const ciphertext = Buffer.concat([
        cipher.update(String(plaintext), "utf8"),
        cipher.final(),
      ])
      const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
      return `${V2_PREFIX}${keyId(current)}.${payload.toString("base64")}`
    },

    /**
     * Plaintext, or null when the value is not ours, the key is unknown, or
     * authentication fails. Never throws.
     * @param {unknown} value
     */
    decrypt(value) {
      if (typeof value !== "string" || value === "") return null
      try {
        if (value.startsWith(V2_PREFIX)) {
          const [, kid, payloadB64] = value.split(".")
          if (!kid || !payloadB64) return null
          const key = all().find((k) => keyId(k) === kid)
          if (!key) return null
          const payload = Buffer.from(payloadB64, "base64")
          if (payload.length < IV_LENGTH + TAG_LENGTH) return null
          const decipher = nodeCrypto.createDecipheriv(
            "aes-256-gcm",
            aesKey(key),
            payload.subarray(0, IV_LENGTH),
          )
          decipher.setAuthTag(payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH))
          return Buffer.concat([
            decipher.update(payload.subarray(IV_LENGTH + TAG_LENGTH)),
            decipher.final(),
          ]).toString("utf8")
        }
        if (value.startsWith(LEGACY_PREFIX)) {
          const key = oldest()
          if (!key) return null
          return decryptLegacy(value, key) || null
        }
        return null
      } catch (_err) {
        return null
      }
    },

    /** True for any value this keyring writes or reads (v2 or legacy). */
    isCiphertext(value) {
      return (
        typeof value === "string" &&
        (value.startsWith(V2_PREFIX) || value.startsWith(LEGACY_PREFIX))
      )
    },

    /** True when the value should be rewritten under the current key. */
    needsReencrypt(value) {
      if (typeof value !== "string") return false
      if (value.startsWith(LEGACY_PREFIX)) return true
      if (value.startsWith(V2_PREFIX)) return value.split(".")[1] !== this.currentKeyId()
      return false
    },
  }
}

/** The keyring configured by the environment, read at call time. */
function envKeyring() {
  return createKeyring({
    current: process.env.ENCRYPTION_KEY,
    previous: process.env.ENCRYPTION_KEY_PREVIOUS,
  })
}

module.exports = {
  createKeyring,
  envKeyring,
  keyId,
  V2_PREFIX,
  LEGACY_PREFIX,
}
