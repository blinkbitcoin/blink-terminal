/** @jest-environment node */

/**
 * Bolt Card spending (LNURL-withdraw) is off unless BOLTCARD_SPEND_ENABLED is
 * exactly "true": every method must get 503 before any card / ledger code
 * runs. The former unauthenticated top-up webhook is retired (410) regardless.
 */

const mockBoltcardCall = jest.fn()
jest.mock(
  "../../lib/boltcard",
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "__esModule"
            ? true
            : (...args: unknown[]) => mockBoltcardCall(prop, ...args),
      },
    ),
)

const mockBlinkApi = jest.fn()
jest.mock("../../lib/blink-api", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockBlinkApi(...args),
}))
jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_WRITE: {},
}))

import { isBoltcardSpendEnabled } from "../../lib/config/features"
import lnurlwHandler from "../../pages/api/boltcard/lnurlw/[cardId]"
import lnurlwCallbackHandler from "../../pages/api/boltcard/lnurlw/[cardId]/callback"
import webhookHandler from "../../pages/api/boltcard/webhook"

type Handler = (req: never, res: never) => unknown

const call = async (handler: Handler, req: Record<string, unknown>) => {
  const res = {
    statusCode: 0,
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
  }
  await handler(req as never, res as never)
  return res
}

describe("Bolt Card spend kill switch", () => {
  const rawFetch = jest.fn()
  beforeEach(() => {
    global.fetch = rawFetch as unknown as typeof fetch
  })

  const original = process.env.BOLTCARD_SPEND_ENABLED
  afterEach(() => {
    if (original === undefined) delete process.env.BOLTCARD_SPEND_ENABLED
    else process.env.BOLTCARD_SPEND_ENABLED = original
  })

  it.each([undefined, "", "false", "1", "TRUE", "yes"])(
    "is off for BOLTCARD_SPEND_ENABLED=%p",
    (value) => {
      if (value === undefined) delete process.env.BOLTCARD_SPEND_ENABLED
      else process.env.BOLTCARD_SPEND_ENABLED = value
      expect(isBoltcardSpendEnabled()).toBe(false)
    },
  )

  it('is on only for BOLTCARD_SPEND_ENABLED="true"', () => {
    process.env.BOLTCARD_SPEND_ENABLED = "true"
    expect(isBoltcardSpendEnabled()).toBe(true)
  })

  it("the retired top-up webhook is 410 even with spending enabled", async () => {
    process.env.BOLTCARD_SPEND_ENABLED = "true"
    const res = await call(webhookHandler as Handler, {
      method: "POST",
      query: {},
      body: { paymentHash: "ab", status: "PAID" },
      headers: {},
    })
    expect(res.statusCode).toBe(410)
    expect(mockBoltcardCall).not.toHaveBeenCalled()
  })

  it.each([
    ["lnurlw GET (tap)", lnurlwHandler, "GET", { cardId: "c1", p: "00", c: "00" }, {}],
    ["lnurlw POST", lnurlwHandler, "POST", { cardId: "c1" }, { k1: "c1", pr: "lnbc1" }],
    [
      "callback GET without k1",
      lnurlwCallbackHandler,
      "GET",
      { cardId: "c1", pr: "lnbc1" },
      {},
    ],
    [
      "callback POST",
      lnurlwCallbackHandler,
      "POST",
      { cardId: "c1" },
      { k1: "c1", pr: "lnbc1" },
    ],
  ])(
    "%s returns 503 (flag unset) without touching card code",
    async (_name, handler, method, query, body) => {
      delete process.env.BOLTCARD_SPEND_ENABLED
      const res = await call(handler as Handler, { method, query, body, headers: {} })

      expect(res.statusCode).toBe(503)
      expect(res.body).toEqual(expect.objectContaining({ status: "ERROR" }))
      expect(mockBoltcardCall).not.toHaveBeenCalled()
      expect(mockBlinkApi).not.toHaveBeenCalled()
      expect(rawFetch).not.toHaveBeenCalled()
    },
  )
})
