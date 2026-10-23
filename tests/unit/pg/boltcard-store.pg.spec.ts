/** @jest-environment node */

/**
 * Bolt Card store on real Postgres (blink-wip#1616): consumed payment hashes
 * across concurrent claims and across a wipe + re-registration (the #1646
 * out-of-scope item), and the fair reconciliation order (migration 031) with
 * the store's own methods.
 */

// Must stay first: sets the env lib/auth reads at module load.
import "./env"

import type { Client } from "pg"

import { BoltcardStore } from "../../../lib/boltcard/store"

import { concurrently, describePg, setupTestDatabase, type TestDatabase } from "./harness"

jest.setTimeout(60_000)

describePg("Bolt Card store on real Postgres", () => {
  let db: TestDatabase
  let sql: Client
  const store = () => {
    const s = new BoltcardStore()
    s.lastCleanup = Date.now()
    return s
  }
  const HASH = "ab".repeat(32)

  beforeAll(async () => {
    db = await setupTestDatabase("boltcards")
    sql = await db.connect()
  })
  afterAll(async () => {
    await sql?.end()
    await db?.teardown()
  })
  beforeEach(async () => {
    jest.spyOn(console, "log").mockImplementation(() => {})
    jest.spyOn(console, "error").mockImplementation(() => {})
    await sql.query(
      "TRUNCATE boltcard_pending_withdrawals, boltcard_consumed_payment_hashes, boltcards CASCADE",
    )
  })

  const insertCard = async (id: string, uid = "04a39493cc8680", balance = 10_000) => {
    await sql.query(
      `INSERT INTO boltcards
         (id, card_uid, owner_pubkey, wallet_id, api_key_encrypted,
          k0_encrypted, k1_encrypted, k2_encrypted, status, balance, created_at)
       VALUES ($1, $2, $3, 'w1', 'enc', 'k0', 'k1', 'k2', 'ACTIVE', $4, $5)`,
      [id, uid, "a".repeat(64), balance, Date.now()],
    )
  }
  const balanceOf = async (id: string) =>
    Number(
      (await sql.query("SELECT balance FROM boltcards WHERE id = $1", [id])).rows[0]
        .balance,
    )

  describe("consumed payment hashes", () => {
    it("parallel claims of one hash: exactly one claims and deducts once", async () => {
      await insertCard("card-a".padEnd(32, "0"))
      const id = "card-a".padEnd(32, "0")
      const results = await concurrently(8, () =>
        store().claimAndDeductWithdrawal(HASH, id, 1000),
      )
      const statuses = results.map((r) =>
        r.status === "fulfilled" ? r.value.status : "error",
      )
      expect(statuses.filter((s) => s === "claimed")).toHaveLength(1)
      expect(statuses.filter((s) => s === "spent")).toHaveLength(7)
      expect(await balanceOf(id)).toBe(9_000)
    })

    it("claim -> wipe -> re-register (card row deleted) -> re-claim the same hash: spent, no deduction", async () => {
      const a = "card-a".padEnd(32, "0")
      await insertCard(a)
      expect((await store().claimAndDeductWithdrawal(HASH, a, 1000)).status).toBe(
        "claimed",
      )

      // Wipe, then the re-registration path deletes the WIPED card row
      // (store._completeClaimedRegistration): the withdrawal row cascades
      // away, the consumed-hash tombstone stays.
      await store().wipeCard(a)
      await sql.query("DELETE FROM boltcards WHERE id = $1", [a])
      const leftovers = await sql.query(
        `SELECT
           (SELECT COUNT(*)::int FROM boltcard_pending_withdrawals WHERE payment_hash = $1) AS withdrawals,
           (SELECT COUNT(*)::int FROM boltcard_consumed_payment_hashes WHERE payment_hash = $1) AS tombstones`,
        [HASH],
      )
      expect(leftovers.rows[0]).toEqual({ withdrawals: 0, tombstones: 1 })

      const b = "card-b".padEnd(32, "0")
      await insertCard(b) // same UID, new card
      await expect(store().claimAndDeductWithdrawal(HASH, b, 1000)).resolves.toEqual({
        status: "spent",
      })
      expect(await balanceOf(b)).toBe(10_000)
    })

    it("a fresh hash on the re-registered card claims normally", async () => {
      const b = "card-b".padEnd(32, "0")
      await insertCard(b)
      expect(
        (await store().claimAndDeductWithdrawal("cd".repeat(32), b, 500)).status,
      ).toBe("claimed")
      expect(await balanceOf(b)).toBe(9_500)
    })
  })

  describe("fair reconciliation order (migration 031) with the store's methods", () => {
    it("a stuck prefix rotates; every unresolved row is selected within ceil(n / batch) passes", async () => {
      const card = "card-a".padEnd(32, "0")
      await insertCard(card)
      const now = Date.now()
      const hashes = ["01", "02", "03", "04", "05"].map((h) => h.repeat(32))
      for (const [i, h] of hashes.entries()) {
        await sql.query(
          `INSERT INTO boltcard_pending_withdrawals
             (payment_hash, card_id, amount, balance_after, created_at, kind)
           VALUES ($1, $2, 100, 0, $3, 'UNKNOWN')`,
          [h, card, now - (10 - i) * 60_000],
        )
      }

      const seen = new Set<string>()
      for (let pass = 0; pass < 3; pass++) {
        const batch = await store().getPendingWithdrawals(undefined, 2)
        for (const row of batch) {
          seen.add(row.paymentHash)
          await store().markWithdrawalChecked(
            row.paymentHash,
            now + pass * 10 + seen.size,
          )
        }
      }
      expect([...seen].sort()).toEqual([...hashes].sort())
      expect(await store().countPendingWithdrawals()).toBe(5)
    })
  })
})
