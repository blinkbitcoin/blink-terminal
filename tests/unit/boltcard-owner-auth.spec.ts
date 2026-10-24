/** @jest-environment node */

/**
 * Bolt Card management authorization:
 * - every management route requires the owner's Nostr session; the owner is
 *   taken from the session only, and another owner's card answers 404;
 * - register requires the API key to currently own the wallet (live check);
 * - stats are owner-scoped;
 * - card-protocol endpoints: the keys link never logs key material, a used
 *   registration answers 404, and reset/confirm only wipes after a recent
 *   tap-verified reset.
 */

const OWNER = "a".repeat(64)
const OTHER = "b".repeat(64)

// --- Session ----------------------------------------------------------------
const sessions: Record<string, { username: string }> = {
  "token-owner": { username: `nostr:${OWNER}` },
  "token-other": { username: `nostr:${OTHER}` },
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

// --- Store --------------------------------------------------------------------
const mockStoreFns: Record<string, jest.Mock> = {}
// Any store method is a jest.fn, created on first access.
const mockStore = new Proxy(mockStoreFns, {
  get: (target, prop: string) => (target[prop] ??= jest.fn()),
}) as Record<string, jest.Mock>
jest.mock("../../lib/boltcard/store", () => {
  const actual = jest.requireActual("../../lib/boltcard/store")
  return {
    ...actual,
    __esModule: true,
    default: new Proxy(
      {},
      {
        get: (_t, prop: string) => mockStore[prop],
      },
    ),
  }
})

// --- Blink API ------------------------------------------------------------------
const mockGetWalletInfo = jest.fn()
jest.mock("../../lib/blink-api", () => {
  class BlinkAuthError extends Error {}
  class BlinkAPI {
    getWalletInfo() {
      return mockGetWalletInfo()
    }
  }
  return { __esModule: true, default: BlinkAPI, BlinkAPI, BlinkAuthError }
})

// --- Tap verification (reset) -----------------------------------------------------
const mockVerifyCardTap = jest.fn()
jest.mock("../../lib/boltcard/crypto", () => ({
  ...jest.requireActual("../../lib/boltcard/crypto"),
  verifyCardTap: (...args: unknown[]) => mockVerifyCardTap(...args),
}))

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_READ: {},
  RATE_LIMIT_WRITE: {},
}))

import { BlinkAuthError } from "../../lib/blink-api"
import { getSessionPubkey } from "../../lib/boltcard/owner-auth"
import cardHandler from "../../pages/api/boltcard/cards/[cardId]"
import cardsHandler from "../../pages/api/boltcard/cards/index"
import fundHandler from "../../pages/api/boltcard/fund"
import keysHandler from "../../pages/api/boltcard/keys/[registrationId]"
import recoverKeysHandler from "../../pages/api/boltcard/recover-keys"
import registerHandler from "../../pages/api/boltcard/register"
import resetHandler from "../../pages/api/boltcard/reset/[cardId]"
import resetConfirmHandler from "../../pages/api/boltcard/reset/[cardId]/confirm"
import statsHandler from "../../pages/api/boltcard/stats"
import wipeKeysHandler from "../../pages/api/boltcard/wipe-keys/[cardId]"

type Handler = (req: never, res: never) => unknown

const KEYS = {
  k0: "00112233445566778899aabbccddeeff",
  k1: "11112233445566778899aabbccddeeff",
  k2: "22112233445566778899aabbccddeeff",
  k3: "33112233445566778899aabbccddeeff",
  k4: "44112233445566778899aabbccddeeff",
}

const card = (overrides: Record<string, unknown> = {}) => ({
  id: "c".repeat(32),
  cardUid: "04a39493cc8680",
  cardIdHash: "h".repeat(32),
  ownerPubkey: OWNER,
  walletId: "wallet-btc",
  walletCurrency: "BTC",
  balance: 1000,
  status: "ACTIVE",
  version: 1,
  lastCounter: 0,
  environment: "production",
  apiKey: "blink_owner_key",
  ...KEYS,
  ...overrides,
})

