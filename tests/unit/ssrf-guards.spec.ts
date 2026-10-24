/** @jest-environment node */

/**
 * SSRF regression tests: voucher PDF route disabled, react-pdf image sources
 * restricted to inline data URLs, batch-payment / LNURL fetches refuse
 * internal targets.
 */

import { bech32 } from "bech32"

jest.mock("nostr-tools", () => ({
  nip19: { decode: () => ({ type: "npub", data: "x" }) },
}))

// Real safeFetchJson, with DNS + https stubbed so nothing leaves the process.
const mockLookup = jest.fn()
const mockHttpsRequest = jest.fn()
jest.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}))
jest.mock("node:https", () => ({
  __esModule: true,
  default: { request: (...args: unknown[]) => mockHttpsRequest(...args) },
}))

jest.mock("../../lib/config/api", () => ({
  getApiUrl: () => "https://api.blink.sv/graphql",
  getAllValidDomains: () => ["blink.sv"],
}))

import {
  RECIPIENT_TYPES,
  type ParsedRecipient,
} from "../../lib/batch-payments/csv-parser"
import { executeLnurlPayment } from "../../lib/batch-payments/payment-executor"
import {
  ERROR_CODES,
  validateLnAddress,
  validateLnurl,
} from "../../lib/batch-payments/recipient-validator"
import { isVoucherPdfEnabled } from "../../lib/config/features"
import { isSafeImageDataUrl, safeImageSrc } from "../../lib/pdf/safe-image-src"
import voucherPdfHandler, {
  config as voucherPdfConfig,
} from "../../pages/api/voucher/pdf"

const INTERNAL_TARGETS = [
  "127.0.0.1",
  "10.0.0.5:8080",
  "10.0.0.1",
  "169.254.169.254",
  "[::1]",
]

const rawFetch = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  global.fetch = rawFetch as unknown as typeof fetch
})

const recipient = (
  type: ParsedRecipient["type"],
  normalized: string,
): ParsedRecipient => ({
  rowNumber: 1,
  original: normalized,
  type,
  normalized,
  amount: 10,
  amountSats: 10,
  currency: "SATS",
  memo: "",
})

const encodeLnurl = (url: string): string =>
  bech32.encode("lnurl", bech32.toWords(Buffer.from(url, "utf8")), 2000)

describe("/api/voucher/pdf is disabled", () => {
  const callRoute = (body: unknown) => {
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
    voucherPdfHandler({ method: "POST", body } as never, res as never)
    return res
  }

  it("returns 503 for a legitimate request", () => {
    const res = callRoute({
      vouchers: [{ satsAmount: 100, qrDataUrl: "data:image/png;base64,AAAA" }],
    })
    expect(res.statusCode).toBe(503)
  })

  it("returns 503 for an SSRF payload without fetching anything", () => {
    const res = callRoute({
      vouchers: [
        {
          satsAmount: 1,
          qrDataUrl: {
            uri: "http://10.0.0.5:8080/internal?x=1",
            method: "GET",
            headers: { Host: "evil.example" },
          },
        },
      ],
    })
    expect(res.statusCode).toBe(503)
    expect(rawFetch).not.toHaveBeenCalled()
    expect(mockHttpsRequest).not.toHaveBeenCalled()
  })

  it("does not parse the request body", () => {
    expect(voucherPdfConfig.api.bodyParser).toBe(false)
  })

  it("is hidden in the UI", () => {
    expect(isVoucherPdfEnabled()).toBe(false)
  })
})

describe("react-pdf image src guard", () => {
  it("accepts inline PNG/JPEG/WebP base64 data URLs", () => {
    for (const v of [
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/jpeg;base64,AAAA",
      "data:image/jpg;base64,AAAA",
      "data:image/webp;base64,AAAA",
    ]) {
      expect(isSafeImageDataUrl(v)).toBe(true)
      expect(safeImageSrc(v)).toBe(v)
    }
  })

  it.each([
    "http://10.0.0.5:8080/internal?x=1",
    "https://example.com/logo.png",
    "file:///etc/passwd",
    "//169.254.169.254/latest/meta-data",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/html;base64,AAAA",
    "data:image/png;base64,AAAA\nhttp://evil",
    "",
  ])("rejects %p", (value) => {
    expect(isSafeImageDataUrl(value)).toBe(false)
    expect(safeImageSrc(value)).toBeUndefined()
  })

  it.each([
    { uri: "http://127.0.0.1/", method: "POST", headers: {}, body: "" },
    { data: Buffer.from("x"), format: "png" },
    ["data:image/png;base64,AAAA"],
    null,
    undefined,
    42,
  ])("rejects non-string src %p", (value) => {
    expect(isSafeImageDataUrl(value)).toBe(false)
    expect(safeImageSrc(value)).toBeUndefined()
  })
})

describe("batch payments refuse internal targets", () => {
  beforeEach(() => {
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }])
  })

  it.each(INTERNAL_TARGETS)("validateLnAddress refuses user@%s", async (host) => {
    const result = await validateLnAddress(
      recipient(RECIPIENT_TYPES.LN_ADDRESS, `u@${host}`),
    )
    expect(result.valid).toBe(false)
    expect(result.error?.code).toBe(ERROR_CODES.LNURL_UNREACHABLE)
    expect(rawFetch).not.toHaveBeenCalled()
    expect(mockHttpsRequest).not.toHaveBeenCalled()
  })

  it("validateLnAddress refuses a public-looking name resolving to a private IP", async () => {
    const result = await validateLnAddress(
      recipient(RECIPIENT_TYPES.LN_ADDRESS, "u@api.internal.example"),
    )
    expect(result.valid).toBe(false)
    expect(result.error?.message).toContain("does not resolve to a public address")
    expect(mockHttpsRequest).not.toHaveBeenCalled()
  })

  it.each([
    "http://example.com/lnurlp",
    "https://127.0.0.1/lnurlp",
    "https://10.0.0.5:8080/internal?x=1",
    "https://169.254.169.254/latest/meta-data/",
    "https://kubernetes.default.svc/api",
  ])("validateLnurl refuses %s", async (target) => {
    const result = await validateLnurl(
      recipient(RECIPIENT_TYPES.LNURL, encodeLnurl(target)),
    )
    expect(result.valid).toBe(false)
    expect(rawFetch).not.toHaveBeenCalled()
    expect(mockHttpsRequest).not.toHaveBeenCalled()
  })

  it("executeLnurlPayment refuses an internal callback URL", async () => {
    const result = await executeLnurlPayment({
      apiKey: "k",
      senderWalletId: "w",
      lnurlData: { callback: "https://10.0.0.5:8080/metrics" },
      amountSats: 10,
    })
    expect(result.success).toBe(false)
    expect(rawFetch).not.toHaveBeenCalled()
    expect(mockHttpsRequest).not.toHaveBeenCalled()
  })
})
