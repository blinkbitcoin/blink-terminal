/** @jest-environment node */

/**
 * Network routes authenticate via the Nostr session cookie ONLY
 * (blink-wip#1679). The unsigned X-User-Npub / X-User-Pubkey headers used to
 * be bearer identities: anyone could impersonate the super admin or any
 * community leader. These tests assert:
 *
 * - every previously header-authenticated route answers 401 with no session;
 * - a forged X-User-Npub / X-User-Pubkey header is ignored (the session
 *   identity wins), which is the regression test for the report;
 * - identity is derived from the session in both forms (npub + hex).
 */

import { bech32 } from "bech32"

const npubEncode = (hex: string): string =>
  bech32.encode("npub", bech32.toWords(Buffer.from(hex, "hex")))
const npubDecode = (npub: string): string =>
  Buffer.from(bech32.fromWords(bech32.decode(npub).words)).toString("hex")

const OWNER = "a".repeat(64)
const OTHER = "b".repeat(64)
const OWNER_NPUB = npubEncode(OWNER)
const OTHER_NPUB = npubEncode(OTHER)

// The hardcoded super admin (pages/api/network/whitelist/check.ts)
const SUPER_ADMIN_NPUB = "npub1flac02t5hw6jljk8x7mec22uq37ert8d3y3mpwzcma726g5pz4lsmfzlk6"
const SUPER_ADMIN_HEX = npubDecode(SUPER_ADMIN_NPUB)

// --- Session ----------------------------------------------------------------
const sessions: Record<string, { username: string }> = {
  "token-owner": { username: `nostr:${OWNER}` },
  "token-other": { username: `nostr:${OTHER}` },
  "token-admin": { username: `nostr:${SUPER_ADMIN_HEX}` },
  "token-legacy": { username: "alice" },
  "token-badkey": { username: "nostr:not-a-pubkey" },
}
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: {
    verifySession: (token?: string) => (token ? (sessions[token] ?? null) : null),
    encryptApiKey: (k: string) => k,
    decryptApiKey: (k: string) => k,
  },
}))

// --- Network DB (any method is a jest.fn, created on first access) -----------
const mockDbFns: Record<string, jest.Mock> = {}
const mockDb = new Proxy(mockDbFns, {
  get: (target, prop: string) => (target[prop] ??= jest.fn()),
}) as Record<string, jest.Mock>
jest.mock(
  "../../lib/network/db",
  () =>
    // Getter-based: spreading a Proxy would capture nothing (ownKeys is empty).
    new Proxy({ __esModule: true } as Record<string, unknown>, {
      get: (target, prop: string) =>
        prop in target ? target[prop] : (mockDbFns[prop] ??= jest.fn()),
    }),
)

// --- Blink API (consent POST validates keys against it) -----------------------
jest.mock("../../lib/blink-api", () => {
  class BlinkAPI {
    getMe() {
      return Promise.resolve({ username: "alice" })
    }
  }
  return { __esModule: true, default: BlinkAPI, BlinkAPI }
})

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_READ: {},
  RATE_LIMIT_WRITE: {},
}))

import { getSessionNpub, requireSessionIdentity } from "../../lib/auth/session-pubkey"
import communitiesHandler from "../../pages/api/network/communities"
import consentHandler from "../../pages/api/network/consent"
import membersHandler from "../../pages/api/network/members"
import membershipsHandler from "../../pages/api/network/memberships"
import applyHandler from "../../pages/api/network/memberships/apply"
import pendingHandler from "../../pages/api/network/memberships/pending"
import reviewHandler from "../../pages/api/network/memberships/review"
import syncHandler from "../../pages/api/network/sync"
import whitelistHandler from "../../pages/api/network/whitelist/check"

type Handler = (req: never, res: never) => unknown

const call = async (
  handler: Handler,
  {
    token,
    method = "GET",
    query = {},
    body = {},
    headers = {},
  }: {
    token?: string
    method?: string
    query?: Record<string, unknown>
    body?: unknown
    headers?: Record<string, string>
  } = {},
) => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    setHeader: jest.fn(),
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
    end() {
      return this
    },
  }
  await handler(
    {
      method,
      query,
      body,
      headers: { host: "terminal.example", ...headers },
      cookies: token ? { "auth-token": token } : {},
      url: "/api/network",
    } as never,
    res as never,
  )
  return res
}

jest.spyOn(console, "log").mockImplementation(() => {})
jest.spyOn(console, "warn").mockImplementation(() => {})
jest.spyOn(console, "error").mockImplementation(() => {})

beforeEach(() => {
  for (const fn of Object.values(mockDbFns)) fn.mockReset()
  // Mirror the real db.ts: the hardcoded super admin is always an admin.
  mockDb.isSuperAdmin = jest.fn(async (npub: string) => npub === SUPER_ADMIN_NPUB)
})

describe("session-pubkey helpers", () => {
  it.each([
    [undefined, null],
    ["unknown-token", null],
    ["token-legacy", null],
    ["token-badkey", null],
    ["token-owner", OWNER_NPUB],
  ])("getSessionNpub(%p) -> %p", (token, expected) => {
    const req = { cookies: token ? { "auth-token": token } : {} } as never
    expect(getSessionNpub(req)).toBe(expected)
  })

  it("requireSessionIdentity returns hex + npub from the session", () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as never
    const req = { cookies: { "auth-token": "token-owner" } } as never
    expect(requireSessionIdentity(req, res)).toEqual({
      pubkey: OWNER,
      npub: OWNER_NPUB,
    })
  })
})

