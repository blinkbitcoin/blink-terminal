/**
 * Browser stand-in. Relays are dialed from the user's browser, not this
 * process. The server build is lib/nwc/pinned-socket.ts.
 */
export async function pinNwcRelays(_relays: string[]): Promise<void> {
  throw new Error("Invalid NWC connection")
}

export const PinnedWebSocket = null
