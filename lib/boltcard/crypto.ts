/**
 * Boltcard Crypto - NTAG424DNA key derivation and authentication
 *
 * Implements the cryptographic operations needed for Boltcard per the official spec:
 * https://github.com/boltcard/boltcard/blob/main/docs/DETERMINISTIC.md
 *
 * Features:
 * - Spec-compliant deterministic key derivation using AES-CMAC PRF
 * - PICCData decryption with proper tag byte validation (0xc7)
 * - SunMAC (CMAC) verification
 * - Counter validation for replay protection
 * - Privacy-preserving card ID derivation
 *
 * References:
 * - NTAG 424 DNA datasheet (NXP)
 * - BTCPayServer.BoltCardTools: https://github.com/btcpayserver/BTCPayServer.BoltCardTools
 * - Boltcard spec: https://github.com/boltcard/boltcard/blob/main/docs/DETERMINISTIC.md
 */

import crypto from "crypto"

// =============================================================================
// INTERFACES & TYPES
// =============================================================================

/** Derived card keys (K0-K4) plus metadata */
export interface DerivedCardKeys {
  k0: string
  k1: string
  k2: string
  k3: string
  k4: string
  cardKey: string
  cardIdHash: string
}

/** Result of decrypting PICCData */
export interface PICCDataResult {
  cardUid: string
  counter: number
  raw: string
}

/** Result of verifying a card tap */
export interface CardTapResult {
  valid: boolean
  cardUid?: string
  counter?: number
  error?: string
}

/** Extracted p and c parameters from a URL */
export interface PandCParams {
  p: string
  c: string
}

/** Card keys object used for programming */
export interface CardKeys {
  k0: string
  k1: string
  k2: string
  k3: string
  k4: string
}

/** Keys response for NFC Programmer app */
export interface KeysResponse {
  LNURLW: string
  K0: string
  K1: string
  K2: string
  K3: string
  K4: string
}

/** Registration data for card programming */
export interface RegistrationData {
  deeplink: string
  keysRequestUrl: string
  qrPayload: string
}

/** Legacy card keys (K0-K4 only) */
export interface LegacyCardKeys {
  k0: string
  k1: string
  k2: string
  k3: string
  k4: string
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Key slots for NTAG424DNA
 */
export const KeySlot = {
  K0: 0, // AppMasterKey - can change other keys
  K1: 1, // EncryptionKey - decrypts PICCData (SHARED across all cards per issuer)
  K2: 2, // AuthenticationKey - generates SunMAC (CMAC)
  K3: 3, // Reserved
  K4: 4, // Reserved
} as const

/**
 * Magic constants for key derivation per spec
 * These are the domain separation tags from DETERMINISTIC.md
 */
export const DerivationConstants: Record<string, Buffer> = {
  CARD_KEY: Buffer.from([0x2d, 0x00, 0x3f, 0x75]), // CardKey derivation
  K0_APP_MASTER: Buffer.from([0x2d, 0x00, 0x3f, 0x76]), // K0 (AppMasterKey)
  K1_ENCRYPTION: Buffer.from([0x2d, 0x00, 0x3f, 0x77]), // K1 (Encryption) - from IssuerKey only
  K2_AUTH: Buffer.from([0x2d, 0x00, 0x3f, 0x78]), // K2 (Authentication)
  K3_RESERVED: Buffer.from([0x2d, 0x00, 0x3f, 0x79]), // K3
  K4_RESERVED: Buffer.from([0x2d, 0x00, 0x3f, 0x7a]), // K4
  CARD_ID: Buffer.from([0x2d, 0x00, 0x3f, 0x7b]), // Privacy-preserving ID
}

/**
 * PICCData tag byte for Boltcard format
 * 0xc7 = 0b11000111 = has UID (bit 7) + has counter (bit 6) + UID is 7 bytes (bits 0-2 = 111)
 */
export const PICCDATA_TAG_BOLTCARD: number = 0xc7

/**
 * SV2 prefix constant for SunMAC calculation per NXP AN12196
 * SV2 = 3Ch||C3h||00h||01h||00h||80h||UID||SDMReadCtr
 *
 * References:
 * - NXP AN12196 Application Note
 * - boltcard/boltcard-wallet: class/Ntag424.js
 * - lnbits/boltcards: nxp424.py get_sun_mac()
 */
const SV2_PREFIX: Buffer = Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80])

