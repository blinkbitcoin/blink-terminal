/** @jest-environment node */

/**
 * /api/paycode/pdf input bounds (blink-wip#1664 follow-up). The route is
 * public (the public POS prints paycodes without a session) and renders in
 * the single Node process. Measured against a production build before the
 * fix: a 100 KB displayAmount took 25 s and starved concurrent requests; a
 * 198 KB PNG declaring 6000x6000 took 6 s (~144 MB decoded). Every rendered
 * value is now bounded before the renderer runs.
 */

import { toDataURL } from "qrcode"

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

import paycodePdfHandler, { config } from "../../pages/api/paycode/pdf"

import { SIGNATURE, dataUrl, ihdr, rgbaPng } from "./png-fixtures"

/** A PNG data URL that is only a signature + IHDR declaring w x h (no pixels). */
const pngHeader = (w: number, h: number) =>
  dataUrl(Buffer.concat([SIGNATURE, ihdr(w, h)]))

/** The review's 41-byte PNG: IHDR 1x1, then a PLTE header claiming 20 MB that is absent. */
const forgedPlte = () => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(20_000_000, 0)
  head.write("PLTE", 4, "latin1")
  return dataUrl(Buffer.concat([SIGNATURE, ihdr(1, 1), head]))
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

describe("paycode PDF input bounds", () => {
  let clientQr: string
  let log: jest.SpyInstance

  beforeAll(async () => {
    // Exactly what components/PublicPOS/PrintPaycodeView.tsx produces.
    clientQr = await toDataURL("https://pay.blink.sv/lnurlp/alice", {
      width: 400,
      margin: 2,
      errorCorrectionLevel: "H",
    })
  })

  beforeEach(() => {
    mockRenderToBuffer.mockReset()
    mockRenderToBuffer.mockResolvedValue(Buffer.from("%PDF"))
    log = jest.spyOn(console, "log").mockImplementation(() => {})
    jest.spyOn(console, "error").mockImplementation(() => {})
  })

  const base = () => ({
    lightningAddress: "alice@blink.sv",
    username: "alice",
    qrDataUrl: clientQr,
  })

  it("renders the request the app's client sends", async () => {
    const res = await call({
      ...base(),
      amount: null,
      displayAmount: null,
      webUrl: "https://terminal.blinkbtc.com/alice",
    })
    expect(res.statusCode).toBe(200)
    expect(mockRenderToBuffer).toHaveBeenCalledTimes(1)
  })

  it("renders a fixed-amount paycode within bounds", async () => {
    const res = await call({
      ...base(),
      amount: 1000,
      displayAmount: "$1,000,000.00 USD",
    })
    expect(res.statusCode).toBe(200)
    expect(mockRenderToBuffer).toHaveBeenCalledTimes(1)
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
    [
      "webUrl over 256 chars",
      { webUrl: `https://x/${"a".repeat(256)}` },
      "Invalid webUrl",
    ],
    [
      "PNG declaring 6000x6000 (decompression bomb)",
      { qrDataUrl: pngHeader(6000, 6000) },
      "Invalid qrDataUrl",
    ],
    [
      "a valid PNG 1025 px wide",
      { qrDataUrl: dataUrl(rgbaPng(1025, 1)) },
      "Invalid qrDataUrl",
    ],
    [
      "a tiny PNG with a forged chunk length (renderer heap OOM)",
      { qrDataUrl: forgedPlte() },
      "Invalid qrDataUrl",
    ],
    ["PNG declaring 0x0", { qrDataUrl: pngHeader(0, 0) }, "Invalid qrDataUrl"],
    [
      "PNG signature without IHDR",
      { qrDataUrl: "data:image/png;base64,iVBORw0KGgo=" },
      "Invalid qrDataUrl",
    ],
    [
      "JPEG (the client only sends PNG; dimensions unchecked)",
      { qrDataUrl: "data:image/jpeg;base64,/9j/4AAQ" },
      "Invalid qrDataUrl",
    ],
    [
      "data URL over 256 KB",
      { qrDataUrl: pngHeader(400, 400) + "A".repeat(256 * 1024) },
      "Invalid qrDataUrl",
    ],
  ])("rejects %s before rendering", async (_name, override, error) => {
    const res = await call({ ...base(), ...override })
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe(error)
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
  })

  it("accepts the maximum PNG side", async () => {
    expect(
      (await call({ ...base(), qrDataUrl: dataUrl(rgbaPng(1024, 1024)) })).statusCode,
    ).toBe(200)
  })

  it("never logs caller-supplied free text", async () => {
    await call({ ...base(), displayAmount: "LOGME".repeat(20) })
    await call({ ...base(), amount: 5, displayAmount: "LOGME" })
    expect(JSON.stringify(log.mock.calls)).not.toContain("LOGME")
  })

  it("caps the request body (was 10 MB)", () => {
    expect(config.api.bodyParser.sizeLimit).toBe("300kb")
  })
})
