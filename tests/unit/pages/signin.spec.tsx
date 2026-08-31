/**
 * Router-boundary tests for the /signin page.
 *
 * The safe-redirect *helper* is unit-tested separately; this suite proves the
 * page wiring: the authenticated-redirect effect waits for router.isReady,
 * preserves a safe ?redirect= target (including query/hash), and falls back to
 * "/" for missing, unsafe, or control-character targets — so a regression that
 * drops the query, bypasses the helper, or redirects before hydration is caught.
 */

import { render } from "@testing-library/react"

// --- Mocks -----------------------------------------------------------------

const mockReplace = jest.fn()
let mockRouter: {
  isReady: boolean
  query: Record<string, string | string[] | undefined>
  replace: typeof mockReplace
}
jest.mock("next/router", () => ({
  useRouter: () => mockRouter,
}))

let mockAuth: { loading: boolean; isAuthenticated: boolean }
jest.mock("../../../lib/hooks/useCombinedAuth", () => ({
  useCombinedAuth: () => mockAuth,
}))

// Stub the heavy Nostr login form — not under test here.
jest.mock("../../../components/auth/NostrLoginForm", () => ({
  __esModule: true,
  default: () => <div data-testid="nostr-login-form" />,
}))

import SignIn from "../../../pages/signin"

function setup({
  isReady = true,
  isAuthenticated = true,
  loading = false,
  query = {} as Record<string, string | string[] | undefined>,
} = {}) {
  mockRouter = { isReady, query, replace: mockReplace }
  mockAuth = { loading, isAuthenticated }
  return render(<SignIn />)
}

beforeEach(() => {
  mockReplace.mockClear()
})

describe("pages/signin redirect effect", () => {
  it("does not redirect until router.isReady", () => {
    const { rerender } = setup({
      isReady: false,
      isAuthenticated: true,
      query: { redirect: "/dashboard" },
    })
    expect(mockReplace).not.toHaveBeenCalled()

    // Router becomes ready — the intended destination is preserved, not dropped.
    mockRouter = {
      isReady: true,
      query: { redirect: "/dashboard" },
      replace: mockReplace,
    }
    rerender(<SignIn />)
    expect(mockReplace).toHaveBeenCalledWith("/dashboard")
  })

  it("does not redirect an unauthenticated visitor", () => {
    setup({ isReady: true, isAuthenticated: false, query: { redirect: "/dashboard" } })
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it("does not redirect while auth is still loading", () => {
    setup({ isReady: true, loading: true, isAuthenticated: true })
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it("preserves a safe redirect target including query and hash", () => {
    setup({
      isReady: true,
      isAuthenticated: true,
      query: { redirect: "/setuppwa?x=1#h" },
    })
    expect(mockReplace).toHaveBeenCalledWith("/setuppwa?x=1#h")
  })

  it("redirects to / when no redirect param is present", () => {
    setup({ isReady: true, isAuthenticated: true, query: {} })
    expect(mockReplace).toHaveBeenCalledWith("/")
  })

  it("falls back to / for an absolute-URL (open-redirect) target", () => {
    setup({
      isReady: true,
      isAuthenticated: true,
      query: { redirect: "https://evil.example" },
    })
    expect(mockReplace).toHaveBeenCalledWith("/")
  })

  it("falls back to / for a control-character target", () => {
    setup({
      isReady: true,
      isAuthenticated: true,
      query: { redirect: "/\t/evil.example" },
    })
    expect(mockReplace).toHaveBeenCalledWith("/")
  })

  it("falls back to / for a non-string (array) redirect value", () => {
    setup({
      isReady: true,
      isAuthenticated: true,
      query: { redirect: ["/a", "/b"] },
    })
    expect(mockReplace).toHaveBeenCalledWith("/")
  })
})
