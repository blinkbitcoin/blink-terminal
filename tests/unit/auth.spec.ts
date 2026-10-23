/**
 * Unit tests for AuthManager encrypt/decrypt API key flow.
 *
 * Validates that API keys are properly encrypted at rest and
 * correctly decrypted for runtime use — the core security mechanism
 * for #481 (encrypt API keys in payment_splits).
 */

// Must set env vars before any imports (jest.mock runs before imports)
beforeAll(() => {
  // Already set below via top-level assignment
})

// Use jest.mock to ensure env vars are set before the auth module's IIFE runs
jest.mock("../../lib/config/api", () => ({
  getApiUrl: jest.fn(() => "https://api.blink.sv/graphql"),
}))

// Set env vars at the very top — but imports are hoisted above this.
// So we use a dynamic require pattern instead.
describe("AuthManager.encryptApiKey / decryptApiKey", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AuthManager: any

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = "test-encryption-key-for-unit-tests-32chars"
    process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests"
    // Dynamic require so env vars are set before module IIFE executes
    const authModule = await import("../../lib/auth")
    AuthManager = authModule.default
  })

  const sampleApiKey = "blink_yWRQMlU8UnAlFhaF8EtWL0tBHX3d_test"
  const stagingApiKey = "galoy_staging_J0cSDXNLfKDuVU1ctmtA8m16UO8JlJkJzaax"

  it("encrypts an API key to a different string", () => {
    const encrypted = AuthManager.encryptApiKey(sampleApiKey)
    expect(encrypted).toBeDefined()
    expect(encrypted).not.toBe(sampleApiKey)
    expect(typeof encrypted).toBe("string")
  })

  it("by default writes legacy ciphertext the previous release can read (rollback-safe)", () => {
    const encrypted = AuthManager.encryptApiKey(sampleApiKey)
    expect(encrypted.startsWith("U2FsdGVkX1")).toBe(true)
  })

  it("produces authenticated v2 ciphertext once ENCRYPTION_WRITE_FORMAT=v2 (blink-wip#1587)", () => {
    process.env.ENCRYPTION_WRITE_FORMAT = "v2"
    const encrypted = AuthManager.encryptApiKey(sampleApiKey)
    delete process.env.ENCRYPTION_WRITE_FORMAT
    expect(encrypted).toMatch(/^v2\.[0-9a-f]{16}\.[A-Za-z0-9+/=]+$/)
  })

  it("still decrypts legacy CryptoJS ciphertext written before the keyring", async () => {
    // Exactly what encryptApiKey produced before blink-wip#1587
    const CryptoJS = (await import("crypto-js")).default
    const legacy = CryptoJS.AES.encrypt(
      sampleApiKey,
      process.env.ENCRYPTION_KEY as string,
    ).toString()
    expect(legacy.startsWith("U2FsdGVkX1")).toBe(true)
    expect(AuthManager.decryptApiKey(legacy)).toBe(sampleApiKey)
  })

  it("decrypts back to the original API key", () => {
    const encrypted = AuthManager.encryptApiKey(sampleApiKey)
    const decrypted = AuthManager.decryptApiKey(encrypted)
    expect(decrypted).toBe(sampleApiKey)
  })

  it("handles staging API keys", () => {
    const encrypted = AuthManager.encryptApiKey(stagingApiKey)
    const decrypted = AuthManager.decryptApiKey(encrypted)
    expect(decrypted).toBe(stagingApiKey)
  })

  it("returns null for invalid ciphertext", () => {
    const result = AuthManager.decryptApiKey("not-valid-ciphertext")
    expect(result).toBeNull()
  })

  it("returns null for empty string", () => {
    const result = AuthManager.decryptApiKey("")
    expect(result).toBeNull()
  })

  it("produces different ciphertext each time (random salt/IV)", () => {
    const encrypted1 = AuthManager.encryptApiKey(sampleApiKey)
    const encrypted2 = AuthManager.encryptApiKey(sampleApiKey)
    // CryptoJS uses random salt, so two encryptions of the same plaintext differ
    expect(encrypted1).not.toBe(encrypted2)
    // Both should still decrypt to the same value
    expect(AuthManager.decryptApiKey(encrypted1)).toBe(sampleApiKey)
    expect(AuthManager.decryptApiKey(encrypted2)).toBe(sampleApiKey)
  })

  it("handles NWC connection URIs (used same encrypt method)", () => {
    const nwcUri =
      "nostr+walletconnect://relay.example.com?secret=abc123&relay=wss://relay.example.com"
    const encrypted = AuthManager.encryptApiKey(nwcUri)
    const decrypted = AuthManager.decryptApiKey(encrypted)
    expect(decrypted).toBe(nwcUri)
  })

  it("handles long API keys", () => {
    const longKey = "blink_" + "a".repeat(200)
    const encrypted = AuthManager.encryptApiKey(longKey)
    const decrypted = AuthManager.decryptApiKey(encrypted)
    expect(decrypted).toBe(longKey)
  })

  it("handles keys with special characters", () => {
    const specialKey = "blink_key+with/special=chars&more!"
    const encrypted = AuthManager.encryptApiKey(specialKey)
    const decrypted = AuthManager.decryptApiKey(encrypted)
    expect(decrypted).toBe(specialKey)
  })
})

describe("AuthManager.encryptApiKey backward compatibility", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AuthManager: any

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = "test-encryption-key-for-unit-tests-32chars"
    process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests"
    const authModule = await import("../../lib/auth")
    AuthManager = authModule.default
  })

  it("plaintext API keys that start with blink_ are distinguishable from ciphertext", () => {
    const plaintext = "blink_testkey123"
    process.env.ENCRYPTION_WRITE_FORMAT = "v2"
    const encrypted = AuthManager.encryptApiKey(plaintext)
    delete process.env.ENCRYPTION_WRITE_FORMAT
    // Plaintext starts with "blink_", ciphertext starts with "v2."
    expect(plaintext.startsWith("blink_")).toBe(true)
    expect(encrypted.startsWith("v2.")).toBe(true)
    expect(plaintext.startsWith("v2.")).toBe(false)
  })

  it("decrypting a plaintext API key returns null (graceful failure)", () => {
    // If old data has plaintext keys, decryptApiKey should return null
    // The hybrid-store falls back to raw value in this case
    const result = AuthManager.decryptApiKey("blink_plaintext_key")
    expect(result).toBeNull()
  })
})
