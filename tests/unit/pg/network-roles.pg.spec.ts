/** @jest-environment node */

/**
 * Network roles on real Postgres (blink-wip#1679 follow-up).
 *
 * GET /api/network/whitelist/check (what the UI uses to show leader/admin
 * features) used hard-coded npub lists that had drifted from the database
 * every other /api/network route authorizes against: leaders added by later
 * migrations were reported as plain users. lib/network/db.isSuperAdmin also
 * had a hard-coded super admin that setting the row 'suspended' could not
 * revoke. Both now read the migrated tables only.
 */

// Must stay first: sets the env lib/auth reads at module load.
import "./env"

import { bech32 } from "bech32"
import type { Client } from "pg"

import AuthManager from "../../../lib/auth"
import * as networkDb from "../../../lib/network/db"
import checkHandler from "../../../pages/api/network/whitelist/check"

import { describePg, setupTestDatabase, type TestDatabase } from "./harness"

jest.mock("../../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_READ: {},
}))

jest.setTimeout(60_000)

const SEEDED_SUPER_ADMIN =
  "npub1flac02t5hw6jljk8x7mec22uq37ert8d3y3mpwzcma726g5pz4lsmfzlk6"
// Leaders the old hard-coded list in whitelist/check.ts did not contain.
const PREVIOUSLY_MISSED = {
  "Blink team (004)": "npub13ljnkd633c7maxatymv3y2fqq8vt3qk7j3tt0vytv90eztwgha9qmfcfhw",
  "Afribit (010)": "npub1djkgnrt4y05htqk7cxztnvqwcuyd3tea0jrxr8z9e6jx0zashskqkq9fhz",
  "Bitcoin Paraguay (014)":
    "npub1l57mdhhlkuulspszd6qarjxennpytglns6kth2agmjvrwyx8aqdqgj645x",
}
const STRANGER = bech32.encode("npub", bech32.toWords(Buffer.alloc(32, 7)))

const hexOf = (npub: string) =>
  Buffer.from(bech32.fromWords(bech32.decode(npub).words)).toString("hex")

/** Call the real route with a real signed session for `npub`. */
const check = async (npub: string) => {
  const res = {
    statusCode: 0,
    body: undefined as unknown as {
      success: boolean
      isSuperAdmin: boolean
      isWhitelisted: boolean
      role: string
    },
    setHeader: jest.fn(),
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: never) {
      this.body = payload
      return this
    },
  }
  const token = AuthManager.generateSession(`nostr:${hexOf(npub)}`)
  await checkHandler(
    { method: "GET", headers: {}, query: {}, cookies: { "auth-token": token } } as never,
    res as never,
  )
  return res
}

describePg("network roles come from the database", () => {
  let db: TestDatabase
  let sql: Client

  beforeAll(async () => {
    db = await setupTestDatabase("network_roles")
    sql = await db.connect()
  })
  afterAll(async () => {
    await sql?.end()
    await db?.teardown()
  })

  it("every active whitelisted leader in the database is reported as a leader", async () => {
    const rows = (
      await sql.query(
        "SELECT npub FROM community_leader_whitelist WHERE status = 'active'",
      )
    ).rows as { npub: string }[]
    for (const npub of Object.values(PREVIOUSLY_MISSED)) {
      expect(rows.map((r) => r.npub)).toContain(npub)
    }
    for (const { npub } of rows) {
      const res = await check(npub)
      expect(res.statusCode).toBe(200)
      expect(res.body.isWhitelisted).toBe(true)
      expect(["community_leader", "super_admin"]).toContain(res.body.role)
    }
  })

  it.each(Object.entries(PREVIOUSLY_MISSED))(
    "%s is a community leader (the hard-coded list reported 'user')",
    async (_name, npub) => {
      const res = await check(npub)
      expect(res.body).toMatchObject({
        success: true,
        isWhitelisted: true,
        isSuperAdmin: false,
        role: "community_leader",
      })
    },
  )

  it("the seeded super admin is a super admin; a stranger is a user", async () => {
    expect((await check(SEEDED_SUPER_ADMIN)).body).toMatchObject({
      isSuperAdmin: true,
      role: "super_admin",
    })
    expect((await check(STRANGER)).body).toMatchObject({
      isSuperAdmin: false,
      isWhitelisted: false,
      role: "user",
    })
  })

  it("suspending the super admin in the database revokes it (no hard-coded fallback)", async () => {
    await sql.query("UPDATE super_admins SET status = 'suspended' WHERE npub = $1", [
      SEEDED_SUPER_ADMIN,
    ])
    try {
      expect(await networkDb.isSuperAdmin(SEEDED_SUPER_ADMIN)).toBe(false)
      expect((await check(SEEDED_SUPER_ADMIN)).body.isSuperAdmin).toBe(false)
    } finally {
      await sql.query("UPDATE super_admins SET status = 'active' WHERE npub = $1", [
        SEEDED_SUPER_ADMIN,
      ])
    }
  })

  it("revoking a leader in the database is reflected immediately", async () => {
    const npub = PREVIOUSLY_MISSED["Afribit (010)"]
    await sql.query(
      "UPDATE community_leader_whitelist SET status = 'revoked' WHERE npub = $1",
      [npub],
    )
    try {
      expect((await check(npub)).body).toMatchObject({
        isWhitelisted: false,
        role: "user",
      })
    } finally {
      await sql.query(
        "UPDATE community_leader_whitelist SET status = 'active' WHERE npub = $1",
        [npub],
      )
    }
  })

  it("no session -> 401", async () => {
    const res = {
      statusCode: 0,
      setHeader: jest.fn(),
      status(c: number) {
        this.statusCode = c
        return this
      },
      json() {
        return this
      },
    }
    await checkHandler(
      { method: "GET", headers: {}, query: {}, cookies: {} } as never,
      res as never,
    )
    expect(res.statusCode).toBe(401)
  })
})
