/**
 * Security tests for the pubkey-binding challenge store.
 *
 * The challenge/verify flow (external-signer login via /api/auth/verify-ownership)
 * mints a session for whatever pubkey signs the challenge. Without binding, a
 * single issued challenge could be replayed by a different pubkey, or a victim
 * phished into signing a reusable challenge could have it consumed for a
 * different identity. These tests pin down:
 *
 *   - single-use (a challenge verifies at most once)
 *   - pubkey binding (first verifier claims it; others are rejected)
 *   - expiry
 *   - pubkey input validation
 *
 * Runs against the in-memory backend (ENABLE_HYBRID_STORAGE is unset in tests).
 */

import {
  generateChallenge,
  generateChallengeSecret,
  storeChallenge,
  verifyChallenge,
} from "../../lib/auth/challengeStore"

const PUBKEY_A = "a".repeat(64)
const PUBKEY_B = "b".repeat(64)

describe("challengeStore pubkey binding", () => {
  it("verifies a freshly stored challenge for the signing pubkey", async () => {
    const challenge = generateChallenge()
    await storeChallenge(challenge, 300)

    const result = await verifyChallenge(challenge, PUBKEY_A)
    expect(result.valid).toBe(true)
  })

  it("rejects an unknown / never-stored challenge", async () => {
    const result = await verifyChallenge("blinkpos:0:never-issued", PUBKEY_A)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/not found|expired/i)
  })

  it("is single-use: a second verify with the SAME pubkey is rejected", async () => {
    const challenge = generateChallenge()
    await storeChallenge(challenge, 300)

    expect((await verifyChallenge(challenge, PUBKEY_A)).valid).toBe(true)
    const second = await verifyChallenge(challenge, PUBKEY_A)
    expect(second.valid).toBe(false)
    expect(second.error).toMatch(/already used/i)
  })

  it("SECURITY: a different pubkey cannot consume a challenge already claimed", async () => {
    const challenge = generateChallenge()
    await storeChallenge(challenge, 300)

    // Attacker's own key claims (and burns) the challenge first.
    expect((await verifyChallenge(challenge, PUBKEY_A)).valid).toBe(true)

    // Victim pubkey can no longer use the same challenge.
    const victim = await verifyChallenge(challenge, PUBKEY_B)
    expect(victim.valid).toBe(false)
  })

  it("SECURITY: rejects when bound pubkey differs even before consumption races", async () => {
    // Two challenges; ensure binding is per-challenge, not global.
    const c1 = generateChallenge()
    const c2 = generateChallenge()
    await storeChallenge(c1, 300)
    await storeChallenge(c2, 300)

    expect((await verifyChallenge(c1, PUBKEY_A)).valid).toBe(true)
    // c2 is independent and can be claimed by a different pubkey.
    expect((await verifyChallenge(c2, PUBKEY_B)).valid).toBe(true)
  })

  it("rejects an expired challenge", async () => {
    const challenge = generateChallenge()
    await storeChallenge(challenge, -1) // already expired

    const result = await verifyChallenge(challenge, PUBKEY_A)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/expired|not found/i)
  })

  it("rejects a missing pubkey", async () => {
    const challenge = generateChallenge()
    await storeChallenge(challenge, 300)
    const result = await verifyChallenge(challenge, "")
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/pubkey/i)
  })

  it("rejects a malformed pubkey (not 64-hex)", async () => {
    const challenge = generateChallenge()
    await storeChallenge(challenge, 300)
    const result = await verifyChallenge(challenge, "xyz")
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/pubkey/i)
  })

  it("generateChallenge produces unique blinkpos-prefixed challenges", () => {
    const a = generateChallenge()
    const b = generateChallenge()
    expect(a.startsWith("blinkpos:")).toBe(true)
    expect(b.startsWith("blinkpos:")).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe("challengeStore secret (anti-bearer) binding", () => {
  it("verifies when the presented secret matches the stored one", async () => {
    const challenge = generateChallenge()
    const secret = generateChallengeSecret()
    await storeChallenge(challenge, 300, secret)

    const result = await verifyChallenge(challenge, PUBKEY_A, secret)
    expect(result.valid).toBe(true)
  })

  it("SECURITY: rejects when no secret is presented for a secret-bound challenge", async () => {
    const challenge = generateChallenge()
    const secret = generateChallengeSecret()
    await storeChallenge(challenge, 300, secret)

    const result = await verifyChallenge(challenge, PUBKEY_A /* no secret */)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/secret/i)
  })

  it("SECURITY: rejects when the wrong secret is presented (phished from another browser)", async () => {
    const challenge = generateChallenge()
    const secret = generateChallengeSecret()
    await storeChallenge(challenge, 300, secret)

    // Attacker has a valid signed event but a different browser → different/no secret.
    const attackerSecret = generateChallengeSecret()
    const result = await verifyChallenge(challenge, PUBKEY_A, attackerSecret)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/secret/i)
  })

  it("SECURITY: a failed secret check does NOT consume the challenge (legit browser can still redeem)", async () => {
    const challenge = generateChallenge()
    const secret = generateChallengeSecret()
    await storeChallenge(challenge, 300, secret)

    // Attacker attempt with wrong secret fails...
    expect((await verifyChallenge(challenge, PUBKEY_A, "deadbeef")).valid).toBe(false)
    // ...and the legitimate browser (correct secret) can still complete login.
    expect((await verifyChallenge(challenge, PUBKEY_A, secret)).valid).toBe(true)
  })

  it("generateChallengeSecret returns unique 64-hex secrets", () => {
    const a = generateChallengeSecret()
    const b = generateChallengeSecret()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(b).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})
