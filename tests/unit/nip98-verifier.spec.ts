/**
 * @jest-environment node
 *
 * Nip98Verifier — including the challenge-tag and expected-pubkey binding added
 * for the server-held NIP-46 flow (issue #70).
 *
 * Plain NIP-98 has no nonce, so a signed event is a bearer artifact for its
 * whole freshness window. The NIP-46 worker asks the signer to include a
 * per-session challenge and requires the signature to come from the key that
 * answered get_public_key; these tests pin both.
 */

import { schnorr } from "@noble/curves/secp256k1"
import { sha256 } from "@noble/hashes/sha256"

import Nip98Verifier from "../../lib/nostr/Nip98Verifier"

const PRIVKEY = new Uint8Array(32).fill(3)

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

interface EventInput {
  url?: string
  method?: string
  challenge?: string | null
  createdAt?: number
  kind?: number
  extraTags?: string[][]
}

const URL_UNDER_TEST = "https://pos.example/api/nostr-connect/sessions/abc/consume"

function signEvent(input: EventInput = {}): Record<string, unknown> {
  const pubkey = toHex(schnorr.getPublicKey(PRIVKEY))
  const tags: string[][] = [
    ["u", input.url ?? URL_UNDER_TEST],
    ["method", input.method ?? "POST"],
  ]
  if (input.challenge !== null) {
    tags.push(["challenge", input.challenge ?? "session-challenge"])
  }
  tags.push(...(input.extraTags ?? []))

  const event = {
    pubkey,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    kind: input.kind ?? 27235,
    tags,
    content: "",
  }

  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ])
  const id = toHex(sha256(new TextEncoder().encode(serialized)))
  const sig = toHex(schnorr.sign(id, PRIVKEY))

  return { ...event, id, sig }
}

const SIGNER_PUBKEY = toHex(schnorr.getPublicKey(PRIVKEY))

describe("Nip98Verifier.verifySignedEvent", () => {
  it("accepts a well-formed event bound to the expected challenge and signer", async () => {
    const result = await Nip98Verifier.verifySignedEvent({
      event: signEvent(),
      url: URL_UNDER_TEST,
      method: "POST",
      challenge: "session-challenge",
      expectedPubkey: SIGNER_PUBKEY,
    })

    expect(result.valid).toBe(true)
    expect(result.pubkey).toBe(SIGNER_PUBKEY.toLowerCase())
  })

  it("rejects an event signed by a different key than get_public_key returned", async () => {
    const result = await Nip98Verifier.verifySignedEvent({
      event: signEvent(),
      url: URL_UNDER_TEST,
      method: "POST",
      expectedPubkey: "f".repeat(64),
    })

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/does not match expected signer/i)
  })

  it("rejects an event with no challenge tag when one is required", async () => {
    const result = await Nip98Verifier.verifySignedEvent({
      event: signEvent({ challenge: null }),
      url: URL_UNDER_TEST,
      method: "POST",
      challenge: "session-challenge",
    })

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/missing challenge tag/i)
  })

  it("rejects a challenge from a different session", async () => {
    const result = await Nip98Verifier.verifySignedEvent({
      event: signEvent({ challenge: "other-session" }),
      url: URL_UNDER_TEST,
      method: "POST",
      challenge: "session-challenge",
    })

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/challenge mismatch/i)
  })

  it("ignores the challenge tag when the caller does not require one", async () => {
    const result = await Nip98Verifier.verifySignedEvent({
      event: signEvent({ challenge: "anything" }),
      url: URL_UNDER_TEST,
      method: "POST",
    })

    expect(result.valid).toBe(true)
  })

  it("rejects a mismatched u tag", async () => {
    const result = await Nip98Verifier.verifySignedEvent({
      event: signEvent({ url: "https://evil.example/api/steal" }),
      url: URL_UNDER_TEST,
      method: "POST",
    })

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/url mismatch/i)
  })

  it("rejects a mismatched method tag", async () => {
    const result = await Nip98Verifier.verifySignedEvent({
      event: signEvent({ method: "GET" }),
      url: URL_UNDER_TEST,
      method: "POST",
    })

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/method mismatch/i)
  })

  it("rejects the wrong event kind", async () => {
    const result = await Nip98Verifier.verifySignedEvent({
      event: signEvent({ kind: 22242 }),
      url: URL_UNDER_TEST,
      method: "POST",
    })

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/invalid event kind/i)
  })

  it("rejects a stale event", async () => {
    const result = await Nip98Verifier.verifySignedEvent({
      event: signEvent({ createdAt: Math.floor(Date.now() / 1000) - 600 }),
      url: URL_UNDER_TEST,
      method: "POST",
      maxAgeSeconds: 120,
    })

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/too old/i)
  })

  it("rejects a tampered event whose id no longer matches", async () => {
    const event = signEvent() as Record<string, unknown>
    event.created_at = (event.created_at as number) - 1

    const result = await Nip98Verifier.verifySignedEvent({
      event,
      url: URL_UNDER_TEST,
      method: "POST",
    })

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/does not match calculated hash/i)
  })

  it("rejects an event whose signature does not verify", async () => {
    const event = signEvent() as Record<string, unknown>
    event.sig = "0".repeat(128)

    const result = await Nip98Verifier.verifySignedEvent({
      event,
      url: URL_UNDER_TEST,
      method: "POST",
    })

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/invalid signature/i)
  })
})

describe("Nip98Verifier.verify (header form)", () => {
  it("still verifies a base64 Authorization header", async () => {
    const event = signEvent({ url: "https://pos.example/api/auth/nostr-login" })
    const header = Nip98Verifier.createAuthHeader(
      event as unknown as Parameters<typeof Nip98Verifier.createAuthHeader>[0],
    )

    const result = await Nip98Verifier.verify({
      authHeader: header,
      url: "https://pos.example/api/auth/nostr-login",
      method: "POST",
      maxAgeSeconds: 120,
    })

    expect(result.valid).toBe(true)
    expect(result.pubkey).toBe(SIGNER_PUBKEY.toLowerCase())
  })

  it("rejects a malformed header", async () => {
    const result = await Nip98Verifier.verify({
      authHeader: "Bearer nope",
      url: URL_UNDER_TEST,
      method: "POST",
    })

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/failed to extract/i)
  })
})
