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
      body: {
        walletId: "wallet-btc",
        apiKey: "blink_owner_key",
        walletCurrency: "BTC",
        ...body,
      },
    })

  beforeEach(() => {
    mockGetWalletInfo.mockResolvedValue([
      { id: "wallet-btc", walletCurrency: "BTC" },
      { id: "wallet-usd", walletCurrency: "USD" },
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