// =============================================================================
// AES-CMAC IMPLEMENTATION (RFC 4493 / NIST 800-38B)
// =============================================================================

/**
 * Generate CMAC subkey by left-shifting and conditional XOR with Rb
 * @param key - Input key (16 bytes)
 * @returns Subkey (16 bytes)
 */
export function generateSubkey(key: Buffer): Buffer {
  const subkey = Buffer.alloc(16)
  let carry = 0

  for (let i = 15; i >= 0; i--) {
    const newCarry = (key[i] & 0x80) >> 7
    subkey[i] = ((key[i] << 1) | carry) & 0xff
    carry = newCarry
  }

  // XOR with Rb (0x87) if MSB was 1
  if (key[0] & 0x80) {
    subkey[15] ^= 0x87
  }

  return subkey
}

/**
 * Calculate AES-CMAC (RFC 4493)
 *
 * @param key - AES-128 key (16 bytes)
 * @param message - Message to authenticate
 * @returns 16-byte CMAC
 */
export function calculateCMAC(key: Buffer, message: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null)
  cipher.setAutoPadding(false)

  // Step 1: Generate subkeys
  const zero = Buffer.alloc(16, 0)
  const L = cipher.update(zero)
  const K1 = generateSubkey(L)
  const K2 = generateSubkey(K1)

  // Step 2: Determine number of blocks
  const blocks = Math.ceil(message.length / 16) || 1
  const lastBlockComplete = message.length > 0 && message.length % 16 === 0

  // Step 3: Prepare last block
  let lastBlock: Buffer
  if (lastBlockComplete) {
    lastBlock = Buffer.alloc(16)
    message.copy(lastBlock, 0, (blocks - 1) * 16)
    for (let i = 0; i < 16; i++) {
      lastBlock[i] ^= K1[i]
    }
  } else {
    // Pad with 10*
    lastBlock = Buffer.alloc(16, 0)
    const start = (blocks - 1) * 16
    const remaining = message.length - start
    for (let i = 0; i < remaining; i++) {
      lastBlock[i] = message[start + i]
    }
    lastBlock[remaining] = 0x80
    for (let i = 0; i < 16; i++) {
      lastBlock[i] ^= K2[i]
    }
  }

  // Step 4: CBC-MAC over all blocks
  let X: Buffer = Buffer.alloc(16, 0)
  for (let i = 0; i < blocks - 1; i++) {
    const block = message.slice(i * 16, (i + 1) * 16)
    for (let j = 0; j < 16; j++) {
      X[j] ^= block[j]
    }
    const blockCipher = crypto.createCipheriv("aes-128-ecb", key, null)
    blockCipher.setAutoPadding(false)
    X = blockCipher.update(X)
  }

  // Process last block
  for (let i = 0; i < 16; i++) {
    X[i] ^= lastBlock[i]
  }
  const finalCipher = crypto.createCipheriv("aes-128-ecb", key, null)
  finalCipher.setAutoPadding(false)
  return finalCipher.update(X)
}

/**
 * AES-CMAC as a PRF (Pseudo-Random Function)
 * Used for deterministic key derivation per spec
 *
 * @param key - AES-128 key (16 bytes)
 * @param message - Input data
 * @returns 16-byte derived key
 */
export function cmacPRF(key: Buffer, message: Buffer): Buffer {
  return calculateCMAC(key, message)
}

// =============================================================================
// SPEC-COMPLIANT KEY DERIVATION (per DETERMINISTIC.md)
// =============================================================================

/**
 * Generate a random IssuerKey (one per user/service)
 * @returns 32 hex character issuer key
 */
export function generateIssuerKey(): string {
  return crypto.randomBytes(16).toString("hex")
}

/**
 * Derive the shared encryption key K1 from IssuerKey
 * K1 = PRF(IssuerKey, '2d003f77')
 *
 * NOTE: K1 is SHARED across all cards for an issuer to enable efficient lookup
 *
 * @param issuerKeyHex - IssuerKey (32 hex chars = 16 bytes)
 * @returns K1 encryption key (32 hex chars)
 */
