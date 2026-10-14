/** @jest-environment node */

const mockLookup = jest.fn()
const constructed: Array<{
  url: unknown
  options?: { lookup?: (...args: unknown[]) => void }
}> = []

jest.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}))

jest.mock("node:https", () => ({
  __esModule: true,
  default: { request: jest.fn() },
}))

jest.mock("ws", () => {
  class FakeWS {
    static OPEN = 1
    constructor(
      url: unknown,
      protocols?: unknown,
      options?: { lookup?: (...args: unknown[]) => void },
    ) {
      const opts =
        protocols && typeof protocols === "object" && !Array.isArray(protocols)
          ? (protocols as { lookup?: (...args: unknown[]) => void })
          : options
      constructed.push({ url, options: opts })
    }
  }
  return { __esModule: true, default: FakeWS }
})

import { pinNwcRelays, PinnedWebSocket } from "../../lib/nwc/pinned-socket"

beforeEach(() => {
  constructed.length = 0
  mockLookup.mockReset()
})

describe("pinned NWC socket", () => {
  it("rejects a private-only relay before any socket", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])

    await expect(pinNwcRelays(["wss://relay.private.example"])).rejects.toThrow(
      /public address/,
    )
    expect(constructed).toHaveLength(0)
  })

  it("rejects a mixed public and private answer before any socket", async () => {
    mockLookup.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ])

    await expect(pinNwcRelays(["wss://relay.mixed.example"])).rejects.toThrow(
      /public address/,
    )
    expect(constructed).toHaveLength(0)
  })

  it("dials the pinned address when a later lookup changes", async () => {
    mockLookup
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }])

    await pinNwcRelays(["wss://relay.pinned.example"])
    expect(mockLookup).toHaveBeenCalledTimes(1)

    new PinnedWebSocket("wss://relay.pinned.example")
    const lookup = constructed[0]?.options?.lookup
    expect(lookup).toEqual(expect.any(Function))

    const dialed = await new Promise<{ address: string; family?: number }>(
      (resolve, reject) => {
        lookup!(
          "relay.pinned.example",
          {},
          (
            err: Error | null,
            address: string | { address: string }[],
            family?: number,
          ) => {
            if (err) reject(err)
            else resolve({ address: address as string, family })
          },
        )
      },
    )

    expect(dialed).toEqual({ address: "8.8.8.8", family: 4 })
    expect(mockLookup).toHaveBeenCalledTimes(1)
  })

  it("throws before opening a socket when the host was not pinned", () => {
    expect(() => new PinnedWebSocket("wss://relay.unpinned.example")).toThrow(
      /Invalid NWC connection/,
    )
    expect(constructed).toHaveLength(0)
  })
})
