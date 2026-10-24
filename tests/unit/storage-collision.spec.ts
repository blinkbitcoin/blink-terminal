/**
 * Tests for the PostgreSQL-backed user record store (lib/storage.ts).
 *
 * User data used to be written to per-pod local-disk JSON keyed by a SHA-256 of
 * the userId. It now lives in the shared `user_records` table so that all
 * application replicas see the same data (fixing cross-device divergence).
 *
 * These tests assert the security-relevant properties that must survive the
 * move to Postgres:
 *   - distinct userIds map to distinct primary keys (no collision / cross-read),
 *   - the `apiKey` field is encrypted at rest and round-trips on read,
 *   - saves upsert (latest write wins), and deletes remove the record.
 *
 * A lightweight in-memory fake of the shared pool emulates the `user_records`
 * table so no real database connection is required.
 */

// In-memory store keyed by user_hash, emulating the user_records table.
const rows = new Map<string, { data: unknown; updated_at: number }>()

function fakeQuery(text: string, params?: unknown[]) {
  const sql = text.trim().toUpperCase()

  if (sql.startsWith("INSERT INTO USER_RECORDS")) {
    const userHash = params![0] as string
    const data = JSON.parse(params![1] as string)
    rows.set(userHash, { data, updated_at: Date.now() })
    return Promise.resolve({ rowCount: 1, rows: [] })
  }

  if (sql.startsWith("SELECT DATA FROM USER_RECORDS")) {
    const userHash = params![0] as string
    const row = rows.get(userHash)
    if (!row) return Promise.resolve({ rowCount: 0, rows: [] })
    // Deep clone so callers mutating the returned object (apiKey decrypt) don't
    // corrupt the stored encrypted-at-rest value, matching JSONB semantics.
    return Promise.resolve({
      rowCount: 1,
      rows: [{ data: JSON.parse(JSON.stringify(row.data)) }],
    })
  }

  if (sql.startsWith("DELETE FROM USER_RECORDS")) {
    const userHash = params![0] as string
    const existed = rows.delete(userHash)
    return Promise.resolve({ rowCount: existed ? 1 : 0, rows: [] })
  }

  if (sql.startsWith("SELECT USER_HASH FROM USER_RECORDS")) {
    return Promise.resolve({
      rowCount: rows.size,
      rows: Array.from(rows.keys()).map((user_hash) => ({ user_hash })),
    })
  }

  return Promise.resolve({ rowCount: 0, rows: [] })
}

jest.mock("../../lib/db", () => ({
  getSharedPool: jest.fn(() => ({
    query: (text: string, params?: unknown[]) => fakeQuery(text, params),
    connect: jest.fn(),
    on: jest.fn(),
  })),
  getClient: jest.fn(),
}))

jest.mock("../../lib/config/api", () => ({
  getApiUrl: jest.fn(() => "https://api.blink.sv/graphql"),
}))

// lib/auth runs an IIFE requiring JWT_SECRET at import time, and lib/storage
// imports lib/auth. Set env BEFORE dynamically importing either (jest hoists
// `import` above top-level statements, so we cannot rely on a plain assignment).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let StorageManagerClass: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = "test-encryption-key-for-unit-tests-32chars"
  process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests"
  StorageManagerClass = (await import("../../lib/storage")).StorageManager
  store = new StorageManagerClass()
})

afterEach(() => {
  rows.clear()
})

const USER = `collision-test-user-${Date.now()}`

describe("StorageManager (Postgres-backed)", () => {
  it("getUserStoragePath returns the full 64-hex digest as the primary key", () => {
    const key = store.getUserStoragePath(USER)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it("maps distinct userIds to distinct keys (no collision)", () => {
    const a = store.getUserStoragePath("nostr:aaaa")
    const b = store.getUserStoragePath("nostr:bbbb")
    expect(a).not.toEqual(b)
  })

  it("saves and round-trips the API key (encrypted at rest)", async () => {
    const ok = await store.saveUserData(USER, { apiKey: "blink_secret_key" })
    expect(ok).toBe(true)

    // Stored value must NOT be the plaintext key.
    const userHash = store.getUserStoragePath(USER)
    const stored = rows.get(userHash)!.data as { apiKey: string }
    expect(stored.apiKey).not.toBe("blink_secret_key")

    // Loading decrypts it back to plaintext.
    const loaded = await store.loadUserData(USER)
    expect(loaded?.apiKey).toBe("blink_secret_key")
  })

  it("returns null for a user with no record", async () => {
    const loaded = await store.loadUserData("no-such-user")
    expect(loaded).toBeNull()
  })

  it("does not leak one user's data to another (distinct records)", async () => {
    await store.saveUserData("nostr:userA", { apiKey: "keyA", blinkUsername: "alice" })
    await store.saveUserData("nostr:userB", { apiKey: "keyB", blinkUsername: "bob" })

    const a = await store.loadUserData("nostr:userA")
    const b = await store.loadUserData("nostr:userB")
    expect(a?.apiKey).toBe("keyA")
    expect(a?.blinkUsername).toBe("alice")
    expect(b?.apiKey).toBe("keyB")
    expect(b?.blinkUsername).toBe("bob")
  })

  it("upserts on repeated save (latest write wins)", async () => {
    await store.saveUserData(USER, { apiKey: "OLD" })
    await store.saveUserData(USER, { apiKey: "NEW" })

    const loaded = await store.loadUserData(USER)
    expect(loaded?.apiKey).toBe("NEW")
  })

  it("preserves non-apiKey fields and a null apiKey", async () => {
    await store.saveUserData("nostr_pubkeyx", {
      legacyUsername: "alice",
      linkedAt: "2026-06-05T00:00:00.000Z",
    })
    const loaded = await store.loadUserData("nostr_pubkeyx")
    expect(loaded?.legacyUsername).toBe("alice")
    expect(loaded?.linkedAt).toBe("2026-06-05T00:00:00.000Z")
    expect(loaded?.apiKey ?? null).toBeNull()
  })

  it("deleteUserData removes the record", async () => {
    await store.saveUserData(USER, { apiKey: "NEW" })
    const deleted = await store.deleteUserData(USER)
    expect(deleted).toBe(true)
    expect(await store.loadUserData(USER)).toBeNull()
  })

  it("deleteUserData returns false when nothing was deleted", async () => {
    const deleted = await store.deleteUserData("no-such-user")
    expect(deleted).toBe(false)
  })

  it("listUsers returns the per-user hashes", async () => {
    await store.saveUserData("nostr:one", { apiKey: "1" })
    await store.saveUserData("nostr:two", { apiKey: "2" })
    const users = await store.listUsers()
    expect(users).toContain(store.getUserStoragePath("nostr:one"))
    expect(users).toContain(store.getUserStoragePath("nostr:two"))
    expect(users).toHaveLength(2)
  })
})
