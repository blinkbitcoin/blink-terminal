/**
 * Owns the *live* half of a server-held NIP-46 sign-in session.
 *
 * Split of responsibilities (deliberate):
 *   - here (in-process, never persisted): the ephemeral NIP-46 private key, the
 *     relay transport, the abort controller and the background worker.
 *   - sessionStore (Redis/Map, TTL-bound): status metadata only.
 *
 * Because the live half is process-local, a restart destroys it. We do not try
 * to persist and resurrect the ephemeral key — instead `resolveStatus` reports a
 * session that is still "pending" with no live worker as failed
 * (`server_restarted`) so the browser stops polling and starts a fresh session.
 * That is honest and cheap; resurrecting a signer conversation is neither.
 *
 * NOTE ON MULTI-INSTANCE: the current deployment is single-instance
 * (docker-compose, one app container, stop/start deploys). Status and
 * consumption already go through Redis, so polling and finalization are
 * instance-independent; only the live worker is pinned. If this is ever scaled
 * out, `resolveStatus`'s restart heuristic must additionally record the owning
 * instance, or a pending session on instance A would look "restarted" to
 * instance B.
 */

import Nip98Verifier from "../nostr/Nip98Verifier"
import { onShutdown } from "../shutdown"

import { Nip46CapacityError, Nip46RelayUnavailableError } from "./errors"
import { getNip46Relays } from "./relays"
import {
  consumeSession,
  createSession,
  generateBindingSecret,
  generateSessionChallenge,
  generateSessionId,
  getSession,
  markApproved,
  markFailed,
  sha256Hex,
  SESSION_TTL_SECONDS,
  type ConsumeResult,
  type Nip46FailureReason,
  type Nip46SessionRecord,
} from "./sessionStore"
import { Nip46Transport, type PoolLike } from "./transport"

// ---------- Tunables ----------

/** How long we wait for the FIRST relay to be connected + subscribed. */
export const RELAY_READY_TIMEOUT_MS = 8_000
/** How long a `get_public_key` round trip may take once the signer acked. */
const GET_PUBKEY_TIMEOUT_MS = 30_000
/** NIP-98 freshness window applied to the signed kind-27235 event. */
const SIGNED_EVENT_MAX_AGE_SECONDS = 120

function intFromEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] || "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Caps. Request rate alone does not bound a distributed resource-exhaustion
 * attack: every live session holds one socket per relay, so we cap concurrent
 * sessions per IP and globally in addition to the route's rate limiter.
 */
function maxSessionsGlobal(): number {
  return intFromEnv("NIP46_MAX_SESSIONS", 200)
}
function maxSessionsPerIp(): number {
  return intFromEnv("NIP46_MAX_SESSIONS_PER_IP", 5)
}

// ---------- Types ----------

export interface LiveSession {
  id: string
  ip: string
  bindingHash: string
  transport: Nip46Transport
  controller: AbortController
  createdAt: number
}

export interface CreateSessionOptions {
  ip: string
  /** Absolute origin of the request, e.g. https://terminal.blinkbtc.com */
  origin: string
  /** SHA-256 of the caller's existing binding cookie, if it presented one. */
  previousBindingHash?: string
  /** Test seam. */
  pool?: PoolLike
  relays?: string[]
}

export interface CreatedSession {
  sessionId: string
  uri: string
  bindingSecret: string
  expiresAt: number
  readyRelays: string[]
}

export interface SessionStatus {
  status: Nip46SessionRecord["status"]
  pubkey?: string
  error?: string
  expiresAt: number
}

// ---------- Manager ----------

class Nip46SessionManager {
  private readonly live = new Map<string, LiveSession>()

