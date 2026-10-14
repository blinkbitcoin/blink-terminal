/**
 * Browser stand-in. Relays are dialed from the user's browser, not this
 * process. The server build is lib/nwc/pinned-socket.ts.
 */
export async function createPinnedWebSocket(_relays: string[]): Promise<never> {
  throw new Error("Invalid NWC connection")
}

export function retainedRelayPins(): number {
  return 0
}
