/** @jest-environment node */

/**
 * Bolt Card store security contracts (mocked pool; no Postgres harness):
 * - a pending registration (single-use keys link) is claimed atomically;
 *   a lost claim mints nothing; a failure after the claim releases it;
 * - reset confirmation only wipes within the window after a verified reset.
 */

const mockPoolQuery = jest.fn()
jest.mock("../../lib/db", () => ({
  getSharedPool: () => ({ query: (...args: unknown[]) => mockPoolQuery(...args) }),
}))
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: { encryptApiKey: (k: string) => k, decryptApiKey: (k: string) => k },
}))

import { BoltcardStore } from "../../lib/boltcard/store"

const pendingRow = {
  id: "r".repeat(32),
  owner_pubkey: "a".repeat(64),
  wallet_id: "w1",
  wallet_currency: "BTC",
  api_key_encrypted: "blink_key",
  name: null,
  max_tx_amount: null,
  daily_limit: null,
  initial_balance: "0",
  environment: "production",
  status: "PENDING",
  created_at: String(Date.now()),
  expires_at: String(Date.now() + 60_000),
}

const sqlCalls = () =>
  mockPoolQuery.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " "))

const store = () => {
  const s = new BoltcardStore()
  s.lastCleanup = Date.now()
  return s
}

beforeEach(() => mockPoolQuery.mockReset())

describe("completePendingRegistration: atomic single-use claim", () => {
  it("a lost claim throws and mints nothing", async () => {
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (/FROM boltcard_pending_registrations/.test(sql)) return { rows: [pendingRow] }
      if (/UPDATE boltcard_pending_registrations/.test(sql))
        return { rowCount: 0, rows: [] }
      return { rows: [], rowCount: 0 }
    })

    await expect(
      store().completePendingRegistration("r".repeat(32), "04a39493cc8680"),
    ).rejects.toThrow("Registration is not pending")

    const sql = sqlCalls()
    expect(sql.some((q) => /status = \$4 AND expires_at > \$3/.test(q))).toBe(true)
    expect(sql.some((q) => /INSERT INTO boltcards/.test(q))).toBe(false)
  })

  it("releases the claim when nothing could be minted", async () => {
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (/FROM boltcard_pending_registrations/.test(sql)) return { rows: [pendingRow] }
      if (
        /UPDATE boltcard_pending_registrations\s+SET status = \$2, completed_at = \$3/.test(
          sql,
        )
      )
        return { rowCount: 1, rows: [{ id: pendingRow.id }] }
      // The UID belongs to another owner
      if (/FROM boltcards WHERE card_uid/.test(sql))
        return { rows: [{ id: "x", owner_pubkey: "b".repeat(64), status: "ACTIVE" }] }
      return { rows: [], rowCount: 1 }
    })

    await expect(
      store().completePendingRegistration("r".repeat(32), "04a39493cc8680"),
    ).rejects.toThrow("already registered to another user")

    const release = mockPoolQuery.mock.calls.find(([sql]) =>
      /completed_at = NULL/.test(String(sql)),
    )
    expect(release).toBeDefined()
    expect(String(release![0])).toMatch(/card_id IS NULL/)
    expect(release![1]).toEqual([pendingRow.id, "PENDING", "COMPLETED"])
  })
})

describe("reset confirmation window", () => {
  it("markResetVerified stamps the card (not wiped ones)", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })
    await expect(store().markResetVerified("c1")).resolves.toBe(true)
    const [sql, params] = mockPoolQuery.mock.calls[0]
    expect(String(sql)).toMatch(/SET reset_verified_at = \$2/)
    expect(String(sql)).toMatch(/status != 'WIPED'/)
    expect(params[0]).toBe("c1")
  })

  it("wipeCardAfterVerifiedReset requires a verification inside the window and consumes it", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    const before = Date.now()

    await expect(store().wipeCardAfterVerifiedReset("c1", 600_000)).resolves.toBe(false)

    const [sql, params] = mockPoolQuery.mock.calls[0]
    expect(String(sql)).toMatch(
      /reset_verified_at IS NOT NULL AND reset_verified_at > \$3/,
    )
    expect(String(sql)).toMatch(/reset_verified_at = NULL/)
    expect(params[0]).toBe("c1")
    expect(params[2]).toBeGreaterThanOrEqual(before - 600_000)
    expect(params[2]).toBeLessThanOrEqual(Date.now() - 600_000)
  })
})
