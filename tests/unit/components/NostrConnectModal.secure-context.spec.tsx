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

describe("NostrConnectModal on an insecure origin", () => {
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
