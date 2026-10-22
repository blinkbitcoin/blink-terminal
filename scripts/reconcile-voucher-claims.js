#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * One-time reconciliation for CLAIMED vouchers created before PR #94.
 *
 * Before this change, successful redemptions stayed CLAIMED forever: Blink
 * had already debited the wallet, but the voucher still counted as an
 * outstanding liability, blocking new issuance against the same balance.
 * Settlement was never persisted, so the DB alone cannot tell a settled claim
 * from a PENDING/unknown-outcome one.
 *
 * This tool asks Blink's ledger (authoritative) and transitions a CLAIMED
 * voucher to PAID only when exactly one settled outgoing payment matches:
 *   - direction SEND, status SUCCESS/ALREADY_PAID
 *   - paid from the voucher's wallet currency (BTC sats / USD cents)
 *   - settlement amount equals the voucher's amount
 *   - memo is a BlinkPOS voucher memo (written by the redemption callback)
 *   - transaction time within 2 minutes before / 30 minutes after claimed_at
 *
 * Zero or multiple candidates leave the voucher CLAIMED, so it stays counted
 * in the liability aggregate (the conservative direction). Dry-run by
 * default; pass --apply to write. Run migration 029 first (PAID is rejected
 * by the pre-029 status constraint).
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

const CryptoJS = require("crypto-js")
const { Pool } = require("pg")

const API_URLS = {
  production: "https://api.blink.sv/graphql",
  staging: "https://api.staging.blink.sv/graphql",
}

