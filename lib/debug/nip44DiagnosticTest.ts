/**
 * NIP-44 Diagnostic Test - iOS Safari Debugging
 *
 * Tests individual crypto operations used in NIP-44 encryption to identify
 * which specific operation fails on iOS Safari:
 *
 * 1. HKDF key derivation (from @noble/hashes)
 * 2. ChaCha20 encryption (from @noble/ciphers)
 * 3. HMAC-SHA256 (from @noble/hashes)
 * 4. Full NIP-44 encrypt/decrypt round-trip
 *
 * Results are logged both to console and optionally to remote server.
 */

import { chacha20 } from "@noble/ciphers/chacha.js"
import { secp256k1 } from "@noble/curves/secp256k1"
import { hkdf } from "@noble/hashes/hkdf"
import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "@noble/hashes/utils"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"

export interface DiagnosticTestResult {
  pass?: boolean
  error?: string
  [key: string]: unknown
}

export interface DiagnosticResults {
  timestamp: string
  userAgent: string
  platform: string
  tests: Record<string, DiagnosticTestResult>
  overall: string
  summary?: string
}

// Known test vectors for validation
const TEST_VECTORS: {
  plaintext: string
  hkdfInput: Uint8Array
  hkdfSalt: Uint8Array
  sha256Input: string
  sha256Expected: string
} = {
  // Simple UTF-8 test
  plaintext: "Hello, Nostr! Testing NIP-44 on iOS Safari 🎉",

  // Known HKDF output for specific input (computed reference)
  hkdfInput: hexToBytes("000102030405060708090a0b0c0d0e0f"),
  hkdfSalt: hexToBytes(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  ),

  // Known SHA256 output
  sha256Input: "test message for SHA256",
  sha256Expected: "a32d88aee0c9f9c6a5cc1f6c58c82c0bc8e6c02e58e7e6f8a4f7e8d9c0b1a2f3", // Placeholder
}

/**
 * Run all NIP-44 diagnostic tests
 * @param logCallback - Optional callback for each log message
 * @returns Test results
 */