export function deriveEncryptionKey(issuerKeyHex: string): string {
  if (!/^[0-9a-fA-F]{32}$/.test(issuerKeyHex)) {
    throw new Error("IssuerKey must be 32 hex characters (16 bytes)")
  }

  const issuerKey = Buffer.from(issuerKeyHex, "hex")
  const k1 = cmacPRF(issuerKey, DerivationConstants.K1_ENCRYPTION)
  return k1.toString("hex")
}

/**
 * Derive CardKey from IssuerKey + UID + Version
 * CardKey = PRF(IssuerKey, '2d003f75' || UID || Version)
 *
 * @param issuerKeyHex - IssuerKey (32 hex chars)
 * @param uidHex - Card UID (14 hex chars = 7 bytes)
 * @param version - Key version (incremented on re-program)
 * @returns CardKey (32 hex chars)
 */
export function deriveCardKey(
  issuerKeyHex: string,
  uidHex: string,
  version: number,
): string {
  if (!/^[0-9a-fA-F]{32}$/.test(issuerKeyHex)) {
    throw new Error("IssuerKey must be 32 hex characters (16 bytes)")
  }
  if (!/^[0-9a-fA-F]{14}$/.test(uidHex)) {
    throw new Error("UID must be 14 hex characters (7 bytes)")
  }
  if (typeof version !== "number" || version < 0) {
    throw new Error("Version must be a non-negative integer")
  }

  const issuerKey = Buffer.from(issuerKeyHex, "hex")
  const uid = Buffer.from(uidHex, "hex")

  // Version as 4 bytes little-endian
  const versionBuf = Buffer.alloc(4)
  versionBuf.writeUInt32LE(version, 0)

  const message = Buffer.concat([DerivationConstants.CARD_KEY, uid, versionBuf])

  const cardKey = cmacPRF(issuerKey, message)
  return cardKey.toString("hex")
}

/**
 * Derive privacy-preserving card ID from IssuerKey + UID
 * ID = PRF(IssuerKey, '2d003f7b' || UID)
 *
 * This ID is stored in the database instead of the raw UID for privacy
 *
 * @param issuerKeyHex - IssuerKey (32 hex chars)
 * @param uidHex - Card UID (14 hex chars)
 * @returns Card ID hash (32 hex chars)
 */
export function deriveCardIdHash(issuerKeyHex: string, uidHex: string): string {
  if (!/^[0-9a-fA-F]{32}$/.test(issuerKeyHex)) {
    throw new Error("IssuerKey must be 32 hex characters (16 bytes)")
  }
  if (!/^[0-9a-fA-F]{14}$/.test(uidHex)) {
    throw new Error("UID must be 14 hex characters (7 bytes)")
  }

  const issuerKey = Buffer.from(issuerKeyHex, "hex")
  const uid = Buffer.from(uidHex, "hex")

  const message = Buffer.concat([DerivationConstants.CARD_ID, uid])

  const cardId = cmacPRF(issuerKey, message)
  return cardId.toString("hex")
}

/**
 * Derive all card keys (K0-K4) per spec
 *
 * Per DETERMINISTIC.md:
 * - K0 = PRF(CardKey, '2d003f76')
 * - K1 = PRF(IssuerKey, '2d003f77')  <- SHARED across all cards
 * - K2 = PRF(CardKey, '2d003f78')
 * - K3 = PRF(CardKey, '2d003f79')
 * - K4 = PRF(CardKey, '2d003f7a')
 *
 * @param issuerKeyHex - IssuerKey (32 hex chars)
 * @param uidHex - Card UID (14 hex chars)
 * @param version - Key version (default: 1)
 * @returns { k0, k1, k2, k3, k4, cardKey, cardIdHash } (each 32 hex chars)
 */
