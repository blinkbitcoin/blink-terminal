/** @jest-environment node */

/**
 * Ledger reconciliation for pre-PR#94 CLAIMED vouchers: only a unique,
 * settled outgoing Blink payment can transition a legacy claim to PAID.
 */

// voucher-store imports AuthManager at module scope (JWT_SECRET guard).
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: { encryptApiKey: (k: string) => k, decryptApiKey: (k: string) => k },
}))
jest.mock("../../lib/db", () => ({ getSharedPool: () => ({ query: jest.fn() }) }))

import { encode as encodeInvoice, sign as signInvoice } from "bolt11"

import { buildVoucherMemo as callbackMemo } from "../../lib/voucher-memo"
import {
  LOCK_TIMEOUT_SQL as STORE_LOCK_TIMEOUT_SQL,
  MARK_VOUCHER_PAID_SQL,
  WALLET_LOCK_SQL as STORE_WALLET_LOCK_SQL,
} from "../../lib/voucher-store"

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  buildVoucherMemo,
  invoicePrincipalSats,
  matchRedemptionCandidates,
  classifyVoucher,
  fetchTransactions,
  isAuthFailure,
  MIN_APPLY_AGE_MINUTES,
  WINDOW_AFTER_MS,
  reconcileClaimedVouchers,
  parseArgs,
  MARK_PAID_SQL,
  WALLET_LOCK_SQL,
  LOCK_TIMEOUT_SQL,
} = require("../../scripts/reconcile-voucher-claims")

const NOW = 1_760_000_000_000
const MINUTE = 60 * 1000

const PRIVKEY = "e126f68f7eafcc8b74f54d269fe206be715000f94dac067d1c04a8ca3b2db734"
const HASH = "ab".repeat(32)
const TEST_NETWORKS = {
  regtest: {
    bech32: "bcrt",
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    validWitnessVersions: [0, 1],
  },
  testnet: {
    bech32: "tb",
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    validWitnessVersions: [0, 1],
  },
  signet: {
    bech32: "tbs",
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    validWitnessVersions: [0, 1],
  },
}

/** A signed BOLT11 invoice (cached: signing is the slow part). */
const invoiceCache = new Map<string, string>()
const lnInvoice = ({
  sats,
  millisats,
  hash = HASH,
  network,
}: {
  sats?: number
  millisats?: string
  hash?: string
  network?: keyof typeof TEST_NETWORKS
}): string => {
  const key = JSON.stringify({ sats, millisats, hash, network })
  const cached = invoiceCache.get(key)
  if (cached) return cached
  const encoded = encodeInvoice({
    ...(sats !== undefined ? { satoshis: sats } : {}),
    ...(millisats !== undefined ? { millisatoshis: millisats } : {}),
    ...(network ? { network: TEST_NETWORKS[network] } : {}),
    timestamp: Math.floor(NOW / 1000),
    tags: [
      { tagName: "payment_hash", data: hash },
      { tagName: "payment_secret", data: "11".repeat(32) },
      { tagName: "description", data: "voucher" },
    ],
  })
  const request = signInvoice(encoded, PRIVKEY).paymentRequest as string
  invoiceCache.set(key, request)
  return request
}

/** Blink's initiationVia for a Lightning send of `sats`. */
const lnVia = (sats: number, overrides: Record<string, unknown> = {}) => ({
  __typename: "InitiationViaLn",
  paymentHash: HASH,
  paymentRequest: lnInvoice({ sats }),
  ...overrides,
})

const voucher = (overrides: Record<string, unknown> = {}) => ({
  id: "v1",
  amount: 500,
  usdAmountCents: null,
  walletCurrency: "BTC",
  claimedAt: NOW,
  ...overrides,
})

const tx = (overrides: Record<string, unknown> = {}) => ({
  id: "tx1",
  direction: "SEND",
  status: "SUCCESS",
  settlementAmount: -500,
  settlementFee: 0,
  settlementCurrency: "BTC",
  createdAt: Math.floor(NOW / 1000), // Blink Timestamp is Unix seconds
  memo: "BlinkPOS Voucher: 500 sats",
  initiationVia: lnVia(500),
  ...overrides,
})

describe("invoicePrincipalSats", () => {
  it("decodes the recorded invoice's amount in whole sats", () => {
    expect(invoicePrincipalSats(tx())).toBe(500)
    expect(invoicePrincipalSats(tx({ initiationVia: lnVia(2000) }))).toBe(2000)
  })

  it.each([
    ["regtest", "lnbcrt"],
    ["testnet", "lntb"],
    ["signet", "lntbs"],
  ] as const)("decodes %s invoices (%s)", (network, prefix) => {
    const via = lnVia(500, { paymentRequest: lnInvoice({ sats: 500, network }) })
    expect(via.paymentRequest.startsWith(prefix)).toBe(true)
    expect(invoicePrincipalSats(tx({ initiationVia: via }))).toBe(500)
  })

  it("returns null when the principal cannot be established", () => {
    const cases = [
      undefined,
      { __typename: "InitiationViaIntraLedger", counterPartyWalletId: "w2" },
      lnVia(500, { paymentRequest: "" }), // Blink's resolver failure value
      lnVia(500, { paymentRequest: "lnbc1notaninvoice" }),
      lnVia(500, { paymentHash: "cd".repeat(32) }), // hash not bound to tx
      lnVia(500, { paymentHash: "" }),
      lnVia(0, { paymentRequest: lnInvoice({}) }), // amountless
      lnVia(0, { paymentRequest: lnInvoice({ millisats: "500500" }) }), // sub-sat
    ]
    for (const initiationVia of cases) {
      expect(invoicePrincipalSats(tx({ initiationVia }))).toBeNull()
    }
  })
})

