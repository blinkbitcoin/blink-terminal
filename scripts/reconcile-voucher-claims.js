#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Reconciliation for CLAIMED vouchers: legacy claims from before PR #94, and
 * any later redemption that answered PENDING and settled afterwards (the
 * callback only marks PAID on a synchronous SUCCESS). Every CLAIMED row older
 * than --min-age-minutes is a target, and the run is safe to repeat.
 *
 * Before this change, successful redemptions stayed CLAIMED forever: Blink
 * had already debited the wallet, but the voucher still counted as an
 * outstanding liability, blocking new issuance against the same balance.
 * Settlement was never persisted, so the DB alone cannot tell a settled claim
 * from a PENDING/unknown-outcome one.
 *
 * This tool asks Blink's ledger (authoritative), scoped to the voucher's
 * wallet, and transitions a CLAIMED voucher to PAID only when exactly one
 * settled outgoing payment matches:
 *   - direction SEND, status SUCCESS (Blink's TxStatus), voucher wallet currency
 *   - principal (authoritative, both currencies): the payment's BOLT11
 *     invoice — InitiationViaLn.paymentRequest, which Blink resolves from its
 *     own payment record by the transaction's payment hash — decodes to
 *     exactly the voucher's face value in sats, and its payment hash equals
 *     InitiationViaLn.paymentHash. The callback only pays invoices for the
 *     exact face value (also for USD vouchers), so this binds the payout
 *     amount independently of fees and exchange rate.
 *   - settlementFee is present (fails closed otherwise)
 *   - BTC: also |settlementAmount| - |settlementFee| equals the face value
 *     (Blink debits principal + fee; settlementAmount is credit - debit).
 *   - USD: also a positive fee-normalized debit. The cents follow the
 *     redemption-time rate, not usd_amount_cents, so they are not compared.
 *   - memo equals the exact memo the redemption callback wrote for this
 *     voucher (lib/voucher-memo.ts) — defense in depth, never sufficient
 *   - transaction time within 2 minutes before / 30 minutes after claimed_at
 *
 * Zero or multiple candidates leave the voucher CLAIMED, so it stays counted
 * in the liability aggregate (the conservative direction). A payment that
 * also matches any other claimed voucher of the wallet (CLAIMED or PAID, of
 * any age) is contested and credited to none — which is why cleanup never
 * deletes redeemed rows (migration 029): a PAID row is competitor evidence,
 * and only its secret is scrubbed after 30 days. Uniqueness is only meaningful
 * over a COMPLETE scan: if --max-pages is hit before the ledger has been read
 * back past the earliest target's window, nothing is written for that wallet
 * (a rival candidate could sit in the unscanned part) and the run reports
 * that --max-pages must be raised. Dry-run by default; pass
 * --apply to write. Run migration 029 first (PAID is rejected by the pre-029
 * status constraint).
 *
 * Usage:
 *   node scripts/reconcile-voucher-claims.js [options]
 *
 * Options:
 *   --apply                 Write CLAIMED -> PAID (default: dry run)
 *   --wallet <id>           Only reconcile one Blink wallet id
 *   --min-age-minutes <n>   Only claims older than n minutes (default: 60)
 *   --max-pages <n>         Transaction pages to scan per wallet (default: 5)
 *   --help                  Show this help
 *
 * Requires ENCRYPTION_KEY (voucher API keys) and the usual database env vars.
 */

const fs = require("fs")
const path = require("path")

const bolt11 = require("bolt11")
const CryptoJS = require("crypto-js")
const { Pool } = require("pg")

const API_URLS = {
  production: "https://api.blink.sv/graphql",
  staging: "https://api.staging.blink.sv/graphql",
}

const TRANSACTIONS_QUERY = `
  query VoucherReconciliationList($first: Int!, $after: String, $walletIds: [WalletId]) {
    me {
      defaultAccount {
        transactions(first: $first, after: $after, walletIds: $walletIds) {
          edges {
            cursor
            node {
              id
              direction
              status
              settlementAmount
              settlementFee
              settlementCurrency
              createdAt
              memo
              initiationVia {
                __typename
                ... on InitiationViaLn {
                  paymentHash
                  paymentRequest
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`

/** Payment claim -> ledger timestamp tolerance (callback claims immediately). */
const WINDOW_BEFORE_MS = 2 * 60 * 1000
const WINDOW_AFTER_MS = 30 * 60 * 1000

// Keep in sync with MARK_VOUCHER_PAID_SQL / WALLET_LOCK_SQL / LOCK_TIMEOUT_SQL
// in lib/voucher-store.ts (parity asserted in tests/unit/voucher-reconcile.spec.ts).
const MARK_PAID_SQL = `UPDATE vouchers
   SET status = 'PAID'
   WHERE id = $1 AND status = 'CLAIMED'
   RETURNING id`
const WALLET_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1))"
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '15s'"

