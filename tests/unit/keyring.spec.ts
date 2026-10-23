/** @jest-environment node */

/**
 * blink-wip#1587: rotatable encryption for secrets at rest.
 */

import CryptoJS from "crypto-js"

import { createKeyring, envKeyring, keyId } from "../../lib/crypto/keyring"

const K0 = "key-zero-very-old-0123456789abcdef"
const K1 = "key-one-original-0123456789abcdef"
const K2 = "key-two-rotated-0123456789abcdef"
const SECRET = "blink_live_0123456789abcdefABCDEF"
const legacy = (plaintext: string, key: string) =>
  CryptoJS.AES.encrypt(plaintext, key).toString()

describe("v2 format", () => {
  it("round-trips and tags the ciphertext with the current key id", () => {
    const ring = createKeyring({ current: K1 })
    const ct = ring.encrypt(SECRET)
    expect(ct.split(".")).toHaveLength(3)
    expect(ct.split(".")[1]).toBe(keyId(K1))
    expect(ring.currentKeyId()).toBe(keyId(K1))
    expect(ring.decrypt(ct)).toBe(SECRET)
    expect(ring.encrypt(SECRET)).not.toBe(ct) // random IV
  })

  it("after rotation, the previous key still decrypts its own values (selected by key id)", () => {
    const old = createKeyring({ current: K1 }).encrypt(SECRET)
    const rotated = createKeyring({ current: K2, previous: K1 })
    expect(rotated.decrypt(old)).toBe(SECRET)
    expect(rotated.encrypt(SECRET).split(".")[1]).toBe(keyId(K2)) // writes use the new key
  })

  it("once the previous key is removed, its values no longer decrypt", () => {
    const old = createKeyring({ current: K1 }).encrypt(SECRET)
    expect(createKeyring({ current: K2 }).decrypt(old)).toBeNull()
  })

  it("a tampered ciphertext fails authentication (null, never garbage)", () => {
    const ring = createKeyring({ current: K1 })
    const [v, kid, payload] = ring.encrypt(SECRET).split(".")
    const bytes = Buffer.from(payload, "base64")
    bytes[bytes.length - 1] ^= 0x01
    expect(ring.decrypt(`${v}.${kid}.${bytes.toString("base64")}`)).toBeNull()
    // A forged key id pointing at another configured key fails too
    const both = createKeyring({ current: K2, previous: K1 })
    expect(both.decrypt(`${v}.${keyId(K2)}.${payload}`)).toBeNull()
  })

  it("parses a comma-separated previous list (newest first)", () => {
    const fromK0 = createKeyring({ current: K0 }).encrypt(SECRET)
    const ring = createKeyring({ current: K2, previous: ` ${K1} , ${K0} ,` })
    expect(ring.decrypt(fromK0)).toBe(SECRET)
  })
})

describe("legacy CryptoJS values", () => {
  it("decrypt with the current key when no rotation is configured", () => {
    expect(createKeyring({ current: K1 }).decrypt(legacy(SECRET, K1))).toBe(SECRET)
  })

  it("byte-compatible with CryptoJS for arbitrary plaintexts (unicode, long, short)", () => {
    const ring = createKeyring({ current: K1 })
    const samples = [
      "x",
      "nostr+walletconnect://abc?secret=ü€😀",
      "a".repeat(1000),
      SECRET,
    ]
    for (let i = 0; i < 200; i++)
      samples.push(
        Math.random()
          .toString(36)
          .repeat(1 + (i % 7)),
      )
    for (const plaintext of samples)
      expect(ring.decrypt(legacy(plaintext, K1))).toBe(plaintext)
  })

  it("a wrong key yields null, not garbage (padding + UTF-8 validated)", () => {
    // CryptoJS itself skips padding validation and returns garbage for about
    // 0.6% of wrong-key decryptions (measured over 20k); the keyring must not.
    const ring = createKeyring({ current: K2 }) // legacy values decrypt with K2 here
    for (let i = 0; i < 2000; i++) {
      expect(
        ring.decrypt(legacy(`blink_${i}_${Math.random().toString(36)}`, K1)),
      ).toBeNull()
    }
  })

  it("decrypt with the OLDEST configured key, never by trial", () => {
    // Legacy values predate the keyring: written by the key in use before the
    // first rotation, which becomes PREVIOUS.
    const ring = createKeyring({ current: K2, previous: K1 })
    expect(ring.decrypt(legacy(SECRET, K1))).toBe(SECRET)
    // A legacy value under the *current* key cannot exist; it is not tried
    // (CryptoJS has no integrity check, so trying keys could yield garbage).
    expect(ring.decrypt(legacy(SECRET, K2))).toBeNull()
  })
})

describe("non-ciphertext input is null, deterministically", () => {
  it.each([
    ["plaintext API key", "blink_plaintext_key"],
    ["empty", ""],
    ["junk v2", "v2.deadbeef.!!!"],
    ["truncated v2", "v2.abcd1234"],
    ["short payload", `v2.${keyId(K1)}.AAAA`],
    ["number", 42],
    ["null", null],
  ])("%s", (_name, value) => {
    expect(createKeyring({ current: K1 }).decrypt(value)).toBeNull()
  })

  it("random plaintext never decrypts to something (the old intermittent test)", () => {
    const ring = createKeyring({ current: K1 })
    for (let i = 0; i < 500; i++) {
      expect(ring.decrypt(`blink_${Math.random().toString(36).slice(2)}`)).toBeNull()
    }
  })
})

