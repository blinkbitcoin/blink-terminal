/**
 * Revoke-consent feedback (PR #92 re-review): a failed revoke used to write
 * the shared `error` state, which the community dashboard never renders — the
 * consent and its stored API key stayed active while the button looked like a
 * no-op. Revoke failures must render beside the Revoke control.
 */

import { render, screen, waitFor } from "@testing-library/react"

import Network from "../../../components/Network"

const PUBKEY = "a".repeat(64)

const COMMUNITY = {
  id: "1",
  name: "Test Community",
  slug: "test",
  description: null,
  country_code: "ZA",
  region: null,
  city: null,
  latitude: 0,
  longitude: 0,
  leader_npub: "npub1xyz",
  member_count: 2,
  data_sharing_member_count: 1,
  status: "active",
  created_at: "2026-01-01",
}

const MEMBERSHIP = {
  id: 3,
  community_id: "1",
  community_name: "Test Community",
  community_slug: "test",
  user_npub: "npub1self",
  role: "member",
  status: "approved",
}

// revokeOutcome controls what DELETE /api/network/consent answers.
let revokeOutcome: { status: number; body: unknown } = {
  status: 500,
  body: { success: false, error: "Failed to revoke consent" },
}

const mockFetch = jest.fn(
  (input: RequestInfo | URL, init?: RequestInit): Promise<unknown> => {
    const url = String(input)
    const json = (status: number, body: unknown) =>
      Promise.resolve({ status, json: () => Promise.resolve(body) })

    if (url.startsWith("/api/network/consent") && init?.method === "DELETE") {
      return json(revokeOutcome.status, revokeOutcome.body)
    }
    if (url.startsWith("/api/network/consent")) {
      return json(200, {
        success: true,
        consents: [
          {
            id: "9",
            community_id: "1",
            status: "active",
            blink_username: "alice",
            consented_at: "2026-10-01",
          },
        ],
      })
    }
    if (url.startsWith("/api/network/communities")) {
      return json(200, { success: true, communities: [COMMUNITY] })
    }
    if (url.startsWith("/api/network/memberships/pending")) {
      return json(200, { success: true, applications: [] })
    }
    if (url.startsWith("/api/network/memberships")) {
      return json(200, { success: true, memberships: [MEMBERSHIP] })
    }
    if (url.startsWith("/api/network/whitelist/check")) {
      return json(200, {
        success: true,
        isSuperAdmin: false,
        isWhitelisted: false,
        role: "user",
      })
    }
    if (url.startsWith("/api/network/leaderboard")) {
      return json(200, { success: true, leaderboard: [] })
    }
    return json(200, { success: true })
  },
)

global.fetch = mockFetch as unknown as typeof fetch

jest.spyOn(console, "error").mockImplementation(() => {})

beforeEach(() => {
  mockFetch.mockClear()
  revokeOutcome = {
    status: 500,
    body: { success: false, error: "Failed to revoke consent" },
  }
})

const openCommunityView = async () => {
  render(<Network publicKey={PUBKEY} nostrProfile={null} darkMode={false} />)
  const viewButton = await screen.findByText("View")
  viewButton.click()
  await screen.findByText("Data Sharing Active")
}

describe("revoke consent feedback", () => {
  it("a failed revoke is visible beside the Revoke control", async () => {
    await openCommunityView()

    screen.getByText("Revoke").click()

    await waitFor(() => {
      expect(screen.getByText("Failed to revoke consent")).toBeTruthy()
    })
    // Consent stays active (status card still shown)
    expect(screen.getByText("Data Sharing Active")).toBeTruthy()
  })

  it("a successful revoke flips the status card off and shows no error", async () => {
    revokeOutcome = { status: 200, body: { success: true } }
    await openCommunityView()

    screen.getByText("Revoke").click()

    await waitFor(() => {
      expect(screen.queryByText("Data Sharing Active")).toBeNull()
    })
    expect(screen.queryByText("Failed to revoke consent")).toBeNull()
  })
})
