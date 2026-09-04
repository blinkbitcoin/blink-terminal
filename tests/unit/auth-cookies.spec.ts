/**
 * Tests for the centralized session-cookie helpers.
 *
 * Guarantees consistent attributes across every auth route:
 *   - HttpOnly always
 *   - SameSite=Lax (needed for the external-signer redirect return)
 *   - Secure only in production
 *   - Path=/ and a 24h Max-Age on set; Max-Age=0 on clear
 */

import {
  AUTH_COOKIE_NAME,
  AUTH_COOKIE_MAX_AGE_SECONDS,
  CHALLENGE_COOKIE_NAME,
  CHALLENGE_COOKIE_MAX_AGE_SECONDS,
  NIP46_COOKIE_NAME,
  buildSessionCookie,
  buildClearSessionCookie,
  buildChallengeCookie,
  buildClearChallengeCookie,
  buildNip46BindingCookie,
  buildClearNip46BindingCookie,
  nip46BindingCookieRequiresSecureContext,
} from "../../lib/auth/cookies"

const ORIGINAL_NODE_ENV = process.env.NODE_ENV

// process.env.NODE_ENV is typed read-only under Next's types; set it via a cast.
function setNodeEnv(value: string): void {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV ?? "test")
})

describe("buildSessionCookie", () => {
  it("includes the token, HttpOnly, Path, SameSite=Lax and Max-Age", () => {
    setNodeEnv("test")
    const cookie = buildSessionCookie("tok123")
    expect(cookie).toContain(`${AUTH_COOKIE_NAME}=tok123`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain(`Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`)
  })

  it("URL-encodes the token value", () => {
    setNodeEnv("test")
    const cookie = buildSessionCookie("a b/c")
    expect(cookie).toContain(`${AUTH_COOKIE_NAME}=a%20b%2Fc`)
  })

  it("omits Secure outside production", () => {
    setNodeEnv("development")
    expect(buildSessionCookie("t")).not.toContain("Secure")
  })

  it("adds Secure in production", () => {
    setNodeEnv("production")
    expect(buildSessionCookie("t")).toContain("Secure")
  })

  it("never uses SameSite=Strict (would break external-signer redirect)", () => {
    setNodeEnv("production")
    expect(buildSessionCookie("t")).not.toContain("SameSite=Strict")
  })
})

describe("buildClearSessionCookie", () => {
  it("expires the cookie with Max-Age=0 and matching attributes", () => {
    setNodeEnv("test")
    const cookie = buildClearSessionCookie()
    expect(cookie).toContain(`${AUTH_COOKIE_NAME}=`)
    expect(cookie).toContain("Max-Age=0")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("SameSite=Lax")
  })

  it("adds Secure in production on clear too", () => {
    setNodeEnv("production")
    expect(buildClearSessionCookie()).toContain("Secure")
  })
})

describe("buildChallengeCookie", () => {
  it("carries the secret, HttpOnly, Path, SameSite=Lax and a 5-min Max-Age", () => {
    setNodeEnv("test")
    const cookie = buildChallengeCookie("sek123")
    expect(cookie).toContain(`${CHALLENGE_COOKIE_NAME}=sek123`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain(`Max-Age=${CHALLENGE_COOKIE_MAX_AGE_SECONDS}`)
    expect(CHALLENGE_COOKIE_MAX_AGE_SECONDS).toBe(300)
  })

  it("URL-encodes the secret value", () => {
    setNodeEnv("test")
    expect(buildChallengeCookie("a/b")).toContain(`${CHALLENGE_COOKIE_NAME}=a%2Fb`)
  })

  it("omits Secure outside production, adds it in production", () => {
    setNodeEnv("development")
    expect(buildChallengeCookie("s")).not.toContain("Secure")
    setNodeEnv("production")
    expect(buildChallengeCookie("s")).toContain("Secure")
  })

  it("is HttpOnly so the redemption secret is not readable from JS", () => {
    setNodeEnv("production")
    expect(buildChallengeCookie("s")).toContain("HttpOnly")
  })
})

describe("buildClearChallengeCookie", () => {
  it("expires the challenge cookie with Max-Age=0 and matching attributes", () => {
    setNodeEnv("test")
    const cookie = buildClearChallengeCookie()
    expect(cookie).toContain(`${CHALLENGE_COOKIE_NAME}=`)
    expect(cookie).toContain("Max-Age=0")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
  })
})

/**
 * The NIP-46 binding cookie and the diagnostics that pre-empt its failure must
 * never disagree about whether `Secure` is emitted.
 *
 * A browser discards a `Secure` cookie on a non-secure origin silently, so the
 * sign-in modal refuses to start and the server logs a misconfiguration warning
 * when that would happen. An earlier version restated the production condition
 * in each of those places instead of deriving it, and the copies drifted: the
 * guard rejected plain-HTTP LAN origins in development, where the cookie has no
 * `Secure` attribute and sign-in genuinely worked (PR #77 review).
 *
 * These tests pin the predicate to the emitted attribute in BOTH environments,
 * so any future change to one has to change the other.
 */
describe("nip46BindingCookieRequiresSecureContext", () => {
  it.each(["development", "test", "production"])(
    "matches whether the emitted cookie carries Secure (NODE_ENV=%s)",
    (env) => {
      setNodeEnv(env)

      const emitsSecure = buildNip46BindingCookie("s").includes("Secure")

      expect(nip46BindingCookieRequiresSecureContext()).toBe(emitsSecure)
      // The clear cookie must agree too, or the browser will not overwrite the
      // one that was set.
      expect(buildClearNip46BindingCookie().includes("Secure")).toBe(emitsSecure)
    },
  )

  it("is true in production, where the cookie is Secure", () => {
    setNodeEnv("production")
    expect(nip46BindingCookieRequiresSecureContext()).toBe(true)
    expect(buildNip46BindingCookie("s")).toContain("Secure")
  })

  it("is false in development, so LAN testing over plain HTTP still works", () => {
    setNodeEnv("development")
    expect(nip46BindingCookieRequiresSecureContext()).toBe(false)
    expect(buildNip46BindingCookie("s")).not.toContain("Secure")
  })
})

describe("buildNip46BindingCookie", () => {
  it("is HttpOnly, path-scoped and SameSite=Strict", () => {
    setNodeEnv("production")
    const cookie = buildNip46BindingCookie("secret123")
    expect(cookie).toContain(`${NIP46_COOKIE_NAME}=secret123`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Path=/api/nostr-connect")
    expect(cookie).toContain("SameSite=Strict")
  })
})