describe("matchRedemptionCandidates", () => {
  it("matches a unique settled BTC payment at the claim time", () => {
    // Production shape: Blink's settlementAmount is signed (credit - debit),
    // so an outgoing payment is negative.
    expect(matchRedemptionCandidates(voucher(), [tx()])).toHaveLength(1)
  })

  it("matches by settlement-amount magnitude, not sign", () => {
    expect(
      matchRedemptionCandidates(voucher(), [tx({ settlementAmount: -500 })]),
    ).toHaveLength(1)
    expect(
      matchRedemptionCandidates(voucher(), [tx({ settlementAmount: 500 })]),
    ).toHaveLength(1)
  })

  it("matches a settled USD voucher whatever cents were debited", () => {
    // The callback pays a fixed 2000-sat invoice from the USD wallet, so the
    // cents debited follow the redemption-time rate, not usd_amount_cents.
    const usdVoucher = voucher({
      amount: 2000,
      usdAmountCents: 100,
      walletCurrency: "USD",
    })
    const usdTx = tx({
      settlementAmount: -103,
      settlementFee: 0,
      settlementCurrency: "USD",
      memo: "BlinkPOS USD Voucher: $1.00 USD = 2000 sats",
      initiationVia: lnVia(2000),
    })
    expect(matchRedemptionCandidates(usdVoucher, [usdTx])).toHaveLength(1)
    // A different USD voucher's memo never matches
    expect(
      matchRedemptionCandidates(usdVoucher, [
        tx({ ...usdTx, memo: "BlinkPOS USD Voucher: $1.01 USD = 2000 sats" }),
      ]),
    ).toEqual([])
  })

  describe("USD principal is bound to the paid invoice, not the memo", () => {
    const usdVoucher = voucher({
      amount: 2000,
      usdAmountCents: 10000,
      walletCurrency: "USD",
    })
    const memo = "BlinkPOS USD Voucher: $100.00 USD = 2000 sats"
    const usdTx = (overrides: Record<string, unknown>) =>
      tx({ settlementCurrency: "USD", settlementFee: 0, memo, ...overrides })

    it("matches the face-value invoice at any redemption-time cents", () => {
      expect(
        matchRedemptionCandidates(usdVoucher, [
          usdTx({ settlementAmount: -9700, initiationVia: lnVia(2000) }),
        ]),
      ).toHaveLength(1)
    })

    it("rejects a tiny same-memo transaction (the reviewer's probe)", () => {
      expect(
        matchRedemptionCandidates(usdVoucher, [
          // 1 cent paying a 1-sat invoice
          usdTx({ id: "tiny-ln", settlementAmount: -1, initiationVia: lnVia(1) }),
          // 1 cent with no Lightning invoice at all (intraledger send)
          usdTx({
            id: "tiny-intraledger",
            settlementAmount: -1,
            initiationVia: { __typename: "InitiationViaIntraLedger" },
          }),
          // 1 cent, invoice unresolvable
          usdTx({ id: "tiny-no-pr", settlementAmount: -1, initiationVia: undefined }),
        ]),
      ).toEqual([])
    })

    it("rejects a wrong-principal same-memo transaction", () => {
      expect(
        matchRedemptionCandidates(usdVoucher, [
          usdTx({ settlementAmount: -9700, initiationVia: lnVia(1999) }),
          usdTx({ settlementAmount: -9700, initiationVia: lnVia(2001) }),
        ]),
      ).toEqual([])
    })

    it("rejects an invoice not bound to the transaction's payment hash", () => {
      expect(
        matchRedemptionCandidates(usdVoucher, [
          usdTx({
            settlementAmount: -9700,
            initiationVia: lnVia(2000, { paymentHash: "cd".repeat(32) }),
          }),
        ]),
      ).toEqual([])
    })

    it("rejects a face-value invoice with no principal debited", () => {
      expect(
        matchRedemptionCandidates(usdVoucher, [
          usdTx({ settlementAmount: -3, settlementFee: 3, initiationVia: lnVia(2000) }),
        ]),
      ).toEqual([])
    })
  })

  it("BTC requires both the invoice and the debited principal at face value", () => {
    expect(
      matchRedemptionCandidates(voucher(), [
        tx({ settlementAmount: -400, initiationVia: lnVia(500) }),
        tx({ settlementAmount: -500, initiationVia: lnVia(400) }),
      ]),
    ).toEqual([])
  })

  it("matches a fee-bearing external send on its principal", () => {
    // Blink debits principal + fee: a 500-sat redemption with a 10-sat fee
    // is recorded as -510 with settlementFee 10.
    expect(
      matchRedemptionCandidates(voucher(), [
        tx({ settlementAmount: -510, settlementFee: 10 }),
      ]),
    ).toHaveLength(1)
    expect(
      matchRedemptionCandidates(voucher(), [
        tx({ settlementAmount: -510, settlementFee: -10 }),
      ]),
    ).toHaveLength(1)
  })

  it("attributes overlapping face values by principal (500 + fee vs 510)", () => {
    const fee500 = tx({ settlementAmount: -510, settlementFee: 10 })
    const v510 = voucher({ id: "v510", amount: 510 })
    expect(matchRedemptionCandidates(voucher(), [fee500])).toHaveLength(1)
    expect(matchRedemptionCandidates(v510, [fee500])).toEqual([])
    // Even with the 510 voucher's memo, a 500 principal is not a 510 payout
    expect(
      matchRedemptionCandidates(v510, [
        tx({
          settlementAmount: -510,
          settlementFee: 10,
          memo: "BlinkPOS Voucher: 510 sats",
        }),
      ]),
    ).toEqual([])
  })

  it("fails closed when fee data is absent", () => {
    expect(
      matchRedemptionCandidates(voucher(), [
        tx({ settlementFee: undefined }),
        tx({ settlementFee: null }),
        tx({ settlementFee: "n/a" }),
      ]),
    ).toEqual([])
  })

  it("requires the exact memo the callback wrote for this voucher", () => {
    expect(
      matchRedemptionCandidates(voucher(), [
        tx({ memo: "BlinkPOS Voucher: 5000 sats" }),
        tx({ memo: "BlinkPOS Voucher: EUR 0.30 = 500 sats" }),
        tx({ memo: "BlinkPOS Voucher: 500 sats " }),
      ]),
    ).toEqual([])
    const displayVoucher = voucher({
      displayAmount: "0.30",
      displayCurrency: "EUR",
      commissionPercent: 5,
    })
    expect(
      matchRedemptionCandidates(displayVoucher, [
        tx({ memo: "BlinkPOS Voucher: EUR 0.30 (5% commission) = 500 sats" }),
      ]),
    ).toHaveLength(1)
  })

  it("requires the settlement currency", () => {
    expect(
      matchRedemptionCandidates(voucher(), [tx({ settlementCurrency: undefined })]),
    ).toEqual([])
  })

  it("requires the settlement amount to equal the voucher amount", () => {
    expect(
      matchRedemptionCandidates(voucher(), [tx({ settlementAmount: -501 })]),
    ).toEqual([])
    // A BTC payment cannot confirm a USD voucher (and vice versa).
    expect(
      matchRedemptionCandidates(voucher({ walletCurrency: "USD", usdAmountCents: 100 }), [
        tx(),
      ]),
    ).toEqual([])
  })

  it("ignores incoming, unsettled and non-voucher payments", () => {
    expect(
      matchRedemptionCandidates(voucher(), [
        tx({ direction: "RECEIVE" }),
        tx({ direction: undefined }),
        tx({ status: "ALREADY_PAID" }), // not a TxStatus: never settled
        tx({ status: "PENDING" }),
        tx({ status: "FAILED" }),
        tx({ memo: "BlinkPOS payment" }),
        tx({ memo: "" }),
      ]),
    ).toEqual([])
  })

  it("only matches payments around the claim time", () => {
    expect(
      matchRedemptionCandidates(voucher(), [
        tx({ createdAt: Math.floor((NOW - 3 * MINUTE) / 1000) }),
        tx({ createdAt: Math.floor((NOW + 31 * MINUTE) / 1000) }),
      ]),
    ).toEqual([])
    // Window is inclusive: 2 min before / 30 min after.
    expect(
      matchRedemptionCandidates(voucher(), [
        tx({ createdAt: Math.floor((NOW - 2 * MINUTE) / 1000) }),
      ]),
    ).toHaveLength(1)
    expect(
      matchRedemptionCandidates(voucher(), [
        tx({ createdAt: Math.floor((NOW + 30 * MINUTE) / 1000) }),
      ]),
    ).toHaveLength(1)
  })

  it("tolerates millisecond timestamps", () => {
    expect(
      matchRedemptionCandidates(voucher(), [tx({ createdAt: NOW + 1000 })]),
    ).toHaveLength(1)
  })

  it("classifies multiple candidates as ambiguous (never settled)", () => {
    const result = classifyVoucher(voucher(), [tx({ id: "a" }), tx({ id: "b" })])
    expect(result.outcome).toBe("ambiguous")
    expect(result.candidates).toHaveLength(2)
  })
})

