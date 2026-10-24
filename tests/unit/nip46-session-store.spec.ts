/**
 * @jest-environment node
 *
 * NIP-46 session store — TTL, browser binding and single-use consumption.
 *
 * ENABLE_HYBRID_STORAGE is unset here, so these exercise the in-memory backend
 * (same convention as challenge-store.spec.ts). The Redis path mirrors the same
 * checks through a WATCH/MULTI compare-and-swap.
 */

import {
  __resetSessionStoreForTests,
  bindingMatches,
  consumeSession,
  createSession,
  generateBindingSecret,
  generateSessionId,
  getSession,
  markApproved,
  markFailed,
  sha256Hex,
} from "../../lib/nip46-server/sessionStore"

const PUBKEY = "a".repeat(64)

async function seed(overrides: { ttlSeconds?: number } = {}): Promise<{
  id: string
  secret: string
}> {
  const id = generateSessionId()
  const secret = generateBindingSecret()
  await createSession({
    id,
    bindingHash: sha256Hex(secret),
    expectedUrl: `https://pos.example/api/nostr-connect/sessions/${id}/consume`,
    challenge: "challenge-value",
    ttlSeconds: overrides.ttlSeconds,
  })
  return { id, secret }
}

beforeEach(() => {
  __resetSessionStoreForTests()
})

describe("createSession / getSession", () => {
  it("starts pending and never stores the binding secret in the clear", async () => {
    const { id, secret } = await seed()
    const record = await getSession(id)

    expect(record?.status).toBe("pending")
    expect(record?.bindingHash).toBe(sha256Hex(secret))
    expect(JSON.stringify(record)).not.toContain(secret)
  })

  it("returns null for an unknown session", async () => {
    expect(await getSession("nope")).toBeNull()
  })

  it("treats an expired session as absent", async () => {
    const { id } = await seed({ ttlSeconds: -1 })
    expect(await getSession(id)).toBeNull()
  })
})

describe("markApproved / markFailed", () => {
  it("approves a pending session and records the pubkey", async () => {
    const { id } = await seed()
    expect(await markApproved(id, PUBKEY)).toBe(true)

    const record = await getSession(id)
    expect(record?.status).toBe("approved")
    expect(record?.pubkey).toBe(PUBKEY)
  })

  it("refuses to approve a session that is no longer pending", async () => {
    const { id } = await seed()
    await markFailed(id, "cancelled")

    expect(await markApproved(id, PUBKEY)).toBe(false)
    expect((await getSession(id))?.status).toBe("failed")
  })

  it("keeps terminal states terminal", async () => {
    const { id, secret } = await seed()
    await markApproved(id, PUBKEY)
    await consumeSession(id, secret)

    expect(await markFailed(id, "server_restarted")).toBe(false)
    expect((await getSession(id))?.status).toBe("consumed")
  })

  it("records the failure reason", async () => {
    const { id } = await seed()
    await markFailed(id, "connect_timeout")
    expect((await getSession(id))?.error).toBe("connect_timeout")
  })
})

describe("consumeSession", () => {
  it("consumes an approved session exactly once", async () => {
    const { id, secret } = await seed()
    await markApproved(id, PUBKEY)

    const first = await consumeSession(id, secret)
    expect(first).toEqual({ ok: true, pubkey: PUBKEY })

    const second = await consumeSession(id, secret)
    expect(second.ok).toBe(false)
    expect(second.error).toBe("Session already used")
  })

  it("rejects a session that has not been approved", async () => {
    const { id, secret } = await seed()
    const result = await consumeSession(id, secret)

    expect(result.ok).toBe(false)
    expect(result.error).toBe("Session is not approved")
    // Still consumable later, once the signer approves.
    await markApproved(id, PUBKEY)
    expect((await consumeSession(id, secret)).ok).toBe(true)
  })

  it("rejects a failed session", async () => {
    const { id, secret } = await seed()
    await markFailed(id, "signing_timeout")

    expect((await consumeSession(id, secret)).ok).toBe(false)
  })

  it("requires the browser binding secret", async () => {
    const { id, secret } = await seed()
    await markApproved(id, PUBKEY)

    const noCookie = await consumeSession(id, undefined)
    expect(noCookie.ok).toBe(false)
    // Indistinguishable from "unknown session": possessing the id alone must
    // not reveal that it exists.
    expect(noCookie.error).toBe("Session not found or expired")

    const wrongCookie = await consumeSession(id, generateBindingSecret())
    expect(wrongCookie.ok).toBe(false)

    // A rejected attempt must not have burned the approval.
    expect((await consumeSession(id, secret)).ok).toBe(true)
  })

  it("rejects an expired session", async () => {
    const { id, secret } = await seed({ ttlSeconds: -1 })
    const result = await consumeSession(id, secret)
    expect(result.ok).toBe(false)
  })
})

describe("bindingMatches", () => {
  it("matches only the exact hash", () => {
    const hash = sha256Hex("secret")
    expect(bindingMatches(hash, hash)).toBe(true)
    expect(bindingMatches(hash, sha256Hex("other"))).toBe(false)
    expect(bindingMatches(hash, undefined)).toBe(false)
    expect(bindingMatches(hash, "short")).toBe(false)
  })
})
