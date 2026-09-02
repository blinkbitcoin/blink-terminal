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
    connectStalled: false,
    connected: false,
    hasPubkey: false,
    hasSession: false,
  }

  it("leaves a non-in-flight flow alone (idle/complete/error)", () => {
    expect(decideNip46Resume({ ...base, stage: "idle" })).toBeNull()
    expect(decideNip46Resume({ ...base, stage: "complete" })).toBeNull()
    expect(decideNip46Resume({ ...base, stage: "error" })).toBeNull()
  })

  it("leaves a pending fresh connect attempt alone while it is still legitimately waiting", () => {
    // The attempt's fromURI promise owns the flow: it will resolve and drive the
    // connection itself. Even with a stale session present, touching the service singleton
    // here would race the pending attempt. connectStalled=false → not interrupted.
    for (const stage of ["waiting", "connected", "signing"] as const) {
      expect(
        decideNip46Resume({
          ...base,
          stage,
          connectInFlight: true,
          connectStalled: false,
          hasSession: true,
        }),
      ).toBeNull()
    }
  })

  it("reconnects when a stalled connect established NOTHING (no session persisted)", () => {
    // The tab went hidden before the signer's connect-ack arrived, so no (pending) session
    // was stored and the pending promise would hang until maxWait. With nothing established,
    // the only way forward is a fresh connect for a new ack.
    expect(
      decideNip46Resume({
        ...base,
        stage: "waiting",
        connectInFlight: true,
        connectStalled: true,
        hasSession: false,
      }),
    ).toBe("reconnect")
  })

  it("restores (not reconnects) when a stalled connect had ESTABLISHED (pending session present)", () => {
    // The handshake reached the ack (signer pubkey known → pending session persisted) but the
    // socket died before/at getPublicKey. The signer now considers itself connected and will
    // NOT re-ack, so a fresh connect would hang — restore rebuilds via fromBunker and finishes
    // getPublicKey on a live socket. This is the core same-device deeplink fix.
    expect(
      decideNip46Resume({
        ...base,
        stage: "waiting",
        connectInFlight: true,
        connectStalled: true,
        hasSession: true,
      }),
    ).toBe("restore-session")
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