/**
 * The exact headers the browser client sends on mutations (useBoltcards.ts,
 * BoltcardDetails.tsx, BoltcardRecovery.tsx): JSON content type plus the
 * same-origin Origin the browser attaches. Passed explicitly per test — the
 * call() helper must not inject them, or client/guard drift goes unnoticed
 * (PR #92: a bodyless DELETE without Content-Type shipped that way).
 */
const CLIENT_MUTATION_HEADERS = {
  "content-type": "application/json",
  "origin": "https://terminal.example",
}

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
      url: "/api/boltcard",
    } as never,
    res as never,
  )
  return res
}

const consoleLog = jest.spyOn(console, "log").mockImplementation(() => {})
jest.spyOn(console, "warn").mockImplementation(() => {})
jest.spyOn(console, "error").mockImplementation(() => {})

beforeEach(() => {
  for (const fn of Object.values(mockStoreFns)) fn.mockReset()
  mockGetWalletInfo.mockReset()
  mockVerifyCardTap.mockReset()
  consoleLog.mockClear()
  mockStore.getCard = jest.fn(async (id: string) => (id === card().id ? card() : null))
  mockStore.getTopUpsNeedingReview = jest.fn().mockResolvedValue([])
  mockStore.getStaleWithdrawals = jest.fn().mockResolvedValue([])
})

describe("getSessionPubkey", () => {
  it.each([
    [undefined, null],
    ["unknown-token", null],
    ["token-legacy", null],
    ["token-badkey", null],
    ["token-owner", OWNER],
  ])("%p -> %p", (token, expected) => {
    const req = { cookies: token ? { "auth-token": token } : {} } as never
    expect(getSessionPubkey(req)).toBe(expected)
  })
})

describe("cards list: session owner only", () => {
  it("requires a session", async () => {
    const res = await call(cardsHandler as Handler)
    expect(res.statusCode).toBe(401)
    expect(mockStore.getCardsByOwner).not.toHaveBeenCalled()
  })

  it("lists the session's cards and ignores ?ownerPubkey=", async () => {
    mockStore.getCardsByOwner = jest.fn().mockResolvedValue([card()])
    const res = await call(cardsHandler as Handler, {
      token: "token-owner",
      query: { ownerPubkey: OTHER },
    })
    expect(res.statusCode).toBe(200)
    expect(mockStore.getCardsByOwner).toHaveBeenCalledWith(OWNER)
    expect(JSON.stringify(res.body)).not.toContain(KEYS.k0)
  })
})

