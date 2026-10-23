/** @jest-environment node */

/**
 * Voucher store on real Postgres (blink-wip#1616): claim/cancel races, the
 * owner-listing contract and its index, and the per-wallet backing invariant
 * under real advisory locks (the cases mocked pools and PGlite cannot show).
 */

// Must stay first: sets the env lib/auth reads at module load.
import "./env"

import type { Client } from "pg"

import { isRedeemedStatus } from "../../../lib/voucher-expiry"
import {
  isLockTimeout,
  OWNER_LISTING_SQL,
  VoucherStore,
  WALLET_LOCK_SQL,
} from "../../../lib/voucher-store"

import {
  concurrently,
  describePg,
  indexesUsed,
  setupTestDatabase,
  type TestDatabase,
} from "./harness"

jest.setTimeout(60_000)

const HOUR = 60 * 60 * 1000

describePg("voucher store on real Postgres", () => {
  let db: TestDatabase
  let sql: Client
  const store = () => {
    const s = new VoucherStore()
    s.lastCleanup = Date.now() // keep lazy cleanup out of the timing-sensitive cases
    return s
  }

  beforeAll(async () => {
    db = await setupTestDatabase("vouchers")
    sql = await db.connect()
  })
  afterAll(async () => {
    await sql?.end()
    await db?.teardown()
  })
  beforeEach(async () => {
    jest.spyOn(console, "log").mockImplementation(() => {})
    jest.spyOn(console, "error").mockImplementation(() => {})
    await sql.query("TRUNCATE vouchers")
  })

  /** Direct insert with full control over timestamps / status / environment. */
  const insert = async (
    id: string,
    o: {
      walletId?: string
      environment?: string | null
      createdAt?: number
      expiresAt?: number
      status?: string
      claimed?: boolean
      claimedAt?: number | null
      cancelledAt?: number | null
      amount?: number
    } = {},
  ) => {
    const now = Date.now()
    await sql.query(
      `INSERT INTO vouchers
         (id, amount_sats, wallet_id, api_key_encrypted, status, claimed, claimed_at,
          created_at, expires_at, expiry_id, cancelled_at, environment, wallet_currency)
       VALUES ($1, $2, $3, 'enc', $4, $5, $6, $7, $8, '24h', $9, $10, 'BTC')`,
      [
        id,
        o.amount ?? 500,
        o.walletId ?? "w1",
        o.status ?? "ACTIVE",
        o.claimed ?? false,
        o.claimedAt ?? null,
        o.createdAt ?? now,
        o.expiresAt ?? now + HOUR,
        o.cancelledAt ?? null,
        o.environment === undefined ? "production" : o.environment,
      ],
    )
  }

  describe("claim / cancel races", () => {
    it("claim vs cancel on one voucher: exactly one wins, every time", async () => {
      for (let round = 0; round < 25; round++) {
        await sql.query("TRUNCATE vouchers")
        const id = `v${round}`.padEnd(32, "0")
        await insert(id)
        const [claim, cancel] = await concurrently(2, (i) =>
          i === 0 ? store().claimVoucher(id) : store().cancelVoucher(id),
        )
        const won = [claim, cancel].map(
          (r) => r.status === "fulfilled" && r.value === true,
        )
        expect(won.filter(Boolean)).toHaveLength(1)

        const row = (
          await sql.query(
            "SELECT status, claimed, cancelled_at FROM vouchers WHERE id = $1",
            [id],
          )
        ).rows[0]
        if (won[0]) {
          expect(row).toMatchObject({
            status: "CLAIMED",
            claimed: true,
            cancelled_at: null,
          })
        } else {
          expect(row.status).toBe("CANCELLED")
          expect(row.claimed).toBe(false)
        }
      }
    })

    it("ten parallel claims: exactly one succeeds", async () => {
      const id = "c".repeat(32)
      await insert(id)
      const results = await concurrently(10, () => store().claimVoucher(id))
      expect(
        results.filter((r) => r.status === "fulfilled" && r.value === true),
      ).toHaveLength(1)
      expect(
        (await sql.query("SELECT status FROM vouchers WHERE id = $1", [id])).rows[0]
          .status,
      ).toBe("CLAIMED")
    })
  })

  describe("owner listing contract", () => {
    it("scopes by wallet and environment (NULL = production), newest first, keys never decrypted", async () => {
      const now = Date.now()
      await insert("a".repeat(32), { walletId: "w1", createdAt: now - 3000 })
      await insert("b".repeat(32), {
        walletId: "w1",
        createdAt: now - 1000,
        environment: null,
      })
      await insert("c".repeat(32), { walletId: "w2", createdAt: now - 2000 })
      await insert("d".repeat(32), { walletId: "w1", environment: "staging" })
      await insert("e".repeat(32), { walletId: "w9" })

      const prod = await store().getVouchersByWalletIds(["w1", "w2"], "production")
      expect(prod.map((v) => v.id[0])).toEqual(["b", "c", "a"])
      expect(prod.every((v) => v.apiKey === null)).toBe(true)

      const staging = await store().getVouchersByWalletIds(["w1", "w2"], "staging")
      expect(staging.map((v) => v.id[0])).toEqual(["d"])
    })

    it("honours the limit", async () => {
      for (let i = 0; i < 5; i++)
        await insert(`${i}`.repeat(32), { createdAt: Date.now() + i })
      const two = await store().getVouchersByWalletIds(["w1"], "production", 2)
      expect(two.map((v) => v.id[0])).toEqual(["4", "3"])
    })

    it("stats agree with getVoucherStatus over the same rows", async () => {
      const now = Date.now()
      await insert("1".repeat(32), { expiresAt: now + 48 * HOUR }) // active, not expiring soon
      await insert("2".repeat(32), { expiresAt: now + 2 * HOUR }) // active, expiring soon
      await insert("3".repeat(32), { expiresAt: now - 1000 }) // expired
      await insert("4".repeat(32), { status: "CANCELLED", cancelledAt: now }) // cancelled
      await insert("5".repeat(32), { status: "CLAIMED", claimed: true, claimedAt: now })
      await insert("6".repeat(32), { status: "PAID", claimed: true, claimedAt: now })
      await insert("7".repeat(32), { walletId: "other" }) // out of scope

      const listed = await store().getVouchersByWalletIds(["w1"], "production")
      const stats = await store().getVoucherStatsByWalletIds(["w1"], "production")
      const fold = (pred: (s: string) => boolean) =>
        listed.filter((v) => pred(v.status)).length

      expect(stats.total).toBe(listed.length)
      expect(stats.claimed).toBe(fold(isRedeemedStatus)) // CLAIMED + PAID
      expect(stats.cancelled).toBe(fold((s) => s === "CANCELLED"))
      expect(stats.expired).toBe(fold((s) => s === "EXPIRED"))
      expect(stats.active).toBe(fold((s) => s === "ACTIVE"))
      expect(stats).toMatchObject({
        total: 6,
        active: 2,
        claimed: 2,
        cancelled: 1,
        expired: 1,
        expiringSoon: 1,
      })
    })

    it("the listing query can use idx_vouchers_env_wallet_created", async () => {
      expect(
        await indexesUsed(sql, OWNER_LISTING_SQL, [["w1", "w2"], "production", 500]),
      ).toContain("idx_vouchers_env_wallet_created")
    })
  })

  describe("backing invariant under real advisory locks", () => {
    const backing = (max: number, liability: number) => async () => ({
      maxLiabilityMinor: max,
      liabilityMinor: liability,
    })

    it("two concurrent creates against one ceiling: exactly one succeeds", async () => {
      // Without the per-wallet lock both would sum 0 and both be accepted.
      const results = await concurrently(2, () =>
        store().createVoucher(600, "blink_key", "w1", { backing: backing(1000, 600) }),
      )
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      const rejected = results.find(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult
      expect(String(rejected.reason)).toContain("exceeds the wallet balance")
      expect(
        (
          await sql.query(
            "SELECT COUNT(*)::int AS n FROM vouchers WHERE wallet_id = 'w1'",
          )
        ).rows[0].n,
      ).toBe(1)
    })

    it("markVoucherPaid waits for a create holding the wallet lock; the create sees the pre-settlement sum", async () => {
      const claimed = "p".repeat(32)
      await insert(claimed, {
        status: "CLAIMED",
        claimed: true,
        claimedAt: Date.now(),
        amount: 600,
      })

      let releaseBacking!: () => void
      const backingGate = new Promise<void>((r) => (releaseBacking = r))
      let backingEntered!: () => void
      const entered = new Promise<void>((r) => (backingEntered = r))

      // The create takes the lock, then blocks inside backing() (the Blink fetch).
      const create = store().createVoucher(600, "blink_key", "w1", {
        backing: async () => {
          backingEntered()
          await backingGate
          return { maxLiabilityMinor: 1000, liabilityMinor: 600 }
        },
      })
      await entered

      let paidResolved = false
      const paid = store()
        .markVoucherPaid(claimed)
        .then((v) => {
          paidResolved = true
          return v
        })
      try {
        await new Promise((r) => setTimeout(r, 500))
        expect(paidResolved).toBe(false) // blocked on the same wallet lock
      } finally {
        // Always let the create finish, or its pool client would keep the
        // suite's teardown waiting.
        releaseBacking()
      }
      // The create summed while still holding the lock: the CLAIMED 600 counted.
      await expect(create).rejects.toThrow("exceeds the wallet balance")
      await expect(paid).resolves.toBe(true)
      expect(
        (await sql.query("SELECT status FROM vouchers WHERE id = $1", [claimed])).rows[0]
          .status,
      ).toBe("PAID")
    })

    it("a create blocked past lock_timeout fails with SQLSTATE 55P03 (mapped to a retryable 503)", async () => {
      const holder = await db.connect()
      try {
        await holder.query("BEGIN")
        await holder.query(WALLET_LOCK_SQL, ["w1"])
        const err = await store()
          .createVoucher(100, "blink_key", "w1", { backing: backing(1000, 100) })
          .then(
            () => null,
            (e: unknown) => e,
          )
        expect(err).not.toBeNull()
        expect((err as { code?: string }).code).toBe("55P03")
        expect(isLockTimeout(err)).toBe(true)
        expect(
          (await sql.query("SELECT COUNT(*)::int AS n FROM vouchers")).rows[0].n,
        ).toBe(0)
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined)
        await holder.end()
      }
    }, 40_000)
  })
})
