import { decideNip46Resume, type ResumeInput } from "../../lib/nostr/nip46-resume"

/**
 * The same-device mobile NIP-46 fix: when the browser tab is backgrounded by the
 * nostrconnect:// deep link into the signer, the relay client loop stalls. On foreground
 * return the modal must resume from wherever it stopped. These cases pin that decision.
 */
describe("decideNip46Resume (same-device mobile sign-in resume)", () => {
  const base: ResumeInput = {
    stage: "signing",
    connected: false,
    hasPubkey: false,
    hasSession: false,
  }

  it("leaves a non-in-flight flow alone (idle/complete/error)", () => {
    expect(decideNip46Resume({ ...base, stage: "idle" })).toBeNull()
    expect(decideNip46Resume({ ...base, stage: "complete" })).toBeNull()
    expect(decideNip46Resume({ ...base, stage: "error" })).toBeNull()
  })

  it("re-drives only the NIP-98 sign step when the connection survived and we have the pubkey", () => {
    // Covers every in-flight stage; the fastest correct resume is re-running the challenge.
    for (const stage of ["waiting", "connected", "signing"] as const) {
      expect(
        decideNip46Resume({ ...base, stage, connected: true, hasPubkey: true }),
      ).toBe("resume-signing")
    }
  })

  it("restores the session when the socket died but a session is stored", () => {
    expect(decideNip46Resume({ ...base, connected: false, hasSession: true })).toBe(
      "restore-session",
    )
    // Even with a pubkey, a dead socket must restore before it can sign.
    expect(
      decideNip46Resume({ ...base, connected: false, hasPubkey: true, hasSession: true }),
    ).toBe("restore-session")
  })

  it("restarts from idle when there is no live connection and no stored session", () => {
    expect(decideNip46Resume({ ...base, connected: false, hasSession: false })).toBe(
      "restart",
    )
  })
})
