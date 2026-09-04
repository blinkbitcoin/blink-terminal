/**
 * NostrConnectSignIn — one NIP-46 sign-in as a single atomic transaction.
 *
 * Extracted from useNostrAuth (issue #67). Every finding in the long PR #66 review chain traced
 * to the same cause: a sign-in is a multi-resource transaction — server session cookie, local
 * auth data, profile record and pointer, React provider state — executed across concurrent
 * attempts, with cancellation and rollback scattered across a hook, a service and a modal. This
 * unit owns that whole lifecycle so the invariants are structural rather than a set of
 * conditionals:
 *
 *  - Serialisation is a real FIFO mutex: each attempt chains onto the tail and only the head
 *    runs, so N overlapping attempts can never observe a stale snapshot and enter together.
 *  - The consume request is driven by ONE AbortSignal owned by the transaction. A timeout or
 *    supersession cancels the request, so it cannot commit a session late; there is no
 *    abandoned-request window to paper over.
 *  - The only resource that exists before the outcome is known is the server session, because
 *    the signature (verified server-side, see lib/nip46-server) is what proves the user. If the attempt loses ownership, times out, fails, or its
 *    local commit throws, that session is discarded. Local state is written only after the
 *    ownership gate, inside the mutex, so there is never a partial local commit to roll back.
 *
 * The caller (the modal) still owns its own UI continuation via its auth token; this unit owns
 * the durable work and reports a result the caller can trust.
 */
import ProfileStorage, {
  type StoredProfile,
  type StoredBlinkAccount,
} from "../storage/ProfileStorage"

import NostrAuthService from "./NostrAuthService"
import { consumeSession } from "./NostrConnectClient"

export interface SignInTransactionOptions {
  /**
   * The server-held NIP-46 session to finalize. The signer's approval was
   * verified server-side; consuming it is what mints the session cookie.
   */
  sessionId: string
  /** Abort deadline in ms. */
  timeout: number
  /** Caller ownership check; defaults to owned. */
  isCurrent?: () => boolean
  /**
   * External cancellation. The caller aborts this when it retires the attempt, which cancels
   * the transaction's in-flight work immediately. A polled predicate alone cannot do that — it
   * is only consulted at the transaction's own checkpoints, so a hung request would keep the
   * mutex until its own deadline while the replacement waited (PR #66 review).
   */
  signal?: AbortSignal
  onProgress?: (stage: string, message?: string) => void
}

export interface SignInTransactionResult {
  success: boolean
  publicKey?: string
  profile?: StoredProfile
  activeBlinkAccount?: StoredBlinkAccount | null
  error?: string
  errorType?: "timeout" | "session" | "superseded" | "unknown"
}

/**
 * A FIFO mutex over the session lifecycle. Each acquirer chains onto the tail and points the
 * tail at its own completion, so waiters are released strictly in order and exactly one attempt
 * holds the session at a time. Waiting is abortable via the caller's signal, so a superseded
 * waiter leaves the queue instead of blocking it.
 */
let sessionMutexTail: Promise<void> = Promise.resolve()

/** Test-only: reset the queue. Production never calls this. */
export function __resetSessionMutexForTests(): void {
  sessionMutexTail = Promise.resolve()
}

function acquireSessionMutex(signal: AbortSignal): Promise<() => void> {
  let release: () => void = () => {}
  const slot = new Promise<void>((resolve) => {
    release = resolve
  })
  const previous = sessionMutexTail
  sessionMutexTail = slot

  // A cancelled waiter rejects its OWN acquisition immediately, but its slot must not resolve
  // on cancellation: a successor is chained to this slot, and resolving it would release the
  // successor while the real holder is still active — the very A/B/C race this mutex exists
  // to prevent (PR #66 review). Instead the slot forwards its predecessor's release, so
  // successors stay transitively chained to the live holder whether or not this node ran.
  return new Promise((resolveAcquired, rejectAcquired) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      rejectAcquired(new Error("aborted before entering"))
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener("abort", onAbort)
    }
    // ONE continuation decides, atomically, what happens when our turn comes: either this node
    // was cancelled while queued (forward the release so successors are not stranded), or it
    // acquires (and releases when it is done). Two separate continuations on `previous` would
    // race each other and release the slot for every node.
    previous.then(() => {
      signal.removeEventListener("abort", onAbort)
      if (settled) {
        // Cancelled while queued: hand the turn straight to the successor.
        release()
        return
      }
      settled = true
      resolveAcquired(release)
    })
  })
}

