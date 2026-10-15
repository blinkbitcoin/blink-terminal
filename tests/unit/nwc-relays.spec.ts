/** @jest-environment node */

import { assertNwcRelayUrl } from "../../lib/nwc/relays"

describe("NWC relay URL", () => {
  it("rejects ws://127.0.0.1 before any socket", () => {
    expect(() => assertNwcRelayUrl("ws://127.0.0.1:6379")).toThrow(
      /Invalid NWC connection/,
    )
  })

  it("rejects a public-looking IP literal", () => {
    expect(() => assertNwcRelayUrl("wss://1.1.1.1")).toThrow(/Invalid NWC connection/)
  })

  it("accepts a wss hostname without dialing", () => {
    expect(() => assertNwcRelayUrl("wss://relay.example.com")).not.toThrow()
  })
})
