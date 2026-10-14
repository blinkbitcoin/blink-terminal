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

import { BoltcardStore, CARD_ACTIVATION_FAILED } from "../../lib/boltcard/store"

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