/**
 * CLAIMED -> PAID under the per-wallet lock, like VoucherStore.markVoucherPaid
 * (BACKING INVARIANT in lib/voucher-store.ts): the debit happened long ago,
 * but removing the liability must still not interleave with a live create's
 * balance read + liability sum on the same wallet.
 */
async function markPaidLocked(pool, walletId, voucherId) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(LOCK_TIMEOUT_SQL)
    await client.query(WALLET_LOCK_SQL, [walletId])
    const update = await client.query(MARK_PAID_SQL, [voucherId])
    await client.query("COMMIT")
    return update.rowCount === 1 ? "paid" : "not-claimed"
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    // Postgres lock_timeout (SQLSTATE 55P03): a live create holds the wallet
    // lock. Nothing was written; the voucher stays CLAIMED for a re-run.
    if (err && (err.code === "55P03" || /lock timeout/i.test(err.message || ""))) {
      return "lock-timeout"
    }
    throw err
  } finally {
    client.release()
  }
}

function loadEnv() {
  const envPath = path.join(__dirname, "../.env")
  if (!fs.existsSync(envPath)) return
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const match = line.match(/^([^=]+)=(.*)$/)
      if (match && !line.startsWith("#")) {
        const key = match[1].trim()
        const value = match[2].trim().replace(/^["']|["']$/g, "")
        if (!process.env[key]) process.env[key] = value
      }
    })
}

function decryptApiKey(encrypted, key) {
  try {
    const decrypted = CryptoJS.AES.decrypt(encrypted, key).toString(CryptoJS.enc.Utf8)
    return decrypted || null
  } catch (_err) {
    return null
  }
}

function createdAtMs(tx) {
  const value = Number(tx.createdAt)
  if (!Number.isFinite(value)) return NaN
  // Blink's Timestamp scalar is Unix seconds; tolerate milliseconds too.
  return value > 1e12 ? value : value * 1000
}

function isSettledOutgoing(tx) {
  // direction is non-null in Blink's schema: require it (fail closed).
  if (String(tx.direction || "").toUpperCase() !== "SEND") return false
  const status = String(tx.status || "").toUpperCase()
  // TxStatus is FAILURE | PENDING | SUCCESS; only SUCCESS is settled.
  return status === "SUCCESS"
}

/**
 * The exact payer memo the redemption callback writes.
 * Keep in sync with buildVoucherMemo in lib/voucher-memo.ts (parity is
 * asserted in tests/unit/voucher-reconcile.spec.ts).
 */
function buildVoucherMemo(voucher) {
  const isUsdVoucher = voucher.walletCurrency === "USD"

  if (isUsdVoucher && voucher.usdAmountCents) {
    const usdAmount = (voucher.usdAmountCents / 100).toFixed(2)
    if (
      voucher.displayAmount &&
      voucher.displayCurrency &&
      voucher.displayCurrency !== "USD"
    ) {
      if (voucher.commissionPercent && voucher.commissionPercent > 0) {
        return `BlinkPOS USD Voucher: ${voucher.displayCurrency} ${voucher.displayAmount} (${voucher.commissionPercent}% commission) = $${usdAmount} USD`
      }
      return `BlinkPOS USD Voucher: ${voucher.displayCurrency} ${voucher.displayAmount} = $${usdAmount} USD`
    }
    return `BlinkPOS USD Voucher: $${usdAmount} USD = ${voucher.amount} sats`
  }

  if (voucher.displayAmount && voucher.displayCurrency) {
    if (voucher.commissionPercent && voucher.commissionPercent > 0) {
      return `BlinkPOS Voucher: ${voucher.displayCurrency} ${voucher.displayAmount} (${voucher.commissionPercent}% commission) = ${voucher.amount} sats`
    }
    return `BlinkPOS Voucher: ${voucher.displayCurrency} ${voucher.displayAmount} = ${voucher.amount} sats`
  }

  return `BlinkPOS Voucher: ${voucher.amount} sats`
}

