# User-Keyed Encryption for Server-Stored API Keys

> Research analysis: Can we replace the server-side `ENCRYPTION_KEY` with user-held keys (e.g. nsec) for encrypting API keys at rest?

**Date:** 2026-02-17  
**Status:** Research / Proposal  
**TL;DR:** Yes, this is better. Yes, there is Nostr protocol support. No, it is not a complete replacement for all use cases. A hybrid model is recommended.

---

## 1. Problem Statement

The current architecture uses a single server-side `ENCRYPTION_KEY` environment variable (through `lib/crypto/keyring.js`) to encrypt all users' API keys, NWC URIs, and boltcard secrets before storing them in the database. By default the keyring still writes the CryptoJS-compatible AES-CBC format (rollback-safe); authenticated AES-256-GCM (`v2`) writes start per environment only once `ENCRYPTION_WRITE_FORMAT=v2` is set (blink-wip#1587, phase 2).

**If the server is compromised, an attacker obtains:**

1. The `ENCRYPTION_KEY` from the environment
2. All encrypted blobs from the database
3. Therefore: every user's plaintext API keys, NWC URIs, and boltcard keys

The question is whether we can shift encryption so that the decryption key is held only by the respective user (derived from their Nostr identity / nsec), making a server breach yield only undecryptable ciphertext.

---

## 2. Relevant Nostr Protocol Standards

### NIP-44 — Encrypted Payloads (Versioned) — PRIMARY

The most relevant standard. NIP-44 defines keypair-based encryption using:

