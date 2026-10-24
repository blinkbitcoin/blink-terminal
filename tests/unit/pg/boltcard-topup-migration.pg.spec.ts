/** @jest-environment node */

/**
 * Migration 032 on a database that already holds duplicate TOPUP credits
 * (possible from the pre-fix race in blink-wip#1623). Migrations run in the
 * chart's init container with ON_ERROR_STOP and the Deployment uses
 * Recreate: a failing migration would leave no running pod, so 032 must
 * apply cleanly, keep one credited hash per payment, and block new credits.
 * (Own file: the store caches lib/db's pool per module registry.)
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

import { describePg, setupTestDatabase, type TestDatabase } from "./harness"

jest.setTimeout(90_000)

const CARD_A = "card-a".padEnd(32, "0")

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

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {})
  jest.spyOn(console, "error").mockImplementation(() => {})
})

describePg("migration 032 on a database that already has duplicate credits", () => {
  let db: TestDatabase
  let sql: Client

  beforeAll(async () => {
    db = await setupTestDatabase("topup_migration", { through: 31 })
    sql = await db.connect()
  })
  afterAll(async () => {
    await sql?.end()
    await db?.teardown()
  })

  it("applies (never blocks the deploy), backfills each hash once, and blocks further credits", async () => {
    await insertCard(sql, CARD_A, "04a39493cc8680", 3_000)
    const tx = (hash: string, at: number) =>
      sql.query(
        `INSERT INTO boltcard_transactions (card_id, tx_type, amount, balance_after, payment_hash, created_at)
         VALUES ($1, 'TOPUP', 1000, 0, $2, $3)`,
        [CARD_A, hash, at],
      )
    const dup = "ee".repeat(32)
    await tx(dup, 2_000) // the pre-fix double credit
    await tx(dup, 1_000)
    await tx("ff".repeat(32), 3_000)

    await expect(db.migrateRest()).resolves.toBeUndefined()

    const rows = (
      await sql.query(
        "SELECT payment_hash, credited_at FROM boltcard_credited_topups ORDER BY payment_hash",
      )
    ).rows
    expect(rows).toEqual([
      { payment_hash: dup, credited_at: "1000" }, // earliest credit
      { payment_hash: "ff".repeat(32), credited_at: "3000" },
    ])

    const result = await store().topUpCard(CARD_A, 500, dup)
    expect(result).toMatchObject({ success: false, alreadyCredited: true })
    expect(await balanceOf(sql, CARD_A)).toBe(3_000)
  })
})