export async function runNIP44Diagnostics(
  logCallback?: (msg: string) => void,
): Promise<DiagnosticResults> {
  const log = (msg: string): void => {
    console.log("[NIP44-Diag]", msg)
    if (logCallback) logCallback(msg)
  }

  const results: DiagnosticResults = {
    timestamp: new Date().toISOString(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    platform: typeof navigator !== "undefined" ? navigator.platform : "unknown",
    tests: {},
    overall: "pending",
  }

  log("=== NIP-44 Diagnostic Test Suite ===")
  log(`Platform: ${results.platform}`)
  log(`User Agent: ${results.userAgent.substring(0, 80)}...`)
  log("")

  // Test 1: Basic crypto availability
  log("--- Test 1: Crypto Availability ---")
  try {
    results.tests.cryptoAvailable = {
      webCrypto: typeof crypto !== "undefined" && !!crypto.subtle,
      getRandomValues: typeof crypto !== "undefined" && !!crypto.getRandomValues,
    }
    log(`WebCrypto subtle: ${results.tests.cryptoAvailable.webCrypto}`)
    log(`getRandomValues: ${results.tests.cryptoAvailable.getRandomValues}`)
    results.tests.cryptoAvailable.pass = true
  } catch (e: unknown) {
    results.tests.cryptoAvailable = { pass: false, error: (e as Error).message }
    log(`FAILED: ${(e as Error).message}`)
  }
  log("")

  // Test 2: SHA256 hash
  log("--- Test 2: SHA256 Hash ---")
  try {
    const input: Uint8Array = utf8ToBytes("test")
    const hash: Uint8Array = sha256(input)
    const hashHex: string = bytesToHex(hash)
    const expected: string =
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    results.tests.sha256 = {
      input: "test",
      output: hashHex,
      expected: expected,
      pass: hashHex === expected,
    }
    log(`Input: "test"`)
    log(`Output: ${hashHex}`)
    log(`Expected: ${expected}`)
    log(`Match: ${results.tests.sha256.pass ? "YES ✓" : "NO ✗"}`)
  } catch (e: unknown) {
    results.tests.sha256 = { pass: false, error: (e as Error).message }
    log(`FAILED: ${(e as Error).message}`)
  }
  log("")

  // Test 3: HMAC-SHA256
  log("--- Test 3: HMAC-SHA256 ---")
  try {
    const key: Uint8Array = hexToBytes("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
    const data: Uint8Array = utf8ToBytes("Hi There")
    const mac: Uint8Array = hmac(sha256, key, data)
    const macHex: string = bytesToHex(mac)
    // RFC 4231 Test Vector 1
    const expected: string =
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
    results.tests.hmac = {
      output: macHex,
      expected: expected,
      pass: macHex === expected,
    }
    log(`Output: ${macHex}`)
    log(`Expected: ${expected}`)
    log(`Match: ${results.tests.hmac.pass ? "YES ✓" : "NO ✗"}`)
  } catch (e: unknown) {
    results.tests.hmac = { pass: false, error: (e as Error).message }
    log(`FAILED: ${(e as Error).message}`)
  }
  log("")

  // Test 4: HKDF key derivation
  log("--- Test 4: HKDF Key Derivation ---")
  try {
    const ikm: Uint8Array = hexToBytes("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
    const salt: Uint8Array = hexToBytes("000102030405060708090a0b0c")
    const info: Uint8Array = utf8ToBytes("")
    const derivedKey: Uint8Array = hkdf(sha256, ikm, salt, info, 42)
    const derivedHex: string = bytesToHex(derivedKey)
    // RFC 5869 Test Case 1
    const expected: string =
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    results.tests.hkdf = {
      outputLength: derivedKey.length,
      output: derivedHex,
      expected: expected,
      pass: derivedHex === expected,
    }
    log(`Output (${derivedKey.length} bytes): ${derivedHex}`)
    log(`Expected: ${expected}`)
    log(`Match: ${results.tests.hkdf.pass ? "YES ✓" : "NO ✗"}`)
  } catch (e: unknown) {
    results.tests.hkdf = { pass: false, error: (e as Error).message }
    log(`FAILED: ${(e as Error).message}`)
  }
  log("")

  // Test 5: ChaCha20 encryption
  log("--- Test 5: ChaCha20 Encryption ---")
  try {
    // Test vector from RFC 8439
    const key: Uint8Array = hexToBytes(
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    )
    const nonce: Uint8Array = hexToBytes("000000000000004a00000000")
    const plaintext: Uint8Array = utf8ToBytes(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    )

    const cipher: Uint8Array = chacha20(key, nonce, plaintext)
    const cipherHex: string = bytesToHex(cipher)

    // Known output from RFC 8439 section 2.4.2
    const expectedStart: string =
      "6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0bf91b65c5524733ab8f593d"

    results.tests.chacha20 = {
      inputLength: plaintext.length,
      outputLength: cipher.length,
      outputStart: cipherHex.substring(0, 90),
      expectedStart: expectedStart,
      pass: cipherHex.startsWith(expectedStart),
    }
    log(`Input length: ${plaintext.length}`)
    log(`Output length: ${cipher.length}`)
    log(`Output (first 45 bytes): ${cipherHex.substring(0, 90)}`)
    log(`Expected start: ${expectedStart}`)
    log(`Match: ${results.tests.chacha20.pass ? "YES ✓" : "NO ✗"}`)

    // Also test decryption (ChaCha20 is symmetric)
    const decrypted: Uint8Array = chacha20(key, nonce, cipher)
    const decryptedText: string = new TextDecoder().decode(decrypted)
    const originalText: string = new TextDecoder().decode(plaintext)
    results.tests.chacha20.decryptMatch = decryptedText === originalText
    log(`Decrypt roundtrip: ${results.tests.chacha20.decryptMatch ? "YES ✓" : "NO ✗"}`)
  } catch (e: unknown) {
    results.tests.chacha20 = { pass: false, error: (e as Error).message }
    log(`FAILED: ${(e as Error).message}`)
  }
  log("")

  // Test 6: secp256k1 ECDH shared secret
  log("--- Test 6: secp256k1 ECDH ---")
  try {
    // Generate two keypairs
    const sk1: Uint8Array = generateSecretKey()
    const pk1: string = getPublicKey(sk1)
    const sk2: Uint8Array = generateSecretKey()
    const pk2: string = getPublicKey(sk2)

    // Compute shared secret both ways
    const shared1: Uint8Array = secp256k1.getSharedSecret(sk1, "02" + pk2)
    const shared2: Uint8Array = secp256k1.getSharedSecret(sk2, "02" + pk1)

    const shared1Hex: string = bytesToHex(shared1.slice(1, 33)) // Remove prefix, take x-coord
    const shared2Hex: string = bytesToHex(shared2.slice(1, 33))

    results.tests.ecdh = {
      sharedSecret1: shared1Hex.substring(0, 32) + "...",
      sharedSecret2: shared2Hex.substring(0, 32) + "...",
      pass: shared1Hex === shared2Hex,
    }
    log(`Shared secret (A→B): ${shared1Hex.substring(0, 32)}...`)
    log(`Shared secret (B→A): ${shared2Hex.substring(0, 32)}...`)
    log(`Match: ${results.tests.ecdh.pass ? "YES ✓" : "NO ✗"}`)
  } catch (e: unknown) {
    results.tests.ecdh = { pass: false, error: (e as Error).message }
    log(`FAILED: ${(e as Error).message}`)
  }
  log("")

  // Test 7: Full NIP-44 style encrypt/decrypt
  log("--- Test 7: Full NIP-44 Round-trip ---")
  try {
    // Generate keypairs for Alice and Bob
    const aliceSk: Uint8Array = generateSecretKey()
    const alicePk: string = getPublicKey(aliceSk)
    const bobSk: Uint8Array = generateSecretKey()
    const bobPk: string = getPublicKey(bobSk)

    log(`Alice pubkey: ${alicePk.substring(0, 16)}...`)
    log(`Bob pubkey: ${bobPk.substring(0, 16)}...`)

    // Compute conversation key (like NIP-44 does)
    const sharedPoint: Uint8Array = secp256k1.getSharedSecret(aliceSk, "02" + bobPk)
    const sharedX: Uint8Array = sharedPoint.slice(1, 33)

    // Derive conversation key using HKDF
    const conversationKey: Uint8Array = hkdf(
      sha256,
      sharedX,
      utf8ToBytes("nip44-v2"),
      undefined,
      32,
    )
    const conversationKeyHex: string = bytesToHex(conversationKey)
    log(`Conversation key: ${conversationKeyHex.substring(0, 32)}...`)

    // Generate random nonce
    const nonce: Uint8Array = new Uint8Array(12)
    crypto.getRandomValues(nonce)

    // Encrypt with ChaCha20
    const plaintext: Uint8Array = utf8ToBytes(TEST_VECTORS.plaintext)
    const ciphertext: Uint8Array = chacha20(conversationKey, nonce, plaintext)

    log(`Plaintext: "${TEST_VECTORS.plaintext}"`)
    log(`Plaintext bytes: ${plaintext.length}`)
    log(`Ciphertext bytes: ${ciphertext.length}`)
    log(`Nonce: ${bytesToHex(nonce)}`)

    // Compute MAC (HMAC-SHA256)
    const macData: Uint8Array = concatBytes(nonce, ciphertext)
    const mac: Uint8Array = hmac(sha256, conversationKey, macData)
    log(`MAC: ${bytesToHex(mac).substring(0, 32)}...`)

    // Now decrypt
    const decrypted: Uint8Array = chacha20(conversationKey, nonce, ciphertext)
    const decryptedText: string = new TextDecoder().decode(decrypted)

    // Verify MAC
    const verifyMacData: Uint8Array = concatBytes(nonce, ciphertext)
    const verifyMac: Uint8Array = hmac(sha256, conversationKey, verifyMacData)
    const macValid: boolean = bytesToHex(mac) === bytesToHex(verifyMac)

    const roundTripMatch: boolean = decryptedText === TEST_VECTORS.plaintext

    results.tests.nip44Roundtrip = {
      originalText: TEST_VECTORS.plaintext,
      decryptedText: decryptedText,
      macValid: macValid,
      pass: roundTripMatch && macValid,
    }

    log(`Decrypted: "${decryptedText}"`)
    log(`MAC valid: ${macValid ? "YES ✓" : "NO ✗"}`)
    log(`Round-trip match: ${roundTripMatch ? "YES ✓" : "NO ✗"}`)
  } catch (e: unknown) {
    results.tests.nip44Roundtrip = { pass: false, error: (e as Error).message }
    log(`FAILED: ${(e as Error).message}`)
    log(`Stack: ${(e as Error).stack?.split("\n").slice(0, 3).join(" | ")}`)
  }
  log("")

  // Test 8: Cross-keypair encryption (simulating real NIP-46 scenario)
  log("--- Test 8: Cross-keypair Communication ---")
  try {
    // This simulates what happens in NIP-46:
    // Client encrypts a message for the bunker (signer)
    // Bunker decrypts it with its own key

    const clientSk: Uint8Array = generateSecretKey()
    const clientPk: string = getPublicKey(clientSk)
    const bunkerSk: Uint8Array = generateSecretKey()
    const bunkerPk: string = getPublicKey(bunkerSk)

    log(`Client pubkey: ${clientPk.substring(0, 16)}...`)
    log(`Bunker pubkey: ${bunkerPk.substring(0, 16)}...`)

    // Client computes shared secret with bunker's pubkey
    const clientShared: Uint8Array = secp256k1.getSharedSecret(clientSk, "02" + bunkerPk)
    const clientSharedX: Uint8Array = clientShared.slice(1, 33)
    const clientConvKey: Uint8Array = hkdf(
      sha256,
      clientSharedX,
      utf8ToBytes("nip44-v2"),
      undefined,
      32,
    )

    // Bunker computes shared secret with client's pubkey
    const bunkerShared: Uint8Array = secp256k1.getSharedSecret(bunkerSk, "02" + clientPk)
    const bunkerSharedX: Uint8Array = bunkerShared.slice(1, 33)
    const bunkerConvKey: Uint8Array = hkdf(
      sha256,
      bunkerSharedX,
      utf8ToBytes("nip44-v2"),
      undefined,
      32,
    )

    // Keys should match
    const keysMatch: boolean = bytesToHex(clientConvKey) === bytesToHex(bunkerConvKey)
    log(`Conversation keys match: ${keysMatch ? "YES ✓" : "NO ✗"}`)

    if (!keysMatch) {
      log(`Client conv key: ${bytesToHex(clientConvKey)}`)
      log(`Bunker conv key: ${bytesToHex(bunkerConvKey)}`)
    }

    // Client encrypts message
    const message: string = '{"method":"connect","params":["test"]}'
    const nonce: Uint8Array = new Uint8Array(12)
    crypto.getRandomValues(nonce)

    const encrypted: Uint8Array = chacha20(clientConvKey, nonce, utf8ToBytes(message))
    const mac: Uint8Array = hmac(sha256, clientConvKey, concatBytes(nonce, encrypted))

    // Bunker decrypts message
    const decrypted: Uint8Array = chacha20(bunkerConvKey, nonce, encrypted)
    const decryptedMsg: string = new TextDecoder().decode(decrypted)

    // Bunker verifies MAC
    const verifyMac: Uint8Array = hmac(
      sha256,
      bunkerConvKey,
      concatBytes(nonce, encrypted),
    )
    const macValid: boolean = bytesToHex(mac) === bytesToHex(verifyMac)

    const messageMatch: boolean = decryptedMsg === message

    results.tests.crossKeypair = {
      keysMatch: keysMatch,
      macValid: macValid,
      messageMatch: messageMatch,
      originalMessage: message,
      decryptedMessage: decryptedMsg,
      pass: keysMatch && macValid && messageMatch,
    }

    log(`Original: ${message}`)
    log(`Decrypted: ${decryptedMsg}`)
    log(`MAC valid: ${macValid ? "YES ✓" : "NO ✗"}`)
    log(`Message match: ${messageMatch ? "YES ✓" : "NO ✗"}`)
  } catch (e: unknown) {
    results.tests.crossKeypair = { pass: false, error: (e as Error).message }
    log(`FAILED: ${(e as Error).message}`)
  }
  log("")

  // Calculate overall result
  const testResults: DiagnosticTestResult[] = Object.values(results.tests)
  const passedCount: number = testResults.filter(
    (t: DiagnosticTestResult) => t.pass,
  ).length
  const totalCount: number = testResults.length
  results.overall = passedCount === totalCount ? "PASS" : "FAIL"
  results.summary = `${passedCount}/${totalCount} tests passed`

  log("=== Summary ===")
  log(`Overall: ${results.overall}`)
  log(`${results.summary}`)

  // List failed tests
  const failedTests: string[] = Object.entries(results.tests)
    .filter(([_name, t]: [string, DiagnosticTestResult]) => !t.pass)
    .map(([name, _t]: [string, DiagnosticTestResult]) => name)

  if (failedTests.length > 0) {
    log(`Failed tests: ${failedTests.join(", ")}`)
  }

  return results
}

/**
 * Send diagnostic results to remote server
 * @param results - Test results from runNIP44Diagnostics
 */
export async function sendDiagnosticsToServer(results: DiagnosticResults): Promise<void> {
  try {
    const response: Response = await fetch("/api/debug/remote-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "NIP44_DIAGNOSTICS",
        timestamp: results.timestamp,
        userAgent: results.userAgent,
        platform: results.platform,
        overall: results.overall,
        summary: results.summary,
        tests: results.tests,
      }),
    })

    if (response.ok) {
      console.log("[NIP44-Diag] Results sent to server")
    }
  } catch (e: unknown) {
    console.warn("[NIP44-Diag] Failed to send results to server:", (e as Error).message)
  }
}

export default { runNIP44Diagnostics, sendDiagnosticsToServer }
