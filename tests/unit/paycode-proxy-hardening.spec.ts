/** @jest-environment node */

/**
 * blink-wip#1690 item 2: the paycode routes proxy to pay.blink.sv with the
 * username as a path segment and the amount as a query value. Both must be
 * validated/encoded so a caller cannot traverse the upstream path (`..%2F`)
 * or smuggle extra upstream query parameters.
 */

jest.mock("../../lib/rate-limit", () => ({
  withRateLimit: (handler: unknown) => handler,
  RATE_LIMIT_PUBLIC: {},
}))

import { isValidBlinkUsername, parseMillisatAmount } from "../../lib/paycode-lnurl"
import lnurlpHandler from "../../pages/api/paycode/lnurlp/[username]"
import callbackHandler from "../../pages/api/paycode/lnurlp/callback/[username]"

type Handler = (req: never, res: never) => unknown

const call = async (handler: Handler, query: Record<string, unknown>) => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    setHeader() {},
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
    { method: "GET", query, headers: { host: "terminal.example" } } as never,
    res as never,
  )
  return res
}

const fetchMock = jest.fn()
beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
  jest.spyOn(console, "log").mockImplementation(() => {})
  jest.spyOn(console, "error").mockImplementation(() => {})
})

const upstreamUrl = () => String(fetchMock.mock.calls[0][0])

describe("validators", () => {
  it("accepts Blink usernames and rejects path/query characters", () => {
    for (const ok of ["alice", "bob_42", "ABC"])
      expect(isValidBlinkUsername(ok)).toBe(true)
    for (const bad of [
      "..%2Fother",
      "../other",
      "alice/callback",
      "alice?x=1",
      "alice&y=2",
      "ab",
      "a".repeat(51),
      "",
      ["alice"],
      undefined,
    ]) {
      expect(isValidBlinkUsername(bad)).toBe(false)
    }
  })

  it("amount is a positive integer of millisatoshis", () => {
    expect(parseMillisatAmount("1000")).toBe(1000)
    for (const bad of [
      "0",
      "-1",
      "1e3",
      "1000&comment=x",
      "abc",
      "",
      ["1000"],
      undefined,
    ]) {
      expect(parseMillisatAmount(bad)).toBeNull()
    }
  })
})

describe("callback/[username] proxy", () => {
  it("builds a validated, encoded upstream URL", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ pr: "lnbc1...", routes: [] }) })
    const res = await call(callbackHandler as Handler, {
      username: "alice",
      amount: "1000",
      comment: "hi & bye",
    })
    expect(res.body).toEqual({ pr: "lnbc1...", routes: [] })
    expect(upstreamUrl()).toBe(
      "https://pay.blink.sv/lnurlp/alice/callback?amount=1000&comment=hi+%26+bye",
    )
  })

  it("rejects a traversing username without calling upstream", async () => {
    for (const username of ["..%2Fother", "../other", "alice/callback", "alice?x=1"]) {
      const res = await call(callbackHandler as Handler, { username, amount: "1000" })
      expect(res.body).toEqual({ status: "ERROR", reason: "Username required" })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects an amount carrying extra upstream parameters", async () => {
    const res = await call(callbackHandler as Handler, {
      username: "alice",
      amount: "1000&comment=injected",
    })
    expect(res.body).toEqual({ status: "ERROR", reason: "Amount required" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects array-valued parameters", async () => {
    const res = await call(callbackHandler as Handler, {
      username: "alice",
      amount: "1000",
      comment: ["a", "b"],
    })
    expect(res.body).toEqual({ status: "ERROR", reason: "Invalid parameters" })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("[username] metadata proxy", () => {
  it("rejects a traversing username without calling upstream", async () => {
    const res = await call(lnurlpHandler as Handler, { username: "../other" })
    expect(res.body).toEqual({ status: "ERROR", reason: "Username required" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("encodes the username into the upstream path and our callback", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        minSendable: 1000,
        maxSendable: 100000000,
        metadata: '[["text/plain","Pay alice"]]',
      }),
    })
    const res = await call(lnurlpHandler as Handler, { username: "alice" })
    expect(upstreamUrl()).toBe("https://pay.blink.sv/.well-known/lnurlp/alice")
    expect((res.body as { callback: string }).callback).toBe(
      "https://terminal.example/api/paycode/lnurlp/callback/alice",
    )
  })
})