export function deriveAllKeys(
  issuerKeyHex: string,
  uidHex: string,
  version: number = 1,
): DerivedCardKeys {
  if (!/^[0-9a-fA-F]{32}$/.test(issuerKeyHex)) {
    throw new Error("IssuerKey must be 32 hex characters (16 bytes)")
  }
  if (!/^[0-9a-fA-F]{14}$/.test(uidHex)) {
    throw new Error("UID must be 14 hex characters (7 bytes)")
  }

  const issuerKey = Buffer.from(issuerKeyHex, "hex")

  // Derive CardKey first
  const cardKeyHex = deriveCardKey(issuerKeyHex, uidHex, version)
  const cardKey = Buffer.from(cardKeyHex, "hex")

  // K0 = PRF(CardKey, '2d003f76')
  const k0 = cmacPRF(cardKey, DerivationConstants.K0_APP_MASTER)

  // K1 = PRF(IssuerKey, '2d003f77') - SHARED
  const k1 = cmacPRF(issuerKey, DerivationConstants.K1_ENCRYPTION)

  // K2 = PRF(CardKey, '2d003f78')
  const k2 = cmacPRF(cardKey, DerivationConstants.K2_AUTH)

  // K3 = PRF(CardKey, '2d003f79')
  const k3 = cmacPRF(cardKey, DerivationConstants.K3_RESERVED)

  // K4 = PRF(CardKey, '2d003f7a')
  const k4 = cmacPRF(cardKey, DerivationConstants.K4_RESERVED)

  // Privacy-preserving ID
  const cardIdHash = deriveCardIdHash(issuerKeyHex, uidHex)

  return {
    k0: k0.toString("hex"),
    k1: k1.toString("hex"),
    k2: k2.toString("hex"),
    k3: k3.toString("hex"),
    k4: k4.toString("hex"),
    cardKey: cardKeyHex,
    cardIdHash,
  }
}

/**
 * Validate key derivation against spec test vectors
 *
 * Test vectors from DETERMINISTIC.md:
 * - UID: 04a39493cc8680
 * - IssuerKey: 00000000000000000000000000000001
 * - Version: 1
 *
 * Expected:
 * - K0: a29119fcb48e737d1591d3489557e49b
 * - K1: 55da174c9608993dc27bb3f30a4a7314
 * - K2: f4b404be700ab285e333e32348fa3d3b
 * - K3: 73610ba4afe45b55319691cb9489142f
 * - K4: addd03e52964369be7f2967736b7bdb5
 * - ID: e07ce1279d980ecb892a81924b67bf18
 * - CardKey: ebff5a4e6da5ee14cbfe720ae06fbed9
 *
 * @returns True if all test vectors pass
 */
export function validateTestVectors(): boolean {
  const testUid = "04a39493cc8680"
  const testIssuerKey = "00000000000000000000000000000001"
  const testVersion = 1

  const expected: Record<string, string> = {
    k0: "a29119fcb48e737d1591d3489557e49b",
    k1: "55da174c9608993dc27bb3f30a4a7314",
    k2: "f4b404be700ab285e333e32348fa3d3b",
    k3: "73610ba4afe45b55319691cb9489142f",
    k4: "addd03e52964369be7f2967736b7bdb5",
    cardIdHash: "e07ce1279d980ecb892a81924b67bf18",
    cardKey: "ebff5a4e6da5ee14cbfe720ae06fbed9",
  }

  const derived: DerivedCardKeys = deriveAllKeys(testIssuerKey, testUid, testVersion)

  const failures: string[] = []
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (derived[key as keyof DerivedCardKeys] !== expectedValue) {
      failures.push(
        `${key}: expected ${expectedValue}, got ${derived[key as keyof DerivedCardKeys]}`,
      )
    }
  }

  if (failures.length > 0) {
    console.error("[BoltcardCrypto] Test vector failures:", failures)
    return false
  }

  console.log("[BoltcardCrypto] All test vectors passed")
  return true
}

// =============================================================================
// LEGACY KEY DERIVATION (deprecated, kept for reference)
// =============================================================================

/**
 * @deprecated Use deriveAllKeys() instead
 * Legacy key derivation using HMAC-SHA256 (non-spec-compliant)
 */