describe("reconcileClaimedVouchers", () => {
  // Older than the default 60-minute minimum age, and the ledger payment is
  // anchored to the claim instant.
  const CLAIMED_AT = NOW - 2 * 60 * MINUTE
  const settledTx = (overrides: Record<string, unknown> = {}) =>
    tx({ createdAt: Math.floor(CLAIMED_AT / 1000), ...overrides })

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "v1",
    status: "CLAIMED",
    amount_sats: "500",
    usd_amount_cents: null,
    wallet_id: "w1",
    api_key_encrypted: "enc",
    claimed_at: CLAIMED_AT,
    environment: "production",
    wallet_currency: "BTC",
    display_amount: null,
    display_currency: null,
    commission_percent: "0.00",
    ...overrides,
  })

  const setup = (rows: Array<Record<string, unknown>>) => {
    // Every statement, from the pool (the SELECT) and from the transaction
    // client (--apply writes), in order.
    const queries: Array<[string, unknown[]]> = []
    const record = async (text: string, params: unknown[]) => {
      queries.push([text, params])
      if (text.startsWith("SELECT id, status")) return { rows }
      if (text.startsWith("UPDATE")) return { rows: [{ id: params[0] }], rowCount: 1 }
      return { rows: [] }
    }
    const release = jest.fn()
    const pool = {
      query: jest.fn(record),
      connect: jest.fn(async () => ({ query: jest.fn(record), release })),
    }
    return { pool, queries, release }
  }

  it("reports matches in dry-run without writing", async () => {
    const { pool, queries } = setup([row()])
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(async () => [settledTx()]),
      decryptApiKey: () => "key",
      apply: false,
      now: NOW,
      log: () => {},
    })

    expect(summary).toMatchObject({ checked: 1, matched: 1, applied: 0 })
    expect(queries.filter(([text]) => text.startsWith("UPDATE"))).toEqual([])
  })

  it("transitions only uniquely matched vouchers on --apply", async () => {
    const { pool, queries } = setup([
      row({ id: "matched" }),
      row({ id: "unmatched", amount_sats: "999" }),
    ])
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(async () => [settledTx()]),
      decryptApiKey: () => "key",
      apply: true,
      now: NOW,
      log: () => {},
    })

    expect(summary).toMatchObject({ checked: 2, matched: 1, applied: 1, unmatched: 1 })
    const updates = queries.filter(([text]) => text.startsWith("UPDATE"))
    expect(updates).toHaveLength(1)
    expect(updates[0][1]).toEqual(["matched"])
    expect(MARK_PAID_SQL).toContain("status = 'CLAIMED'")
  })

  it("--apply skips a voucher whose wallet lock times out and continues", async () => {
    // A live create holds w1's lock past lock_timeout: nothing is written for
    // that voucher, the run goes on, and the summary says to re-run.
    const { pool, queries } = setup([
      row({ id: "busy" }),
      row({ id: "free", wallet_id: "w2" }),
    ])
    const original = pool.connect.getMockImplementation() as () => Promise<{
      query: jest.Mock
      release: jest.Mock
    }>
    pool.connect.mockImplementation(async () => {
      const client = await original()
      const inner = client.query.getMockImplementation() as (
        t: string,
        p: unknown[],
      ) => Promise<unknown>
      client.query.mockImplementation(async (text: string, params: unknown[]) => {
        if (text.includes("pg_advisory_xact_lock") && params[0] === "w1") {
          queries.push([text, params])
          throw Object.assign(new Error("canceling statement due to lock timeout"), {
            code: "55P03",
          })
        }
        return inner(text, params)
      })
      return client
    })

    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(async () => [settledTx()]),
      decryptApiKey: () => "key",
      apply: true,
      now: NOW,
      log: () => {},
    })

    expect(summary).toMatchObject({ checked: 2, matched: 2, applied: 1, lockTimeouts: 1 })
    const updates = queries.filter(([text]) => text.startsWith("UPDATE"))
    expect(updates.map(([, p]) => p)).toEqual([["free"]])
    expect(queries.filter(([t]) => t === "ROLLBACK")).toHaveLength(1)
  })

  it("--apply writes under the wallet lock (BACKING INVARIANT)", async () => {
    const { pool, queries, release } = setup([row()])
    await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(async () => [settledTx()]),
      decryptApiKey: () => "key",
      apply: true,
      now: NOW,
      log: () => {},
    })
    const texts = queries.map(([t]) => t)
    const begin = texts.indexOf("BEGIN")
    expect(begin).toBeGreaterThan(0)
    expect(texts.slice(begin)).toEqual([
      "BEGIN",
      LOCK_TIMEOUT_SQL,
      WALLET_LOCK_SQL,
      MARK_PAID_SQL,
      "COMMIT",
    ])
    expect(queries[begin + 2][1]).toEqual(["w1"]) // lock on the voucher's wallet
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("leaves ambiguous vouchers CLAIMED", async () => {
    const { pool, queries } = setup([row()])
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(async () => [
        settledTx({ id: "a" }),
        settledTx({ id: "b" }),
      ]),
      decryptApiKey: () => "key",
      apply: true,
      now: NOW,
      log: () => {},
    })

    expect(summary).toMatchObject({ matched: 0, applied: 0, ambiguous: 1 })
    expect(queries.filter(([text]) => text.startsWith("UPDATE"))).toEqual([])
  })

  it("skips wallets whose API key cannot be decrypted", async () => {
    const { pool } = setup([row()])
    const fetchTransactions = jest.fn()
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions,
      decryptApiKey: () => null,
      now: NOW,
      log: () => {},
    })

    expect(summary).toMatchObject({ checked: 1, skippedWallets: 1 })
    expect(fetchTransactions).not.toHaveBeenCalled()
  })

  it("skips a wallet when the ledger call fails", async () => {
    const { pool } = setup([row()])
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(async () => {
        throw new Error("Blink API HTTP 500")
      }),
      decryptApiKey: () => "key",
      now: NOW,
      log: () => {},
    })

    expect(summary).toMatchObject({ checked: 1, skippedWallets: 1, matched: 0 })
  })

  it("loads every claimed voucher of the wallet; only old CLAIMED rows are targets", async () => {
    const { pool, queries } = setup([
      row({ id: "young", claimed_at: NOW - 10 * MINUTE }),
      row({ id: "paid", status: "PAID" }),
    ])
    const fetchTransactions = jest.fn()
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions,
      decryptApiKey: () => "key",
      walletId: "w9",
      minAgeMinutes: 15,
      now: NOW,
      log: () => {},
    })

    const [text, params] = queries[0]
    expect(text).toContain("status IN ('CLAIMED', 'PAID')")
    expect(text).toContain("wallet_id = $1")
    expect(params).toEqual(["w9"])
    // Neither row is a target: no ledger call, nothing checked
    expect(summary).toMatchObject({ checked: 0, matched: 0 })
    expect(fetchTransactions).not.toHaveBeenCalled()
  })

  it("scopes the ledger query to the voucher's wallet", async () => {
    const { pool } = setup([row()])
    const fetchTransactions = jest.fn(async () => [settledTx()])
    await reconcileClaimedVouchers({
      pool,
      fetchTransactions,
      decryptApiKey: () => "key",
      now: NOW,
      log: () => {},
    })
    expect(fetchTransactions).toHaveBeenCalledWith(
      "key",
      "production",
      expect.objectContaining({ walletId: "w1" }),
    )
  })

  it("an incomplete ledger scan never writes, even with one visible candidate", async () => {
    // The page cap stopped the scan before the target's window was covered:
    // the single visible candidate might be contested by a transaction in
    // the unscanned part, so --apply must not mark PAID.
    const { pool, queries } = setup([row()])
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(async () => ({
        transactions: [settledTx()],
        complete: false,
        pages: 5,
      })),
      decryptApiKey: () => "key",
      apply: true,
      now: NOW,
      log: () => {},
    })

    expect(summary).toMatchObject({
      checked: 1,
      matched: 1,
      applied: 0,
      unverified: 1,
      incompleteWallets: 1,
    })
    expect(queries.filter(([text]) => text.startsWith("UPDATE"))).toEqual([])
  })

  it("a complete scan ({transactions, complete: true}) writes as before", async () => {
    const { pool, queries } = setup([row()])
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(async () => ({
        transactions: [settledTx()],
        complete: true,
        pages: 1,
      })),
      decryptApiKey: () => "key",
      apply: true,
      now: NOW,
      log: () => {},
    })
    expect(summary).toMatchObject({
      matched: 1,
      applied: 1,
      unverified: 0,
      incompleteWallets: 0,
    })
    expect(queries.filter(([text]) => text.startsWith("UPDATE"))).toHaveLength(1)
  })

  describe("claim-after-snapshot race (--min-age-minutes floor for --apply)", () => {
    // A is 20 minutes old. The competitor snapshot (the SELECT) sees only A.
    // Then B — same wallet/memo/amount — is claimed and paid; its payment
    // lands inside A's +30-minute window, B is not in the competitor map.
    const A_CLAIMED_AT = NOW - 20 * MINUTE
    const B_PAID_AT = NOW - 1 * MINUTE
    const raceSetup = () => {
      const { pool, queries } = setup([row({ id: "a", claimed_at: A_CLAIMED_AT })])
      const ledger = jest.fn(async () => ({
        transactions: [
          settledTx({ id: "tx-b", createdAt: Math.floor(B_PAID_AT / 1000) }),
        ],
        complete: true,
      }))
      return { pool, queries, ledger }
    }

    it("floor = match window + 1 minute", () => {
      expect(MIN_APPLY_AGE_MINUTES).toBe(WINDOW_AFTER_MS / MINUTE + 1)
      expect(MIN_APPLY_AGE_MINUTES).toBe(31)
    })

    it("dry run below the floor shows the unsafe unique match — flagged unverified", async () => {
      const { pool, queries, ledger } = raceSetup()
      const logs: string[] = []
      const summary = await reconcileClaimedVouchers({
        pool,
        fetchTransactions: ledger,
        decryptApiKey: () => "key",
        apply: false,
        minAgeMinutes: 15,
        now: NOW,
        log: (m: string) => logs.push(m),
      })
      // B's payment looks unique to A: this is what the floor prevents.
      expect(summary).toMatchObject({ checked: 1, matched: 1, unverified: 1, applied: 0 })
      expect(logs.some((l) => l.startsWith("[warn] --min-age-minutes 15"))).toBe(true)
      expect(logs.some((l) => l.includes("match window may still be open"))).toBe(true)
      expect(queries.filter(([t]) => t.startsWith("UPDATE"))).toEqual([])
    })

    it("--apply below the floor is refused before any query", async () => {
      const { pool, queries, ledger } = raceSetup()
      await expect(
        reconcileClaimedVouchers({
          pool,
          fetchTransactions: ledger,
          decryptApiKey: () => "key",
          apply: true,
          minAgeMinutes: 15,
          now: NOW,
          log: () => {},
        }),
      ).rejects.toThrow("--apply requires --min-age-minutes >= 31")
      expect(queries).toEqual([])
      expect(ledger).not.toHaveBeenCalled()
    })

    it("--apply at the floor runs; A (20 min old) is then not a target", async () => {
      const { pool, queries, ledger } = raceSetup()
      const summary = await reconcileClaimedVouchers({
        pool,
        fetchTransactions: ledger,
        decryptApiKey: () => "key",
        apply: true,
        minAgeMinutes: MIN_APPLY_AGE_MINUTES,
        now: NOW,
        log: () => {},
      })
      expect(summary).toMatchObject({ checked: 0, applied: 0 })
      expect(queries.filter(([t]) => t.startsWith("UPDATE"))).toEqual([])
    })
  })

  describe("credential failover", () => {
    const AUTH_401 = () => new Error("Blink API HTTP 401")

    it("tries a newer valid key when an older claim's key was revoked", async () => {
      // Two targets on w1: the older claim stored the revoked key, the newer
      // one a valid replacement. Rows arrive oldest first.
      const { pool, queries } = setup([
        row({
          id: "old",
          api_key_encrypted: "enc-revoked",
          claimed_at: CLAIMED_AT - 10 * MINUTE,
        }),
        row({ id: "new", api_key_encrypted: "enc-valid" }),
      ])
      const ledger = jest.fn(async (apiKey: string) => {
        if (apiKey === "revoked") throw AUTH_401()
        return { transactions: [settledTx()], complete: true }
      })
      const logs: string[] = []
      const summary = await reconcileClaimedVouchers({
        pool,
        fetchTransactions: ledger,
        decryptApiKey: (enc: string) => enc.replace("enc-", ""),
        apply: true,
        now: NOW,
        log: (m: string) => logs.push(m),
      })

      // Newest key first, so the valid one is tried first here; the wallet
      // is scanned and both targets classified (one payment -> contested).
      expect(ledger).toHaveBeenCalledTimes(1)
      expect(ledger.mock.calls[0][0]).toBe("valid")
      expect(summary).toMatchObject({ checked: 2, skippedWallets: 0, ambiguous: 2 })
      expect(queries.filter(([t]) => t.startsWith("UPDATE"))).toEqual([])
    })

    it("falls over to the next key on an auth rejection", async () => {
      const { pool } = setup([
        row({
          id: "old",
          api_key_encrypted: "enc-valid",
          claimed_at: CLAIMED_AT - 10 * MINUTE,
        }),
        row({ id: "new", api_key_encrypted: "enc-revoked" }), // newest, tried first, rejected
      ])
      const ledger = jest.fn(async (apiKey: string) => {
        if (apiKey === "revoked") throw AUTH_401()
        return { transactions: [], complete: true }
      })
      const summary = await reconcileClaimedVouchers({
        pool,
        fetchTransactions: ledger,
        decryptApiKey: (enc: string) => enc.replace("enc-", ""),
        now: NOW,
        log: () => {},
      })
      expect(ledger.mock.calls.map((c) => c[0])).toEqual(["revoked", "valid"])
      expect(summary).toMatchObject({ checked: 2, skippedWallets: 0, unmatched: 2 })
    })

    it("skips the wallet only after every key fails, listing what was tried", async () => {
      const { pool } = setup([
        row({
          id: "a",
          api_key_encrypted: "enc-r1",
          claimed_at: CLAIMED_AT - 10 * MINUTE,
        }),
        row({ id: "b", api_key_encrypted: "enc-r2" }),
        row({ id: "c", api_key_encrypted: "enc-bad" }), // undecryptable
      ])
      const logs: string[] = []
      const summary = await reconcileClaimedVouchers({
        pool,
        fetchTransactions: jest.fn(async () => {
          throw AUTH_401()
        }),
        decryptApiKey: (enc: string) => (enc === "enc-bad" ? null : enc),
        now: NOW,
        log: (m: string) => logs.push(m),
      })
      expect(summary).toMatchObject({ checked: 3, skippedWallets: 1 })
      expect(logs.find((l) => l.startsWith("[skip] wallet w1"))).toContain(
        "3 key(s) tried",
      )
    })

    it("does not try further keys on a non-auth failure (5xx)", async () => {
      const { pool } = setup([
        row({
          id: "old",
          api_key_encrypted: "enc-a",
          claimed_at: CLAIMED_AT - 10 * MINUTE,
        }),
        row({ id: "new", api_key_encrypted: "enc-b" }),
      ])
      const ledger = jest.fn(async () => {
        throw new Error("Blink API HTTP 502")
      })
      const summary = await reconcileClaimedVouchers({
        pool,
        fetchTransactions: ledger,
        decryptApiKey: (enc: string) => enc,
        now: NOW,
        log: () => {},
      })
      expect(ledger).toHaveBeenCalledTimes(1)
      expect(summary).toMatchObject({ skippedWallets: 1 })
    })

    it("recognizes Blink auth rejections", () => {
      for (const m of [
        "Blink API HTTP 401",
        "Blink API HTTP 403",
        "Not authorized",
        "UNAUTHENTICATED",
        "Invalid API key",
      ]) {
        expect(isAuthFailure(new Error(m))).toBe(true)
      }
      for (const m of ["Blink API HTTP 502", "socket hang up", "Blink API HTTP 4010"]) {
        expect(isAuthFailure(new Error(m))).toBe(false)
      }
    })
  })

  it("never credits a recent claim's payment to a legacy claim", async () => {
    // A (legacy, payout never settled) claimed 61 min ago; B (same face
    // value) claimed 40 min ago and settled — inside A's +30 min window but
    // too young to be a target. B still competes, so A stays CLAIMED.
    const aClaimedAt = NOW - 61 * MINUTE
    const bClaimedAt = NOW - 40 * MINUTE
    const { pool, queries } = setup([
      row({ id: "a", claimed_at: aClaimedAt }),
      row({ id: "b", claimed_at: bClaimedAt }),
    ])
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(async () => [
        settledTx({ createdAt: Math.floor(bClaimedAt / 1000) }),
      ]),
      decryptApiKey: () => "key",
      apply: true,
      now: NOW,
      log: () => {},
    })

    expect(summary).toMatchObject({ checked: 1, matched: 0, applied: 0, ambiguous: 1 })
    expect(queries.filter(([text]) => text.startsWith("UPDATE"))).toEqual([])
  })

  it("never credits an already-PAID voucher's payment to a legacy claim", async () => {
    const { pool, queries } = setup([
      row({ id: "a" }),
      row({ id: "p", status: "PAID", claimed_at: CLAIMED_AT + 5 * MINUTE }),
    ])
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(async () => [
        settledTx({ createdAt: Math.floor((CLAIMED_AT + 5 * MINUTE) / 1000) }),
      ]),
      decryptApiKey: () => "key",
      apply: true,
      now: NOW,
      log: () => {},
    })

    expect(summary).toMatchObject({ checked: 1, matched: 0, applied: 0, ambiguous: 1 })
    expect(queries.filter(([text]) => text.startsWith("UPDATE"))).toEqual([])
  })

  it("rebuilds display/commission memos from the row like the store does", async () => {
    const { pool } = setup([
      row({
        display_amount: "0.30",
        display_currency: "EUR",
        commission_percent: "5.00",
      }),
    ])
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(async () => [
        settledTx({ memo: "BlinkPOS Voucher: EUR 0.30 (5% commission) = 500 sats" }),
      ]),
      decryptApiKey: () => "key",
      now: NOW,
      log: () => {},
    })
    expect(summary).toMatchObject({ checked: 1, matched: 1 })
  })

  it("does not credit one payment to two nearby vouchers", async () => {
    // Voucher B was claimed 1 minute after A's payment, same amount: the
    // single settled tx is a candidate for both, so neither is confirmed.
    const { pool, queries } = setup([
      row({ id: "a" }),
      row({ id: "b", claimed_at: CLAIMED_AT + MINUTE }),
    ])
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(async () => [settledTx()]),
      decryptApiKey: () => "key",
      apply: true,
      now: NOW,
      log: () => {},
    })

    expect(summary).toMatchObject({ checked: 2, matched: 0, applied: 0, ambiguous: 2 })
    expect(queries.filter(([text]) => text.startsWith("UPDATE"))).toEqual([])
  })
})

