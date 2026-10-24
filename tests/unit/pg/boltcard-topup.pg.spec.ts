/** @jest-environment node */

/**
 * A Lightning payment credits a Bolt Card at most once, enforced by the
 * database (migration 032, blink-wip#1623 defense in depth).
 *
 * Before: the only guard was the pending row's processed flag. The upsert in
 * storePendingTopUp could reset it, cleanup deletes processed rows after 24 h,
 * and the TOPUP audit rows cascade away when a card is wiped — nothing in the
 * schema stopped a second credit for the same payment hash.
 */

// Must stay first: sets the env lib/auth reads at module load.
import "./env"

import type { Client } from "pg"

import { BoltcardStore } from "../../../lib/boltcard/store"

import { concurrently, describePg, setupTestDatabase, type TestDatabase } from "./harness"

jest.setTimeout(90_000)

const HASH = "cd".repeat(32)
const CARD_A = "card-a".padEnd(32, "0")
const CARD_B = "card-b".padEnd(32, "0")

const store = () => {
  const s = new BoltcardStore()
  s.lastCleanup = Date.now()
  return s
}

const insertCard = async (sql: Client, id: string, uid: string, balance = 0) => {
  await sql.query(
    `INSERT INTO boltcards
       (id, card_uid, owner_pubkey, wallet_id, api_key_encrypted,
        k0_encrypted, k1_encrypted, k2_encrypted, status, balance, created_at)
     VALUES ($1, $2, $3, 'w1', 'enc', 'k0', 'k1', 'k2', 'ACTIVE', $4, $5)`,
    [id, uid, "a".repeat(64), balance, Date.now()],
  )
}

const balanceOf = async (sql: Client, id: string) =>
  Number(
    (await sql.query("SELECT balance FROM boltcards WHERE id = $1", [id])).rows[0]
      .balance,
  )

const topupRows = async (sql: Client, hash: string) =>
  Number(
    (
      await sql.query(
        "SELECT COUNT(*) AS n FROM boltcard_transactions WHERE tx_type = 'TOPUP' AND payment_hash = $1",
        [hash],
      )
    ).rows[0].n,
  )

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {})
  jest.spyOn(console, "error").mockImplementation(() => {})
})

describePg("a payment hash credits a card at most once", () => {
  let db: TestDatabase
  let sql: Client

  beforeAll(async () => {
    db = await setupTestDatabase("topup_once")
    sql = await db.connect()
  })
  afterAll(async () => {
    await sql?.end()
    await db?.teardown()
  })
  beforeEach(async () => {
    await sql.query(
      "TRUNCATE boltcard_pending_topups, boltcard_credited_topups, boltcard_transactions, boltcards CASCADE",
    )
    await insertCard(sql, CARD_A, "04a39493cc8680")
  })

  it("a second credit of the same hash is refused and writes nothing", async () => {
    expect(await store().topUpCard(CARD_A, 1_000, HASH)).toMatchObject({
      success: true,
      balance: 1_000,
    })
    expect(await store().topUpCard(CARD_A, 1_000, HASH)).toMatchObject({
      success: false,
      alreadyCredited: true,
    })
    expect(await balanceOf(sql, CARD_A)).toBe(1_000)
    expect(await topupRows(sql, HASH)).toBe(1)
    expect(await store().isTopUpCredited(HASH)).toBe(true)
  })

  it("concurrent credits of one hash: exactly one succeeds", async () => {
    const results = await concurrently(8, () => store().topUpCard(CARD_A, 1_000, HASH))
    const values = results.map((r) =>
      r.status === "fulfilled" ? r.value : { error: "threw" },
    )
    expect(values.filter((v) => "success" in v && v.success)).toHaveLength(1)
    expect(
      values.filter((v) => "alreadyCredited" in v && v.alreadyCredited),
    ).toHaveLength(7)
    expect(await balanceOf(sql, CARD_A)).toBe(1_000)
    expect(await topupRows(sql, HASH)).toBe(1)
  })

  it("replay after the pending row was cleaned up and re-stored: still credited once", async () => {
    const s = store()
    expect(await s.storePendingTopUp(CARD_A, HASH, 1_000)).toBe(true)
    expect(await s.markTopUpProcessed(HASH)).toBe(true)
    expect((await s.topUpCard(CARD_A, 1_000, HASH)).success).toBe(true)

    // 25 h later the cleanup deletes the processed row...
    await sql.query(
      "UPDATE boltcard_pending_topups SET processed_at = $2 WHERE payment_hash = $1",
      [HASH, Date.now() - 25 * 3600_000],
    )
    expect(await s.cleanupPendingTopUps()).toBe(1)
    // ...so the old guard (the processed flag) is gone: the hash can be
    // stored and claimed again.
    expect(await s.storePendingTopUp(CARD_A, HASH, 1_000)).toBe(true)
    expect(await s.markTopUpProcessed(HASH)).toBe(true)

    expect(await s.isTopUpCredited(HASH)).toBe(true)
    expect(await s.topUpCard(CARD_A, 1_000, HASH)).toMatchObject({
      alreadyCredited: true,
    })
    expect(await balanceOf(sql, CARD_A)).toBe(1_000)
  })

  it("survives a card wipe: the audit rows cascade away, the credited hash does not", async () => {
    expect((await store().topUpCard(CARD_A, 1_000, HASH)).success).toBe(true)
    await sql.query("DELETE FROM boltcards WHERE id = $1", [CARD_A])
    expect(await topupRows(sql, HASH)).toBe(0)

    await insertCard(sql, CARD_B, "04b39493cc8681")
    expect(await store().topUpCard(CARD_B, 1_000, HASH)).toMatchObject({
      alreadyCredited: true,
    })
    expect(await balanceOf(sql, CARD_B)).toBe(0)
  })

  it("storePendingTopUp never resets a processed top-up to claimable", async () => {
    const s = store()
    expect(await s.storePendingTopUp(CARD_A, HASH, 1_000)).toBe(true)
    expect(await s.markTopUpProcessed(HASH)).toBe(true)

    expect(await s.storePendingTopUp(CARD_A, HASH, 5_000)).toBe(false)
    const row = (
      await sql.query(
        "SELECT processed, amount FROM boltcard_pending_topups WHERE payment_hash = $1",
        [HASH],
      )
    ).rows[0]
    expect(row).toEqual({ processed: true, amount: "1000" })
    expect(await s.markTopUpProcessed(HASH)).toBe(false)
  })

  it("an unprocessed pending top-up can still be re-stored (invoice re-issued)", async () => {
    const s = store()
    expect(await s.storePendingTopUp(CARD_A, HASH, 1_000)).toBe(true)
    expect(await s.storePendingTopUp(CARD_A, HASH, 2_000)).toBe(true)
    expect(
      (
        await sql.query(
          "SELECT amount FROM boltcard_pending_topups WHERE payment_hash = $1",
          [HASH],
        )
      ).rows[0].amount,
    ).toBe("2000")
  })

  it("a card that is not active is a definite failure, and the hash stays creditable", async () => {
    await sql.query("UPDATE boltcards SET status = 'DISABLED' WHERE id = $1", [CARD_A])
    expect(await store().topUpCard(CARD_A, 1_000, HASH)).toMatchObject({ success: false })
    expect(await store().isTopUpCredited(HASH)).toBe(false)
    await sql.query("UPDATE boltcards SET status = 'ACTIVE' WHERE id = $1", [CARD_A])
    expect((await store().topUpCard(CARD_A, 1_000, HASH)).success).toBe(true)
  })
})
