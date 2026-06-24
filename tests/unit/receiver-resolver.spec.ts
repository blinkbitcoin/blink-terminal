/**
 * Tests for lib/receiver-resolver.ts
 *
 * Resolution rule (custodial-first, LNURL fallback):
 *   1. custodial probe (accountDefaultWallet) hit        => "custodial"
 *   2. else LNURL probe (.well-known/lnurlp) resolves    => "lnaddress"
 *   3. else                                              => ReceiverNotFoundError
 *
 * Also covers: bare-username vs full-address input, explicit external domain
 * (skips custodial probe), normalization, and session caching.
 */

const mockGetWalletByUsername = jest.fn()
const mockGetBtcWalletByUsername = jest.fn()

jest.mock("../../lib/blink-api", () => ({
  __esModule: true,
  default: {
    getWalletByUsername: (...a: unknown[]) => mockGetWalletByUsername(...a),
    getBtcWalletByUsername: (...a: unknown[]) => mockGetBtcWalletByUsername(...a),
  },
}))

const mockFetchLnurlPayMetadata = jest.fn()

// Fully mock lib/lnurl to avoid loading its nostr-tools import chain (ESM
// transform issue under jest). The resolver only needs parseLightningAddress
// and fetchLnurlPayMetadata; we provide a faithful parseLightningAddress.
jest.mock("../../lib/lnurl", () => ({
  __esModule: true,
  parseLightningAddress: (address: string) => {
    const [localpart, domain] = address.split("@")
    return {
      localpart,
      domain,
      lnurlEndpoint: `https://${domain}/.well-known/lnurlp/${localpart}`,
    }
  },
  fetchLnurlPayMetadata: (...a: unknown[]) => mockFetchLnurlPayMetadata(...a),
}))

import {
  resolveReceiver,
  normalizeIdentifier,
  clearReceiverResolutionCache,
  ReceiverNotFoundError,
} from "../../lib/receiver-resolver"

const META = {
  callback: "https://blink.sv/lnurlp/merchant/invoice",
  minSendable: 1000,
  maxSendable: 100000000000,
  metadata: '[["text/plain","Pay to merchant"]]',
  commentAllowed: 255,
  allowsNostr: false,
  nostrPubkey: undefined,
}

beforeEach(() => {
  jest.clearAllMocks()
  clearReceiverResolutionCache()
})

describe("normalizeIdentifier", () => {
  it("parses a bare username", () => {
    expect(normalizeIdentifier("merchant")).toEqual({ username: "merchant" })
  })

  it("parses a full lightning address and lowercases the domain", () => {
    expect(normalizeIdentifier("merchant@Blink.SV")).toEqual({
      username: "merchant",
      domain: "blink.sv",
    })
  })

  it("strips a lightning: prefix", () => {
    expect(normalizeIdentifier("lightning:merchant@blink.sv")).toEqual({
      username: "merchant",
      domain: "blink.sv",
    })
  })

  it("trims whitespace", () => {
    expect(normalizeIdentifier("  merchant  ")).toEqual({ username: "merchant" })
  })

  it("rejects malformed addresses", () => {
    expect(() => normalizeIdentifier("a@b@c")).toThrow()
    expect(() => normalizeIdentifier("@blink.sv")).toThrow()
    expect(() => normalizeIdentifier("merchant@")).toThrow()
  })

  it("rejects empty input", () => {
    expect(() => normalizeIdentifier("")).toThrow()
  })
})

