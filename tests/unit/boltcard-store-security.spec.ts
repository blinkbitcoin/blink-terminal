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
  getClient: async () => ({
    query: (...args: unknown[]) => mockPoolQuery(...args),
    release: () => undefined,
  }),
}))
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: { encryptApiKey: (k: string) => k, decryptApiKey: (k: string) => k },
}))

import {
  BoltcardStore,
  CARD_ACTIVATION_FAILED,
  CONSUMED_HASH_SQLSTATE,
} from "../../lib/boltcard/store"

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

  it("activateCard returns false (its real failure contract) -> fails without keys, stays consumed", async () => {
    mockDb()
    const s = store()
    jest.spyOn(s, "createCard").mockResolvedValue({ id: "card-1" } as never)
    jest.spyOn(s, "activateCard").mockResolvedValue(false)
    const getCard = jest.spyOn(s, "getCard")

    await expect(
      s.completePendingRegistration(pendingRow.id, "04a39493cc8680"),
    ).rejects.toThrow(CARD_ACTIVATION_FAILED)
    expect(released()).toBe(false)
    // never linked, never loaded with keys
    expect(
      mockPoolQuery.mock.calls.some(([sql]) => /card_id = \$4/.test(String(sql))),
    ).toBe(false)
    expect(getCard).not.toHaveBeenCalled()
  })

  it("reprogram (same owner) re-activates the card, then links and returns keys", async () => {
    mockDb({
      existingCard: { id: "x", owner_pubkey: pendingRow.owner_pubkey, status: "PENDING" },
    })
    const s = store()
    jest.spyOn(s, "reprogramCard").mockResolvedValue({ id: "x" } as never)
    const activate = jest.spyOn(s, "activateCard").mockResolvedValue(true)
    jest.spyOn(s, "getCard").mockResolvedValue({ id: "x", k0: "k" } as never)

    await expect(
      s.completePendingRegistration(pendingRow.id, "04a39493cc8680"),
    ).resolves.toEqual({
      id: "x",
      k0: "k",
    })
    expect(activate).toHaveBeenCalledWith("x")
    expect(
      mockPoolQuery.mock.calls.some(([sql]) => /card_id = \$4/.test(String(sql))),
    ).toBe(true)
  })

  it("reprogram whose activation returns false -> fails without keys, stays consumed", async () => {
    mockDb({
      existingCard: { id: "x", owner_pubkey: pendingRow.owner_pubkey, status: "ACTIVE" },
    })
    const s = store()
    jest.spyOn(s, "reprogramCard").mockResolvedValue({ id: "x" } as never)
    jest.spyOn(s, "activateCard").mockResolvedValue(false)
    const getCard = jest.spyOn(s, "getCard")

    await expect(
      s.completePendingRegistration(pendingRow.id, "04a39493cc8680"),
    ).rejects.toThrow(CARD_ACTIVATION_FAILED)
    expect(released()).toBe(false)
    expect(getCard).not.toHaveBeenCalled()
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

describe("withdraw sessions (tap-bound k1)", () => {
  it("startWithdrawSession advances the counter and inserts the session in one statement", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ k1_hash: "x" }] })

    const k1 = await store().startWithdrawSession("c1", 9, 5_000_000)

    expect(k1).toMatch(/^[0-9a-f]{64}$/)
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockPoolQuery.mock.calls[0]
    const q = String(sql).replace(/\s+/g, " ")
    expect(q).toMatch(/WITH advanced AS \( UPDATE boltcards SET last_counter = \$2/)
    expect(q).toMatch(/WHERE id = \$1 AND last_counter < \$2 AND status = 'ACTIVE'/)
    expect(q).toMatch(
      /INSERT INTO boltcard_withdraw_sessions .* SELECT \$3, id, \$2, \$4, \$5, \$6 FROM advanced/,
    )
    // Only the hash is stored
    expect(params[2]).toMatch(/^[0-9a-f]{64}$/)
    expect(params[2]).not.toBe(k1)
    expect(params.slice(0, 2)).toEqual(["c1", 9])
    expect(params[3]).toBe(5_000_000)
  })

  it("startWithdrawSession returns null for a replayed tap", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    await expect(store().startWithdrawSession("c1", 9, 5_000_000)).resolves.toBeNull()
  })

  it("consumeWithdrawSession is single-use, card-bound and unexpired", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ max_msats: "5000000" }] })

    await expect(store().consumeWithdrawSession("f".repeat(64), "c1")).resolves.toBe(
      5_000_000,
    )

    const [sql, params] = mockPoolQuery.mock.calls[0]
    expect(String(sql).replace(/\s+/g, " ")).toMatch(
      /WHERE k1_hash = \$1 AND card_id = \$2 AND used_at IS NULL AND expires_at > \$3/,
    )
    expect(params[0]).not.toBe("f".repeat(64)) // hashed
    expect(params[1]).toBe("c1")
  })

  it.each(["", "c1", "z".repeat(64), "f".repeat(63)])(
    "consumeWithdrawSession rejects malformed k1 %p without querying",
    async (k1) => {
      await expect(store().consumeWithdrawSession(k1, "c1")).resolves.toBeNull()
      expect(mockPoolQuery).not.toHaveBeenCalled()
    },
  )

  it("unmarkTopUpProcessed only releases a processed claim", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })
    await expect(store().unmarkTopUpProcessed("h")).resolves.toBe(true)
    expect(String(mockPoolQuery.mock.calls[0][0])).toMatch(
      /WHERE payment_hash = \$1 AND processed = TRUE/,
    )
  })
})

