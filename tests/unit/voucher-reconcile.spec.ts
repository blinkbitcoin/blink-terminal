/** @jest-environment node */

/**
 * Ledger reconciliation for pre-PR#94 CLAIMED vouchers: only a unique,
 * settled outgoing Blink payment can transition a legacy claim to PAID.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  matchRedemptionCandidates,
  classifyVoucher,
  reconcileClaimedVouchers,
  parseArgs,
  MARK_PAID_SQL,
} = require("../../scripts/reconcile-voucher-claims")

const NOW = 1_760_000_000_000
const MINUTE = 60 * 1000

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
  settlementAmount: 500,
  settlementCurrency: "BTC",
  createdAt: Math.floor(NOW / 1000), // Blink Timestamp is Unix seconds
  memo: "BlinkPOS Voucher: 500 sats",
  ...overrides,
})

describe("matchRedemptionCandidates", () => {
  it("matches a unique settled BTC payment at the claim time", () => {
    expect(matchRedemptionCandidates(voucher(), [tx()])).toHaveLength(1)
  })

  it("matches a settled USD voucher in cents", () => {
    const usdVoucher = voucher({
      amount: 2000,
      usdAmountCents: 100,
      walletCurrency: "USD",
    })
    const usdTx = tx({
      settlementAmount: 100,
      settlementCurrency: "USD",
      memo: "BlinkPOS USD Voucher: $1.00 USD = 2000 sats",
    })
    expect(matchRedemptionCandidates(usdVoucher, [usdTx])).toHaveLength(1)
  })

  it("requires the settlement amount to equal the voucher amount", () => {
    expect(matchRedemptionCandidates(voucher(), [tx({ settlementAmount: 501 })])).toEqual(
      [],
    )
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

  it("never matches a USD voucher with no recorded cents", () => {
    expect(
      matchRedemptionCandidates(
        voucher({ walletCurrency: "USD", usdAmountCents: null }),
        [tx({ settlementAmount: 0, settlementCurrency: "USD" })],
      ),
    ).toEqual([])
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
    amount_sats: "500",
    usd_amount_cents: null,
    wallet_id: "w1",
    api_key_encrypted: "enc",
    claimed_at: CLAIMED_AT,
    environment: "production",
    wallet_currency: "BTC",
    ...overrides,
  })

  const setup = (rows: Array<Record<string, unknown>>) => {
    const queries: Array<[string, unknown[]]> = []
    const pool = {
      query: jest.fn(async (text: string, params: unknown[]) => {
        queries.push([text, params])
        if (text.startsWith("SELECT")) return { rows }
        return { rows: [{ id: params[0] }], rowCount: 1 }
      }),
    }
    return { pool, queries }
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

  it("filters by wallet and claim age in SQL", async () => {
    const { pool, queries } = setup([])
    await reconcileClaimedVouchers({
      pool,
      fetchTransactions: jest.fn(),
      decryptApiKey: () => "key",
      walletId: "w9",
      minAgeMinutes: 15,
      now: NOW,
      log: () => {},
    })

    const [text, params] = queries[0]
    expect(text).toContain("status = 'CLAIMED'")
    expect(text).toContain("claimed_at < $1")
    expect(text).toContain("wallet_id = $2")
    expect(params).toEqual([NOW - 15 * MINUTE, "w9"])
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
        "15",
        "--max-pages",
        "3",
      ]),
    ).toMatchObject({
      apply: true,
      walletId: "w1",
      minAgeMinutes: 15,
      maxPages: 3,
    })
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
