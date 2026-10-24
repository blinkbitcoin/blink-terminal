import { resolvePublicAddresses } from "../server/safe-fetch-json"

const isIP = (host: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")

export const MAX_NWC_RELAYS = 3

/** Reject a relay URL before any socket. IP literals and non-wss fail here. */
export function assertNwcRelayUrl(relay: string): void {
  let url: URL
  try {
    url = new URL(relay)
  } catch {
    throw new Error("Invalid NWC connection")
  }
  if (url.protocol !== "wss:") {
    throw new Error("Invalid NWC connection")
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("Invalid NWC connection")
  }
}

/** Scheme check plus DNS: the host must resolve to a public address. */
export async function assertNwcRelays(relays: string[]): Promise<void> {
  if (relays.length === 0 || relays.length > MAX_NWC_RELAYS) {
    throw new Error("Invalid NWC connection")
  }
  for (const relay of relays) {
    assertNwcRelayUrl(relay)
    await resolvePublicAddresses(new URL(relay).hostname)
  }
}