describe("topUpCard: atomic credit + audit, definite vs ambiguous failure", () => {
  const TX_ROW = {
    id: 1,
    card_id: "c1",
    tx_type: "TOPUP",
    amount: "1000",
    balance_after: "6000",
    payment_hash: "h",
    description: "d",
    created_at: "1",
  }

  it("credits the balance and inserts the TOPUP row in ONE statement", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [TX_ROW] })

    const result = await store().topUpCard("c1", 1000, "h", "d")

    expect(result).toMatchObject({ success: true, balance: 6000 })
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockPoolQuery.mock.calls[0]
    const q = String(sql).replace(/\s+/g, " ")
    expect(q).toMatch(/WITH credited AS \( UPDATE boltcards SET balance = balance \+ \$2/)
    expect(q).toMatch(/WHERE id = \$1 AND status = 'ACTIVE'/)
    expect(q).toMatch(
      /INSERT INTO boltcard_transactions .* SELECT id, \$3, \$2, balance, \$4, \$5, \$6 FROM credited/,
    )
    expect(params.slice(0, 4)).toEqual(["c1", 1000, "TOPUP", "h"])
  })

  it("zero rows = definite failure (nothing written)", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    await expect(store().topUpCard("c1", 1000, "h")).resolves.toMatchObject({
      success: false,
    })
  })

  it("a database error is ambiguous and THROWS (callers keep the claim)", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("connection reset"))
    await expect(store().topUpCard("c1", 1000, "h")).rejects.toThrow("connection reset")
  })

  it("records the credited hash in the SAME statement (migration 032)", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [TX_ROW] })
    await store().topUpCard("c1", 1000, "h", "d")
    const q = String(mockPoolQuery.mock.calls[0][0]).replace(/\s+/g, " ")
    expect(q).toMatch(
      /INSERT INTO boltcard_credited_topups \(payment_hash, card_id, credited_at\) SELECT .* FROM tx/,
    )
  })

  it("the credited-hash primary key violation is a DEFINITE 'already credited'", async () => {
    mockPoolQuery.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint: "boltcard_credited_topups_pkey",
      }),
    )
    await expect(store().topUpCard("c1", 1000, "h")).resolves.toMatchObject({
      success: false,
      alreadyCredited: true,
    })
  })

  it("any other unique violation stays ambiguous and THROWS", async () => {
    mockPoolQuery.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint: "something_else",
      }),
    )
    await expect(store().topUpCard("c1", 1000, "h")).rejects.toThrow("duplicate key")
  })
})