/**
 * Ceiling on the compensating logout, so a hung request cannot hold the mutex slot for long.
 *
 * Deliberately short: the successor is chained to this attempt's release, so this is time a
 * replacement sign-in spends waiting. Giving up on the logout only means the abandoned session
 * lives until the next successful login overwrites the cookie, which is strictly better than
 * blocking the user's retry (PR #69 review).
 */
const LOGOUT_CEILING_MS = 1500

/** How long a login may keep running after its abort before the transaction abandons it. */
const GRACE_AFTER_ABORT_MS = 250

/**
 * Give up a session this attempt created. Bounded by a fixed ceiling ONLY, so a never-settling
 * request cannot hold the mutex slot open and wedge the successor.
 *
 * Deliberately NOT cancelled by the transaction's own signal: this compensation exists
 * precisely because the attempt was cancelled, so wiring the cancellation into it would abort
 * the cleanup at exactly the moment it is needed and leave the session alive (PR #69 review).
 * The successor is chained to THIS attempt's release, so it cannot log in before this logout
 * has completed or hit the ceiling — the shared cookie is never mutated by two attempts at
 * once.
 */
/**
 * Rejects only if the login is still running GRACE_AFTER_ABORT_MS after cancellation.
 *
 * This is a liveness backstop for a login that ignores its signal, not a cancellation path: it
 * cannot fire before the abort, and a login that settles promptly after being aborted always
 * wins the race. That ordering is what keeps a session established at header receipt from being
 * abandoned without compensation (PR #69 review).
 */
function abandonAfterGrace(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const arm = (): void => {
      setTimeout(
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        GRACE_AFTER_ABORT_MS,
      )
    }
    if (signal.aborted) arm()
    else signal.addEventListener("abort", arm, { once: true })
  })
}

async function discardSession(): Promise<void> {
  const ceiling = new AbortController()
  const timer = setTimeout(() => ceiling.abort(), LOGOUT_CEILING_MS)
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      signal: ceiling.signal,
    })
  } catch {
    // best-effort: the session is abandoned regardless
  } finally {
    clearTimeout(timer)
  }
}

type AbortCause = "timeout" | "superseded"

const aborted = (cause: AbortCause): SignInTransactionResult =>
  cause === "timeout"
    ? { success: false, error: "Timed out", errorType: "timeout" }
    : { success: false, error: "Superseded", errorType: "superseded" }

