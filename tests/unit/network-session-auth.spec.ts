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

// Sync triggers call into the sync service; keep it in-memory.
const mockSyncCommunityTransactions = jest.fn()
const mockSyncAllCommunities = jest.fn()
jest.mock("../../lib/network/syncService", () => ({
  __esModule: true,
  syncCommunityTransactions: (...args: unknown[]) =>
    mockSyncCommunityTransactions(...args),
  syncAllCommunities: (...args: unknown[]) => mockSyncAllCommunities(...args),
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
      // Browser mutations always send Origin + JSON content type; tests
      // override these explicitly to exercise the mutation guard.
      headers: {
        host: "terminal.example",
        ...(method === "POST" || method === "DELETE"
          ? { "content-type": "application/json", "origin": "https://terminal.example" }
          : {}),
        ...headers,
      },
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
  mockSyncCommunityTransactions.mockReset()
  mockSyncAllCommunities.mockReset()
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

describe("mutation guard (same-site CSRF boundary, PR #92 review)", () => {
  it("rejects form-urlencoded mutations before auth or DB", async () => {
    const res = await call(reviewHandler as Handler, {
      token: "token-owner",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { applicationId: "5", action: "approve" },
    })
    expect(res.statusCode).toBe(415)
    expect(mockDb.query).not.toHaveBeenCalled()
  })

  it("rejects a hostile same-site Origin", async () => {
    const res = await call(reviewHandler as Handler, {
      token: "token-owner",
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: { applicationId: "5", action: "approve" },
    })
    expect(res.statusCode).toBe(403)
    expect(mockDb.query).not.toHaveBeenCalled()
  })

  it("rejects a missing Origin", async () => {
    const res = await call(reviewHandler as Handler, {
      token: "token-owner",
      method: "POST",
      headers: { origin: undefined as unknown as string },
      body: { applicationId: "5", action: "approve" },
    })
    expect(res.statusCode).toBe(403)
  })

  it("rejects an unparseable Origin", async () => {
    const res = await call(reviewHandler as Handler, {
      token: "token-owner",
      method: "POST",
      headers: { origin: "not a url" },
      body: { applicationId: "5", action: "approve" },
    })
    expect(res.statusCode).toBe(403)
  })

  it("honours x-forwarded-host behind a proxy", async () => {
    mockDb.query = jest.fn().mockResolvedValue({
      rows: [{ id: "5", status: "pending", leader_npub: OWNER_NPUB }],
    })
    mockDb.reviewApplication = jest
      .fn()
      .mockResolvedValue({ id: "5", status: "approved" })
    const res = await call(reviewHandler as Handler, {
      token: "token-owner",
      method: "POST",
      headers: {
        "host": "internal:3000",
        "x-forwarded-host": "terminal.example",
        "origin": "https://terminal.example",
      },
      body: { applicationId: "5", action: "approve" },
    })
    expect(res.statusCode).toBe(200)
  })

  it.each([
    [
      "communities POST",
      communitiesHandler,
      "POST",
      { name: "x", slug: "x", leaderNpub: OWNER_NPUB },
    ],
    ["consent POST", consentHandler, "POST", { communityId: "1", apiKey: "blink_x" }],
    ["consent DELETE", consentHandler, "DELETE", {}],
    ["apply POST", applyHandler, "POST", { communityId: "1" }],
    ["sync POST", syncHandler, "POST", { syncAll: true }],
  ])(
    "%s: form post -> 415 before anything runs",
    async (_name, handler, method, body) => {
      const res = await call(handler as Handler, {
        token: "token-admin",
        method: method as string,
        query: { communityId: "1" },
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      })
      expect(res.statusCode).toBe(415)
    },
  )

  it("members DELETE: form post -> 415 before the mutation runs", async () => {
    // members.ts checks leadership (DB lookup) before method dispatch.
    mockDb.getCommunityById = jest
      .fn()
      .mockResolvedValue({ id: "1", leader_npub: SUPER_ADMIN_NPUB })
    const res = await call(membersHandler as Handler, {
      token: "token-admin",
      method: "DELETE",
      query: { communityId: "1" },
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { membershipId: "5" },
    })
    expect(res.statusCode).toBe(415)
    expect(mockDb.removeMember).not.toHaveBeenCalled()
  })
})

describe("session-bound mutations execute for the right session", () => {
  it("consent POST stores consent for the session npub", async () => {
    mockDb.getMembership = jest.fn().mockResolvedValue({ id: 3, status: "approved" })
    mockDb.getConsentByUser = jest.fn().mockResolvedValue(null)
    mockDb.createOrUpdateConsent = jest.fn().mockResolvedValue({
      id: 9,
      blink_username: "alice",
      consented_at: "2026-10-22",
    })
    const res = await call(consentHandler as Handler, {
      token: "token-owner",
      method: "POST",
      body: { communityId: "1", apiKey: "blink_valid" },
    })
    expect(res.statusCode).toBe(200)
    expect(mockDb.createOrUpdateConsent).toHaveBeenCalledWith(
      3,
      OWNER_NPUB,
      "1",
      expect.objectContaining({ consentGiven: true }),
    )
  })

  it("consent DELETE revokes for the session npub", async () => {
    mockDb.getMembership = jest.fn().mockResolvedValue({ id: 3, status: "approved" })
    mockDb.createOrUpdateConsent = jest.fn().mockResolvedValue({ id: 9 })
    const res = await call(consentHandler as Handler, {
      token: "token-owner",
      method: "DELETE",
      query: { communityId: "1" },
    })
    expect(res.statusCode).toBe(200)
    expect(mockDb.createOrUpdateConsent).toHaveBeenCalledWith(
      3,
      OWNER_NPUB,
      "1",
      expect.objectContaining({ consentGiven: false }),
    )
  })

  it("members DELETE removes a member as the leader session", async () => {
    mockDb.getCommunityById = jest
      .fn()
      .mockResolvedValue({ id: "1", leader_npub: OWNER_NPUB })
    mockDb.getMembershipById = jest
      .fn()
      .mockResolvedValue({ id: 5, community_id: "1", role: "member" })
    mockDb.removeMember = jest.fn().mockResolvedValue(undefined)
    const res = await call(membersHandler as Handler, {
      token: "token-owner",
      method: "DELETE",
      query: { communityId: "1" },
      body: { membershipId: "5" },
    })
    expect(res.statusCode).toBe(200)
    expect(mockDb.removeMember).toHaveBeenCalledWith("5", OWNER_NPUB)
  })

  it("memberships GET returns the session user's memberships", async () => {
    mockDb.getUserMemberships = jest.fn().mockResolvedValue([])
    const res = await call(membershipsHandler as Handler, { token: "token-owner" })
    expect(res.statusCode).toBe(200)
    expect(mockDb.getUserMemberships).toHaveBeenCalledWith(OWNER_NPUB)
    expect(res.body).toMatchObject({ success: true, memberships: [] })
  })

  it("pending GET lists applications for the leader's communities", async () => {
    mockDb.listCommunities = jest.fn().mockResolvedValue([
      { id: "1", leader_npub: OWNER_NPUB },
      { id: "2", leader_npub: OTHER_NPUB },
    ])
    mockDb.getPendingApplications = jest
      .fn()
      .mockResolvedValue([{ id: 11, status: "pending" }])
    const res = await call(pendingHandler as Handler, { token: "token-owner" })
    expect(res.statusCode).toBe(200)
    expect(mockDb.getPendingApplications).toHaveBeenCalledWith("1")
    expect(mockDb.getPendingApplications).not.toHaveBeenCalledWith("2")
  })

  it("communities POST creates a community as super admin", async () => {
    mockDb.isLeaderWhitelisted = jest.fn().mockResolvedValue(true)
    mockDb.createCommunity = jest.fn().mockResolvedValue({ id: 9, name: "New" })
    const res = await call(communitiesHandler as Handler, {
      token: "token-admin",
      method: "POST",
      body: { name: "New", slug: "new", leaderNpub: OWNER_NPUB },
    })
    expect(res.statusCode).toBe(201)
    expect(mockDb.createCommunity).toHaveBeenCalled()
    expect(mockDb.addToWhitelist).not.toHaveBeenCalled()
  })

  it("sync POST syncs one community as its leader", async () => {
    mockDb.getCommunityById = jest
      .fn()
      .mockResolvedValue({ id: "1", leader_npub: OWNER_NPUB })
    mockSyncCommunityTransactions.mockResolvedValue({
      members_synced: 1,
      total_transactions: 2,
    })
    const res = await call(syncHandler as Handler, {
      token: "token-owner",
      method: "POST",
      body: { communityId: "1" },
    })
    expect(res.statusCode).toBe(200)
    expect(mockSyncCommunityTransactions).toHaveBeenCalledWith("1")
  })

  it("sync POST syncAll runs as super admin only", async () => {
    mockSyncAllCommunities.mockResolvedValue({
      communities_synced: 2,
      total_transactions: 5,
    })
    const res = await call(syncHandler as Handler, {
      token: "token-admin",
      method: "POST",
      body: { syncAll: true },
    })
    expect(res.statusCode).toBe(200)
    expect(mockSyncAllCommunities).toHaveBeenCalled()
  })
})
