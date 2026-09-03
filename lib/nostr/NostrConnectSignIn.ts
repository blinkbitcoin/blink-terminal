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
 *  - The login and the relay signing round-trip are driven by ONE AbortSignal owned by the
 *    transaction. A timeout or supersession cancels the request, so it cannot commit a session
 *    late; there is no abandoned-request window to paper over.
 *  - The only resource that exists before the outcome is known is the server session, because
 *    signing is what proves the user. If the attempt loses ownership, times out, fails, or its
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

export interface SignInTransactionOptions {
  /** Abort deadline in ms. */
  timeout: number
  /** Caller ownership check; defaults to owned. */
  isCurrent?: () => boolean
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
  return new Promise((resolveAcquired, rejectAcquired) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort)
      // Leave the queue: this slot is released immediately so the chain can move on.
      release()
      rejectAcquired(new Error("aborted before entering"))
    }
    if (signal.aborted) {
      release()
      rejectAcquired(new Error("aborted before entering"))
      return
    }
    signal.addEventListener("abort", onAbort)
    previous.then(() => {
      signal.removeEventListener("abort", onAbort)
      resolveAcquired(release)
    })
  })
}

async function discardSession(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" })
  } catch {
    // best-effort: the session is abandoned regardless
  }
}

const superseded = (): SignInTransactionResult => ({
  success: false,
  error: "Superseded",
  errorType: "superseded",
})

export async function runNostrConnectSignIn(
  publicKey: string,
  options: SignInTransactionOptions,
): Promise<SignInTransactionResult> {
  const { timeout, isCurrent, onProgress } = options
  const stillOwned = (): boolean => isCurrent?.() ?? true

  // One signal for the whole transaction. Timeout and supersession both abort it, so the login
  // and the signing round-trip cannot outlive the decision (PR #66 review).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  let release: (() => void) | null = null
  let released = false
  const releaseOnce = (): void => {
    if (released) return
    released = true
    release?.()
  }
  // Releasing the slot cannot depend on the attempt's own async work completing: a login that
  // never settles even when aborted would otherwise hold the queue forever (PR #66 review).
  // On abort we hand the slot to the next waiter immediately; this attempt's work is dead
  // regardless.
  controller.signal.addEventListener("abort", () => releaseOnce())

  try {
    release = await acquireSessionMutex(controller.signal)
  } catch {
    clearTimeout(timer)
    return superseded()
  }

  // Ownership can be lost while QUEUED (before any work begins). This attempt has not created
  // anything yet, so there is nothing to discard — just leave without logging in.
  if (!stillOwned()) {
    clearTimeout(timer)
    releaseOnce()
    return superseded()
  }

  // The transaction resolves on timeout even if the underlying request never settles — an
  // aborted-but-stuck login must not hold this attempt open forever (PR #66 review).
  const onAbort = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    )
  })

  try {
    onProgress?.("signing", "Signing authentication event...")

    // Sign and establish the server session, both abortable via the transaction's signal.
    const sessionResult: Awaited<ReturnType<typeof NostrAuthService.nip98Login>> =
      await Promise.race([
        NostrAuthService.nip98Login({
          signWithMethod: "nostrConnect",
          signal: controller.signal,
        }),
        onAbort,
      ])

    if (controller.signal.aborted) {
      return superseded()
    }
    if (!sessionResult.success) {
      return {
        success: false,
        error: sessionResult.error || "Failed to establish session",
        errorType: sessionResult.errorType === "superseded" ? "superseded" : "session",
      }
    }

    // Ownership gate. The session exists but nothing local does. If this attempt no longer owns
    // the flow, give the session up; because establishment is serialised, no replacement has a
    // session of its own for this to destroy.
    if (!stillOwned()) {
      await discardSession()
      return superseded()
    }

    // Commit. Synchronous and inside the mutex; a storage throw discards the session so the app
    // is not left authenticated under a user the caller was told failed (PR #66 review).
    try {
      const registration = NostrAuthService.signInWithNostrConnect(publicKey)
      if (!registration.success) {
        await discardSession()
        return { success: false, error: registration.error }
      }

      const profile: StoredProfile = ProfileStorage.createProfile(
        publicKey,
        "nostrConnect",
      )
      ProfileStorage.setActiveProfile(profile.id)
      const activeBlinkAccount: StoredBlinkAccount | null =
        profile.blinkAccounts.find((a) => a.isActive) || null

      onProgress?.("complete", "Done!")
      return { success: true, publicKey, profile, activeBlinkAccount }
    } catch (commitErr: unknown) {
      await discardSession()
      return {
        success: false,
        error:
          commitErr instanceof Error ? commitErr.message : "Failed to complete sign-in",
        errorType: "unknown",
      }
    }
  } catch (error: unknown) {
    // An abort during login lands here as a thrown AbortError from the fetch.
    if (controller.signal.aborted) {
      return superseded()
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "An unexpected error occurred",
      errorType: "unknown",
    }
  } finally {
    clearTimeout(timer)
    release()
  }
}