- **secp256k1 ECDH** to derive a `conversation_key` between two parties
- **HKDF -> ChaCha20 + HMAC-SHA256** for the actual encryption
- Audited by [Cure53](https://cure53.de/audit-report_nip44-implementations.pdf) (December 2023)

NIP-44 supports **"self-to-self" encryption** — where a user encrypts data to themselves:

```
conversation_key = get_conversation_key(user_privkey, user_pubkey)
// conv(a, A) — encrypt to self, only the user can decrypt
```

This produces a deterministic conversation key from the user's own keypair that can encrypt/decrypt their own secrets. No server involvement required.

**Source:** https://github.com/nostr-protocol/nips/blob/master/44.md

### NIP-49 — Private Key Encryption — RELEVANT PATTERN

Defines password-based encryption of private keys using **scrypt + XChaCha20-Poly1305** (`ncryptsec` format). While not directly applicable (it encrypts the nsec itself), it establishes the Nostr community's accepted pattern for user-held-key encryption of sensitive material.

**Source:** https://github.com/nostr-protocol/nips/blob/master/49.md

### NIP-78 — Arbitrary Custom App Data — STORAGE PATTERN

Defines `kind: 30078` addressable events for app-specific data storage on relays. Could be used to store NIP-44-encrypted API keys _on relays_ rather than on our server — eliminating the server as a storage target entirely.

**Source:** https://github.com/nostr-protocol/nips/blob/master/78.md

### NIP-46 — Nostr Remote Signing — RELEVANT FOR SIGNER INTEGRATION

Defines how clients can request encryption operations from a remote signer (bunker) without touching the nsec. Users with NIP-46 signers can perform NIP-44 encryption via `nip44_encrypt` / `nip44_decrypt` RPC calls, meaning the app never needs to see the private key.

**Source:** https://github.com/nostr-protocol/nips/blob/master/46.md

### NIP-EE — E2EE Messaging (MLS) — DESIGN PRINCIPLE

While now superseded by the Marmot Protocol, NIP-EE explicitly states: _"This NIP does not depend on a user's Nostr identity key for any aspect of the MLS messaging protocol. Compromise of a user's Nostr identity key does not give access to past or future messages."_ This establishes the Nostr community's design principle of minimizing key exposure and blast radius.

**Source:** https://github.com/nostr-protocol/nips/blob/master/EE.md

---

## 3. Current Codebase Architecture

### Server-Side Encryption (`lib/auth.ts`) — The subject of this analysis

```typescript
// One server key (lib/crypto/keyring.js) encrypts ALL users' secrets
static encryptApiKey(apiKey: string): string {
  return envKeyring().encrypt(apiKey) // ENCRYPTION_KEY
}
```

- Single `ENCRYPTION_KEY` env var used to encrypt every user's data (plus read-only `ENCRYPTION_KEY_PREVIOUS` during a rotation)
- ~64 call sites across vouchers, boltcards, network consent, webhooks, payment splits
- Write format follows `ENCRYPTION_WRITE_FORMAT`: `legacy` (default) is CryptoJS-compatible AES-CBC without authentication; `v2` is AES-256-GCM tagged with a key id. Reads accept both.
- Until phase 2 of `docs/encryption-key-rotation.md` runs in an environment, new values there are still written in the legacy format.

### Network Module — uses the same server key

- Network consent API keys (`data_sharing_consents.blink_api_key_encrypted`) are encrypted with `AuthManager` / `ENCRYPTION_KEY`, like everything else.
- The separate `NETWORK_ENCRYPTION_KEY` and `lib/network/crypto.ts` were never used and have been removed (blink-wip#1587).

### Client-Side Encryption (`lib/storage/CryptoUtils.ts`) — Already good

- Uses Web Crypto API with AES-GCM
- Device-key or password-based encryption
- Already has `deriveCryptoKeyFromString()` which could accept nsec-derived values

---

## 4. Feasibility Analysis

### Where User-Keyed Encryption Works

**User-interactive operations** where the user is present and can provide their key:

| Operation                          | Current Flow                                          | Proposed Flow                                                                         |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| User saves API key                 | Client -> Server encrypts with `ENCRYPTION_KEY` -> DB | Client encrypts with NIP-44 (self-to-self) -> Server stores ciphertext                |
| User views dashboard               | Server decrypts -> returns data                       | Server returns ciphertext -> Client decrypts with nsec                                |
| User creates invoice (interactive) | Server decrypts API key -> calls Blink                | Client decrypts -> sends plaintext API key with request -> Server uses it transiently |

**The NIP-44 self-to-self encryption flow:**

```python
# Client-side: encrypt before sending to server
conversation_key = nip44.get_conversation_key(user_nsec, user_npub)
encrypted_api_key = nip44.encrypt(api_key, conversation_key)
# Send encrypted_api_key to server for storage — server never sees plaintext

# Client-side: decrypt after receiving from server
conversation_key = nip44.get_conversation_key(user_nsec, user_npub)
api_key = nip44.decrypt(encrypted_api_key, conversation_key)
```

### Where User-Keyed Encryption Breaks

**Server-initiated autonomous operations** where no user is present to supply their key:

| Operation                                             | Problem                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Webhook processing** (`pages/api/blink/webhook.ts`) | Blink sends a webhook -> server must decrypt NWC URI to forward payment -> no user present to provide nsec   |
| **Boltcard tap processing**                           | Card is tapped -> server must decrypt API key + card keys (k0-k4) to validate and process -> no user present |
| **Network sync**                                      | Background sync decrypts `encrypted_api_key` for community operations -> no user present                     |
| **Voucher redemption**                                | Voucher is redeemed -> server must decrypt associated API key -> redeemer is not the creator                 |

These are the fundamental tension points. The server currently acts as an autonomous agent on behalf of the user, and it needs access to these secrets to fulfil that role.

---

## 5. Recommended Architecture: Hybrid Model

Rather than all-or-nothing, we recommend a tiered approach:

### Tier 1: User-Keyed (NIP-44 Self-to-Self) — for user-present operations

- User profile settings and preferences
- Display of API key metadata
- Any data the user stores and retrieves interactively
- **Implementation:** NIP-44 encryption on client, server stores only ciphertext
- **Benefit:** Server breach yields nothing usable for these data classes

### Tier 2: Per-User Derived Server Key — for server-autonomous operations

For operations where the server MUST act without the user, derive a **per-user server-side key** rather than using a single global key:

```
per_user_key = HKDF(
  IKM = server_master_key,
  salt = user_npub,
  info = "blinkpos-api-key-encryption"
)
```

**Benefit over current approach:** Even if `server_master_key` leaks, an attacker must know which npub maps to which encrypted blob AND must compute each user's key individually. It eliminates single-point bulk decryption.

### Tier 3: NIP-46 Remote Signer Integration — future ideal

The user's remote signer (bunker) could be queried to decrypt on-demand:

1. Server receives webhook
2. Server sends NIP-46 `nip44_decrypt` request to user's bunker
3. Bunker responds with decrypted key
4. Server uses key transiently, never stores plaintext

**Caveat:** Requires the bunker to be online and responsive in real-time during webhook processing. Adds latency and a failure mode. Not practical for boltcard tap processing where sub-second response is required.

### Tier 4: NWC as the Paradigm Shift

For payment operations specifically (the main reason most API keys exist), **Nostr Wallet Connect (NIP-47) already solves this correctly.** The NWC connection URI is a delegated, scoped credential. The user can revoke it independently. We are already partially using this pattern.

---

## 6. Prioritized Implementation Plan

| Priority | Action                                                                      | Impact                                                                                                                                     | Effort |
| -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **P0**   | Move from single `ENCRYPTION_KEY` to per-user derived keys (Tier 2)         | Eliminates single-point-of-failure. No client changes needed.                                                                              | Medium |
| **P1**   | Implement NIP-44 client-side encryption for new API key storage flows       | User-present operations become zero-knowledge to server                                                                                    | Medium |
| **P2**   | Replace `CryptoJS.AES` with Node.js `crypto` (AES-256-GCM) server-side      | **In progress** (blink-wip#1587). Implemented in `lib/crypto/keyring.js` (`v2` = AES-256-GCM, rotatable keys), but active per environment only after phase 2 sets `ENCRYPTION_WRITE_FORMAT=v2`; existing values are then re-encrypted with `scripts/reencrypt-secrets.js --apply` / `--check` (`docs/encryption-key-rotation.md`). Until then writes stay in the legacy CryptoJS format. | Low    |
| **P3**   | Evaluate NIP-78 for storing encrypted user data on relays instead of our DB | Removes our server as a storage target entirely for eligible data                                                                          | Low    |
| **P4**   | Investigate NIP-46 bunker integration for real-time decryption              | Best security model but adds infrastructure complexity                                                                                     | High   |

---

## 7. Caveats and Limitations

### NIP-44 has no forward secrecy

If the nsec is ever compromised, all data previously encrypted with it is exposed. However, this is equivalent to the current threat model (if `ENCRYPTION_KEY` leaks, all data is exposed) — with the crucial improvement that each user's nsec is independent. A single breach does not compromise all users.

### Browser signer extensions handle this transparently

Many users use Nostr browser extensions (nos2x, Alby, etc.) that perform NIP-44 encryption internally without exposing the nsec to the application. The extension handles `nip44_encrypt` / `nip44_decrypt` in its own secure context. This is the ideal UX — our app never sees the nsec.

### Boltcard keys are a special case

Boltcard keys (k0-k4) MUST be available to the server during card-tap processing in real-time with no user present. These cannot be user-keyed unless the boltcard architecture is fundamentally changed (e.g., to a model where card taps are proxied to a user-controlled signing device).

### Migration path

Existing encrypted data uses the current `ENCRYPTION_KEY`. Any migration requires a re-encryption step. The existing `scripts/reencrypt-secrets.js` (re-encryption under the current keyring key, used for phase 2 and key rotation) provides a pattern for this, but would need to be adapted for per-user key derivation.

---

## 8. Summary

| Aspect                  | Current                                | Proposed Hybrid                                             |
| ----------------------- | -------------------------------------- | ----------------------------------------------------------- |
| Server breach impact    | All users' secrets exposed             | Only server-autonomous secrets exposed (per-user encrypted) |
| User-interactive data   | Decryptable by server                  | Zero-knowledge to server (NIP-44)                           |
| Autonomous operations   | Work today                             | Continue to work (per-user derived keys)                    |
| Single point of failure | Yes (`ENCRYPTION_KEY`)                 | No (per-user keys)                                          |
| Protocol alignment      | Custom, non-standard                   | NIP-44 (audited, standardized)                              |
| Crypto library          | CryptoJS-compatible AES-CBC by default (unauthenticated); AES-256-GCM `v2` after phase 2 | NIP-44 ChaCha20 + HMAC-SHA256 (audited)                     |

The Nostr ecosystem provides the cryptographic primitives (NIP-44), the signer abstraction (NIP-46), and the storage patterns (NIP-78) to support user-keyed encryption of server-stored secrets. The hybrid model addresses the practical reality that the server performs autonomous operations while maximizing the security benefit for user-interactive flows.