describe("cards/[cardId]: owner only, every method", () => {
  const cardId = card().id

  it.each(["GET", "PUT", "DELETE", "POST"])(
    "%s without a session -> 401",
    async (method) => {
      const res = await call(cardHandler as Handler, { method, query: { cardId } })
      expect(res.statusCode).toBe(401)
    },
  )

  it.each([
    ["GET", {}],
    ["PUT", { name: "mine now" }],
    ["DELETE", {}],
    ["POST", { action: "adjust", amount: "1000000" }],
    ["POST", { action: "disable" }],
  ])("%s %p on another owner's card -> 404, nothing changes", async (method, body) => {
    const res = await call(cardHandler as Handler, {
      token: "token-other",
      method,
      query: { cardId },
      body,
    })
    expect(res.statusCode).toBe(404)
    for (const name of ["updateCard", "wipeCard", "updateCardBalance", "disableCard"]) {
      expect(mockStore[name]).not.toHaveBeenCalled()
    }
  })

  it("the owner can read their card", async () => {
    mockStore.getCardTransactions = jest.fn().mockResolvedValue([])
    const res = await call(cardHandler as Handler, {
      token: "token-owner",
      query: { cardId },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.stringify(res.body)).not.toContain(KEYS.k0)
  })

  it("unknown methods -> 405 before any lookup", async () => {
    const res = await call(cardHandler as Handler, { method: "PATCH", query: { cardId } })
    expect(res.statusCode).toBe(405)
    expect(mockStore.getCard).not.toHaveBeenCalled()
  })
})

describe("legacy owner stored with mixed-case pubkey", () => {
  beforeEach(() => {
    mockStore.getCard = jest
      .fn()
      .mockResolvedValue(card({ ownerPubkey: OWNER.toUpperCase() }))
  })

  it("is still recognized as the owner by the lowercase session", async () => {
    mockStore.getCardTransactions = jest.fn().mockResolvedValue([])
    const res = await call(cardHandler as Handler, {
      token: "token-owner",
      query: { cardId: card().id },
    })
    expect(res.statusCode).toBe(200)
  })

  it("can get wipe keys", async () => {
    const res = await call(wipeKeysHandler as Handler, {
      token: "token-owner",
      query: { cardId: card().id },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe("fund: owner only", () => {
  const fund = (token?: string) =>
    call(fundHandler as Handler, {
      token,
      method: "POST",
      headers: CLIENT_MUTATION_HEADERS,
      body: { cardId: card().id, mode: "set", newBalance: 1_000_000_000 },
    })

  it("requires a session", async () => {
    expect((await fund()).statusCode).toBe(401)
    expect(mockStore.updateCardBalance).not.toHaveBeenCalled()
  })

  it("another owner's card -> 404, balance untouched", async () => {
    expect((await fund("token-other")).statusCode).toBe(404)
    expect(mockStore.updateCardBalance).not.toHaveBeenCalled()
  })

  it("refuses to fund a wiped card", async () => {
    mockStore.getCard = jest.fn().mockResolvedValue(card({ status: "WIPED" }))
    const res = await call(fundHandler as Handler, {
      token: "token-owner",
      method: "POST",
      headers: CLIENT_MUTATION_HEADERS,
      body: { cardId: card().id, amount: 100 },
    })
    expect(res.statusCode).toBe(400)
    expect(mockStore.updateCardBalance).not.toHaveBeenCalled()
  })

  it("the owner can fund their card", async () => {
    mockGetWalletInfo.mockResolvedValue([
      { id: "wallet-btc", walletCurrency: "BTC", balance: 5 },
    ])
    mockStore.updateCardBalance = jest.fn().mockResolvedValue(true)
    mockStore.recordTransaction = jest.fn().mockResolvedValue(undefined)
    const res = await call(fundHandler as Handler, {
      token: "token-owner",
      method: "POST",
      headers: CLIENT_MUTATION_HEADERS,
      body: { cardId: card().id, amount: 100 },
    })
    expect(res.statusCode).toBe(200)
    expect(mockStore.updateCardBalance).toHaveBeenCalledWith(card().id, 1100)
  })
})

describe("register: session owner + live wallet ownership", () => {
  const register = (token: string | undefined, body: Record<string, unknown> = {}) =>
    call(registerHandler as Handler, {
      token,
      method: "POST",
      headers: CLIENT_MUTATION_HEADERS,
      body: {
        walletId: "wallet-btc",
        apiKey: "blink_owner_key",
        walletCurrency: "BTC",
        ...body,
      },
    })

  beforeEach(() => {
    mockGetWalletInfo.mockResolvedValue([
      { id: "wallet-btc", walletCurrency: "BTC", balance: 100000 },
      { id: "wallet-usd", walletCurrency: "USD", balance: 100000 },
    ])
    mockStore.createPendingRegistration = jest.fn().mockResolvedValue({
      id: "r".repeat(32),
      name: null,
      walletCurrency: "BTC",
      initialBalance: 0,
      status: "PENDING",
      createdAt: 1,
      expiresAt: 2,
    })
  })

  it("requires a session", async () => {
    expect((await register(undefined)).statusCode).toBe(401)
    expect(mockStore.createPendingRegistration).not.toHaveBeenCalled()
  })

  it("rejects an ownerPubkey that isn't the session's", async () => {
    expect((await register("token-owner", { ownerPubkey: OTHER })).statusCode).toBe(403)
    expect(mockStore.createPendingRegistration).not.toHaveBeenCalled()
  })

  it("rejects a key that doesn't own the wallet", async () => {
    expect((await register("token-owner", { walletId: "someone-else" })).statusCode).toBe(
      403,
    )
  })

  it("rejects a revoked key (403) and a Blink outage (503)", async () => {
    mockGetWalletInfo.mockRejectedValueOnce(new BlinkAuthError("401"))
    expect((await register("token-owner")).statusCode).toBe(403)
    mockGetWalletInfo.mockRejectedValueOnce(new Error("502"))
    expect((await register("token-owner")).statusCode).toBe(503)
    expect(mockStore.createPendingRegistration).not.toHaveBeenCalled()
  })

  it("rejects a currency that doesn't match the wallet", async () => {
    const res = await register("token-owner", {
      walletId: "wallet-usd",
      walletCurrency: "BTC",
    })
    expect(res.statusCode).toBe(400)
  })

  it("registers for the session owner", async () => {
    const res = await register("token-owner", { ownerPubkey: OWNER })
    expect(res.statusCode).toBe(200)
    expect(mockStore.createPendingRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ ownerPubkey: OWNER, walletId: "wallet-btc" }),
      expect.objectContaining({ environment: "production" }),
    )
    // The single-use keys link is not logged
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("r".repeat(32))
  })
})

describe("stats: owner-scoped", () => {
  it("requires a session", async () => {
    expect((await call(statsHandler as Handler)).statusCode).toBe(401)
    expect(mockStore.getStats).not.toHaveBeenCalled()
  })

  it("aggregates only the session's cards", async () => {
    mockStore.getCardsByOwner = jest
      .fn()
      .mockResolvedValue([
        card(),
        card({ id: "d".repeat(32), walletCurrency: "USD", balance: 50 }),
      ])
    mockStore.getPendingRegistrationsByOwner = jest.fn().mockResolvedValue([])
    mockStore.getAllPendingTopUps = jest
      .fn()
      .mockResolvedValue([{ cardId: card().id }, { cardId: "someone-elses-card" }])

    const res = await call(statsHandler as Handler, { token: "token-owner" })

    expect(mockStore.getCardsByOwner).toHaveBeenCalledWith(OWNER)
    expect(mockStore.getStats).not.toHaveBeenCalled()
    expect((res.body as { stats: Record<string, number> }).stats).toMatchObject({
      total: 2,
      btcCards: 1,
      usdCards: 1,
      totalBtcBalanceSats: 1000,
      totalUsdBalanceCents: 50,
      pendingTopUps: 1,
    })
  })

  it("reports in-flight and stale withdrawals for the session's cards only (blink-wip#1619)", async () => {
    const mine = card().id
    mockStore.getCardsByOwner = jest.fn().mockResolvedValue([card()])
    mockStore.getPendingRegistrationsByOwner = jest.fn().mockResolvedValue([])
    mockStore.getAllPendingTopUps = jest.fn().mockResolvedValue([])
    const stale = {
      paymentHash: "ab".repeat(32),
      cardId: mine,
      amount: 1000,
      kind: "UNKNOWN",
      attempt: 1,
      createdAt: 0,
      ageMs: 42 * 60_000,
    }
    mockStore.getStaleWithdrawals = jest.fn(async (olderThanMs: number) =>
      olderThanMs === 0
        ? [stale, { ...stale, paymentHash: "cd".repeat(32), ageMs: 60_000 }]
        : [stale],
    )
    const res = await call(statsHandler as Handler, { token: "token-owner" })
    expect(res.statusCode).toBe(200)
    // Scoped to the owner's card ids, both for the in-flight count and the stale list
    expect(mockStore.getStaleWithdrawals).toHaveBeenCalledWith(0, [mine])
    expect(mockStore.getStaleWithdrawals).toHaveBeenCalledWith(15 * 60_000, [mine])
    expect((res.body as { stats: Record<string, unknown> }).stats).toMatchObject({
      withdrawalsInFlight: 2,
      withdrawalsStale: [
        {
          paymentHash: "ab".repeat(32),
          cardId: mine,
          amount: 1000,
          kind: "UNKNOWN",
          ageMinutes: 42,
        },
      ],
    })
  })
})

describe("wipe-keys / recover-keys", () => {
  it("wipe-keys: another owner's card -> 404 without keys", async () => {
    const res = await call(wipeKeysHandler as Handler, {
      token: "token-other",
      query: { cardId: card().id },
    })
    expect(res.statusCode).toBe(404)
    expect(mockStore.getIssuerKey).not.toHaveBeenCalled()
  })

  it("wipe-keys: the owner gets the card's stored keys (no issuer-key dependency)", async () => {
    const res = await call(wipeKeysHandler as Handler, {
      token: "token-owner",
      query: { cardId: card().id },
    })
    expect(res.statusCode).toBe(200)
    expect((res.body as { keys: Record<string, string> }).keys.k0).toBe(
      KEYS.k0.toUpperCase(),
    )
    expect(mockStore.getIssuerKey).not.toHaveBeenCalled()
  })

  it("wipe-keys: derives from the issuer key only when stored keys are missing", async () => {
    mockStore.getCard = jest.fn().mockResolvedValue(card({ k0: null }))
    mockStore.getIssuerKey = jest.fn().mockResolvedValue("0".repeat(32))
    const res = await call(wipeKeysHandler as Handler, {
      token: "token-owner",
      query: { cardId: card().id },
    })
    expect(res.statusCode).toBe(200)
    expect(mockStore.getIssuerKey).toHaveBeenCalledWith(OWNER)
  })

  it("recover-keys requires a session", async () => {
    const res = await call(recoverKeysHandler as Handler, {
      method: "POST",
      body: { uid: "04a39493cc8680" },
    })
    expect(res.statusCode).toBe(401)
    expect(mockStore.getIssuerKey).not.toHaveBeenCalled()
  })
})

describe("keys link (NFC Programmer app)", () => {
  const registrationId = "e".repeat(32)
  const post = () =>
    call(keysHandler as Handler, {
      method: "POST",
      query: { registrationId },
      body: { UID: "04A39493CC8680" },
      headers: { cookie: "auth-token=secret-cookie" },
    })

  it("a used registration answers 404", async () => {
    mockStore.getPendingRegistration = jest
      .fn()
      .mockResolvedValue({ status: "COMPLETED", expiresAt: Date.now() + 60_000 })
    expect((await post()).statusCode).toBe(404)
    expect(mockStore.completePendingRegistration).not.toHaveBeenCalled()
  })

  it("a concurrently claimed registration answers 404", async () => {
    mockStore.getPendingRegistration = jest
      .fn()
      .mockResolvedValue({ status: "PENDING", expiresAt: Date.now() + 60_000 })
    mockStore.completePendingRegistration = jest
      .fn()
      .mockRejectedValue(new Error("Registration is not pending"))
    expect((await post()).statusCode).toBe(404)
  })

  it("activation failure -> 500 with a recovery hint and no keys", async () => {
    mockStore.getPendingRegistration = jest
      .fn()
      .mockResolvedValue({ status: "PENDING", expiresAt: Date.now() + 60_000 })
    mockStore.completePendingRegistration = jest
      .fn()
      .mockRejectedValue(new Error("Failed to activate card"))

    const res = await post()

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      status: "ERROR",
      reason:
        "Card could not be activated - start a new registration and tap the same card",
    })
  })

  it("returns keys once and never logs keys, headers or the registration id", async () => {
    mockStore.getPendingRegistration = jest
      .fn()
      .mockResolvedValue({ status: "PENDING", expiresAt: Date.now() + 60_000 })
    mockStore.completePendingRegistration = jest.fn().mockResolvedValue(card())

    const res = await post()

    expect(res.statusCode).toBe(200)
    expect(JSON.stringify(res.body)).toContain(KEYS.k0.toUpperCase())
    const logged = JSON.stringify(consoleLog.mock.calls).toLowerCase()
    for (const secret of [KEYS.k0, KEYS.k1, KEYS.k2, registrationId, "secret-cookie"]) {
      expect(logged).not.toContain(secret)
    }
  })
})

describe("reset: tap-verified, then a short confirm window", () => {
  const cardId = card().id

  const resetTap = () =>
    call(resetHandler as Handler, {
      method: "POST",
      query: { cardId },
      body: {
        LNURLW: `lnurlw://terminal.example/api/boltcard/lnurlw/${cardId}?p=${"A".repeat(32)}&c=${"B".repeat(16)}`,
      },
    })

  it("a valid reset tap is recorded atomically, then keys are returned", async () => {
    mockVerifyCardTap.mockReturnValue({ valid: true, counter: 5 })
    mockStore.recordVerifiedResetTap = jest.fn().mockResolvedValue(true)

    const res = await resetTap()

    expect(res.statusCode).toBe(200)
    expect(mockStore.recordVerifiedResetTap).toHaveBeenCalledWith(cardId, 5)
    expect(mockStore.updateLastCounter).not.toHaveBeenCalled()
    expect(JSON.stringify(res.body)).toContain(KEYS.k0.toUpperCase())
  })

  it("a replayed / concurrent tap (record not persisted) -> 409 without keys", async () => {
    mockVerifyCardTap.mockReturnValue({ valid: true, counter: 5 })
    mockStore.recordVerifiedResetTap = jest.fn().mockResolvedValue(false)

    const res = await resetTap()

    expect(res.statusCode).toBe(409)
    expect(JSON.stringify(res.body)).not.toContain(KEYS.k0.toUpperCase())
    expect(JSON.stringify(res.body)).not.toContain(KEYS.k0)
  })

  it("a database error while recording -> 500 without keys", async () => {
    mockVerifyCardTap.mockReturnValue({ valid: true, counter: 5 })
    mockStore.recordVerifiedResetTap = jest.fn().mockRejectedValue(new Error("db down"))

    const res = await resetTap()

    expect(res.statusCode).toBe(500)
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain(KEYS.k0)
  })

  it("an invalid tap is refused and not recorded", async () => {
    mockVerifyCardTap.mockReturnValue({ valid: false, error: "bad cmac" })
    const res = await call(resetHandler as Handler, {
      method: "POST",
      query: { cardId },
      body: {
        LNURLW: `lnurlw://x/api/boltcard/lnurlw/${cardId}?p=${"A".repeat(32)}&c=${"B".repeat(16)}`,
      },
    })
    expect(res.statusCode).toBe(401)
    expect(mockStore.recordVerifiedResetTap).not.toHaveBeenCalled()
  })

  it("confirm without a recent verified reset -> 403, card not wiped", async () => {
    mockStore.wipeCardAfterVerifiedReset = jest.fn().mockResolvedValue(false)
    const res = await call(resetConfirmHandler as Handler, {
      method: "POST",
      query: { cardId },
    })
    expect(res.statusCode).toBe(403)
    expect(mockStore.wipeCard).not.toHaveBeenCalled()
  })

  it("confirm after a verified reset wipes within the 10 minute window", async () => {
    mockStore.wipeCardAfterVerifiedReset = jest.fn().mockResolvedValue(true)
    const res = await call(resetConfirmHandler as Handler, {
      method: "POST",
      query: { cardId },
    })
    expect(res.statusCode).toBe(200)
    expect(mockStore.wipeCardAfterVerifiedReset).toHaveBeenCalledWith(
      cardId,
      10 * 60 * 1000,
    )
  })
})

/**
 * Cookie-authenticated Bolt Card mutations carry ambient session authority,
 * so they get the same CSRF boundary as the network routes (PR #92's
 * lib/auth/mutation-guard.ts): JSON content type + same-origin Origin. The
 * guard runs after session/ownership, so 401/404 answers are unchanged.
 */
describe("mutation guard on cookie-authenticated Bolt Card routes", () => {
  const cardId = card().id
  const mutations: Array<
    [string, Handler, string, Record<string, unknown>, Record<string, unknown>, string[]]
  > = [
    [
      "cards PUT",
      cardHandler as Handler,
      "PUT",
      { cardId },
      { name: "x" },
      ["updateCard"],
    ],
    ["cards DELETE", cardHandler as Handler, "DELETE", { cardId }, {}, ["wipeCard"]],
    [
      "cards POST adjust",
      cardHandler as Handler,
      "POST",
      { cardId },
      { action: "adjust", amount: "1000" },
      ["updateCardBalance"],
    ],
    [
      "fund",
      fundHandler as Handler,
      "POST",
      {},
      { cardId, amount: 100 },
      ["updateCardBalance"],
    ],
    [
      "register",
      registerHandler as Handler,
      "POST",
      {},
      { walletId: "wallet-btc", apiKey: "blink_owner_key", walletCurrency: "BTC" },
      ["createPendingRegistration"],
    ],
    [
      "recover-keys",
      recoverKeysHandler as Handler,
      "POST",
      {},
      { uid: "04a39493cc8680" },
      ["getIssuerKey"],
    ],
  ]

  beforeEach(() => {
    mockGetWalletInfo.mockResolvedValue([
      { id: "wallet-btc", walletCurrency: "BTC", balance: 100000 },
    ])
  })

  describe.each(mutations)("%s", (_name, handler, method, query, body, untouched) => {
    const run = (headers: Record<string, string>) =>
      call(handler, { token: "token-owner", method, query, body, headers })

    it("form post -> 415", async () => {
      const res = await run({
        "content-type": "application/x-www-form-urlencoded",
        "origin": "https://terminal.example",
      })
      expect(res.statusCode).toBe(415)
      for (const fn of untouched) expect(mockStore[fn]).not.toHaveBeenCalled()
    })

    it("cross-origin JSON -> 403", async () => {
      const res = await run({
        "content-type": "application/json",
        "origin": "https://evil.example",
      })
      expect(res.statusCode).toBe(403)
      expect(res.body).toEqual({ success: false, error: "Untrusted request origin" })
      for (const fn of untouched) expect(mockStore[fn]).not.toHaveBeenCalled()
    })

    it("missing Origin -> 403", async () => {
      const res = await run({ "content-type": "application/json" })
      expect(res.statusCode).toBe(403)
      for (const fn of untouched) expect(mockStore[fn]).not.toHaveBeenCalled()
    })

    it("no session is still 401, before the guard", async () => {
      const res = await call(handler, { method, query, body, headers: {} })
      expect(res.statusCode).toBe(401)
    })
  })

  it("the browser client's bodyless DELETE (JSON content type, no body) passes the guard", async () => {
    // useBoltcards.ts deleteCard sends exactly this shape
    mockStore.wipeCard = jest.fn().mockResolvedValue(true)
    const res = await call(cardHandler as Handler, {
      token: "token-owner",
      method: "DELETE",
      query: { cardId },
      body: undefined,
      headers: CLIENT_MUTATION_HEADERS,
    })
    expect(res.statusCode).not.toBe(415)
    expect(res.statusCode).not.toBe(403)
  })

  it("GET card details needs no mutation headers", async () => {
    mockStore.getCardTransactions = jest.fn().mockResolvedValue([])
    const res = await call(cardHandler as Handler, {
      token: "token-owner",
      query: { cardId },
    })
    expect(res.statusCode).toBe(200)
  })
})