describe("parseArgs", () => {
  it("defaults to a 60-minute dry run", () => {
    expect(parseArgs([])).toMatchObject({
      apply: false,
      walletId: null,
      minAgeMinutes: 60,
      maxPages: 5,
      help: false,
    })
  })

  it("parses flags", () => {
    expect(
      parseArgs([
        "--apply",
        "--wallet",
        "w1",
        "--min-age-minutes",
        "45",
        "--max-pages",
        "3",
      ]),
    ).toMatchObject({
      apply: true,
      walletId: "w1",
      minAgeMinutes: 45,
      maxPages: 3,
    })
    // Dry runs may use any non-negative age
    expect(parseArgs(["--min-age-minutes", "15"]).minAgeMinutes).toBe(15)
  })

  it("refuses --apply below the match-window floor at the CLI", () => {
    expect(() => parseArgs(["--apply", "--min-age-minutes", "15"])).toThrow(
      "--apply requires --min-age-minutes >= 31",
    )
    expect(parseArgs(["--apply", "--min-age-minutes", "31"]).minAgeMinutes).toBe(31)
    expect(parseArgs(["--apply"]).minAgeMinutes).toBe(60) // default unchanged
  })

  it("rejects invalid numeric options", () => {
    expect(() => parseArgs(["--min-age-minutes", "-1"])).toThrow(
      "--min-age-minutes must be a non-negative number",
    )
    expect(() => parseArgs(["--max-pages", "0"])).toThrow(
      "--max-pages must be a positive integer",
    )
  })
})