export function deriveCardKeysLegacy(masterKey: string, cardUid: string): LegacyCardKeys {
  console.warn(
    "[BoltcardCrypto] deriveCardKeysLegacy is deprecated, use deriveAllKeys instead",
  )

  if (!/^[0-9a-fA-F]{32}$/.test(masterKey)) {
    throw new Error("Master key must be 32 hex characters (16 bytes)")
  }
  if (!/^[0-9a-fA-F]{14}$/.test(cardUid)) {
    throw new Error("Card UID must be 14 hex characters (7 bytes)")
  }

  const masterKeyBuf = Buffer.from(masterKey, "hex")
  const cardUidBuf = Buffer.from(cardUid, "hex")

  const keys: Record<string, string> = {}
  const keyNames = ["k0", "k1", "k2", "k3", "k4"]

  for (let i = 0; i < keyNames.length; i++) {
    const purpose = `boltcard-${keyNames[i]}`
    const hmac = crypto.createHmac("sha256", masterKeyBuf)
    hmac.update(Buffer.concat([Buffer.from(purpose), cardUidBuf, Buffer.from([i])]))
    const derivedKey = hmac.digest().slice(0, 16)
    keys[keyNames[i]] = derivedKey.toString("hex")
  }

  return keys as unknown as LegacyCardKeys
}

/**
 * @deprecated Use generateIssuerKey() instead
 */
export function generateMasterKey(): string {
  return generateIssuerKey()
}

/**
 * Generate random card keys (for testing only)
 * @returns Object with k0, k1, k2, k3, k4 (each 32 hex chars)
 */
export function generateRandomKeys(): CardKeys {
  return {
    k0: crypto.randomBytes(16).toString("hex"),
    k1: crypto.randomBytes(16).toString("hex"),
    k2: crypto.randomBytes(16).toString("hex"),
    k3: crypto.randomBytes(16).toString("hex"),
    k4: crypto.randomBytes(16).toString("hex"),
  }
}

// =============================================================================
// PICCDATA DECRYPTION (corrected per spec)
// =============================================================================

/**
 * Decrypt PICCData from LNURL-withdraw request
 *
 * PICCData structure per BTCPayServer.NTag424/PICCData.cs:
 * - Byte 0: Tag byte (0xc7 for Boltcard = has UID + has counter + 7-byte UID)
 * - Bytes 1-7: Card UID (7 bytes)
 * - Bytes 8-10: Counter (3 bytes, little-endian)
 * - Bytes 11-15: Reserved/padding
 *
 * @param piccDataHex - Encrypted PICCData (32 hex chars = 16 bytes)
 * @param k1Hex - Encryption key K1 (32 hex chars)
 * @returns { cardUid, counter, raw } or null if decryption fails
 */
export function decryptPICCData(
  piccDataHex: string,
  k1Hex: string,
): PICCDataResult | null {
  try {
    if (!/^[0-9a-fA-F]{32}$/.test(piccDataHex)) {
      throw new Error("PICCData must be 32 hex characters (16 bytes)")
    }

    if (!/^[0-9a-fA-F]{32}$/.test(k1Hex)) {
      throw new Error("K1 must be 32 hex characters (16 bytes)")
    }

    const piccData = Buffer.from(piccDataHex, "hex")
    const k1 = Buffer.from(k1Hex, "hex")

    // NTAG424DNA uses AES-128-CBC with zero IV
    const iv = Buffer.alloc(16, 0)

    const decipher = crypto.createDecipheriv("aes-128-cbc", k1, iv)
    decipher.setAutoPadding(false)

    const decrypted = Buffer.concat([decipher.update(piccData), decipher.final()])

    // Validate tag byte (must be 0xc7 for Boltcard format)
    const tagByte = decrypted[0]
    if (tagByte !== PICCDATA_TAG_BOLTCARD) {
      throw new Error(
        `Invalid PICCData tag byte: 0x${tagByte.toString(16)} (expected 0xc7)`,
      )
    }

    // Extract UID (bytes 1-7, 7 bytes)
    const cardUid = decrypted.slice(1, 8).toString("hex")

    // Extract counter (bytes 8-10, 3 bytes little-endian)
    const counter = decrypted[8] | (decrypted[9] << 8) | (decrypted[10] << 16)

    return {
      cardUid,
      counter,
      raw: decrypted.toString("hex"),
    }
  } catch (err: unknown) {
    console.error("[BoltcardCrypto] decryptPICCData error:", (err as Error).message)
    return null
  }
}

/**
 * Try to decrypt PICCData using an IssuerKey
 * Derives K1 from IssuerKey and attempts decryption
 *
 * @param piccDataHex - Encrypted PICCData (32 hex chars)
 * @param issuerKeyHex - IssuerKey (32 hex chars)
 * @returns { cardUid, counter, raw } or null if decryption fails
 */