const BOLT11_NETWORKS = [
  // Longest prefix first: lnbcrt must not be read as mainnet lnbc.
  [
    "lnbcrt",
    { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] },
  ],
  [
    "lnbc",
    { bech32: "bc", pubKeyHash: 0x00, scriptHash: 0x05, validWitnessVersions: [0, 1] },
  ],
  [
    "lntbs",
    { bech32: "tbs", pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] },
  ],
  [
    "lntb",
    { bech32: "tb", pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] },
  ],
]

/**
 * Principal in whole sats of the Lightning invoice Blink recorded for this
 * payment, or null when it cannot be established (not a Lightning send,
 * empty/undecodable invoice, payment hash mismatch, amountless or
 * sub-satoshi amount). Callers must treat null as "no match".
 */
function invoicePrincipalSats(tx) {
  const via = tx.initiationVia
  if (!via || via.__typename !== "InitiationViaLn") return null
  const request = String(via.paymentRequest || "")
    .trim()
    .toLowerCase()
  const paymentHash = String(via.paymentHash || "").toLowerCase()
  if (!request || !paymentHash) return null

  const network = BOLT11_NETWORKS.find(([prefix]) => request.startsWith(prefix))
  if (!network) return null

  let decoded
  try {
    decoded = bolt11.decode(request, network[1])
  } catch (_err) {
    return null
  }
  if (String(decoded.tagsObject?.payment_hash || "").toLowerCase() !== paymentHash) {
    return null
  }
  if (decoded.millisatoshis === null || decoded.millisatoshis === undefined) return null
  const msat = BigInt(decoded.millisatoshis)
  if (msat <= 0n || msat % 1000n !== 0n) return null
  return Number(msat / 1000n)
}

/**
 * Candidate settled payments for one claimed voucher. Callers must require
 * exactly one candidate before treating the voucher as settled.
 */
function matchRedemptionCandidates(voucher, transactions) {
  const claimedAt = Number(voucher.claimedAt)
  const currency = String(voucher.walletCurrency || "BTC").toUpperCase()
  const faceSats = Number(voucher.amount)
  if (!Number.isFinite(claimedAt) || !Number.isFinite(faceSats)) return []
  const expectedMemo = buildVoucherMemo(voucher)

  return transactions.filter((tx) => {
    if (!isSettledOutgoing(tx) || tx.memo !== expectedMemo) return false

    const at = createdAtMs(tx)
    if (!(at >= claimedAt - WINDOW_BEFORE_MS && at <= claimedAt + WINDOW_AFTER_MS)) {
      return false
    }

    if (String(tx.settlementCurrency || "").toUpperCase() !== currency) return false

    // Authoritative principal: the invoice actually paid, bound to this
    // transaction by its payment hash, must be exactly the face value.
    if (invoicePrincipalSats(tx) !== faceSats) return false

    // Fail closed: without the fee the debited principal cannot be derived.
    if (tx.settlementFee === null || tx.settlementFee === undefined) return false
    const fee = Math.abs(Number(tx.settlementFee))
    const gross = Math.abs(Number(tx.settlementAmount))
    if (!Number.isFinite(fee) || !Number.isFinite(gross)) return false

    // USD: the cents debited follow the redemption-time rate (fixed-sats
    // invoice), so only require a real, positive principal debit.
    if (currency === "USD") return gross - fee > 0

    // BTC: settlementAmount is signed (credit - debit) and includes the fee
    // on external sends; the debited principal must equal the face value.
    return gross - fee === faceSats
  })
}

