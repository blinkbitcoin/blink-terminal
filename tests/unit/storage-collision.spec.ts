/**
 * Tests for the storage path collision-hardening fix.
 *
 * Previously user records were keyed by a 16-hex (64-bit) truncated SHA-256 of
 * the username — a non-negligible collision risk where two identities could map
 * to the same file and read each other's API keys. The fix uses the full 64-hex
 * digest, with a backward-compatible read fallback to the legacy path so
 * existing records remain readable (and migrate forward on next write).
 */

import crypto from "crypto"
import fs from "fs/promises"
import path from "path"

jest.mock("../../lib/config/api", () => ({
  getApiUrl: jest.fn(() => "https://api.blink.sv/graphql"),
}))

// lib/auth runs an IIFE requiring JWT_SECRET at import time, and lib/storage
// imports lib/auth. Set env BEFORE dynamically importing either (jest hoists
// `import` above top-level statements, so we cannot rely on a plain assignment).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let StorageManager: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let AuthManager: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any

const dataDir = path.join(process.cwd(), ".data")
const USER = `collision-test-user-${Date.now()}`

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = "test-encryption-key-for-unit-tests-32chars"
  process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests"
  StorageManager = (await import("../../lib/storage")).StorageManager
  AuthManager = (await import("../../lib/auth")).default
  store = new StorageManager()
})

function fullHashPath(userId: string): string {
  const h = crypto.createHash("sha256").update(userId).digest("hex")
  return path.join(dataDir, `user_${h}.json`)
}
function legacyHashPath(userId: string): string {
  const h = crypto.createHash("sha256").update(userId).digest("hex").substring(0, 16)
  return path.join(dataDir, `user_${h}.json`)
}

afterEach(async () => {
  for (const p of [fullHashPath(USER), legacyHashPath(USER)]) {
    try {
      await fs.unlink(p)
    } catch {
      /* ignore */
    }
  }
})

describe("StorageManager path hardening", () => {
  it("getUserStoragePath uses the full 64-hex digest", () => {
    const p = store.getUserStoragePath(USER)
    const m = path.basename(p).match(/^user_([0-9a-f]+)\.json$/)
    expect(m).not.toBeNull()
    expect(m![1]).toHaveLength(64)
  })

  it("legacy path uses the 16-hex truncated digest", () => {
    const p = store.getLegacyUserStoragePath(USER)
    const m = path.basename(p).match(/^user_([0-9a-f]+)\.json$/)
    expect(m![1]).toHaveLength(16)
  })

  it("saves to the full-hash path and round-trips the API key", async () => {
    const ok = await store.saveUserData(USER, { apiKey: "blink_secret_key" })
    expect(ok).toBe(true)
    await expect(fs.stat(fullHashPath(USER))).resolves.toBeDefined()

    const loaded = await store.loadUserData(USER)
    expect(loaded?.apiKey).toBe("blink_secret_key")
  })

  it("reads a legacy (16-hex) record when no full-hash record exists", async () => {
    // Simulate a pre-fix record written at the legacy path (encrypted at rest).
    const legacyRecord = {
      apiKey: AuthManager.encryptApiKey("blink_legacy_key"),
      blinkUsername: "legacy-user",
    }
    await fs.writeFile(legacyHashPath(USER), JSON.stringify(legacyRecord))

    const loaded = await store.loadUserData(USER)
    expect(loaded?.apiKey).toBe("blink_legacy_key")
    expect(loaded?.blinkUsername).toBe("legacy-user")
  })

  it("prefers the full-hash record over a legacy one", async () => {
    await fs.writeFile(
      legacyHashPath(USER),
      JSON.stringify({ apiKey: AuthManager.encryptApiKey("OLD") }),
    )
    await store.saveUserData(USER, { apiKey: "NEW" })

    const loaded = await store.loadUserData(USER)
    expect(loaded?.apiKey).toBe("NEW")
  })

  it("deleteUserData removes both full and legacy files", async () => {
    await store.saveUserData(USER, { apiKey: "NEW" })
    await fs.writeFile(
      legacyHashPath(USER),
      JSON.stringify({ apiKey: AuthManager.encryptApiKey("OLD") }),
    )

    const deleted = await store.deleteUserData(USER)
    expect(deleted).toBe(true)
    await expect(fs.stat(fullHashPath(USER))).rejects.toBeDefined()
    await expect(fs.stat(legacyHashPath(USER))).rejects.toBeDefined()
  })
})