export function tryDecryptWithIssuerKey(
  piccDataHex: string,
  issuerKeyHex: string,
): PICCDataResult | null {
  const k1 = deriveEncryptionKey(issuerKeyHex)
  return decryptPICCData(piccDataHex, k1)
}

// =============================================================================
// SUNMAC VERIFICATION (per NXP AN12196)
// =============================================================================

/**
 * Verify SunMAC from LNURL-withdraw request
 *
 * SunMAC calculation per NXP AN12196:
 * 1. Build SV2 = 3CC300010080 || UID (7 bytes) || SDMReadCtr (3 bytes LE)
 * 2. Derive session MAC key: SesSdmFileReadMACKey = CMAC(K2, SV2)
 * 3. Calculate MAC with empty message: FullMAC = CMAC(SesSdmFileReadMACKey, "")
 * 4. Truncate: Take bytes at odd indices (1, 3, 5, 7, 9, 11, 13, 15)
 *
 * References:
 * - boltcard/boltcard-wallet: class/Ntag424.js testPAndC()
 * - lnbits/boltcards: nxp424.py get_sun_mac()
 * - NXP AN12196 Application Note
 *
 * @param piccDataHex - Encrypted PICCData (32 hex chars) - kept for API compatibility
 * @param sunMacHex - SunMAC from request (16 hex chars = 8 bytes truncated)
 * @param k2Hex - Authentication key K2 (32 hex chars)
 * @param uidHex - Card UID (14 hex chars = 7 bytes) - from decrypted PICCData
 * @param counter - SDM read counter (integer) - from decrypted PICCData
 * @returns True if MAC is valid
 */
export function verifySunMAC(
  piccDataHex: string,
  sunMacHex: string,
  k2Hex: string,
  uidHex: string,
  counter: number,
): boolean {
  try {
    if (!/^[0-9a-fA-F]{16}$/.test(sunMacHex)) {
      throw new Error("SunMAC must be 16 hex characters (8 bytes)")
    }

    if (!/^[0-9a-fA-F]{32}$/.test(k2Hex)) {
      throw new Error("K2 must be 32 hex characters")
    }

    if (!/^[0-9a-fA-F]{14}$/.test(uidHex)) {
      throw new Error("UID must be 14 hex characters (7 bytes)")
    }

    if (typeof counter !== "number" || counter < 0) {
      throw new Error("Counter must be a non-negative integer")
    }

    const sunMac = Buffer.from(sunMacHex, "hex")
    const k2 = Buffer.from(k2Hex, "hex")
    const uid = Buffer.from(uidHex, "hex")

    // Counter as 3 bytes little-endian (SDMReadCtr)
    const counterBuf = Buffer.alloc(3)
    counterBuf[0] = counter & 0xff
    counterBuf[1] = (counter >> 8) & 0xff
    counterBuf[2] = (counter >> 16) & 0xff

    // Step 1: Build SV2 = 3CC300010080 || UID || SDMReadCtr
    const sv2 = Buffer.concat([SV2_PREFIX, uid, counterBuf])

    // No logging of SV2, MACs or key material here (blink-wip#1590): this
    // runs on every tap, and on a tampered tap the expected MAC is exactly
    // what a log reader would need to forge a valid one.

    // Step 2: Derive session MAC key: SesSdmFileReadMACKey = CMAC(K2, SV2)
    const sessionKey = calculateCMAC(k2, sv2)

    // Step 3: Calculate MAC with empty message
    const fullMac = calculateCMAC(sessionKey, Buffer.alloc(0))

    // Step 4: Truncate - take bytes at odd indices (1, 3, 5, 7, 9, 11, 13, 15)
    // This is the "every other byte starting from index 1" pattern
    const expectedMac = Buffer.from([
      fullMac[1],
      fullMac[3],
      fullMac[5],
      fullMac[7],
      fullMac[9],
      fullMac[11],
      fullMac[13],
      fullMac[15],
    ])

    // Constant-time comparison
    return crypto.timingSafeEqual(sunMac, expectedMac)
  } catch (err: unknown) {
    console.error("[BoltcardCrypto] verifySunMAC error:", (err as Error).message)
    return false
  }
}

