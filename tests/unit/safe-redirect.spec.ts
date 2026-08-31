/**
 * Unit tests for lib/auth/safe-redirect.ts
 *
 * These guard the open-redirect / redirect-loop boundary on the sign-in page:
 * only same-origin absolute paths that are not the sign-in route may be used as
 * a post-auth redirect target; everything else falls back to "/".
 */

import { isSafeInternalPath, safeInternalRedirect } from "../../lib/auth/safe-redirect"

describe("lib/auth/safe-redirect", () => {
  describe("isSafeInternalPath", () => {
    const accepted: string[] = [
      "/",
      "/dashboard",
      "/setuppwa",
      "/a/b/c",
      "/path?query=1&x=2",
      "/path#hash",
      "/path?next=/foo", // query may contain slashes; only the pathname matters
    ]

    const rejected: Array<[string, unknown]> = [
      // Absolute URLs (open redirect)
      ["absolute https URL", "https://evil.example"],
      ["absolute http URL", "http://evil.example/path"],
      // Protocol-relative and backslash variants that normalize to //host
      ["protocol-relative //host", "//evil.example"],
      ["backslash-relative /\\host", "/\\evil.example"],
      ["double-backslash /\\\\host", "/\\\\evil.example"],
      // Scheme-based
      ["javascript: scheme", "javascript:alert(1)"],
      ["data: scheme", "data:text/html,<script>1</script>"],
      // Relative / malformed
      ["empty string", ""],
      ["bare word (relative)", "foo"],
      ["relative path", "foo/bar"],
      // Loop back to the sign-in route (any query/hash, any case)
      ["exact /signin", "/signin"],
      ["/signin with query", "/signin?redirect=/x"],
      ["/signin with hash", "/signin#top"],
      ["/SignIn (case-insensitive)", "/SignIn"],
      // Non-string query values (router.query can yield string[] or undefined)
      ["undefined", undefined],
      ["null", null],
      ["number", 42],
      ["array of paths", ["/a", "/b"]],
      ["object", { path: "/a" }],
    ]

    it.each(accepted)("accepts safe internal path %p", (value) => {
      expect(isSafeInternalPath(value)).toBe(true)
    })

    it.each(rejected)("rejects %s", (_label, value) => {
      expect(isSafeInternalPath(value)).toBe(false)
    })
  })

  describe("safeInternalRedirect", () => {
    it("returns the value for a safe internal path", () => {
      expect(safeInternalRedirect("/dashboard")).toBe("/dashboard")
      expect(safeInternalRedirect("/a?b=1#c")).toBe("/a?b=1#c")
    })

    it("falls back to / for unsafe or non-string values", () => {
      expect(safeInternalRedirect("https://evil.example")).toBe("/")
      expect(safeInternalRedirect("//evil.example")).toBe("/")
      expect(safeInternalRedirect("/signin")).toBe("/")
      expect(safeInternalRedirect(undefined)).toBe("/")
      expect(safeInternalRedirect(["/a", "/b"])).toBe("/")
    })

    it("honors a custom fallback", () => {
      expect(safeInternalRedirect("https://evil.example", "/setuppwa")).toBe("/setuppwa")
      expect(safeInternalRedirect(undefined, "/setuppwa")).toBe("/setuppwa")
    })
  })
})
