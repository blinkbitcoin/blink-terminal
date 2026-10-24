/** @jest-environment node */

/**
 * /api/paycode/pdf (blink-wip#1664). The route is public (the public POS
 * prints paycodes without a session) and renders in the single Node process.
 *
 * - Text: measured on a production build before the fix, a 100 KB
 *   displayAmount took 25 s and starved concurrent requests. Every rendered
 *   value is bounded before the renderer runs.
 * - Image: the renderer's PNG parser (png-js) trusts chunk lengths (heap
 *   OOM from a 41-byte PNG), inflates without a limit, and throws from an
 *   async callback on a bad filter byte (request left hanging). The QR is
 *   therefore generated server-side from the username; a caller-supplied
 *   qrDataUrl is ignored and never reaches the renderer.
 */

import jsQR from "jsqr"
import { PNG } from "pngjs"

import { getAppUrl, getLnAddressDomain } from "../../lib/config/api"
import { buildStaticPaycode } from "../../lib/paycode-lnurl"
import paycodePdfHandler, { config } from "../../pages/api/paycode/pdf"

import { badFilterPng, dataUrl, forgedPlteLength, rgbaPng } from "./png-fixtures"

// jest.mock calls are hoisted above these imports.

const mockRenderToBuffer = jest.fn()
jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: (...args: unknown[]) => mockRenderToBuffer(...args),
}))
jest.mock("../../lib/pdf/PaycodePDF", () => ({
  PaycodeDocument: () => null,
}))
jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_PUBLIC: {},
}))

interface RenderedPaycode {
  lightningAddress: string
  qrDataUrl: string
  logoDataUrl?: string
  webUrl?: string
  username?: string
  amount?: number
  displayAmount?: string
}

const call = async (body: unknown) => {
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
  await paycodePdfHandler(
    { method: "POST", body, headers: {}, query: {}, cookies: {} } as never,
    res as never,
  )
  return res
}

/** The paycode props the route handed to the (mocked) renderer. */
const rendered = (): RenderedPaycode =>
  (mockRenderToBuffer.mock.calls[0][0] as { props: { paycode: RenderedPaycode } }).props
    .paycode

/** Decode a QR PNG data URL back to its text, as a phone camera would. */
const scan = (url: string) => {
  const png = PNG.sync.read(Buffer.from(url.split(",")[1], "base64"))
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data
}

const expected = (username: string, env: "production" | "staging") =>
  buildStaticPaycode(username, getLnAddressDomain(env), getAppUrl(env))

let log: jest.SpyInstance
beforeEach(() => {
  mockRenderToBuffer.mockReset()
  mockRenderToBuffer.mockResolvedValue(Buffer.from("%PDF"))
  log = jest.spyOn(console, "log").mockImplementation(() => {})
  jest.spyOn(console, "error").mockImplementation(() => {})
})

describe("paycode PDF: the QR is built server-side", () => {
  it.each(["production", "staging"] as const)(
    "%s: the QR scans to the same paycode the client shows (lib/paycode-lnurl.ts)",
    async (environment) => {
      const res = await call({ username: "Alice_1", environment })
      expect(res.statusCode).toBe(200)
      const paycode = rendered()
      const want = expected("alice_1", environment)
      expect(scan(paycode.qrDataUrl)).toBe(want.qrValue)
      expect(paycode.lightningAddress).toBe(want.lightningAddress)
      expect(paycode.webUrl).toBe(want.webUrl)
      expect(paycode.username).toBe("alice_1")
      expect(paycode.logoDataUrl).toMatch(/^data:image\/png;base64,/)
      expect((res.body as { lightningAddress: string }).lightningAddress).toBe(
        want.lightningAddress,
      )
    },
  )

  it("older clients: username derived from lightningAddress; their webUrl is not used", async () => {
    const res = await call({
      lightningAddress: "bob@blink.sv",
      qrDataUrl: dataUrl(rgbaPng(4, 4)),
      webUrl: "https://evil.example/bob",
    })
    expect(res.statusCode).toBe(200)
    expect(rendered().username).toBe("bob")
    expect(rendered().webUrl).not.toContain("evil.example")
  })

  it.each([
    [
      "the review's 70-byte PNG with scanline filter 5 (async throw, request hangs)",
      badFilterPng(),
    ],
    ["the review's 41-byte PNG with a forged PLTE length (heap OOM)", forgedPlteLength()],
    ["a valid but unrelated PNG", rgbaPng(8, 8)],
  ])("a caller-supplied qrDataUrl never reaches the renderer: %s", async (_name, png) => {
    const res = await call({ username: "alice", qrDataUrl: dataUrl(png) })
    expect(res.statusCode).toBe(200)
    const paycode = rendered()
    expect(paycode.qrDataUrl).not.toBe(dataUrl(png))
    expect(scan(paycode.qrDataUrl)).toBe(expected("alice", "production").qrValue)
  })

  it.each([
    ["missing", {}],
    ["too short", { username: "ab" }],
    ["bad characters", { username: "al ice" }],
    ["not a string", { username: ["alice"] }],
    ["bad lightningAddress localpart", { lightningAddress: "a!b@blink.sv" }],
  ])("rejects a %s username", async (_name, body) => {
    const res = await call(body)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe("Missing or invalid username")
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
  })

  it("rejects an unknown environment", async () => {
    const res = await call({ username: "alice", environment: "mainnet" })
    expect(res.statusCode).toBe(400)
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
  })
})

describe("paycode PDF: rendered text is bounded", () => {
  it("renders a fixed-amount paycode within bounds", async () => {
    const res = await call({
      username: "alice",
      amount: 1000,
      displayAmount: "$1,000,000.00 USD",
    })
    expect(res.statusCode).toBe(200)
    expect(rendered().displayAmount).toBe("$1,000,000.00 USD")
  })

  it.each([
    [
      "displayAmount over 64 chars",
      { displayAmount: "A".repeat(65) },
      "Invalid displayAmount",
    ],
    [
      "displayAmount 100 KB (the measured 25 s render)",
      { displayAmount: "A".repeat(100_000) },
      "Invalid displayAmount",
    ],
    ["displayAmount not a string", { displayAmount: ["x"] }, "Invalid displayAmount"],
    [
      "amount as a long digit string (rendered as text)",
      { amount: "9".repeat(20_000) },
      "Invalid amount",
    ],
    ["amount fractional", { amount: 1.5 }, "Invalid amount"],
    ["amount zero", { amount: 0 }, "Invalid amount"],
    ["amount negative", { amount: -1 }, "Invalid amount"],
    [
      "amount above the 21M BTC supply",
      { amount: 21_000_000 * 100_000_000 + 1 },
      "Invalid amount",
    ],
  ])("rejects %s before rendering", async (_name, override, error) => {
    const res = await call({ username: "alice", ...override })
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe(error)
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
  })

  it("never logs caller-supplied free text", async () => {
    await call({ username: "alice", displayAmount: "LOGME".repeat(20) })
    await call({ username: "alice", amount: 5, displayAmount: "LOGME" })
    expect(JSON.stringify(log.mock.calls)).not.toContain("LOGME")
  })

  it("caps the request body (was 10 MB; room for the ignored qrDataUrl of older clients)", () => {
    expect(config.api.bodyParser.sizeLimit).toBe("100kb")
  })
})