/**
 * Parse and verify a full LNURL-withdraw tap
 *
 * IMPORTANT: Per NXP spec, we must decrypt PICCData FIRST to get UID and counter,
 * then verify SunMAC using those values.
 *
 * @param piccDataHex - 'p' parameter from URL
 * @param sunMacHex - 'c' parameter from URL
 * @param k1Hex - Encryption key
 * @param k2Hex - Authentication key
 * @param expectedCardUid - Expected card UID (optional)
 * @param lastCounter - Last seen counter for replay protection
 * @returns { valid, cardUid, counter, error }
 */
export function verifyCardTap(
  piccDataHex: string,
  sunMacHex: string,
  k1Hex: string,
  k2Hex: string,
  expectedCardUid: string | null = null,
  lastCounter: number = 0,
): CardTapResult {
  // Step 1: Decrypt PICCData FIRST to get UID and counter
  // (We need these for SunMAC verification per NXP AN12196)
  const piccResult = decryptPICCData(piccDataHex, k1Hex)
  if (!piccResult) {
    return { valid: false, error: "Failed to decrypt PICCData" }
  }

  // The UID is what SUN encryption hides from passive readers: don't log it.
  console.log("[BoltcardCrypto] verifyCardTap - PICCData decrypted:", {
    counter: piccResult.counter,
  })

  // Step 2: Verify SunMAC using decrypted UID and counter
  if (
    !verifySunMAC(piccDataHex, sunMacHex, k2Hex, piccResult.cardUid, piccResult.counter)
  ) {
    return { valid: false, error: "Invalid SunMAC - card authentication failed" }
  }

  // Step 3: Verify card UID if expected
  if (
    expectedCardUid &&
    piccResult.cardUid.toLowerCase() !== expectedCardUid.toLowerCase()
  ) {
    return { valid: false, error: "Card UID mismatch" }
  }

  // Step 4: Verify counter (replay protection)
  if (piccResult.counter <= lastCounter) {
    return {
      valid: false,
      error: `Counter replay detected: ${piccResult.counter} <= ${lastCounter}`,
      cardUid: piccResult.cardUid,
      counter: piccResult.counter,
    }
  }

  return {
    valid: true,
    cardUid: piccResult.cardUid,
    counter: piccResult.counter,
  }
}

// =============================================================================
// DEEPLINK AND QR CODE GENERATION (per DEEPLINK.md)
// =============================================================================

/**
 * Generate a deeplink URL for programming a card via NFC Programmer app
 * Format: boltcard://program?url={encoded-keys-request-url}
 *
 * @param keysRequestUrl - URL that the app will POST to with UID
 * @returns Deeplink URL
 */
export function generateProgramDeeplink(keysRequestUrl: string): string {
  const encodedUrl = encodeURIComponent(keysRequestUrl)
  return `boltcard://program?url=${encodedUrl}`
}

/**
 * Generate a deeplink URL for resetting a card via NFC Programmer app
 * Format: boltcard://reset?url={encoded-keys-request-url}
 *
 * @param keysRequestUrl - URL that the app will POST to with LNURLW
 * @returns Deeplink URL
 */
export function generateResetDeeplink(keysRequestUrl: string): string {
  const encodedUrl = encodeURIComponent(keysRequestUrl)
  return `boltcard://reset?url=${encodedUrl}`
}

/**
 * Generate the keys response for NFC Programmer app
 * This is the response format expected by the app after POSTing UID
 *
 * The NFC Programmer app expects the format used by the mock server:
 * https://bolt-card-mock-server.vercel.app/api/create
 *
 * @param lnurlwUrl - LNURL-withdraw URL to program into card (https:// format)
 * @param keys - Object with k0, k1, k2, k3, k4
 * @param cardName - Optional name for the card
 * @returns Response object for NFC Programmer app
 */
