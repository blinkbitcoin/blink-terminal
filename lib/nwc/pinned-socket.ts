import WS from "ws"

import { resolvePublicAddresses, type ResolvedAddress } from "../server/safe-fetch-json"

import { assertNwcRelayUrl, MAX_NWC_RELAYS } from "./relays"

type LookupCallback = (
  err: Error | null,
  address: string | readonly ResolvedAddress[],
  family?: number,
) => void

type PinnedSocket = new (address: string | URL, protocols?: string | string[]) => WS

/**
 * Module-level pin entries. This stays empty: each client closes over its own
 * map. `retainedRelayPins` is the size of this map, so a shared registry fails
 * the stress test.
 */
const retainedPins = new Map<string, readonly ResolvedAddress[]>()

export function retainedRelayPins(): number {
  return retainedPins.size
}

function socketOptions(
  pins: ReadonlyMap<string, readonly ResolvedAddress[]>,
  address: string | URL,
): {
  lookup: (
    hostname: string,
    options: { family?: number; all?: boolean } | LookupCallback,
    callback?: LookupCallback,
  ) => void
  servername: string
} {
  const hostname = new URL(typeof address === "string" ? address : address.toString())
    .hostname
  const addresses = pins.get(hostname)
  if (!addresses || addresses.length === 0) {
    throw new Error("Invalid NWC connection")
  }

  return {
    servername: hostname,
    lookup: (_hostname, options, callback) => {
      const cb = typeof options === "function" ? options : callback
      const opts = typeof options === "function" ? {} : options
      if (!cb) {
        throw new Error("Invalid NWC connection")
      }
      const family = opts.family
      const matching = family
        ? addresses.filter((item) => item.family === family)
        : addresses
      if (matching.length === 0) {
        cb(new Error("Invalid NWC connection"), "")
        return
      }
      if (opts.all) {
        cb(null, matching)
        return
      }
      cb(null, matching[0].address, matching[0].family)
    },
  }
}

/**
 * Resolve these relays and return a WebSocket class closed over that result.
 * The map is not stored on the module. An unpinned host throws before a socket
 * opens. A host with any blocked address is rejected here, before dial.
 */
export async function createPinnedWebSocket(relays: string[]): Promise<PinnedSocket> {
  if (relays.length === 0 || relays.length > MAX_NWC_RELAYS) {
    throw new Error("Invalid NWC connection")
  }

  const pins = new Map<string, readonly ResolvedAddress[]>()
  for (const relay of relays) {
    assertNwcRelayUrl(relay)
    const hostname = new URL(relay).hostname
    pins.set(hostname, await resolvePublicAddresses(hostname))
  }

  return class ClientPinnedWebSocket extends WS {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, socketOptions(pins, address) as never)
    }
  }
}