describe("resolveReceiver - custodial first", () => {
  it("resolves a custodial user from a bare username", async () => {
    mockGetWalletByUsername.mockResolvedValue({ id: "wallet-123", currency: "BTC" })

    const result = await resolveReceiver("merchant", { apiUrl: "https://api.test" })

    expect(result).toEqual({
      type: "custodial",
      username: "merchant",
      walletId: "wallet-123",
      walletCurrency: "BTC",
    })
    expect(mockGetWalletByUsername).toHaveBeenCalledWith("merchant", "https://api.test")
    // Custodial hit => no LNURL probe.
    expect(mockFetchLnurlPayMetadata).not.toHaveBeenCalled()
  })

  it("uses the BTC wallet probe when walletCurrency=BTC", async () => {
    mockGetBtcWalletByUsername.mockResolvedValue({ id: "btc-1", currency: "BTC" })

    const result = await resolveReceiver("merchant", { walletCurrency: "BTC" })

    expect(result.type).toBe("custodial")
    expect(mockGetBtcWalletByUsername).toHaveBeenCalled()
    expect(mockGetWalletByUsername).not.toHaveBeenCalled()
  })
})

describe("resolveReceiver - self-custodial LNURL fallback", () => {
  it("falls back to LNURL when no custodial wallet exists (Spark user)", async () => {
    mockGetWalletByUsername.mockRejectedValue(new Error("No wallet found"))
    mockFetchLnurlPayMetadata.mockResolvedValue(META)

    const result = await resolveReceiver("sparkmerchant", { apiUrl: "https://api.test" })

    expect(result).toMatchObject({
      type: "lnaddress",
      lightningAddress: "sparkmerchant@blink.sv",
      username: "sparkmerchant",
      domain: "blink.sv",
      isBlinkDomain: true,
      metadata: META,
    })
    expect(mockGetWalletByUsername).toHaveBeenCalled()
    expect(mockFetchLnurlPayMetadata).toHaveBeenCalledWith(
      "https://blink.sv/.well-known/lnurlp/sparkmerchant",
    )
  })

  it("probes blink.sv for a full @blink.sv address after custodial miss", async () => {
    mockGetWalletByUsername.mockRejectedValue(new Error("not found"))
    mockFetchLnurlPayMetadata.mockResolvedValue(META)

    const result = await resolveReceiver("sparkmerchant@blink.sv")

    expect(result.type).toBe("lnaddress")
    expect(mockFetchLnurlPayMetadata).toHaveBeenCalledWith(
      "https://blink.sv/.well-known/lnurlp/sparkmerchant",
    )
  })
})

describe("resolveReceiver - external domain", () => {
  it("skips the custodial probe for a non-Blink domain", async () => {
    mockFetchLnurlPayMetadata.mockResolvedValue(META)

    const result = await resolveReceiver("alice@external.com")

    expect(mockGetWalletByUsername).not.toHaveBeenCalled()
    expect(mockGetBtcWalletByUsername).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      type: "lnaddress",
      lightningAddress: "alice@external.com",
      domain: "external.com",
      isBlinkDomain: false,
    })
  })
})

describe("resolveReceiver - not found", () => {
  it("throws ReceiverNotFoundError when neither probe resolves", async () => {
    mockGetWalletByUsername.mockRejectedValue(new Error("no wallet"))
    mockFetchLnurlPayMetadata.mockRejectedValue(new Error("404"))

    await expect(resolveReceiver("ghost")).rejects.toBeInstanceOf(ReceiverNotFoundError)
  })
})

describe("resolveReceiver - caching", () => {
  it("caches the resolved result per identifier+apiUrl", async () => {
    mockGetWalletByUsername.mockResolvedValue({ id: "wallet-123", currency: "BTC" })

    await resolveReceiver("merchant", { apiUrl: "https://api.test" })
    await resolveReceiver("merchant", { apiUrl: "https://api.test" })

    // Second call served from cache => only one custodial probe.
    expect(mockGetWalletByUsername).toHaveBeenCalledTimes(1)
  })

  it("does not collide across different apiUrls", async () => {
    mockGetWalletByUsername.mockResolvedValue({ id: "wallet-123", currency: "BTC" })

    await resolveReceiver("merchant", { apiUrl: "https://api.a" })
    await resolveReceiver("merchant", { apiUrl: "https://api.b" })

    expect(mockGetWalletByUsername).toHaveBeenCalledTimes(2)
  })
})