describe("parity with the callback and the store", () => {
  it("rebuilds exactly the memo the redemption callback writes", () => {
    const cases = [
      { amount: 500 },
      {
        amount: 500,
        walletCurrency: "BTC",
        displayAmount: "0.30",
        displayCurrency: "EUR",
      },
      {
        amount: 500,
        displayAmount: "0.30",
        displayCurrency: "EUR",
        commissionPercent: 2.5,
      },
      { amount: 2000, walletCurrency: "USD", usdAmountCents: 100 },
      {
        amount: 2000,
        walletCurrency: "USD",
        usdAmountCents: 105,
        displayAmount: "1000",
        displayCurrency: "ARS",
      },
      {
        amount: 2000,
        walletCurrency: "USD",
        usdAmountCents: 105,
        displayAmount: "1000",
        displayCurrency: "ARS",
        commissionPercent: 3,
      },
      {
        amount: 2000,
        walletCurrency: "USD",
        usdAmountCents: 100,
        displayAmount: "1.00",
        displayCurrency: "USD",
      },
      { amount: 2000, walletCurrency: "USD", usdAmountCents: null },
    ]
    for (const fields of cases) {
      expect(buildVoucherMemo(fields)).toBe(callbackMemo(fields))
    }
  })

  it("marks PAID with the same SQL and lock statements as the store", () => {
    const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim()
    expect(normalize(MARK_PAID_SQL)).toBe(normalize(MARK_VOUCHER_PAID_SQL))
    expect(WALLET_LOCK_SQL).toBe(STORE_WALLET_LOCK_SQL)
    expect(LOCK_TIMEOUT_SQL).toBe(STORE_LOCK_TIMEOUT_SQL)
  })
})