describe("no session -> 401 on every previously header-authenticated route", () => {
  it.each([
    ["GET", whitelistHandler],
    ["POST", communitiesHandler],
    ["GET", consentHandler],
    ["POST", consentHandler],
    ["DELETE", consentHandler],
    ["GET", membersHandler],
    ["DELETE", membersHandler],
    ["GET", membershipsHandler],
    ["POST", applyHandler],
    ["GET", pendingHandler],
    ["POST", reviewHandler],
    ["GET", syncHandler],
    ["POST", syncHandler],
  ])("%s -> 401", async (method, handler) => {
    const res = await call(handler as Handler, {
      method: method as string,
      query: { communityId: "1" },
      // Even a valid-looking super-admin header must not count as auth.
      headers: { "x-user-npub": SUPER_ADMIN_NPUB, "x-user-pubkey": SUPER_ADMIN_HEX },
    })
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ success: false, error: "Authentication required" })
  })

  it("non-nostr (legacy) session -> 401", async () => {
    const res = await call(membershipsHandler as Handler, { token: "token-legacy" })
    expect(res.statusCode).toBe(401)
  })
})

describe("forged X-User-Npub is ignored (regression for blink-wip#1679)", () => {
  it("whitelist/check: super-admin header with a regular session is just a user", async () => {
    const res = await call(whitelistHandler as Handler, {
      token: "token-other",
      headers: { "x-user-npub": SUPER_ADMIN_NPUB },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      isSuperAdmin: false,
      isWhitelisted: false,
      role: "user",
    })
  })

  it("whitelist/check: the real super admin (session only, no header) is recognized", async () => {
    const res = await call(whitelistHandler as Handler, { token: "token-admin" })
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ isSuperAdmin: true, role: "super_admin" })
  })

  it("communities POST: super-admin header does not authorize community creation", async () => {
    const res = await call(communitiesHandler as Handler, {
      token: "token-other",
      method: "POST",
      headers: { "x-user-npub": SUPER_ADMIN_NPUB },
      body: { name: "AOSO-E4-Probe-2", slug: "probe2", leaderNpub: OTHER_NPUB },
    })
    expect(res.statusCode).toBe(403)
    expect(mockDb.isSuperAdmin).toHaveBeenCalledWith(OTHER_NPUB)
    expect(mockDb.createCommunity).not.toHaveBeenCalled()
  })

  it("members GET: leader header on someone else's session -> 403", async () => {
    mockDb.getCommunityById = jest
      .fn()
      .mockResolvedValue({ id: "1", leader_npub: OWNER_NPUB })
    const res = await call(membersHandler as Handler, {
      token: "token-other",
      query: { communityId: "1" },
      headers: { "x-user-npub": OWNER_NPUB },
    })
    expect(res.statusCode).toBe(403)
    expect(mockDb.getCommunityMembers).not.toHaveBeenCalled()
  })

  it("members GET: the actual leader session passes", async () => {
    mockDb.getCommunityById = jest
      .fn()
      .mockResolvedValue({ id: "1", leader_npub: OWNER_NPUB })
    mockDb.getCommunityMembers = jest.fn().mockResolvedValue([])
    const res = await call(membersHandler as Handler, {
      token: "token-owner",
      query: { communityId: "1" },
    })
    expect(res.statusCode).toBe(200)
  })

  it("apply POST: membership is created for the session identity, both headers ignored", async () => {
    mockDb.getMembership = jest.fn().mockResolvedValue(null)
    mockDb.applyToJoinCommunity = jest.fn().mockResolvedValue({
      id: 7,
      community_id: "1",
      user_npub: OWNER_NPUB,
      status: "pending",
      application_note: "hi",
      applied_at: "2026-10-22",
    })
    const res = await call(applyHandler as Handler, {
      token: "token-owner",
      method: "POST",
      headers: { "x-user-npub": OTHER_NPUB, "x-user-pubkey": OTHER },
      body: { communityId: "1", applicationNote: "hi" },
    })
    expect(res.statusCode).toBe(200)
    expect(mockDb.applyToJoinCommunity).toHaveBeenCalledWith("1", OWNER_NPUB, OWNER, "hi")
  })

  it("sync POST: super-admin header does not authorize a full sync", async () => {
    const res = await call(syncHandler as Handler, {
      token: "token-other",
      method: "POST",
      headers: { "x-user-npub": SUPER_ADMIN_NPUB },
      body: { syncAll: true },
    })
    expect(res.statusCode).toBe(403)
    expect(mockDb.isSuperAdmin).toHaveBeenCalledWith(OTHER_NPUB)
  })

  it("review POST: reviewer identity comes from the session", async () => {
    mockDb.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: "5",
          status: "pending",
          leader_npub: OWNER_NPUB,
          community_name: "Ekasi",
        },
      ],
    })
    mockDb.reviewApplication = jest
      .fn()
      .mockResolvedValue({ id: "5", status: "approved" })
    const res = await call(reviewHandler as Handler, {
      token: "token-owner",
      method: "POST",
      headers: { "x-user-npub": OTHER_NPUB },
      body: { applicationId: "5", action: "approve" },
    })
    expect(res.statusCode).toBe(200)
    expect(mockDb.reviewApplication).toHaveBeenCalledWith("5", OWNER_NPUB, true, null)
  })
})

describe("public routes stay reachable without a session", () => {
  it("communities GET lists without auth", async () => {
    mockDb.listCommunities = jest.fn().mockResolvedValue([])
    const res = await call(communitiesHandler as Handler, {})
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ success: true, communities: [] })
  })
})