function classifyVoucher(voucher, transactions) {
  const candidates = matchRedemptionCandidates(voucher, transactions)
  if (candidates.length === 1) return { outcome: "matched", transaction: candidates[0] }
  if (candidates.length > 1) return { outcome: "ambiguous", candidates }
  return { outcome: "unmatched" }
}

/**
 * Settled-side ledger scan, newest first. Resolves to
 * { transactions, complete, pages }: `complete` is true only when the scan
 * reached the end of the history or read back past `untilMs`, i.e. every
 * transaction that could fall in the callers' windows has been seen. A scan
 * cut short by `maxPages` is incomplete and must not drive writes.
 */
async function fetchTransactions(apiKey, environment, options = {}) {
  const url = API_URLS[environment] || API_URLS.production
  const first = 100
  const maxPages = options.maxPages || 5
  const untilMs = options.untilMs || 0
  const transactions = []
  let after = null
  let complete = false
  let pages = 0

  const walletIds = options.walletId ? [options.walletId] : null

  for (let page = 0; page < maxPages; page++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({
        query: TRANSACTIONS_QUERY,
        variables: { first, after, walletIds },
      }),
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) {
      throw new Error(`Blink API HTTP ${response.status}`)
    }
    const body = await response.json()
    if (body.errors && body.errors.length > 0) {
      throw new Error(body.errors.map((e) => e.message).join("; "))
    }

    const connection = body.data?.me?.defaultAccount?.transactions
    const edges = connection?.edges || []
    for (const edge of edges) transactions.push(edge.node)

    pages++
    const oldest = edges.length > 0 ? createdAtMs(edges[edges.length - 1].node) : NaN
    if (!connection?.pageInfo?.hasNextPage) {
      complete = true // end of history
      break
    }
    if (Number.isFinite(oldest) && untilMs && oldest < untilMs) {
      complete = true // read back past the earliest window
      break
    }
    after = connection.pageInfo.endCursor
    if (!after) break // no cursor to continue: incomplete
  }

  return { transactions, complete, pages }
}

/**
 * Reconcile legacy CLAIMED vouchers. Dependencies are injected so the
 * orchestration is testable without a database or network.
 */
