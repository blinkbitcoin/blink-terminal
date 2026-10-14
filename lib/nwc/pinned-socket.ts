import WS from "ws"

import { resolvePublicAddresses, type ResolvedAddress } from "../server/safe-fetch-json"

import { assertNwcRelayUrl, MAX_NWC_RELAYS } from "./relays"

type LookupCallback = (
  err: Error | null,
  address: string | ResolvedAddress[],
  family?: number,
) => void

const pins = new Map<string, ResolvedAddress[]>()

/**
 * Resolve every relay once. A later socket must use these addresses, not a
 * second DNS answer. Throws before any socket if a host is not public.
 */
export async function pinNwcRelays(relays: string[]): Promise<void> {
  if (relays.length === 0 || relays.length > MAX_NWC_RELAYS) {
    throw new Error("Invalid NWC connection")
  }

  const next = new Map<string, ResolvedAddress[]>()
  for (const relay of relays) {
    assertNwcRelayUrl(relay)
    const hostname = new URL(relay).hostname
    next.set(hostname, await resolvePublicAddresses(hostname))
  }
  for (const [hostname, addresses] of next) {
    pins.set(hostname, addresses)
  }
}

function socketOptions(address: string | URL): {
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
 * WebSocket that dials only the addresses pinned for this host. TLS still
 * uses the original hostname. Unpinned hosts throw before a socket opens.
 */
export class PinnedWebSocket extends WS {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols, socketOptions(address) as never)
  }
}