describe("fetchTransactions", () => {
  const page = (
    nodes: Array<Record<string, unknown>>,
    {
      hasNextPage = false,
      endCursor = "c",
    }: { hasNextPage?: boolean; endCursor?: string | null } = {},
  ) => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        me: {
          defaultAccount: {
            transactions: {
              edges: nodes.map((node, i) => ({ cursor: `c${i}`, node })),
              pageInfo: { hasNextPage, endCursor },
            },
          },
        },
      },
    }),
  })
  const at = (ms: number) => tx({ id: `t${ms}`, createdAt: Math.floor(ms / 1000) })

  const fetchMock = jest.fn()
  const realFetch = global.fetch
  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })
  afterAll(() => {
    global.fetch = realFetch
  })

  const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body)

  it("scopes to the wallet and requests the invoice and fee fields", async () => {
    fetchMock.mockResolvedValueOnce(page([at(NOW)]))
    const result = await fetchTransactions("key", "staging", { walletId: "w1" })

    expect(result.transactions.map((t: { id: string }) => t.id)).toEqual([`t${NOW}`])
    expect(result.complete).toBe(true) // hasNextPage=false: end of history
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.staging.blink.sv/graphql")
    expect(init.headers["X-API-KEY"]).toBe("key")
    const body = bodyOf(0)
    expect(body.variables).toEqual({ first: 100, after: null, walletIds: ["w1"] })
    expect(body.query).toContain("walletIds: $walletIds")
    expect(body.query).toContain("settlementFee")
    expect(body.query).toContain("paymentRequest")
    expect(body.query).toContain("paymentHash")
  })

  it("follows cursors until the oldest page passes untilMs", async () => {
    fetchMock
      .mockResolvedValueOnce(
        page([at(NOW), at(NOW - MINUTE)], { hasNextPage: true, endCursor: "p1" }),
      )
      .mockResolvedValueOnce(
        page([at(NOW - 2 * MINUTE), at(NOW - 10 * MINUTE)], {
          hasNextPage: true,
          endCursor: "p2",
        }),
      )
    const result = await fetchTransactions("key", "production", {
      untilMs: NOW - 5 * MINUTE,
      maxPages: 5,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyOf(1).variables.after).toBe("p1")
    expect(result.transactions).toHaveLength(4)
    expect(result.complete).toBe(true) // read back past untilMs
  })

  it("reports an incomplete scan when the page cap stops it before untilMs", async () => {
    fetchMock.mockResolvedValue(page([at(NOW)], { hasNextPage: true, endCursor: "next" }))
    const capped = await fetchTransactions("key", "production", {
      maxPages: 2,
      untilMs: NOW - 60 * MINUTE,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(capped).toMatchObject({ complete: false, pages: 2 })

    // A missing cursor with more pages announced is incomplete too
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(
      page([at(NOW)], { hasNextPage: true, endCursor: null }),
    )
    expect((await fetchTransactions("key", "production")).complete).toBe(false)
  })

  it("stops at maxPages, at the last page, and without a cursor", async () => {
    fetchMock.mockResolvedValue(page([at(NOW)], { hasNextPage: true, endCursor: "next" }))
    await fetchTransactions("key", "production", { maxPages: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(page([at(NOW)], { hasNextPage: false }))
    expect((await fetchTransactions("key", "production", { maxPages: 3 })).complete).toBe(
      true,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(
      page([at(NOW)], { hasNextPage: true, endCursor: null }),
    )
    await fetchTransactions("key", "production", { maxPages: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("throws on HTTP and GraphQL errors (the wallet is then skipped)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) })
    await expect(fetchTransactions("key", "production")).rejects.toThrow(
      "Blink API HTTP 502",
    )

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: "Invalid wallet" }] }),
    })
    await expect(
      fetchTransactions("key", "production", { walletId: "x" }),
    ).rejects.toThrow("Invalid wallet")
  })
})
