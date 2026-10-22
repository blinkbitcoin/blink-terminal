/** @jest-environment node */

/**
 * Transaction receipt PDF hardening (blink-wip#1664): the route rendered
 * caller-supplied strings of any length via react-pdf, whose text layout of
 * one unbroken 200 KB string blocked the Node process for >60 s — an
 * unauthenticated single-request full-service DoS. The route now requires a
 * POS session and length-caps every rendered field before rendering.
 */

const mockRenderToBuffer = jest.fn()
jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: (...args: unknown[]) => mockRenderToBuffer(...args),
}))
jest.mock("../../lib/pdf/TransactionReceiptPDF", () => ({
  TransactionReceiptDocument: () => null,
}))
jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_WRITE: {},
}))
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  default: {
    verifySession: (token?: string) =>
      token === "pos-session" ? { username: "alice" } : null,
  },
}))

import receiptPdfHandler from "../../pages/api/transaction/receipt-pdf"

const call = async (body: unknown, { token }: { token?: string | null } = {}) => {
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
  await receiptPdfHandler(
    {
      method: "POST",
      body,
      headers: {},
      query: {},
      cookies: token ? { "auth-token": token } : {},
    } as never,
    res as never,
  )
  return res
}

const VALID_TX = {
  id: "a".repeat(64),
  direction: "RECEIVE",
  status: "SUCCESS",
  amount: "1,000 sats",
  settlementCurrency: "BTC",
  settlementAmount: 1000,
  settlementFee: 0,
  date: "2026-10-22",
  memo: "coffee",
  initiationVia: { __typename: "InitiationViaLn", paymentHash: "b".repeat(64) },
  settlementVia: { __typename: "SettlementViaLn", preImage: "c".repeat(64) },
}

// jest.config sets restoreMocks: true, which restores module-level spies
// before each test — spies must be created in beforeEach to capture.
let consoleLog: jest.SpyInstance

beforeEach(() => {
  consoleLog = jest.spyOn(console, "log").mockImplementation(() => {})
  jest.spyOn(console, "error").mockImplementation(() => {})
  mockRenderToBuffer.mockReset()
  mockRenderToBuffer.mockResolvedValue(Buffer.from("%PDF-fake"))
})

describe("authentication", () => {
  it("no session -> 401, nothing rendered", async () => {
    const res = await call({ transaction: VALID_TX })
    expect(res.statusCode).toBe(401)
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
  })

  it("invalid session token -> 401, nothing rendered", async () => {
    const res = await call({ transaction: VALID_TX }, { token: "bogus" })
    expect(res.statusCode).toBe(401)
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
  })

  it("valid session renders", async () => {
    const res = await call({ transaction: VALID_TX }, { token: "pos-session" })
    expect(res.statusCode).toBe(200)
    expect(mockRenderToBuffer).toHaveBeenCalled()
  })
})

describe("input bounding (the DoS fix)", () => {
  it("a valid transaction renders", async () => {
    const res = await call({ transaction: VALID_TX }, { token: "pos-session" })
    expect(res.statusCode).toBe(200)
    expect(mockRenderToBuffer).toHaveBeenCalled()
    expect((res.body as { pdf: string }).pdf).toBe(
      Buffer.from("%PDF-fake").toString("base64"),
    )
  })

  it("the 200 KB id from the report is rejected before rendering", async () => {
    const res = await call(
      { transaction: { ...VALID_TX, id: "x".repeat(200 * 1024) } },
      { token: "pos-session" },
    )
    expect(res.statusCode).toBe(400)
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
  })

  it.each([
    ["id", "x".repeat(129)],
    ["memo", "x".repeat(513)],
    ["status", "x".repeat(65)],
    ["amount", "x".repeat(65)],
    ["date", "x".repeat(65)],
    ["settlementCurrency", "x".repeat(65)],
  ])("oversized %s -> 400, nothing rendered", async (field, value) => {
    const res = await call(
      { transaction: { ...VALID_TX, [field]: value } },
      {
        token: "pos-session",
      },
    )
    expect(res.statusCode).toBe(400)
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
  })

  it.each([
    ["paymentHash", "x".repeat(129)],
    ["preImage", "x".repeat(129)],
    ["transactionHash", "x".repeat(129)],
    ["address", "x".repeat(129)],
    ["counterPartyUsername", "x".repeat(65)],
    ["__typename", "x".repeat(65)],
  ])("oversized via.%s -> 400", async (field, value) => {
    const res = await call(
      { transaction: { ...VALID_TX, initiationVia: { [field]: value } } },
      { token: "pos-session" },
    )
    expect(res.statusCode).toBe(400)
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
  })

  it.each([
    [{ transaction: null }, "missing transaction"],
    [{}, "missing transaction"],
    [{ transaction: { ...VALID_TX, id: 42 } }, "non-string id"],
    [{ transaction: { ...VALID_TX, direction: "SIDEWAYS" } }, "bad direction"],
    [{ transaction: { ...VALID_TX, settlementAmount: Number.NaN } }, "non-finite number"],
    [{ transaction: { ...VALID_TX, initiationVia: ["nope"] } }, "via array"],
  ])("malformed body %s -> 400", async (body, _label) => {
    const res = await call(body, { token: "pos-session" })
    expect(res.statusCode).toBe(400)
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
  })

  it("unknown transaction fields are dropped before rendering", async () => {
    await call(
      { transaction: { ...VALID_TX, evil: "x".repeat(10000) } },
      { token: "pos-session" },
    )
    const element = mockRenderToBuffer.mock.calls[0][0] as {
      props: { transaction: Record<string, unknown> }
    }
    expect(element.props.transaction.evil).toBeUndefined()
    expect(element.props.transaction.id).toBe(VALID_TX.id)
  })
})

describe("log hygiene", () => {
  it("never logs caller input at full length", async () => {
    const id = "d".repeat(128)
    const res = await call({ transaction: { ...VALID_TX, id } }, { token: "pos-session" })
    expect(res.statusCode).toBe(200)
    const logged = JSON.stringify(consoleLog.mock.calls)
    expect(logged).not.toContain(id)
    expect(logged).toContain(`${"d".repeat(16)}`)
  })

  it("logs nothing from rejected oversized input", async () => {
    await call(
      { transaction: { ...VALID_TX, id: "y".repeat(5000) } },
      { token: "pos-session" },
    )
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("y".repeat(100))
  })
})