export function generateKeysResponse(
  lnurlwUrl: string,
  keys: CardKeys,
  _cardName: string = "Boltcard",
): KeysResponse {
  // Convert https:// URL to lnurlw:// format
  // The card stores this as the base URL and appends ?p=...&c=... when tapped
  const lnurlwBase = lnurlwUrl.replace(/^https?:\/\//, "lnurlw://")

  // Per DEEPLINK.md spec, the response format uses UPPERCASE key names
  // See: https://github.com/boltcard/boltcard/blob/main/docs/DEEPLINK.md
  return {
    LNURLW: lnurlwBase,
    K0: keys.k0.toUpperCase(),
    K1: keys.k1.toUpperCase(),
    K2: keys.k2.toUpperCase(),
    K3: keys.k3.toUpperCase(),
    K4: keys.k4.toUpperCase(),
  }
}

/**
 * Generate a callback URL with card keys for the NFC programmer app (legacy format)
 *
 * @param callbackUrl - Base callback URL for LNURL-withdraw
 * @param keys - Object with k0, k1, k2, k3, k4
 * @returns Programming URL
 * @deprecated Use generateProgramDeeplink instead
 */
export function generateProgrammingUrl(callbackUrl: string, keys: CardKeys): string {
  const url = new URL(callbackUrl)

  url.searchParams.set("k0", keys.k0)
  url.searchParams.set("k1", keys.k1)
  url.searchParams.set("k2", keys.k2)
  if (keys.k3) url.searchParams.set("k3", keys.k3)
  if (keys.k4) url.searchParams.set("k4", keys.k4)

  return url.toString().replace(/^https?:/, "lnurlw:")
}

/**
 * Generate registration data for card programming
 * Returns both the deeplink (for mobile) and QR payload (for scanning)
 *
 * @param serverUrl - BlinkPOS server URL
 * @param cardId - Card ID from database (or placeholder for dynamic flow)
 * @returns { deeplink, keysRequestUrl, qrPayload }
 */
export function generateRegistrationData(
  serverUrl: string,
  cardId: string,
): RegistrationData {
  const keysRequestUrl = `${serverUrl}/api/boltcard/keys/${cardId}`
  const deeplink = generateProgramDeeplink(keysRequestUrl)

  return {
    deeplink,
    keysRequestUrl,
    // QR code should contain the deeplink
    qrPayload: deeplink,
  }
}

/**
 * @deprecated Use generateRegistrationData instead
 */
export function generateRegistrationQR(
  serverUrl: string,
  cardId: string,
  keys: CardKeys,
): string {
  const callback = `${serverUrl}/api/boltcard/lnurlw/${cardId}`

  return JSON.stringify({
    protocol: "boltcard",
    version: 1,
    action: "program",
    callback: callback,
    k0: keys.k0,
    k1: keys.k1,
    k2: keys.k2,
    k3: keys.k3 || null,
    k4: keys.k4 || null,
  })
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Parse the UID from a raw NFC read
 * NTAG424DNA UID is 7 bytes
 *
 * @param rawUid - Raw UID bytes or hex string
 * @returns Normalized 14-character hex UID (lowercase)
 */
export function parseCardUid(rawUid: Buffer | string): string {
  let uid: string

  if (Buffer.isBuffer(rawUid)) {
    uid = rawUid.toString("hex")
  } else if (typeof rawUid === "string") {
    // Remove any colons, spaces, or dashes
    uid = rawUid.replace(/[:\s-]/g, "")
  } else {
    throw new Error("Invalid UID format")
  }

  if (uid.length !== 14) {
    throw new Error(`Invalid UID length: expected 14 hex chars, got ${uid.length}`)
  }

  return uid.toLowerCase()
}

/**
 * Extract p and c parameters from an LNURL-withdraw URL
 *
 * @param url - LNURL-withdraw URL
 * @returns { p, c } or null if not found
 */
export function extractPandC(url: string): PandCParams | null {
  try {
    const urlObj = new URL(url.replace(/^lnurlw:/, "https:"))
    const p = urlObj.searchParams.get("p")
    const c = urlObj.searchParams.get("c")

    if (!p || !c) {
      return null
    }

    // Validate format
    if (!/^[0-9a-fA-F]{32}$/.test(p)) {
      return null
    }
    if (!/^[0-9a-fA-F]{16}$/.test(c)) {
      return null
    }

    return { p, c }
  } catch (_err: unknown) {
    return null
  }
}

// =============================================================================
// LEGACY ALIAS EXPORT
// =============================================================================

/** @deprecated Use deriveAllKeys instead */
export const deriveCardKeys = deriveCardKeysLegacy
