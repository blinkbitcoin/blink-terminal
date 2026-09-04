/**
 * Browser client for server-held NIP-46 sign-in sessions.
 *
 * This replaces the browser-held relay subscription (issue #70). The browser no
 * longer holds a WebSocket, mints keys, or persists resumable session state — it
 * asks the server to start a session, opens the returned URI in the signer, and
 * polls a status endpoint. Backgrounding the tab is therefore irrelevant: there
 * is nothing to lose. That is the entire point of the change, and it is why all
 * the bfcache/visibility/resume machinery this file replaces could be deleted
 * rather than hardened further.
 *
 * The session is bound to this browser by an HttpOnly cookie the server sets on
 * creation, so every call below uses `credentials: "include"` and none of them
 * carry a secret in JS.
 */

/** Poll cadence while waiting for the signer. */
const POLL_INTERVAL_MS = 1500
/** Backoff applied when the server pushes back (429) or errors. */
const POLL_BACKOFF_MS = 5000

export type Nip46SessionStatus = "pending" | "approved" | "failed" | "consumed"

export interface CreateSessionResult {
  success: boolean
  sessionId?: string
  uri?: string
  expiresAt?: number
  error?: string
  /** Machine-readable reason, e.g. "relays_unavailable" or "capacity". */
  reason?: string
}

export interface SessionStatusResult {
  status: Nip46SessionStatus | "unknown"
  pubkey?: string
  error?: string
}

export interface ConsumeResult {
  success: boolean
  publicKey?: string
  error?: string
  errorType?: "superseded" | "session"
}

const BASE = "/api/nostr-connect/sessions"

/**
 * Ask the server to start a session.
 *
 * The server does not answer until at least one relay is connected and
 * subscribed, so the URI in this response is safe to hand to the signer
 * immediately — the connect ack cannot be missed by arriving first.
 */
export async function createSession(signal?: AbortSignal): Promise<CreateSessionResult> {
  try {
    const response = await fetch(BASE, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      signal,
    })

    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>

    if (!response.ok) {
      return {
        success: false,
        error: (data.error as string) || "Could not start sign-in",
        reason: data.reason as string | undefined,
      }
    }

    return {
      success: true,
      sessionId: data.sessionId as string,
      uri: data.uri as string,
      expiresAt: data.expiresAt as number,
    }
  } catch (error: unknown) {
    if (isAbort(error, signal)) {
      return { success: false, error: "Aborted", reason: "aborted" }
    }
    return { success: false, error: (error as Error).message || "Network error" }
  }
}

/** One non-mutating status read. Never establishes a login. */
export async function getSessionStatus(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionStatusResult> {
  const response = await fetch(`${BASE}/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    credentials: "include",
    signal,
  })

  if (response.status === 429) {
    // Treat push-back as "still pending", with backoff applied by the caller.
    return { status: "pending" }
  }
  if (!response.ok) {
    return { status: "failed", error: "session_not_found" }
  }

  const data = (await response.json()) as Record<string, unknown>
  return {
    status: (data.status as Nip46SessionStatus) || "unknown",
    pubkey: data.pubkey as string | undefined,
    error: data.error as string | undefined,
  }
}

/**
 * Poll until the session reaches a terminal state.
 *
 * Polls immediately when the tab becomes visible again: after the user approves
 * in the signer and switches back, we want the result on the first frame rather
 * than up to a full interval later.
 */
export async function pollSession(
  sessionId: string,
  options: {
    signal: AbortSignal
    onStatus?: (status: SessionStatusResult) => void
  },
): Promise<SessionStatusResult> {
  const { signal, onStatus } = options

  while (!signal.aborted) {
    let result: SessionStatusResult
    let delay = POLL_INTERVAL_MS

    try {
      result = await getSessionStatus(sessionId, signal)
    } catch (error: unknown) {
      if (isAbort(error, signal)) return { status: "failed", error: "aborted" }
      // A transient network blip must not end the sign-in; the session lives on
      // the server and is still valid until its TTL.
      result = { status: "pending" }
      delay = POLL_BACKOFF_MS
    }

    onStatus?.(result)
    if (result.status !== "pending" && result.status !== "unknown") return result

    await waitOrWake(delay, signal)
  }

  return { status: "failed", error: "aborted" }
}

/**
 * Turn an approval into a session cookie.
 *
 * Mirrors nip98Login's contract, including the header-receipt semantics that
 * NostrConnectSignIn depends on: the server sets the auth cookie with the
 * response headers, so once the fetch resolves OK a live session exists even if
 * reading the body then fails or is aborted. Reporting otherwise would skip the
 * caller's compensating logout and leave an orphaned session (PR #69).
 */
export async function consumeSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ConsumeResult> {
  try {
    const response = await fetch(`${BASE}/${encodeURIComponent(sessionId)}/consume`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      signal,
    })

    const established = response.ok

    let data: Record<string, unknown> = {}
    try {
      data = (await response.json()) as Record<string, unknown>
    } catch (bodyError: unknown) {
      if (established) {
        // The cookie is already set; report success so the caller can commit or
        // compensate deliberately.
        return { success: true }
      }
      throw bodyError
    }

    if (!established) {
      return {
        success: false,
        error: (data.error as string) || "Could not complete sign-in",
        errorType: "session",
      }
    }

    const user = data.user as { pubkey?: string } | undefined
    return { success: true, publicKey: user?.pubkey }
  } catch (error: unknown) {
    if (isAbort(error, signal)) {
      return { success: false, error: "Aborted", errorType: "superseded" }
    }
    return {
      success: false,
      error: (error as Error).message || "Could not complete sign-in",
      errorType: "session",
    }
  }
}

/**
 * Best-effort cancellation, so an abandoned session releases its relay sockets
 * instead of lingering until its TTL. Uses keepalive so it still goes out when
 * the modal closes or the page is being unloaded.
 */
export async function cancelSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${BASE}/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      credentials: "include",
      keepalive: true,
    })
  } catch {
    // The server expires the session on its own; nothing to recover here.
  }
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted || (error instanceof Error && error.name === "AbortError"),
  )
}

/** Sleep, but wake early when the tab regains visibility or the poll is aborted. */
function waitOrWake(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible)
      }
      resolve()
    }
    const onVisible = (): void => {
      if (document.visibilityState === "visible") done()
    }

    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible)
    }
  })
}
