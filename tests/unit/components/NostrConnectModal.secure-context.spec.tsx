/**
 * NostrConnectModal — insecure-origin pre-flight.
 *
 * The NIP-46 binding cookie is `Secure`, so a browser on a plain-HTTP,
 * non-localhost origin discards it SILENTLY. Everything then looks like a
 * different bug: the session is created fine, but the browser holds no binding,
 * so every poll is an unbound caller and gets the deliberately opaque 404
 * ("Session not found or expired") — surfaced as a generic "Sign-in did not
 * complete". Worse, the cookie is also what lets a retry supersede the previous
 * attempt, so each retry strands another live session until the per-IP cap
 * starts answering "Too many sign-in sessions in progress".
 *
 * Both symptoms were observed on a LAN IP while the identical build worked on
 * localhost (a secure context) and over HTTPS. The modal now checks up front,
 * which also means no server session — and no relay sockets or capacity slot —
 * is created for a sign-in that cannot complete.
 *
 * The check is gated on whether the cookie actually carries `Secure`, which is
 * a production-only attribute. In development it is omitted deliberately so a
 * device on the LAN can sign in over plain HTTP, and an unconditional guard
 * broke exactly that (PR #77 review) — so both environments are covered here.
 *
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

import NostrConnectModal from "../../../components/auth/NostrConnectModal"

const createSession = jest.fn()
const pollSession = jest.fn()
const consumeSession = jest.fn()
const cancelSession = jest.fn()

jest.mock("../../../lib/nostr/NostrConnectClient", () => ({
  __esModule: true,
  createSession: (...args: unknown[]) => createSession(...args),
  pollSession: (...args: unknown[]) => pollSession(...args),
  consumeSession: (...args: unknown[]) => consumeSession(...args),
  cancelSession: (...args: unknown[]) => cancelSession(...args),
}))

function setSecureContext(value: boolean): void {
  Object.defineProperty(window, "isSecureContext", {
    value,
    configurable: true,
    writable: true,
  })
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV

// process.env.NODE_ENV is typed read-only under Next's types; set it via a cast.
// The cookie builder reads it per call, so this drives the guard's condition.
function setNodeEnv(value: string): void {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}

function renderModal() {
  return render(
    <NostrConnectModal
      signInWithNostrConnect={jest.fn(async () => ({ success: true }))}
      onSuccess={jest.fn()}
      onCancel={jest.fn()}
    />,
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  // A session that never resolves, so nothing races the assertions when the
  // secure-context path is allowed to proceed.
  createSession.mockImplementation(() => new Promise(() => {}))
  pollSession.mockImplementation(() => new Promise(() => {}))
})

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV ?? "test")
})

describe("NostrConnectModal on an insecure origin in production", () => {
  beforeEach(() => {
    // Production is where the binding cookie carries `Secure`, so this is the
    // only environment in which an insecure origin actually breaks sign-in.
    setNodeEnv("production")
  })

  it("explains that HTTPS is required instead of failing generically", async () => {
    setSecureContext(false)

    renderModal()

    expect(await screen.findByText(/Sign-in needs a secure connection/i)).toBeTruthy()
    // The message has to be actionable — it must name the fix, not just the symptom.
    expect(screen.getByText(/HTTPS/)).toBeTruthy()
    // And it must not be the old generic copy.
    expect(screen.queryByText(/Sign-in did not complete/i)).toBeNull()
  })

  it("creates no server session, so no relay sockets or capacity slot are stranded", async () => {
    setSecureContext(false)

    renderModal()

    await screen.findByText(/Sign-in needs a secure connection/i)
    expect(createSession).not.toHaveBeenCalled()
    expect(pollSession).not.toHaveBeenCalled()
  })

  it("hides Try Again, which could only fail identically", async () => {
    setSecureContext(false)

    renderModal()

    await screen.findByText(/Sign-in needs a secure connection/i)
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull()
    // Cancel remains: the user still needs a way out of the modal.
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy()
  })

  it("proceeds normally on a secure origin", async () => {
    setSecureContext(true)

    renderModal()

    await waitFor(() => expect(createSession).toHaveBeenCalled())
    expect(screen.queryByText(/Sign-in needs a secure connection/i)).toBeNull()
  })
})

describe("NostrConnectModal on an insecure origin in development", () => {
  beforeEach(() => {
    setNodeEnv("development")
  })

  it("still signs in, because the cookie carries no Secure attribute", async () => {
    // A developer opening http://<LAN-IP>:3000 from a phone. The binding cookie
    // is deliberately non-Secure outside production, so the browser keeps it
    // and sign-in works. Blocking this was a development-only regression.
    setSecureContext(false)

    renderModal()

    await waitFor(() => expect(createSession).toHaveBeenCalled())
    expect(screen.queryByText(/Sign-in needs a secure connection/i)).toBeNull()
  })

  it("still signs in on localhost, which is a secure context anyway", async () => {
    setSecureContext(true)

    renderModal()

    await waitFor(() => expect(createSession).toHaveBeenCalled())
    expect(screen.queryByText(/Sign-in needs a secure connection/i)).toBeNull()
  })
})