  /**
   * Create a session: mint the ephemeral key, get at least one relay listening,
   * and only then hand back the URI. The ordering is the whole point of #70 —
   * see transport.ts.
   */
  async create(options: CreateSessionOptions): Promise<CreatedSession> {
    // One live session per browser: a retry supersedes the caller's previous
    // attempt instead of stacking sockets.
    if (options.previousBindingHash) {
      this.cancelByBindingHash(options.previousBindingHash)
    }

    this.enforceCaps(options.ip)

    const sessionId = generateSessionId()
    const bindingSecret = generateBindingSecret()
    const challenge = generateSessionChallenge()
    const relays = options.relays ?? getNip46Relays()

    const transport = new Nip46Transport({ relays, pool: options.pool })
    const controller = new AbortController()

    try {
      await transport.open({
        timeoutMs: RELAY_READY_TIMEOUT_MS,
        signal: controller.signal,
      })
    } catch (error: unknown) {
      transport.close()
      throw new Nip46RelayUnavailableError((error as Error).message)
    }

    const secret = generateSessionChallenge().slice(0, 32)
    const expectedUrl = buildConsumeUrl(options.origin, sessionId)
    const uri = buildNostrConnectUri({
      clientPubkey: transport.clientPubkey,
      relays,
      secret,
      appOrigin: options.origin,
    })

    const record = await createSession({
      id: sessionId,
      bindingHash: sha256Hex(bindingSecret),
      expectedUrl,
      challenge,
    })

    const session: LiveSession = {
      id: sessionId,
      ip: options.ip,
      bindingHash: record.bindingHash,
      transport,
      controller,
      createdAt: record.createdAt,
    }
    this.live.set(sessionId, session)

    // Detached: the browser polls for the outcome.
    this.runWorker(session, {
      secret,
      challenge,
      expectedUrl,
      expiresAt: record.expiresAt,
    }).catch((error: unknown) => {
      console.error("[nip46] worker crashed:", (error as Error).message)
    })

    return {
      sessionId,
      uri,
      bindingSecret,
      expiresAt: record.expiresAt,
      readyRelays: transport.readyRelays,
    }
  }

  /**
   * Drive the RPC flow: connect ack -> get_public_key -> sign_event(27235),
   * verify strictly, then record the outcome for the poller to pick up.
   */
  private async runWorker(
    session: LiveSession,
    context: {
      secret: string
      challenge: string
      expectedUrl: string
      expiresAt: number
    },
  ): Promise<void> {
    const { transport, controller } = session
    const remaining = (): number => Math.max(1, context.expiresAt - Date.now())

    const fail = async (reason: Nip46FailureReason): Promise<void> => {
      await markFailed(session.id, reason).catch(() => undefined)
      this.teardown(session.id)
    }

    try {
      const ack = await transport.waitForConnectAck({
        secret: context.secret,
        timeoutMs: remaining(),
        signal: controller.signal,
      })

      const pubkey = (
        await transport.request("get_public_key", [], {
          timeoutMs: Math.min(GET_PUBKEY_TIMEOUT_MS, remaining()),
          signal: controller.signal,
        })
      )
        .trim()
        .toLowerCase()

      if (!/^[0-9a-f]{64}$/.test(pubkey)) {
        await fail("verification_failed")
        return
      }

      const template = {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["u", context.expectedUrl],
          ["method", "POST"],
          ["challenge", context.challenge],
        ],
      }

      const raw = await transport.request("sign_event", [JSON.stringify(template)], {
        timeoutMs: remaining(),
        signal: controller.signal,
      })

      let signedEvent: unknown
      try {
        signedEvent = JSON.parse(raw)
      } catch {
        await fail("verification_failed")
        return
      }

      // Strict validation: kind, canonical u, method, per-session challenge,
      // returned pubkey match, event id, signature, freshness. The signer that
      // acked must be the signer that signed.
      const result = await Nip98Verifier.verifySignedEvent({
        event: signedEvent,
        url: context.expectedUrl,
        method: "POST",
        maxAgeSeconds: SIGNED_EVENT_MAX_AGE_SECONDS,
        challenge: context.challenge,
        expectedPubkey: pubkey,
      })

      if (!result.valid || !result.pubkey) {
        console.warn("[nip46] signed event rejected:", result.error)
        await fail("verification_failed")
        return
      }
      if (ack.signerPubkey && transport.pinnedSignerPubkey !== ack.signerPubkey) {
        await fail("verification_failed")
        return
      }

      const approved = await markApproved(session.id, result.pubkey)
      if (!approved) {
        // Cancelled or expired while we were signing.
        this.teardown(session.id)
        return
      }
      // The socket has done its job; the browser finalizes over HTTP.
      this.teardown(session.id)
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        this.teardown(session.id)
        return
      }
      const message = (error as Error).message || ""
      if (message.includes("connect ack timed out")) {
        await fail("connect_timeout")
        return
      }
      if (message.includes("timed out")) {
        await fail("signing_timeout")
        return
      }
      console.warn("[nip46] session failed:", message)
      await fail("signer_rejected")
    }
  }

  /**
   * Status for the polling endpoint. A pending record with no live worker means
   * the process that owned it is gone (restart/deploy) — report it as failed so
   * the browser starts a fresh session instead of polling a dead session.
   */
  async resolveStatus(record: Nip46SessionRecord): Promise<SessionStatus> {
    if (record.status === "pending" && !this.live.has(record.id)) {
      await markFailed(record.id, "server_restarted").catch(() => undefined)
      return {
        status: "failed",
        error: "server_restarted",
        expiresAt: record.expiresAt,
      }
    }
    return {
      status: record.status,
      pubkey: record.status === "approved" ? record.pubkey : undefined,
      error: record.error,
      expiresAt: record.expiresAt,
    }
  }

  async cancel(id: string): Promise<void> {
    await markFailed(id, "cancelled").catch(() => undefined)
    this.teardown(id)
  }

  /** Consume an approval. Delegates the atomic CAS to the store. */
  async consume(id: string, bindingSecret: string | undefined): Promise<ConsumeResult> {
    const result = await consumeSession(id, bindingSecret)
    if (result.ok) this.teardown(id)
    return result
  }

  isLive(id: string): boolean {
    return this.live.has(id)
  }

  get liveCount(): number {
    return this.live.size
  }

  private cancelByBindingHash(bindingHash: string): void {
    for (const session of this.live.values()) {
      if (session.bindingHash !== bindingHash) continue
      markFailed(session.id, "cancelled").catch(() => undefined)
      this.teardown(session.id)
    }
  }

  private enforceCaps(ip: string): void {
    if (this.live.size >= maxSessionsGlobal()) {
      throw new Nip46CapacityError("too many concurrent sign-in sessions")
    }
    let perIp = 0
    for (const session of this.live.values()) {
      if (session.ip === ip) perIp += 1
    }
    if (perIp >= maxSessionsPerIp()) {
      throw new Nip46CapacityError("too many concurrent sign-in sessions for this client")
    }
  }

  /** Abort the worker and release the sockets. Idempotent. */
  private teardown(id: string): void {
    const session = this.live.get(id)
    if (!session) return
    this.live.delete(id)
    session.controller.abort("session finished")
    session.transport.close()
  }

  /**
   * On SIGTERM, mark everything still pending as failed before the sockets go
   * away, so a browser polling across a deploy gets a definite answer instead
   * of timing out.
   */
  async shutdown(): Promise<void> {
    const sessions = [...this.live.values()]
    await Promise.all(
      sessions.map(async (session) => {
        await markFailed(session.id, "server_restarted").catch(() => undefined)
        this.teardown(session.id)
      }),
    )
  }

  /** Test-only. */
  __resetForTests(): void {
    for (const id of [...this.live.keys()]) this.teardown(id)
  }
}