export async function runNostrConnectSignIn(
  publicKey: string,
  options: SignInTransactionOptions,
): Promise<SignInTransactionResult> {
  const { sessionId, timeout, isCurrent, onProgress, signal: external } = options
  const stillOwned = (): boolean => isCurrent?.() ?? true

  // One signal for the whole transaction. The deadline and external cancellation both abort it,
  // so the login, the signing round-trip and the compensating logout cannot outlive the
  // decision (PR #66 review). The CAUSE is tracked so the caller can tell a genuine timeout
  // from supersession — every abort path used to report "superseded", which showed a normal
  // Amber-approval timeout to the user as if they had been replaced.
  const controller = new AbortController()
  let cause: AbortCause = "superseded"
  const abortWith = (c: AbortCause): void => {
    if (controller.signal.aborted) return
    cause = c
    controller.abort()
  }
  const timer = setTimeout(() => abortWith("timeout"), timeout)
  const onExternalAbort = (): void => abortWith("superseded")
  if (external?.aborted) abortWith("superseded")
  external?.addEventListener("abort", onExternalAbort)

  let release: (() => void) | null = null

  try {
    release = await acquireSessionMutex(controller.signal)
  } catch {
    clearTimeout(timer)
    external?.removeEventListener("abort", onExternalAbort)
    return aborted(cause)
  }

  // Ownership can be lost while QUEUED (before any work begins). This attempt has not created
  // anything yet, so there is nothing to discard — just leave without logging in. The slot is
  // released in the finally below so the successor is not stranded.
  if (!stillOwned()) {
    clearTimeout(timer)
    external?.removeEventListener("abort", onExternalAbort)
    release()
    return aborted("superseded")
  }

  try {
    onProgress?.("signing", "Completing sign-in...")

    // consumeSession is given the signal and is expected to settle on abort — it aborts its own
    // fetch, and reports a post-header abort as ESTABLISHED so the session it created can be
    // discarded below. It is NOT raced against a bare abort promise: racing meant an abort
    // landing while the response body was being read won the race and returned cancelled,
    // skipping compensation for a session the server had already committed with its headers
    // (PR #69 review).
    //
    // A grace race is still needed for liveness, because a request that ignores its signal
    // would otherwise hold this transaction — and the mutex slot — forever. The grace period
    // starts only once the abort has fired, so a call that settles promptly (including one
    // reporting an established session) always wins and its session is always compensated.
    //
    // Since #70 this is a plain POST rather than a relay round-trip: the signing already
    // happened server-side and was verified there, so all that remains is to exchange the
    // approval for a cookie. The transaction's guarantees are unchanged.
    const sessionResult = await Promise.race([
      consumeSession(sessionId, controller.signal),
      abandonAfterGrace(controller.signal),
    ])

    // NOTE: deliberately no `if (signal.aborted) return` here. "The caller gave up" and "no
    // session exists" are different questions, and only the login can answer the second. An
    // aborted attempt whose login still established a session must fall through to the
    // ownership gate so that session is discarded (PR #69 review).
    if (!sessionResult.success) {
      // A consume that reports "superseded" was cancelled BEFORE it created a session, so there
      // is nothing to compensate. The transaction reports its OWN cause, so a deadline still
      // surfaces as "timeout" rather than being flattened into "superseded".
      if (sessionResult.errorType === "superseded" || controller.signal.aborted) {
        return aborted(cause)
      }
      return {
        success: false,
        error: sessionResult.error || "Failed to establish session",
        errorType: "session",
      }
    }

    // Ownership gate. The session exists but nothing local does. If this attempt no longer owns
    // the flow, give the session up; because establishment is serialised and the successor is
    // chained to THIS slot's release, no replacement has a session of its own for this to
    // destroy, and none can log in until this logout has completed or been cut off.
    if (!stillOwned() || controller.signal.aborted) {
      await discardSession()
      // A deadline does not flip the caller's isCurrent(), so the cause is what distinguishes a
      // timeout from a supersession here.
      return aborted(controller.signal.aborted ? cause : "superseded")
    }

    // Commit. Synchronous and inside the mutex. FAIL-CLOSED rather than snapshot-and-restore:
    // the only write that makes the app read as authenticated (the auth data that startup's
    // isAuthenticated() consults) is done LAST, after the profile writes. If anything throws,
    // the auth data is cleared and the session discarded, so a half-commit can never be
    // consumed as a login. An orphaned profile record is harmless — startup never reads a
    // profile without auth data (PR #66 review).
    // Validate before touching storage, so an invalid key never creates a profile.
    if (!publicKey || publicKey.length !== 64 || !/^[0-9a-f]{64}$/i.test(publicKey)) {
      await discardSession()
      return { success: false, error: "Invalid public key" }
    }

    let profile: StoredProfile
    try {
      profile = ProfileStorage.createProfile(publicKey, "nostrConnect")
      ProfileStorage.setActiveProfile(profile.id)

      // Last: the write that makes the app read as authenticated.
      const registration = NostrAuthService.signInWithNostrConnect(publicKey)
      if (!registration.success) {
        // Unreachable for a validated key (registration only fails validation), but keep the
        // fail-closed contract if that ever changes.
        throw new Error(registration.error || "Registration failed")
      }
    } catch (commitErr: unknown) {
      // Fail closed: whatever partial state exists, the app must not read as signed in.
      try {
        NostrAuthService.clearAuthData()
      } catch {
        // storage is already failing; the session discard below is what matters
      }
      await discardSession()
      return {
        success: false,
        error:
          commitErr instanceof Error ? commitErr.message : "Failed to complete sign-in",
        errorType: "unknown",
      }
    }

    const activeBlinkAccount: StoredBlinkAccount | null =
      profile.blinkAccounts.find((a) => a.isActive) || null

    onProgress?.("complete", "Done!")
    return { success: true, publicKey, profile, activeBlinkAccount }
  } catch (error: unknown) {
    // An abort during login lands here as a thrown AbortError from the fetch.
    if (controller.signal.aborted) {
      return aborted(cause)
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "An unexpected error occurred",
      errorType: "unknown",
    }
  } finally {
    clearTimeout(timer)
    external?.removeEventListener("abort", onExternalAbort)
    // Released only here, after any logout has completed or been cut off — never on abort
    // while a compensating logout could still be mutating the shared cookie.
    release()
  }
}
