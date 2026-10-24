/** @jest-environment node */

/**
 * blink-wip#1590: bearer secrets must not reach logs.
 *
 * A voucher id is the LNURL-withdraw k1 that redeems it. Every store path
 * that logs a voucher must log a short prefix, never the full id.
 */

const mockPoolQuery = jest.fn()
const mockClientQuery = jest.fn()
jest.mock("../../lib/db", () => ({
  getSharedPool: () => ({
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: () => Promise.resolve({ query: mockClientQuery, release: () => undefined }),
  }),
}))
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: { encryptApiKey: (k: string) => k, decryptApiKey: (k: string) => k },
}))
const mockHandleWithdrawRequest = jest.fn()
jest.mock("../../lib/boltcard", () => ({
  __esModule: true,
  lnurlw: {
    handleWithdrawRequest: (...args: unknown[]) => mockHandleWithdrawRequest(...args),
  },
  store: { getCard: jest.fn() },
}))
jest.mock("../../lib/config/features", () => ({
  __esModule: true,
  isBoltcardSpendEnabled: () => true,
}))
jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_WRITE: {},
}))

import crypto from "crypto"

import * as boltcardCrypto from "../../lib/boltcard/crypto"
import { shortId } from "../../lib/log-redact"
import { VoucherStore } from "../../lib/voucher-store"
import lnurlwHandler from "../../pages/api/boltcard/lnurlw/[cardId]"

const SECRET = "f00dfacecafebeef0123456789abcdef" // a voucher id = LNURL-withdraw k1

let logged: string[]
beforeEach(() => {
  logged = []
  const capture = (...args: unknown[]) => {
    logged.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
    )
  }
  jest.spyOn(console, "log").mockImplementation(capture)
  jest.spyOn(console, "warn").mockImplementation(capture)
  jest.spyOn(console, "error").mockImplementation(capture)
  mockPoolQuery.mockReset()
  mockClientQuery.mockReset()
})

const store = () => {
  const s = new VoucherStore()
  s.lastCleanup = Date.now()
  return s
}

describe("shortId", () => {
  it("keeps 8 characters of a long id", () => {
    expect(shortId(SECRET)).toBe("f00dface…")
    expect(shortId("abc")).toBe("ab…")
    expect(shortId("")).toBe("missing")
    expect(shortId(undefined)).toBe("missing")
  })
})

describe("voucher store never logs a full voucher id", () => {
  const expectNoSecret = () => {
    expect(logged.length).toBeGreaterThan(0) // the paths did log something
    for (const line of logged) expect(line).not.toContain(SECRET)
    expect(logged.some((l) => l.includes(shortId(SECRET)))).toBe(true)
  }

  it("claim / cancel / unclaim, success and failure", async () => {
    mockPoolQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: SECRET }] })
    await store().claimVoucher(SECRET)
    await store().cancelVoucher(SECRET)
    await store().unclaimVoucher(SECRET)
    mockPoolQuery.mockResolvedValue({ rowCount: 0, rows: [] })
    await store().claimVoucher(SECRET)
    await store().cancelVoucher(SECRET)
    await store().unclaimVoucher(SECRET)
    await store().getVoucher(SECRET)
    expectNoSecret()
  })

  it("markVoucherPaid: paid, not found, not CLAIMED", async () => {
    const run = async (update: { rowCount: number }, found = true) => {
      mockClientQuery.mockImplementation(async (sql: string) => {
        if (sql.startsWith("SELECT wallet_id"))
          return { rows: found ? [{ wallet_id: "w1" }] : [] }
        if (sql.startsWith("UPDATE")) return { ...update, rows: [] }
        return { rows: [] }
      })
      await store().markVoucherPaid(SECRET)
    }
    await run({ rowCount: 1 })
    await run({ rowCount: 0 })
    await run({ rowCount: 0 }, false)
    expectNoSecret()
  })

  it("create", async () => {
    jest.spyOn(VoucherStore.prototype, "generateChargeId").mockReturnValue(SECRET)
    mockPoolQuery.mockImplementation(async (sql: string) =>
      sql.startsWith("INSERT")
        ? {
            rows: [
              {
                id: SECRET,
                amount_sats: "500",
                claimed: false,
                created_at: String(Date.now()),
                expires_at: String(Date.now() + 60_000),
                expiry_id: "24h",
                wallet_id: "w1",
                commission_percent: "0",
                status: "ACTIVE",
                wallet_currency: "BTC",
              },
            ],
          }
        : { rows: [{ count: "0" }] },
    )
    await store().createVoucher(500, "blink_key", "w1")
    expectNoSecret()
  })
})