// ---------- URI construction ----------

export function buildConsumeUrl(origin: string, sessionId: string): string {
  return `${origin.replace(/\/+$/, "")}/api/nostr-connect/sessions/${sessionId}/consume`
}

/**
 * Build the nostrconnect:// URI by hand rather than via nostr-tools'
 * createNostrConnectURI: `new URL()` normalizes non-special schemes
 * inconsistently, and the signer must receive the pubkey and relay list exactly
 * as we minted them.
 */
export function buildNostrConnectUri(options: {
  clientPubkey: string
  relays: string[]
  secret: string
  appOrigin: string
}): string {
  const params: string[] = []
  for (const relay of options.relays) {
    params.push(`relay=${encodeURIComponent(relay)}`)
  }
  params.push(`secret=${encodeURIComponent(options.secret)}`)
  params.push(`perms=${encodeURIComponent("sign_event:27235,get_public_key")}`)
  params.push(`name=${encodeURIComponent("Blink POS")}`)
  params.push(`url=${encodeURIComponent(options.appOrigin)}`)
  params.push(
    `image=${encodeURIComponent(`${options.appOrigin.replace(/\/+$/, "")}/icons/icon-96x96.png`)}`,
  )
  return `nostrconnect://${options.clientPubkey}?${params.join("&")}`
}

// ---------- Singleton (HMR-safe) ----------

declare global {
  // eslint-disable-next-line no-var
  var _nip46SessionManager: Nip46SessionManager | undefined
}

function getManager(): Nip46SessionManager {
  if (!global._nip46SessionManager) {
    const manager = new Nip46SessionManager()
    global._nip46SessionManager = manager
    onShutdown("nip46-sessions", () => manager.shutdown())
  }
  return global._nip46SessionManager
}

export { getManager as getNip46SessionManager, Nip46SessionManager }
export { Nip46CapacityError, Nip46RelayUnavailableError }
export { getSession, SESSION_TTL_SECONDS }
