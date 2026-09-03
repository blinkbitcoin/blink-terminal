/**
 * Startup-restore binding guard (PR #66 review).
 *
 * The app-startup NIP-46 restore must be bound to the user the stored auth belongs to. Calling
 * restoreSession() with no expectation lets a stale record for a DIFFERENT user be restored and
 * authenticated as that user — reachable when a previous session write AND its fallback removal
 * both failed, leaving the old record on disk.
 *
 * The service enforces this when it is TOLD who to expect (see the expectedPublicKey tests in
 * nostr-connect-service.spec.ts); this guard pins the one call site that has to pass it. It is a
 * source-level check, following the existing no-stale-signer-copy.spec.ts pattern, because
 * standing up a full hook harness for a single argument would cost far more than it proves.
 */
import { readFileSync } from "fs"
import { join } from "path"

const HOOK = "lib/hooks/useNostrAuth.tsx"

describe("startup restore binding guard", () => {
  const src = readFileSync(join(__dirname, "..", "..", HOOK), "utf8")

  it("passes expectedPublicKey to the startup restoreSession call", () => {
    // Collapse whitespace so line-wrapping/trailing-comma formatting does not break this.
    const flat = src.replace(/\s+/g, " ")
    expect(flat).toMatch(
      /restoreSession\(\s*\{\s*expectedPublicKey:\s*publicKey\s*,?\s*\}\s*\)/,
    )
  })

  it("has no unbound restoreSession() call in the hook", () => {
    // Regex, not a substring check: `restoreSession( )` and other whitespace-only variants
    // would otherwise slip through even after flattening and defeat the intent of this guard.
    const flat = src.replace(/\s+/g, " ")
    expect(flat).not.toMatch(/restoreSession\(\s*\)/)
  })
})