const TRANSACTIONS_QUERY = `
  query VoucherReconciliationList($first: Int!, $after: String) {
    me {
      defaultAccount {
        transactions(first: $first, after: $after) {
          edges {
            cursor
            node {
              id
              direction
              status
              settlementAmount
              settlementCurrency
              createdAt
              memo
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

// Keep in sync with MARK_VOUCHER_PAID_SQL in lib/voucher-store.ts.
const MARK_PAID_SQL = `UPDATE vouchers
   SET status = 'PAID'
   WHERE id = $1 AND status = 'CLAIMED'
   RETURNING id`

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
  const direction = String(tx.direction || "").toUpperCase()
  if (direction && direction !== "SEND") return false
  const status = String(tx.status || "").toUpperCase()
  return status === "SUCCESS" || status === "ALREADY_PAID"
}

function isVoucherMemo(memo) {
  return /^BlinkPOS (USD )?Voucher:/.test(String(memo || ""))
}

/**
 * Candidate settled payments for one CLAIMED voucher. Callers must require
 * exactly one candidate before treating the voucher as settled.
 */
function matchRedemptionCandidates(voucher, transactions) {
  const claimedAt = Number(voucher.claimedAt)
  const currency = String(voucher.walletCurrency || "BTC").toUpperCase()
  const rawMinor = currency === "USD" ? voucher.usdAmountCents : voucher.amount
  if (rawMinor === null || rawMinor === undefined) return []
  const expectedMinor = Number(rawMinor)

  if (!Number.isFinite(claimedAt) || !Number.isFinite(expectedMinor)) return []

  return transactions.filter((tx) => {
    if (!isSettledOutgoing(tx) || !isVoucherMemo(tx.memo)) return false

    const at = createdAtMs(tx)
    if (!(at >= claimedAt - WINDOW_BEFORE_MS && at <= claimedAt + WINDOW_AFTER_MS)) {
      return false
    }

    const txCurrency = String(tx.settlementCurrency || "").toUpperCase()
    if (txCurrency && txCurrency !== currency) return false

    // settlementAmount is in the currency's minor units (sats / cents).
    return Number(tx.settlementAmount) === expectedMinor
  })
}

function classifyVoucher(voucher, transactions) {
  const candidates = matchRedemptionCandidates(voucher, transactions)
  if (candidates.length === 1) return { outcome: "matched", transaction: candidates[0] }
  if (candidates.length > 1) return { outcome: "ambiguous", candidates }
  return { outcome: "unmatched" }
}

async function fetchTransactions(apiKey, environment, options = {}) {
  const url = API_URLS[environment] || API_URLS.production
  const first = 100
  const maxPages = options.maxPages || 5
  const untilMs = options.untilMs || 0
  const transactions = []
  let after = null

  for (let page = 0; page < maxPages; page++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({
        query: TRANSACTIONS_QUERY,
        variables: { first, after },
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

    const oldest = edges.length > 0 ? createdAtMs(edges[edges.length - 1].node) : NaN
    if (!connection?.pageInfo?.hasNextPage) break
    if (Number.isFinite(oldest) && untilMs && oldest < untilMs) break
    after = connection.pageInfo.endCursor
    if (!after) break
  }

  return transactions
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

  const params = [now - minAgeMinutes * 60 * 1000]
  let where = "status = 'CLAIMED' AND claimed_at IS NOT NULL AND claimed_at < $1"
  if (walletId) {
    params.push(walletId)
    where += " AND wallet_id = $2"
  }

  const { rows } = await pool.query(
    `SELECT id, amount_sats, usd_amount_cents, wallet_id, api_key_encrypted,
            claimed_at, environment, wallet_currency
     FROM vouchers
     WHERE ${where}
     ORDER BY wallet_id, claimed_at`,
    params,
  )

  const groups = new Map()
  for (const row of rows) {
    const key = `${row.wallet_id}\u0000${row.environment || "production"}`
    if (!groups.has(key)) {
      groups.set(key, {
        walletId: row.wallet_id,
        environment: row.environment || "production",
        apiKeyEncrypted: row.api_key_encrypted,
        vouchers: [],
      })
    }
    groups.get(key).vouchers.push({
      id: row.id,
      amount: Number(row.amount_sats),
      usdAmountCents: row.usd_amount_cents === null ? null : Number(row.usd_amount_cents),
      walletCurrency: row.wallet_currency || "BTC",
      claimedAt: Number(row.claimed_at),
    })
  }

  const summary = {
    checked: rows.length,
    matched: 0,
    applied: 0,
    ambiguous: 0,
    unmatched: 0,
    skippedWallets: 0,
  }

  for (const group of groups.values()) {
    const apiKey = decryptApiKeyImpl(group.apiKeyEncrypted)
    if (!apiKey) {
      summary.skippedWallets++
      log(`[skip] wallet ${group.walletId}: API key could not be decrypted`)
      continue
    }

    const earliestClaim = Math.min(...group.vouchers.map((v) => v.claimedAt))
    let transactions
    try {
      transactions = await fetchTransactionsImpl(apiKey, group.environment, {
        maxPages,
        untilMs: earliestClaim - WINDOW_BEFORE_MS,
      })
    } catch (err) {
      summary.skippedWallets++
      log(`[skip] wallet ${group.walletId}: ${err.message}`)
      continue
    }

    // Classify every voucher first, then refuse to credit the same payment to
    // two vouchers: a nearby claim (same amount, inside the window) must not
    // inherit another voucher's settled payout. Contested matches stay
    // CLAIMED — conservative, never over-releases liability.
    const classifications = group.vouchers.map((voucher) => ({
      voucher,
      result: classifyVoucher(voucher, transactions),
    }))
    const claimants = new Map()
    for (const { voucher, result } of classifications) {
      if (result.outcome !== "matched") continue
      const txId = result.transaction.id
      if (!claimants.has(txId)) claimants.set(txId, [])
      claimants.get(txId).push(voucher.id)
    }
    const contested = new Set()
    for (const [txId, ids] of claimants) {
      if (ids.length > 1) {
        for (const id of ids) contested.add(id)
        log(`[contested] tx ${txId} matches ${ids.length} vouchers — left CLAIMED`)
      }
    }

    for (const { voucher, result } of classifications) {
      const label = voucher.id.substring(0, 8)
      const amountLabel =
        voucher.walletCurrency === "USD"
          ? `${voucher.usdAmountCents} cents`
          : `${voucher.amount} sats`

      if (result.outcome === "matched" && !contested.has(voucher.id)) {
        summary.matched++
        if (apply) {
          const update = await pool.query(MARK_PAID_SQL, [voucher.id])
          if (update.rowCount === 1) {
            summary.applied++
            log(`[paid] ${label} ${amountLabel} -> tx ${result.transaction.id}`)
          } else {
            log(`[skip] ${label}: no longer CLAIMED at write time`)
          }
        } else {
          log(`[match] ${label} ${amountLabel} -> tx ${result.transaction.id}`)
        }
      } else if (result.outcome === "matched") {
        summary.ambiguous++
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
        `unmatched=${summary.unmatched} skippedWallets=${summary.skippedWallets}`,
    )
    if (!args.apply && summary.matched > 0) {
      console.log("Dry run only. Re-run with --apply to mark matched vouchers PAID.")
    }
  } finally {
    await pool.end()
  }
}

module.exports = {
  matchRedemptionCandidates,
  classifyVoucher,
  reconcileClaimedVouchers,
  fetchTransactions,
  parseArgs,
  MARK_PAID_SQL,
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Reconciliation failed:", err.message)
    process.exitCode = 1
  })
}