async function reconcileClaimedVouchers(deps) {
  const {
    pool,
    fetchTransactions: fetchTransactionsImpl,
    decryptApiKey: decryptApiKeyImpl,
    apply = false,
    walletId = null,
    minAgeMinutes = 60,
    maxPages = 5,
    now = Date.now(),
    log = console.log,
  } = deps

  const cutoff = now - minAgeMinutes * 60 * 1000
  const params = []
  // Every claimed voucher (CLAIMED or PAID, any age) is loaded: targets are
  // old-enough CLAIMED rows, but all of them compete for ledger payments so a
  // payment that belongs to a recent or already-settled voucher can never be
  // credited to a legacy claim.
  let where = "status IN ('CLAIMED', 'PAID') AND claimed_at IS NOT NULL"
  if (walletId) {
    params.push(walletId)
    where += " AND wallet_id = $1"
  }

  const { rows } = await pool.query(
    `SELECT id, status, amount_sats, usd_amount_cents, wallet_id, api_key_encrypted,
            claimed_at, environment, wallet_currency, display_amount,
            display_currency, commission_percent
     FROM vouchers
     WHERE ${where}
     ORDER BY wallet_id, claimed_at`,
    params,
  )

  const groups = new Map()
  let checked = 0
  for (const row of rows) {
    const key = `${row.wallet_id}\u0000${row.environment || "production"}`
    if (!groups.has(key)) {
      groups.set(key, {
        walletId: row.wallet_id,
        environment: row.environment || "production",
        apiKeyEncrypted: null,
        vouchers: [],
      })
    }
    const group = groups.get(key)
    const claimedAt = Number(row.claimed_at)
    const isTarget = row.status === "CLAIMED" && claimedAt < cutoff
    if (isTarget) checked++
    if (isTarget && !group.apiKeyEncrypted) group.apiKeyEncrypted = row.api_key_encrypted
    // Same field mapping as VoucherStore._rowToVoucher, so the rebuilt memo
    // is byte-identical to the one the callback sent.
    group.vouchers.push({
      id: row.id,
      isTarget,
      amount: parseInt(row.amount_sats, 10),
      usdAmountCents: row.usd_amount_cents ? parseInt(row.usd_amount_cents, 10) : null,
      walletCurrency: row.wallet_currency || "BTC",
      displayAmount: row.display_amount,
      displayCurrency: row.display_currency,
      commissionPercent: parseFloat(row.commission_percent) || 0,
      claimedAt,
    })
  }
  for (const [key, group] of groups) {
    if (!group.vouchers.some((v) => v.isTarget)) groups.delete(key)
  }

  const summary = {
    checked,
    matched: 0,
    applied: 0,
    ambiguous: 0,
    unmatched: 0,
    skippedWallets: 0,
    incompleteWallets: 0,
    unverified: 0,
    lockTimeouts: 0,
  }

  for (const group of groups.values()) {
    const apiKey = decryptApiKeyImpl(group.apiKeyEncrypted)
    if (!apiKey) {
      summary.skippedWallets++
      log(`[skip] wallet ${group.walletId}: API key could not be decrypted`)
      continue
    }

    const targets = group.vouchers.filter((v) => v.isTarget)
    const earliestClaim = Math.min(...targets.map((v) => v.claimedAt))
    let transactions
    let complete
    try {
      const scan = await fetchTransactionsImpl(apiKey, group.environment, {
        maxPages,
        walletId: group.walletId,
        untilMs: earliestClaim - WINDOW_BEFORE_MS,
      })
      // Tolerate a bare array (older callers/tests): treat it as complete.
      transactions = Array.isArray(scan) ? scan : scan.transactions
      complete = Array.isArray(scan) ? true : scan.complete === true
    } catch (err) {
      summary.skippedWallets++
      log(`[skip] wallet ${group.walletId}: ${err.message}`)
      continue
    }
    // An incomplete scan cannot prove uniqueness: a rival candidate may sit
    // in the unscanned part of the window. Report, never write.
    if (!complete) {
      summary.incompleteWallets++
      log(
        `[incomplete] wallet ${group.walletId}: --max-pages ${maxPages} reached before ` +
          `the earliest target window — matches below are unverified, nothing is written; raise --max-pages`,
      )
    }

    // Refuse to credit the same payment to two vouchers: a nearby claim
    // (same memo, inside the window) must not inherit another voucher's
    // settled payout. Every claimed voucher of the wallet competes, including
    // recent and already-PAID ones; only targets are written. Contested
    // matches stay CLAIMED — conservative, never over-releases liability.
    const claimants = new Map()
    for (const voucher of group.vouchers) {
      for (const candidate of matchRedemptionCandidates(voucher, transactions)) {
        if (!claimants.has(candidate.id)) claimants.set(candidate.id, [])
        claimants.get(candidate.id).push(voucher.id)
      }
    }

    for (const voucher of targets) {
      const result = classifyVoucher(voucher, transactions)
      const label = voucher.id.substring(0, 8)
      const amountLabel =
        voucher.walletCurrency === "USD"
          ? `${voucher.usdAmountCents} cents`
          : `${voucher.amount} sats`
      const rivals =
        result.outcome === "matched" ? claimants.get(result.transaction.id).length : 0

      if (result.outcome === "matched" && rivals === 1) {
        summary.matched++
        if (!complete) {
          summary.unverified++
          log(
            `[match:unverified] ${label} ${amountLabel} -> tx ${result.transaction.id} (incomplete scan)`,
          )
        } else if (apply) {
          const outcome = await markPaidLocked(pool, group.walletId, voucher.id)
          if (outcome === "paid") {
            summary.applied++
            log(`[paid] ${label} ${amountLabel} -> tx ${result.transaction.id}`)
          } else if (outcome === "lock-timeout") {
            summary.lockTimeouts++
            log(`[skip] ${label}: wallet busy (lock timeout), left CLAIMED — re-run`)
          } else {
            log(`[skip] ${label}: no longer CLAIMED at write time`)
          }
        } else {
          log(`[match] ${label} ${amountLabel} -> tx ${result.transaction.id}`)
        }
      } else if (result.outcome === "matched") {
        summary.ambiguous++
        log(
          `[contested] ${label}: tx ${result.transaction.id} also matches ${rivals - 1} other voucher(s) — left CLAIMED`,
        )
      } else if (result.outcome === "ambiguous") {
        summary.ambiguous++
        log(
          `[ambiguous] ${label}: ${result.candidates.length} matching payments — left CLAIMED`,
        )
      } else {
        summary.unmatched++
        log(`[unmatched] ${label}: no settled payment found — left CLAIMED`)
      }
    }
  }

  return summary
}