describe("review states (pending withdrawals, top-up flags)", () => {
  it("recordPendingWithdrawal inserts idempotently on the payment hash", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ payment_hash: "h" }] })
    await store().recordPendingWithdrawal("h", "c1", 1000, 4000)
    const [sql, params] = mockPoolQuery.mock.calls[0]
    expect(String(sql)).toMatch(/ON CONFLICT \(payment_hash\) DO NOTHING/)
    expect(String(sql)).toMatch(/RETURNING payment_hash/)
    expect(params).toEqual(["h", "c1", 1000, 4000, expect.any(Number), "PENDING", null])
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
  })

  it("a hash conflict with a different amount throws (not a silent no-op)", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockResolvedValueOnce({
      rows: [{ card_id: "c1", amount: "999", kind: "PENDING", resolved_at: null }],
    })
    await expect(store().recordPendingWithdrawal("h", "c1", 1000, 4000)).rejects.toThrow(
      /different amount/,
    )
  })

  it("RESTORE_FAILED is upgraded to an in-flight kind, never downgraded", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { card_id: "c1", amount: "1000", kind: "RESTORE_FAILED", resolved_at: null },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
    await store().recordPendingWithdrawal("h", "c1", 1000, 4000, "PENDING", 777)
    const [sql, params] = mockPoolQuery.mock.calls[2]
    expect(String(sql)).toMatch(/kind = 'RESTORE_FAILED'/)
    expect(params).toEqual(["h", "PENDING", 777, "c1", 1000])

    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockResolvedValueOnce({
      rows: [{ card_id: "c1", amount: "1000", kind: "PENDING", resolved_at: null }],
    })
    await store().recordPendingWithdrawal("h", "c1", 1000, 4000, "RESTORE_FAILED", null)
    expect(mockPoolQuery).toHaveBeenCalledTimes(2)
  })

  it("a finished row is not reopened", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockResolvedValueOnce({
      rows: [{ card_id: "c1", amount: "1000", kind: "PENDING", resolved_at: "5" }],
    })
    await expect(
      store().recordPendingWithdrawal("h", "c1", 1000, 4000, "UNKNOWN", 9),
    ).rejects.toThrow(/already spent/)
    expect(sqlCalls().join(" ")).not.toMatch(/resolved_at = NULL/)
  })

  it("claimAndDeductWithdrawal claims and deducts in one transaction", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // hash not yet consumed
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ attempt: "1" }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ balance: "4000", daily_spent: "1000", daily_reset_at: "777" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({}) // COMMIT
    await expect(store().claimAndDeductWithdrawal("h", "c1", 1000)).resolves.toEqual({
      status: "claimed",
      balance: 4000,
      dailySpent: 1000,
      dailyResetAt: 777,
      attempt: 1,
    })
    const sql = sqlCalls()
    expect(sql[0]).toBe("BEGIN")
    expect(sql.join(" ")).toMatch(/'CLAIMED'/)
    expect(sql.join(" ")).toMatch(/COMMIT/)
    expect(sql.join(" ")).not.toMatch(/ROLLBACK/)
  })

  it("a hash consumed after card deletion is spent: no second deduction", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ "?column?": 1 }] }) // consumed
      // Without the consumed-hash check this is a successful claim and deducts.
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ attempt: "1" }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ balance: "3000", daily_spent: "2000", daily_reset_at: null }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({})
    await expect(store().claimAndDeductWithdrawal("h", "c1", 1000)).resolves.toEqual({
      status: "spent",
    })
    const sql = sqlCalls().join(" ")
    expect(sql).toMatch(/boltcard_consumed_payment_hashes/)
    expect(sql).toMatch(/ROLLBACK/)
    expect(sql).not.toMatch(/balance = balance -/)
  })

  it("a taken hash, including a finished failure, is spent: no second deduction", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // not in the consumed table
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // hash already present
      // A reintroduced reclaim would treat this as success and deduct.
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ attempt: "2" }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ balance: "3000", daily_spent: "2000", daily_reset_at: null }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({})
    await expect(store().claimAndDeductWithdrawal("h", "c1", 1000)).resolves.toEqual({
      status: "spent",
    })
    const sql = sqlCalls().join(" ")
    expect(sql).toMatch(/ROLLBACK/)
    expect(sql).not.toMatch(/balance = balance -/)
    expect(sql).not.toMatch(/attempt = attempt \+ 1/)
  })

  // blink-wip#1646: claimant B passes the pre-check while A's insert is
  // uncommitted; A commits, the card is wiped (withdrawal row cascades away,
  // tombstone stays); B's insert trips migration 030's trigger. That is
  // "spent", not a server fault: the callback must answer "already used".
  it("the retention trigger's rejection (SQLSTATE BC409) is spent, nothing deducted", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // pre-check: not yet consumed
      .mockRejectedValueOnce(
        Object.assign(new Error("payment hash already consumed"), {
          code: CONSUMED_HASH_SQLSTATE,
        }),
      )
      .mockResolvedValueOnce({}) // ROLLBACK
    await expect(store().claimAndDeductWithdrawal("h", "c1", 1000)).resolves.toEqual({
      status: "spent",
    })
    const sql = sqlCalls().join(" ")
    expect(sql).toMatch(/ROLLBACK/)
    expect(sql).not.toMatch(/balance = balance -/)
    expect(sql).not.toMatch(/COMMIT/)
  })

  it("any other database error still throws (the claim may have committed)", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockRejectedValueOnce(
        Object.assign(new Error("deadlock detected"), { code: "40P01" }),
      )
      .mockResolvedValueOnce({})
    await expect(store().claimAndDeductWithdrawal("h", "c1", 1000)).rejects.toThrow(
      "deadlock detected",
    )
    expect(sqlCalls().join(" ")).toMatch(/ROLLBACK/)
  })

  it("beginWithdrawalSend moves only an unresolved CLAIMED row to UNKNOWN", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ payment_hash: "h" }] })
    await expect(store().beginWithdrawalSend("h", 1)).resolves.toBe(true)
    const q = String(mockPoolQuery.mock.calls[0][0]).replace(/\s+/g, " ")
    expect(q).toMatch(
      /SET kind = 'UNKNOWN' WHERE payment_hash = \$1 AND resolved_at IS NULL AND kind = 'CLAIMED' AND attempt = \$2/,
    )
  })

  it("an abandoned claim restores only while the row is still CLAIMED and older than the cutoff", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "c1" }] })
    await expect(store().resolvePendingWithdrawalFailed("h", 1, 1000)).resolves.toBe(true)
    const q = String(mockPoolQuery.mock.calls[0][0]).replace(/\s+/g, " ")
    expect(q).toMatch(/AND attempt = \$3/)
    expect(q).toMatch(/AND kind = 'CLAIMED' AND created_at < \$4/)
    expect(mockPoolQuery.mock.calls[0][1][2]).toBe(1)
    expect(mockPoolQuery.mock.calls[0][1][3]).toBe(1000)

    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "c1" }] })
    await store().resolvePendingWithdrawalFailed("h", 1)
    const plain = String(mockPoolQuery.mock.calls[0][0]).replace(/\s+/g, " ")
    expect(plain).not.toMatch(/kind = 'CLAIMED'/)
  })

  it("a delayed EXPIRED pinned to attempt 1 cannot restore a newer attempt", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    await expect(store().resolvePendingWithdrawalFailed("h", 1)).resolves.toBe(false)
    const q = String(mockPoolQuery.mock.calls[0][0]).replace(/\s+/g, " ")
    expect(q).toMatch(/AND attempt = \$3/)
    expect(mockPoolQuery.mock.calls[0][1][2]).toBe(1)
  })

  it("a delayed PAID pinned to attempt 1 cannot resolve a newer attempt", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    await expect(store().resolvePendingWithdrawal("h", "SUCCESS", 1)).resolves.toBe(false)
    const q = String(mockPoolQuery.mock.calls[0][0]).replace(/\s+/g, " ")
    expect(q).toMatch(/AND attempt = \$4/)
    expect(mockPoolQuery.mock.calls[0][1][3]).toBe(1)
  })

  it("flagUncreditedTopUp does not replace an existing review reason", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    await store().flagUncreditedTopUp("h")
    const q = String(mockPoolQuery.mock.calls[0][0]).replace(/\s+/g, " ")
    expect(q).toMatch(/AND NOT needs_review/)
    expect(mockPoolQuery.mock.calls[0][1][1]).toMatch(/no credit/)
  })

  it("markTopUpProcessed throws on a database error (not a definite miss)", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("connection reset"))
    await expect(store().markTopUpProcessed("h")).rejects.toThrow("connection reset")
  })

  it("rollbackSpend subtracts daily_spent only in the deduction's window", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "c1" }] })
    await expect(store().rollbackSpend("c1", 1000, 777)).resolves.toBe(true)
    const q = String(mockPoolQuery.mock.calls[0][0]).replace(/\s+/g, " ")
    expect(q).toMatch(/balance = balance \+ \$2/)
    expect(q).toMatch(
      /WHEN \$3::bigint IS NOT NULL AND daily_reset_at IS DISTINCT FROM \$3 THEN daily_spent ELSE GREATEST\(0, daily_spent - \$2\) END/,
    )
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(["c1", 1000, 777])
  })

  it("getPendingWithdrawals filters unresolved rows, optionally per card", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] })
    await store().getPendingWithdrawals("c1")
    const [sql, params] = mockPoolQuery.mock.calls[0]
    expect(String(sql)).toMatch(/WHERE resolved_at IS NULL/)
    expect(params).toEqual(["c1", null]) // no cap
    await store().getPendingWithdrawals()
    expect(mockPoolQuery.mock.calls[1][1]).toEqual([null, null])
    // An optional cap bounds one reconciliation pass (oldest first)
    await store().getPendingWithdrawals(undefined, 50)
    expect(String(mockPoolQuery.mock.calls[2][0])).toMatch(
      /ORDER BY last_checked_at ASC NULLS FIRST, created_at ASC\s+LIMIT/, // fair order (migration 031)
    )
    expect(mockPoolQuery.mock.calls[2][1]).toEqual([null, 50])
  })

  it("resolvePendingWithdrawal is one-shot", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
    await expect(store().resolvePendingWithdrawal("h", "SUCCESS", 1)).resolves.toBe(true)
    const [sql] = mockPoolQuery.mock.calls[0]
    expect(String(sql)).toMatch(
      /WHERE payment_hash = \$1 AND resolved_at IS NULL AND attempt = \$4/,
    )
  })

  it("setTopUpReviewReason / getTopUpsNeedingReview / clearTopUpReview", async () => {
    mockPoolQuery.mockResolvedValue({ rowCount: 1, rows: [] })
    await store().setTopUpReviewReason("h", "why")
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(["h", "why"])

    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await store().getTopUpsNeedingReview()
    expect(String(mockPoolQuery.mock.calls[1][0])).toMatch(
      /WHERE processed = TRUE AND needs_review/,
    )

    await store().clearTopUpReview("h")
    expect(String(mockPoolQuery.mock.calls[2][0])).toMatch(/SET needs_review = FALSE/)
  })

  it("unmarkTopUpProcessed clears the review flag too", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })
    await store().unmarkTopUpProcessed("h")
    expect(String(mockPoolQuery.mock.calls[0][0])).toMatch(
      /needs_review = FALSE, review_reason = NULL/,
    )
  })
})

