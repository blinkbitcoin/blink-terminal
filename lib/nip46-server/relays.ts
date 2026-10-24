/**
 * Relay set used by the server-held NIP-46 sessions.
 *
 * Previously this list lived in the browser (NostrConnectService). Now that the
 * relay sockets are held server-side it is server configuration, overridable per
 * deployment via NIP46_RELAYS (comma-separated wss:// URLs).
 */

// Both the server and the signer use the relays advertised in the nostrconnect:// URI, so this
// list is the shared rendezvous for the whole NIP-46 exchange (connect-ack AND sign_event
// responses). On-device testing (2026-09-02) showed sign-in timing out when 2 of 3 relays were
// transiently down — the sign request reached only one relay and the signer's response never
// routed back. Extra reliable relays add rendezvous redundancy so a couple of flaky ones no
// longer break the exchange. Keep this modest — every relay is a socket the server holds open
// for the lifetime of the session.
const DEFAULT_NIP46_RELAYS: readonly string[] = [
  "wss://nos.lol", // Good uptime
  "wss://relay.damus.io", // Very reliable general relay
  "wss://relay.primal.net", // Primal relay
  "wss://relay.nostr.band", // High-uptime aggregator (rendezvous redundancy)
]

function parseRelayEnv(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.startsWith("wss://") || url.startsWith("ws://"))
}

/**
 * Resolve the relay set. Read at call time (not module load) so tests and
 * deployments can change the environment without reloading the module.
 */
export function getNip46Relays(): string[] {
  const configured = parseRelayEnv(process.env.NIP46_RELAYS)
  return configured.length > 0 ? configured : [...DEFAULT_NIP46_RELAYS]
}

export { DEFAULT_NIP46_RELAYS }
