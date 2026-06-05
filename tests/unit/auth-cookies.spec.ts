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
  buildSessionCookie,
  buildClearSessionCookie,
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