describe("incrementDailySpent: checks and deduction in one statement", () => {
  it("gates on status, balance, per-tx and daily limit in the same UPDATE", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ balance: "4000", daily_spent: "1000" }],
    })
    const s = store()
    jest.spyOn(s, "getCard").mockResolvedValue({
      id: "c1",
      status: "ACTIVE",
      maxTxAmount: 2000,
      dailyLimit: 5000,
    } as never)

    const res = await s.incrementDailySpent("c1", 1000)

    expect(res).toEqual({
      success: true,
      balance: 4000,
      dailySpent: 1000,
      dailyResetAt: null,
    })
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockPoolQuery.mock.calls[0]
    const q = String(sql).replace(/\s+/g, " ")
    expect(q).toMatch(/SET balance = balance - \$2/)
    expect(q).toMatch(
      /daily_spent = CASE WHEN daily_reset_at IS NOT NULL AND daily_reset_at < \$3 THEN \$2 ELSE daily_spent \+ \$2 END/,
    )
    expect(q).toMatch(/AND balance >= \$2/)
    expect(q).toMatch(/max_tx_amount IS NULL OR \$2 <= max_tx_amount/)
    expect(q).toMatch(/daily_limit IS NULL OR \(CASE/)
    expect(q).toMatch(/\+ \$2 <= daily_limit/)
    // the limit value comes from the row, not a stale pre-read
    expect(params).toEqual(["c1", 1000, expect.any(Number), expect.any(Number)])
  })

  it("zero rows -> declined (balance or limits, atomically)", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    const s = store()
    jest
      .spyOn(s, "getCard")
      .mockResolvedValue({ id: "c1", status: "ACTIVE", maxTxAmount: null } as never)
    const res = await s.incrementDailySpent("c1", 1000)
    expect(res.success).toBe(false)
  })
})

describe("resolvePendingWithdrawalFailed: resolve + restore in one statement", () => {
  it("CTE resolves once and restores the deduction in the same statement", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "c1" }] })
    await expect(store().resolvePendingWithdrawalFailed("h", 1)).resolves.toBe(true)

    const [sql, params] = mockPoolQuery.mock.calls[0]
    const q = String(sql).replace(/\s+/g, " ")
    expect(q).toMatch(
      /WITH resolved AS \( UPDATE boltcard_pending_withdrawals SET resolved_at = \$2, outcome = 'FAILED' WHERE payment_hash = \$1 AND resolved_at IS NULL AND attempt = \$3 RETURNING card_id, amount, daily_window_reset_at \)/,
    )
    expect(q).toMatch(/IS DISTINCT FROM r\.daily_window_reset_at/)
    expect(q).toMatch(/GREATEST\(0, daily_spent - r\.amount\)/)
    expect(params[0]).toBe("h")
  })

  it("already resolved -> zero rows, nothing restored", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    await expect(store().resolvePendingWithdrawalFailed("h", 1)).resolves.toBe(false)
  })
})
