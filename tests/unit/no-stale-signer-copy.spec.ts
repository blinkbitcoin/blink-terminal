/**
 * Stale signer-copy guard (PR #62 review): the signer-initiated bunker flow and its signer
 * (nsec.app) were removed because the product is discontinued — so no user-facing surface may
 * keep recommending it. This reads the component sources and asserts the promotional strings
 * are gone; a future edit that reintroduces them fails here instead of in review.
 */
import { readFileSync } from "fs"
import { join } from "path"

const COMPONENTS = [
  "components/auth/NostrConnectModal.tsx",
  "components/auth/NostrLoginForm.tsx",
]

/** User-facing strings that promoted the discontinued signer. */
const FORBIDDEN = [
  "Recommended for iOS:", // the nsec.app recommendation banner
  "Paste in nsec.app", // the copy confirmation targeting nsec.app
  "works best with", // the sign-in form's nsec.app hint lead-in
  "https://nsec.app", // any link to the discontinued product
]

describe("stale signer copy guard", () => {
  for (const file of COMPONENTS) {
    it(`${file} contains no nsec.app promotion`, () => {
      const src = readFileSync(join(__dirname, "..", "..", file), "utf8")
      for (const forbidden of FORBIDDEN) {
        expect(src).not.toContain(forbidden)
      }
    })
  }
})
