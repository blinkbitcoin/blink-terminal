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
import { MARK_VOUCHER_PAID_SQL } from "../../lib/voucher-store"

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  buildVoucherMemo,
  invoicePrincipalSats,
  matchRedemptionCandidates,
  classifyVoucher,
  fetchTransactions,
  reconcileClaimedVouchers,
  parseArgs,
  MARK_PAID_SQL,
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

  it("marks PAID with the same SQL as the store", () => {
    const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim()
    expect(normalize(MARK_PAID_SQL)).toBe(normalize(MARK_VOUCHER_PAID_SQL))
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

    expect(result.map((t: { id: string }) => t.id)).toEqual([`t${NOW}`])
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
    expect(result).toHaveLength(4)
  })

  it("stops at maxPages, at the last page, and without a cursor", async () => {
    fetchMock.mockResolvedValue(page([at(NOW)], { hasNextPage: true, endCursor: "next" }))
    await fetchTransactions("key", "production", { maxPages: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(page([at(NOW)], { hasNextPage: false }))
    await fetchTransactions("key", "production", { maxPages: 3 })
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
