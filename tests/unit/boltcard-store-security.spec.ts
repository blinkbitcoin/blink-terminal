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

describe("completePendingRegistration: claim released only if nothing was written", () => {
  const released = () =>
    mockPoolQuery.mock.calls.some(([sql]) => /completed_at = NULL/.test(String(sql)))

  const mockDb = ({
    existingCard = null,
    failLink = false,
  }: { existingCard?: Record<string, unknown> | null; failLink?: boolean } = {}) =>
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (/FROM boltcard_pending_registrations/.test(sql)) return { rows: [pendingRow] }
      if (
        /SET status = \$2, completed_at = \$3\s+WHERE id = \$1 AND status = \$4/.test(sql)
      )
        return { rowCount: 1, rows: [{ id: pendingRow.id }] }
      if (/card_id = \$4/.test(sql) && failLink) throw new Error("link failed")
      if (/FROM boltcards WHERE card_uid/.test(sql))
        return { rows: existingCard ? [existingCard] : [] }
      return { rows: [], rowCount: 1 }
    })

  it.each([
    [
      "createCard throws",
      (s: BoltcardStore) =>
        jest.spyOn(s, "createCard").mockRejectedValue(new Error("boom")),
    ],
    [
      "activateCard throws",
      (s: BoltcardStore) => {
        jest.spyOn(s, "createCard").mockResolvedValue({ id: "card-1" } as never)
        jest.spyOn(s, "activateCard").mockRejectedValue(new Error("boom"))
      },
    ],
  ])("%s -> the link stays consumed", async (_name, arrange) => {
    mockDb()
    const s = store()
    arrange(s)

    await expect(
      s.completePendingRegistration(pendingRow.id, "04a39493cc8680"),
    ).rejects.toThrow("boom")
    expect(released()).toBe(false)
  })

  it("the final linkage update throws -> the link stays consumed", async () => {
    mockDb({ failLink: true })
    const s = store()
    jest.spyOn(s, "createCard").mockResolvedValue({ id: "card-1" } as never)
    jest.spyOn(s, "activateCard").mockResolvedValue(true)

    await expect(
      s.completePendingRegistration(pendingRow.id, "04a39493cc8680"),
    ).rejects.toThrow("link failed")
    expect(released()).toBe(false)
  })

  it("the reprogram path throws -> the link stays consumed", async () => {
    mockDb({
      existingCard: {
        id: "x",
        owner_pubkey: pendingRow.owner_pubkey.toUpperCase(),
        status: "ACTIVE",
      },
    })
    const s = store()
    jest.spyOn(s, "reprogramCard").mockRejectedValue(new Error("boom"))

    await expect(
      s.completePendingRegistration(pendingRow.id, "04a39493cc8680"),
    ).rejects.toThrow("boom")
    expect(s.reprogramCard).toHaveBeenCalled() // same owner despite legacy case
    expect(released()).toBe(false)
  })
})

describe("reset: atomic tap record", () => {
  it("advances the counter and stamps reset_verified_at in one conditional write", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })
    await expect(store().recordVerifiedResetTap("c1", 7)).resolves.toBe(true)

    const [sql, params] = mockPoolQuery.mock.calls[0]
    const q = String(sql).replace(/\s+/g, " ")
    expect(q).toMatch(/SET last_counter = \$2, reset_verified_at = \$3/)
    expect(q).toMatch(/WHERE id = \$1 AND last_counter < \$2 AND status != 'WIPED'/)
    expect(params.slice(0, 2)).toEqual(["c1", 7])
  })

  it("returns false for a replayed / concurrent tap", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    await expect(store().recordVerifiedResetTap("c1", 7)).resolves.toBe(false)
  })

  it("propagates database errors (caller must not return keys)", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("db down"))
    await expect(store().recordVerifiedResetTap("c1", 7)).rejects.toThrow("db down")
  })
})

describe("reset confirmation window", () => {
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

describe("owner pubkeys are normalized to lowercase", () => {
  const MIXED = "AbCd".repeat(16)
  const LOWER = MIXED.toLowerCase()

  it.each([
    ["getCardsByOwner", (s: BoltcardStore) => s.getCardsByOwner(MIXED)],
    [
      "getPendingRegistrationsByOwner",
      (s: BoltcardStore) => s.getPendingRegistrationsByOwner(MIXED),
    ],
    ["getIssuerKey", (s: BoltcardStore) => s.getIssuerKey(MIXED)],
  ])("%s looks up the lowercase pubkey", async (_name, run) => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    await run(store())
    expect(mockPoolQuery.mock.calls[0][1][0]).toBe(LOWER)
  })

  it("getOrCreateIssuerKey stores a new key under the lowercase pubkey", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 })
    await store().getOrCreateIssuerKey(MIXED)
    const insert = mockPoolQuery.mock.calls.find(([sql]) =>
      /INSERT INTO boltcard_issuer_keys/.test(String(sql)),
    )
    expect(insert?.[1][0]).toBe(LOWER)
  })

  it("createPendingRegistration stores the lowercase pubkey", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [{ ...pendingRow, owner_pubkey: LOWER }],
      rowCount: 1,
    })
    await store().createPendingRegistration({
      ownerPubkey: MIXED,
      walletId: "w1",
      apiKey: "k",
    })
    const insert = mockPoolQuery.mock.calls.find(([sql]) =>
      /INSERT INTO boltcard_pending_registrations/.test(String(sql)),
    )
    expect(insert?.[1][1]).toBe(LOWER)
  })
})
