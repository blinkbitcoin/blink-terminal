/**
 * Session-expiry UX (PR #92 re-review): when the 24h server session cookie is
 * gone, every authed call 401s. The banner must render from the shared view
 * shell (not per-view insertions that branches can miss), the My Communities
 * view must not render its misleading "haven't joined" empty state, and a
 * failed whitelist check must not downgrade role state.
 */

import { render, screen, waitFor } from "@testing-library/react"

import Network from "../../../components/Network"

const PUBKEY = "a".repeat(64)

// fetch routing: authed endpoints 401, public endpoints answer normally.
// (jsdom has no Response global — the component only reads .status/.json().)
const mockFetch = jest.fn(
  (input: RequestInfo | URL, _init?: RequestInit): Promise<unknown> => {
    const url = String(input)
    const json = (status: number, body: unknown) =>
      Promise.resolve({ status, json: () => Promise.resolve(body) })

    if (url.startsWith("/api/network/communities")) {
      return json(200, { success: true, communities: [] })
    }
    if (url.startsWith("/api/network/leaderboard")) {
      return json(200, { success: true, leaderboard: [] })
    }
    if (
      url.startsWith("/api/network/memberships") ||
      url.startsWith("/api/network/whitelist/check") ||
      url.startsWith("/api/network/consent")
    ) {
      return json(401, { success: false, error: "Authentication required" })
    }
    return json(404, { success: false, error: "not found" })
  },
)

global.fetch = mockFetch as unknown as typeof fetch

jest.spyOn(console, "error").mockImplementation(() => {})

beforeEach(() => {
  mockFetch.mockClear()
})

const renderNetwork = () =>
  render(<Network publicKey={PUBKEY} nostrProfile={null} darkMode={false} />)

describe("session expiry", () => {
  it("shows the expiry banner in the discovery view when authed calls 401", async () => {
    renderNetwork()

    await waitFor(() => {
      expect(screen.getByText(/sign-in session has expired/i)).toBeTruthy()
    })
  })

  it("shows the banner — not the misleading empty state — in My Communities", async () => {
    renderNetwork()

    // Navigate to My Communities after the 401s have landed
    const navButton = await screen.findByText(/My Communities \(/)
    navButton.click()

    await waitFor(() => {
      expect(screen.getAllByText(/sign-in session has expired/i).length).toBeGreaterThan(
        0,
      )
    })
    expect(screen.queryByText(/haven't joined any communities yet/i)).toBeNull()
  })

  it("does not issue any mutation retry after a 401", async () => {
    renderNetwork()

    await waitFor(() => {
      expect(screen.getByText(/sign-in session has expired/i)).toBeTruthy()
    })

    const mutationCalls = mockFetch.mock.calls.filter(
      ([, init]) => init?.method && init.method !== "GET",
    )
    expect(mutationCalls).toHaveLength(0)
  })
})