describe("inspect: authenticated, never trusts the key id alone", () => {
  const tamper = (ct: string) => {
    const [v, kid, payload] = ct.split(".")
    const bytes = Buffer.from(payload, "base64")
    bytes[12] ^= 0x01 // flip a bit in the GCM tag
    return `${v}.${kid}.${bytes.toString("base64")}`
  }

  it("classifies current, stale (previous key / legacy), undecryptable, not-ciphertext", () => {
    const ring = createKeyring({ current: K2, previous: K1 })
    expect(ring.inspect(ring.encrypt(SECRET))).toEqual({
      status: "current",
      plaintext: SECRET,
    })
    expect(ring.inspect(createKeyring({ current: K1 }).encrypt(SECRET))).toEqual({
      status: "stale",
      plaintext: SECRET,
    })
    expect(ring.inspect(legacy(SECRET, K1))).toEqual({
      status: "stale",
      plaintext: SECRET,
    })
    expect(ring.inspect(createKeyring({ current: "lost-key" }).encrypt(SECRET))).toEqual({
      status: "undecryptable",
    })
    expect(ring.inspect("blink_plain")).toEqual({ status: "not-ciphertext" })
  })

  it("a tampered value under the CURRENT key id is undecryptable, not current", () => {
    // The reviewer's probe: kid matches the current key, tag modified.
    const ring = createKeyring({ current: K1 })
    const bad = tamper(ring.encrypt(SECRET))
    expect(bad.split(".")[1]).toBe(ring.currentKeyId())
    expect(ring.inspect(bad)).toEqual({ status: "undecryptable" })
    expect(ring.decrypt(bad)).toBeNull()
    expect(ring.needsReencrypt(bad)).toBe(false) // cannot be re-encrypted either
  })

  it("key-id collision: a value written by another key with the current id is undecryptable", () => {
    // Simulated 64-bit collision: every key maps to the same id.
    const sameId = () => "00000000000000aa"
    const writtenByA = createKeyring({ current: "key-A", _keyId: sameId }).encrypt(SECRET)
    const currentB = createKeyring({ current: "key-B", _keyId: sameId })
    expect(writtenByA.split(".")[1]).toBe(currentB.currentKeyId())
    expect(currentB.inspect(writtenByA)).toEqual({ status: "undecryptable" })
    expect(currentB.needsReencrypt(writtenByA)).toBe(false)
  })

  it("rejects two distinct configured keys that share a key id", () => {
    const sameId = () => "00000000000000aa"
    expect(() =>
      createKeyring({ current: "key-B", previous: "key-A", _keyId: sameId }),
    ).toThrow("share key id 00000000000000aa")
  })

  it("the same key listed twice is de-duplicated, not an error", () => {
    const ring = createKeyring({ current: K1, previous: `${K1},${K0}` })
    expect(ring.inspect(ring.encrypt(SECRET)).status).toBe("current")
    // oldest is still K0 (the duplicate of K1 does not change the order)
    expect(ring.decrypt(legacy(SECRET, K0))).toBe(SECRET)
  })

  it("uses a 64-bit key id", () => {
    expect(keyId(K1)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("needsReencrypt / isCiphertext", () => {
  const ring = createKeyring({ current: K2, previous: K1 })
  it("is true for legacy and for v2 under a non-current key, false under the current key", () => {
    expect(ring.needsReencrypt(legacy(SECRET, K1))).toBe(true)
    expect(ring.needsReencrypt(createKeyring({ current: K1 }).encrypt(SECRET))).toBe(true)
    expect(ring.needsReencrypt(ring.encrypt(SECRET))).toBe(false)
    expect(ring.needsReencrypt("blink_plain")).toBe(false)
    expect(ring.needsReencrypt(null)).toBe(false)
  })

  it("recognizes both formats as ciphertext, nothing else", () => {
    expect(ring.isCiphertext(legacy(SECRET, K1))).toBe(true)
    expect(ring.isCiphertext(ring.encrypt(SECRET))).toBe(true)
    expect(ring.isCiphertext("blink_plain")).toBe(false)
    expect(ring.isCiphertext({})).toBe(false)
  })
})

describe("environment", () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env.ENCRYPTION_KEY = saved.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY_PREVIOUS = saved.ENCRYPTION_KEY_PREVIOUS
  })

  it("reads ENCRYPTION_KEY / ENCRYPTION_KEY_PREVIOUS at call time", () => {
    process.env.ENCRYPTION_KEY = K1
    delete process.env.ENCRYPTION_KEY_PREVIOUS
    const ct = envKeyring().encrypt(SECRET)
    process.env.ENCRYPTION_KEY = K2
    process.env.ENCRYPTION_KEY_PREVIOUS = K1
    expect(envKeyring().decrypt(ct)).toBe(SECRET)
    expect(envKeyring().currentKeyId()).toBe(keyId(K2))
  })

  it("encrypt without a key throws; decrypt without a key is null", () => {
    delete process.env.ENCRYPTION_KEY
    delete process.env.ENCRYPTION_KEY_PREVIOUS
    expect(() => envKeyring().encrypt(SECRET)).toThrow("ENCRYPTION_KEY")
    expect(envKeyring().decrypt("v2.abcdef12.AAAA")).toBeNull()
  })
})