function parseArgs(argv) {
  const args = {
    apply: argv.includes("--apply"),
    walletId: null,
    minAgeMinutes: 60,
    maxPages: 5,
    help: argv.includes("--help") || argv.includes("-h"),
  }
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? null : argv[index + 1]
  }

  const walletId = value("--wallet")
  if (walletId) args.walletId = walletId

  const minAge = value("--min-age-minutes")
  if (minAge) {
    args.minAgeMinutes = Number(minAge)
    if (!Number.isFinite(args.minAgeMinutes) || args.minAgeMinutes < 0) {
      throw new Error("--min-age-minutes must be a non-negative number")
    }
  }

  const maxPages = value("--max-pages")
  if (maxPages) {
    args.maxPages = Number(maxPages)
    if (!Number.isInteger(args.maxPages) || args.maxPages < 1) {
      throw new Error("--max-pages must be a positive integer")
    }
  }

  return args
}

function createPool() {
  if (process.env.DATABASE_URL) {
    return new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return new Pool({
    host: process.env.POSTGRES_HOST || "localhost",
    port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
    database: process.env.POSTGRES_DB || "blinkpos",
    user: process.env.POSTGRES_USER || "blinkpos",
    password: process.env.POSTGRES_PASSWORD || "blinkpos_dev_password",
  })
}

async function main() {
  loadEnv()
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      "Usage: node scripts/reconcile-voucher-claims.js [--apply] [--wallet <id>] " +
        "[--min-age-minutes <n>] [--max-pages <n>]",
    )
    return
  }

  const encryptionKey = process.env.ENCRYPTION_KEY
  if (!encryptionKey) {
    throw new Error("ENCRYPTION_KEY is required to decrypt voucher API keys")
  }

  const pool = createPool()
  try {
    const summary = await reconcileClaimedVouchers({
      pool,
      fetchTransactions,
      decryptApiKey: (encrypted) => decryptApiKey(encrypted, encryptionKey),
      apply: args.apply,
      walletId: args.walletId,
      minAgeMinutes: args.minAgeMinutes,
      maxPages: args.maxPages,
    })

    console.log("")
    console.log(
      `Summary: checked=${summary.checked} matched=${summary.matched} ` +
        `applied=${summary.applied} ambiguous=${summary.ambiguous} ` +
        `unmatched=${summary.unmatched} skippedWallets=${summary.skippedWallets} ` +
        `incompleteWallets=${summary.incompleteWallets} unverified=${summary.unverified} ` +
        `lockTimeouts=${summary.lockTimeouts}`,
    )
    if (summary.lockTimeouts > 0) {
      console.log(
        `${summary.lockTimeouts} voucher(s) skipped because the wallet was busy; re-run to settle them.`,
      )
    }
    if (summary.incompleteWallets > 0) {
      console.log(
        `${summary.incompleteWallets} wallet(s) hit --max-pages before their window was covered: ` +
          `${summary.unverified} match(es) left unwritten. Re-run with a larger --max-pages.`,
      )
    }
    if (!args.apply && summary.matched > 0) {
      console.log("Dry run only. Re-run with --apply to mark matched vouchers PAID.")
    }
  } finally {
    await pool.end()
  }
}

module.exports = {
  buildVoucherMemo,
  invoicePrincipalSats,
  matchRedemptionCandidates,
  classifyVoucher,
  reconcileClaimedVouchers,
  fetchTransactions,
  parseArgs,
  MARK_PAID_SQL,
  WALLET_LOCK_SQL,
  LOCK_TIMEOUT_SQL,
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Reconciliation failed:", err.message)
    process.exitCode = 1
  })
}