describe("Bolt Card tap verification logs no MACs, key material or UID", () => {
  // Public NXP-style vector inputs (same derivation as boltcard-crypto.spec)
  const ISSUER_KEY = "00000000000000000000000000000001"
  const UID = "04996c6a926980"

  const tap = (counter: number) => {
    const keys = boltcardCrypto.deriveAllKeys(ISSUER_KEY, UID, 1)
    const plaintext = Buffer.alloc(16)
    plaintext[0] = 0xc7
    Buffer.from(UID, "hex").copy(plaintext, 1)
    plaintext[8] = counter & 0xff
    const cipher = crypto.createCipheriv(
      "aes-128-cbc",
      Buffer.from(keys.k1, "hex"),
      Buffer.alloc(16, 0),
    )
    cipher.setAutoPadding(false)
    const picc = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("hex")
    const sv2 = Buffer.concat([
      Buffer.from("3cc300010080", "hex"),
      Buffer.from(UID, "hex"),
      Buffer.from([counter & 0xff, 0, 0]),
    ])
    const session = boltcardCrypto.calculateCMAC(Buffer.from(keys.k2, "hex"), sv2)
    const full = boltcardCrypto.calculateCMAC(session, Buffer.alloc(0))
    const mac = Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i])).toString(
      "hex",
    )
    return { keys, picc, mac, full: full.toString("hex") }
  }

  it("a valid tap and a tampered tap log neither MAC, the CMAC, K2 nor the UID", () => {
    const { keys, picc, mac, full } = tap(100)
    expect(boltcardCrypto.verifyCardTap(picc, mac, keys.k1, keys.k2, UID, 99).valid).toBe(
      true,
    )
    const tampered = "deadbeefdeadbeef"
    expect(
      boltcardCrypto.verifyCardTap(picc, tampered, keys.k1, keys.k2, UID, 99).valid,
    ).toBe(false)

    const all = logged.join("\n").toLowerCase()
    expect(all).not.toContain(mac) // the expected (valid) MAC — forgeable if logged
    expect(all).not.toContain(tampered)
    expect(all).not.toContain(full)
    expect(all).not.toContain(keys.k2.substring(0, 8).toLowerCase())
    expect(all).not.toContain(UID)
    expect(all).toContain("counter") // still useful for debugging
  })
})

describe("Bolt Card tap route logs no p, no c and no raw URL", () => {
  const P = "a1b2c3d4e5f60718293a4b5c6d7e8f90" // encrypted PICCData (32 hex)
  const C = "0f1e2d3c4b5a6978" // SunMAC (16 hex)
  const call = async (query: Record<string, string>, accept = "application/json") => {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(payload: unknown) {
        this.body = payload
        return this
      },
      redirect() {
        return this
      },
      setHeader() {},
    }
    const qs = new URLSearchParams(query).toString()
    await (lnurlwHandler as unknown as (q: unknown, s: unknown) => Promise<void>)(
      {
        method: "GET",
        query: { cardId: "card-1", ...query },
        url: `/api/boltcard/lnurlw/card-1?${qs}`,
        headers: { host: "terminal.example", accept },
      },
      res,
    )
    return res
  }

  it("valid-format tap: values and URL never logged", async () => {
    mockHandleWithdrawRequest.mockResolvedValue({ tag: "withdrawRequest" })
    const res = await call({ p: P, c: C })
    expect(res.statusCode).toBe(200)
    const all = logged.join("\n")
    expect(all).not.toContain(P)
    expect(all).not.toContain(P.substring(0, 16))
    expect(all).not.toContain(C)
    expect(all).not.toContain("?p=")
    expect(all).toContain("p=present (32 chars), c=present (16 chars)")
  })

  it("malformed p / c: the 400 path does not echo the values either", async () => {
    await call({ p: "zz" + P.substring(2), c: C })
    await call({ p: P, c: "zz" + C.substring(2) })
    const all = logged.join("\n")
    expect(all).not.toContain(P.substring(2, 50))
    expect(all).not.toContain(C.substring(2))
  })
})
