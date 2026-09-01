import { decideNip46Resume, type ResumeInput } from "../../lib/nostr/nip46-resume"

/**
 * The same-device mobile NIP-46 fix: when the browser tab is backgrounded by the
 * nostrconnect:// deep link into the signer, the relay client loop stalls. On foreground
 * return the modal must resume from wherever it stopped — WITHOUT clobbering a fresh
 * connect attempt that is still pending, and WITHOUT resurrecting a previous signer's
 * session while a new connection is being attempted (round-2 review race).
 */
describe("decideNip46Resume (same-device mobile sign-in resume)", () => {
  const base: ResumeInput = {
    stage: "signing",
    connectInFlight: false,
    connected: false,
    hasPubkey: false,
    hasSession: false,
  }

  it("leaves a non-in-flight flow alone (idle/complete/error)", () => {
    expect(decideNip46Resume({ ...base, stage: "idle" })).toBeNull()
    expect(decideNip46Resume({ ...base, stage: "complete" })).toBeNull()
    expect(decideNip46Resume({ ...base, stage: "error" })).toBeNull()
  })

  it("leaves a pending fresh connect attempt alone, whatever the service state", () => {
    // The attempt's fromURI promise owns the flow: it will resolve and drive the
    // connection itself. Even with a stale session present, touching the service singleton
    // here would race the pending attempt.
    for (const stage of ["waiting", "connected", "signing"] as const) {
      expect(
        decideNip46Resume({ ...base, stage, connectInFlight: true, hasSession: true }),
      ).toBeNull()
    }
  })

  it("re-drives only the NIP-98 sign step when the connection survived and we have the pubkey", () => {
    for (const stage of ["waiting", "connected", "signing"] as const) {
      expect(
        decideNip46Resume({ ...base, stage, connected: true, hasPubkey: true }),
      ).toBe("resume-signing")
    }
  })

  it("restores the session when an ESTABLISHED connection (connected/signing) dropped", () => {
    expect(
      decideNip46Resume({
        ...base,
        stage: "connected",
        connected: false,
        hasSession: true,
      }),
    ).toBe("restore-session")
    expect(
      decideNip46Resume({
        ...base,
        stage: "signing",
        connected: false,
        hasSession: true,
      }),
    ).toBe("restore-session")
    // Even with a pubkey, a dead established socket must restore before it can sign.
    expect(
      decideNip46Resume({
        ...base,
        stage: "signing",
        connected: false,
        hasPubkey: true,
        hasSession: true,
      }),
    ).toBe("restore-session")
  })

  it("never restores during the waiting stage — a stale session must not resurrect a previous signer mid-attempt", () => {
    expect(
      decideNip46Resume({
        ...base,
        stage: "waiting",
        connected: false,
        hasPubkey: false,
        hasSession: true,
      }),
    ).toBe("restart")
  })

  it("restarts from idle when there is no live connection and no stored session", () => {
    expect(decideNip46Resume({ ...base, connected: false, hasSession: false })).toBe(
      "restart",
    )
  })
})
