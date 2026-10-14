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

import { createPinnedWebSocket, retainedRelayPins } from "../../lib/nwc/pinned-socket"

type Dialed = {
  address: string | Array<{ address: string; family: number }>
  family?: number
}

function dial(
  lookup: (...args: unknown[]) => void,
  hostname: string,
  options: { family?: number; all?: boolean } = {},
): Promise<Dialed> {
  return new Promise((resolve, reject) => {
    lookup(
      hostname,
      options,
      (err: Error | null, address: Dialed["address"], family?: number) => {
        if (err) reject(err)
        else resolve({ address, family })
      },
    )
  })
}

beforeEach(() => {
  constructed.length = 0
  mockLookup.mockReset()
})

describe("pinned NWC socket", () => {
  it("rejects a private-only relay before any socket", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])

    await expect(createPinnedWebSocket(["wss://relay.private.example"])).rejects.toThrow(
      /public address/,
    )
    expect(constructed).toHaveLength(0)
    expect(retainedRelayPins()).toBe(0)
  })

  it("rejects a mixed public and private answer before any socket", async () => {
    mockLookup.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ])

    await expect(createPinnedWebSocket(["wss://relay.mixed.example"])).rejects.toThrow(
      /public address/,
    )
    expect(constructed).toHaveLength(0)
  })

  it("dials the pinned address when a later lookup changes", async () => {
    mockLookup
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }])

    const Socket = await createPinnedWebSocket(["wss://relay.pinned.example"])
    expect(mockLookup).toHaveBeenCalledTimes(1)

    new Socket("wss://relay.pinned.example")
    const lookup = constructed[0]?.options?.lookup
    expect(lookup).toEqual(expect.any(Function))

    await expect(dial(lookup!, "relay.pinned.example")).resolves.toEqual({
      address: "8.8.8.8",
      family: 4,
    })
    expect(mockLookup).toHaveBeenCalledTimes(1)
  })

  it("throws before opening a socket when the host was not pinned", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
    const Socket = await createPinnedWebSocket(["wss://relay.known.example"])
    constructed.length = 0

    expect(() => new Socket("wss://relay.unpinned.example")).toThrow(
      /Invalid NWC connection/,
    )
    expect(constructed).toHaveLength(0)
  })

  it("does not let one client replace another client's pins", async () => {
    mockLookup
      .mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }])
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])

    const SocketA = await createPinnedWebSocket(["wss://relay.shared.example"])
    const SocketB = await createPinnedWebSocket(["wss://relay.shared.example"])

    new SocketA("wss://relay.shared.example")
    new SocketB("wss://relay.shared.example")

    await expect(
      dial(constructed[0].options!.lookup!, "relay.shared.example"),
    ).resolves.toEqual({ address: "1.1.1.1", family: 4 })
    await expect(
      dial(constructed[1].options!.lookup!, "relay.shared.example"),
    ).resolves.toEqual({ address: "8.8.8.8", family: 4 })
    expect(retainedRelayPins()).toBe(0)
  })

  it("does not keep pins from closed clients", async () => {
    mockLookup.mockImplementation(async () => [{ address: "8.8.8.8", family: 4 }])

    for (let i = 0; i < 200; i++) {
      await createPinnedWebSocket([`wss://relay-${i}.example`])
    }

    const Other = await createPinnedWebSocket(["wss://relay-other.example"])
    expect(() => new Other("wss://relay-0.example")).toThrow(/Invalid NWC connection/)
    expect(constructed).toHaveLength(0)
    expect(retainedRelayPins()).toBe(0)
  })

  it("returns every pinned address when lookup asks for all", async () => {
    mockLookup.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ])
    const Socket = await createPinnedWebSocket(["wss://relay.dual.example"])
    new Socket("wss://relay.dual.example")

    await expect(
      dial(constructed[0].options!.lookup!, "relay.dual.example", { all: true }),
    ).resolves.toEqual({
      address: [
        { address: "8.8.8.8", family: 4 },
        { address: "2001:4860:4860::8888", family: 6 },
      ],
      family: undefined,
    })
    expect(mockLookup).toHaveBeenCalledTimes(1)
  })

  it("selects the requested family and refuses a family it does not have", async () => {
    mockLookup.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ])
    const Socket = await createPinnedWebSocket(["wss://relay.family.example"])
    new Socket("wss://relay.family.example")
    const lookup = constructed[0].options!.lookup!

    await expect(dial(lookup, "relay.family.example", { family: 6 })).resolves.toEqual({
      address: "2001:4860:4860::8888",
      family: 6,
    })
    await expect(dial(lookup, "relay.family.example", { family: 0 })).resolves.toEqual({
      address: "8.8.8.8",
      family: 4,
    })

    constructed.length = 0
    mockLookup.mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }])
    const V4 = await createPinnedWebSocket(["wss://relay.v4.example"])
    new V4("wss://relay.v4.example")
    await expect(
      dial(constructed[0].options!.lookup!, "relay.v4.example", { family: 6 }),
    ).rejects.toThrow(/Invalid NWC connection/)
    expect(mockLookup).toHaveBeenCalledTimes(2)
  })
})
