/**
 * Boltcard Crypto Unit Tests
 *
 * Tests for NTAG424DNA cryptographic operations including:
 * - AES-CMAC calculation
 * - Key derivation per DETERMINISTIC.md spec
 * - SunMAC verification per NXP AN12196
 * - PICCData decryption
 */

import crypto from "crypto"

import * as boltcardCrypto from "../../lib/boltcard/crypto"

describe("Boltcard Crypto", () => {
  // Test vectors from DETERMINISTIC.md
  const TEST_VECTORS = {
    uid: "04a39493cc8680",
    issuerKey: "00000000000000000000000000000001",
    version: 1,
    expected: {
      k0: "a29119fcb48e737d1591d3489557e49b",
      k1: "55da174c9608993dc27bb3f30a4a7314",
      k2: "f4b404be700ab285e333e32348fa3d3b",
      k3: "73610ba4afe45b55319691cb9489142f",
      k4: "addd03e52964369be7f2967736b7bdb5",
      cardIdHash: "e07ce1279d980ecb892a81924b67bf18",
      cardKey: "ebff5a4e6da5ee14cbfe720ae06fbed9",
    },
  }

  describe("calculateCMAC", () => {
    it("should calculate correct CMAC for empty message", () => {
      // RFC 4493 test vector for AES-128-CMAC with zero key and empty message
      const key = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex")
      const message = Buffer.alloc(0)

      const cmac = boltcardCrypto.calculateCMAC(key, message)

      // Expected from RFC 4493
      expect(cmac.toString("hex")).toBe("bb1d6929e95937287fa37d129b756746")
    })

    it("should calculate correct CMAC for 16-byte message", () => {
      const key = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex")
      const message = Buffer.from("6bc1bee22e409f96e93d7e117393172a", "hex")

      const cmac = boltcardCrypto.calculateCMAC(key, message)

      // Expected from RFC 4493
      expect(cmac.toString("hex")).toBe("070a16b46b4d4144f79bdd9dd04a287c")
    })
  })

  describe("Key Derivation (DETERMINISTIC.md spec)", () => {
    it("should derive correct CardKey", () => {
      const cardKey = boltcardCrypto.deriveCardKey(
        TEST_VECTORS.issuerKey,
        TEST_VECTORS.uid,
        TEST_VECTORS.version,
      )

      expect(cardKey).toBe(TEST_VECTORS.expected.cardKey)
    })

    it("should derive correct K1 (encryption key) from IssuerKey", () => {
      const k1 = boltcardCrypto.deriveEncryptionKey(TEST_VECTORS.issuerKey)

      expect(k1).toBe(TEST_VECTORS.expected.k1)
    })

    it("should derive all keys correctly", () => {
      const keys = boltcardCrypto.deriveAllKeys(
        TEST_VECTORS.issuerKey,
        TEST_VECTORS.uid,
        TEST_VECTORS.version,
      )

      expect(keys.k0).toBe(TEST_VECTORS.expected.k0)
      expect(keys.k1).toBe(TEST_VECTORS.expected.k1)
      expect(keys.k2).toBe(TEST_VECTORS.expected.k2)
      expect(keys.k3).toBe(TEST_VECTORS.expected.k3)
      expect(keys.k4).toBe(TEST_VECTORS.expected.k4)
      expect(keys.cardKey).toBe(TEST_VECTORS.expected.cardKey)
      expect(keys.cardIdHash).toBe(TEST_VECTORS.expected.cardIdHash)
    })

    it("should pass built-in test vector validation", () => {
      const result = boltcardCrypto.validateTestVectors()
      expect(result).toBe(true)
    })
  })

  describe("PICCData Decryption", () => {
    it("should decrypt valid PICCData with correct K1", () => {
      // Create a test PICCData: tag 0xc7 + UID + counter + padding
      const uid = Buffer.from(TEST_VECTORS.uid, "hex")
      const counter = 42 // Test counter value

      // Build plaintext PICCData
      const plaintext = Buffer.alloc(16)
      plaintext[0] = 0xc7 // Tag byte
      uid.copy(plaintext, 1) // UID at bytes 1-7
      plaintext[8] = counter & 0xff // Counter byte 0 (LE)
      plaintext[9] = (counter >> 8) & 0xff // Counter byte 1
      plaintext[10] = (counter >> 16) & 0xff // Counter byte 2

      // Encrypt with K1
      const k1 = Buffer.from(TEST_VECTORS.expected.k1, "hex")
      const iv = Buffer.alloc(16, 0)
      const cipher = crypto.createCipheriv("aes-128-cbc", k1, iv)
      cipher.setAutoPadding(false)
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])

      // Decrypt using our function
      const result = boltcardCrypto.decryptPICCData(
        encrypted.toString("hex"),
        TEST_VECTORS.expected.k1,
      )

      expect(result).not.toBeNull()
      expect(result!.cardUid).toBe(TEST_VECTORS.uid)
      expect(result!.counter).toBe(counter)
    })

    it("should reject PICCData with wrong tag byte", () => {
      // Create PICCData with wrong tag
      const plaintext = Buffer.alloc(16)
      plaintext[0] = 0x00 // Wrong tag

      const k1 = Buffer.from(TEST_VECTORS.expected.k1, "hex")
      const iv = Buffer.alloc(16, 0)
      const cipher = crypto.createCipheriv("aes-128-cbc", k1, iv)
      cipher.setAutoPadding(false)
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])

      const result = boltcardCrypto.decryptPICCData(
        encrypted.toString("hex"),
        TEST_VECTORS.expected.k1,
      )

      expect(result).toBeNull()
    })
  })

  describe("SunMAC Verification (NXP AN12196)", () => {
    /**
     * SunMAC Algorithm per NXP AN12196:
     * 1. SV2 = 3CC300010080 || UID (7 bytes) || SDMReadCtr (3 bytes LE)
     * 2. SesSdmFileReadMACKey = CMAC(K2, SV2)
     * 3. FullMAC = CMAC(SesSdmFileReadMACKey, "")
     * 4. SunMAC = FullMAC[1,3,5,7,9,11,13,15] (odd-indexed bytes)
     */

    it("should calculate correct SunMAC using SV2-based algorithm", () => {
      const uid = TEST_VECTORS.uid
      const k2 = TEST_VECTORS.expected.k2
      const counter = 1 // Simple counter for testing

      // Manually calculate expected SunMAC using the correct algorithm
      const sv2Prefix = Buffer.from("3cc300010080", "hex")
      const uidBuf = Buffer.from(uid, "hex")
      const counterBuf = Buffer.alloc(3)
      counterBuf[0] = counter & 0xff
      counterBuf[1] = (counter >> 8) & 0xff
      counterBuf[2] = (counter >> 16) & 0xff

      const sv2 = Buffer.concat([sv2Prefix, uidBuf, counterBuf])

      // Step 2: Derive session key
      const sessionKey = boltcardCrypto.calculateCMAC(Buffer.from(k2, "hex"), sv2)

      // Step 3: CMAC with empty message
      const fullMac = boltcardCrypto.calculateCMAC(sessionKey, Buffer.alloc(0))

      // Step 4: Take odd-indexed bytes
      const expectedSunMac = Buffer.from([
        fullMac[1],
        fullMac[3],
        fullMac[5],
        fullMac[7],
        fullMac[9],
        fullMac[11],
        fullMac[13],
        fullMac[15],
      ])

      // Now verify using our function
      // We need a dummy piccDataHex (not used in new algorithm, but required for signature)
      const dummyPiccData = "00000000000000000000000000000000"

      const isValid = boltcardCrypto.verifySunMAC(
        dummyPiccData,
        expectedSunMac.toString("hex"),
        k2,
        uid,
        counter,
      )

      expect(isValid).toBe(true)
    })

    it("should reject incorrect SunMAC", () => {
      const uid = TEST_VECTORS.uid
      const k2 = TEST_VECTORS.expected.k2
      const counter = 1
      const dummyPiccData = "00000000000000000000000000000000"
      const wrongMac = "deadbeefdeadbeef" // Wrong MAC

      const isValid = boltcardCrypto.verifySunMAC(
        dummyPiccData,
        wrongMac,
        k2,
        uid,
        counter,
      )

      expect(isValid).toBe(false)
    })

    it("should reject SunMAC with wrong counter", () => {
      const uid = TEST_VECTORS.uid
      const k2 = TEST_VECTORS.expected.k2
      const correctCounter = 1
      const wrongCounter = 2

      // Calculate MAC for correct counter
      const sv2Prefix = Buffer.from("3cc300010080", "hex")
      const uidBuf = Buffer.from(uid, "hex")
      const counterBuf = Buffer.alloc(3)
      counterBuf[0] = correctCounter & 0xff

      const sv2 = Buffer.concat([sv2Prefix, uidBuf, counterBuf])
      const sessionKey = boltcardCrypto.calculateCMAC(Buffer.from(k2, "hex"), sv2)
      const fullMac = boltcardCrypto.calculateCMAC(sessionKey, Buffer.alloc(0))
      const sunMac = Buffer.from([
        fullMac[1],
        fullMac[3],
        fullMac[5],
        fullMac[7],
        fullMac[9],
        fullMac[11],
        fullMac[13],
        fullMac[15],
      ])

      // Verify with wrong counter - should fail
      const dummyPiccData = "00000000000000000000000000000000"
      const isValid = boltcardCrypto.verifySunMAC(
        dummyPiccData,
        sunMac.toString("hex"),
        k2,
        uid,
        wrongCounter, // Using wrong counter
      )

      expect(isValid).toBe(false)
    })
  })

  describe("verifyCardTap (Integration)", () => {
    it("should verify a complete valid card tap", () => {
      const uid = TEST_VECTORS.uid
      const counter = 100
      const keys = boltcardCrypto.deriveAllKeys(
        TEST_VECTORS.issuerKey,
        uid,
        TEST_VECTORS.version,
      )

      // Build and encrypt PICCData
      const plaintext = Buffer.alloc(16)
      plaintext[0] = 0xc7
      Buffer.from(uid, "hex").copy(plaintext, 1)
      plaintext[8] = counter & 0xff
      plaintext[9] = (counter >> 8) & 0xff
      plaintext[10] = (counter >> 16) & 0xff

      const k1 = Buffer.from(keys.k1, "hex")
      const iv = Buffer.alloc(16, 0)
      const cipher = crypto.createCipheriv("aes-128-cbc", k1, iv)
      cipher.setAutoPadding(false)
      const piccData = Buffer.concat([cipher.update(plaintext), cipher.final()])

      // Calculate correct SunMAC
      const sv2 = Buffer.concat([
        Buffer.from("3cc300010080", "hex"),
        Buffer.from(uid, "hex"),
        Buffer.from([counter & 0xff, (counter >> 8) & 0xff, (counter >> 16) & 0xff]),
      ])
      const sessionKey = boltcardCrypto.calculateCMAC(Buffer.from(keys.k2, "hex"), sv2)
      const fullMac = boltcardCrypto.calculateCMAC(sessionKey, Buffer.alloc(0))
      const sunMac = Buffer.from([
        fullMac[1],
        fullMac[3],
        fullMac[5],
        fullMac[7],
        fullMac[9],
        fullMac[11],
        fullMac[13],
        fullMac[15],
      ])

      // Verify the tap
      const result = boltcardCrypto.verifyCardTap(
        piccData.toString("hex"),
        sunMac.toString("hex"),
        keys.k1,
        keys.k2,
        uid,
        counter - 1, // Last counter was one less
      )

      expect(result.valid).toBe(true)
      expect(result.cardUid).toBe(uid)
      expect(result.counter).toBe(counter)
    })

    it("should reject tap with invalid SunMAC", () => {
      const uid = TEST_VECTORS.uid
      const counter = 100
      const keys = boltcardCrypto.deriveAllKeys(
        TEST_VECTORS.issuerKey,
        uid,
        TEST_VECTORS.version,
      )

      // Build and encrypt PICCData
      const plaintext = Buffer.alloc(16)
      plaintext[0] = 0xc7
      Buffer.from(uid, "hex").copy(plaintext, 1)
      plaintext[8] = counter & 0xff

      const k1 = Buffer.from(keys.k1, "hex")
      const iv = Buffer.alloc(16, 0)
      const cipher = crypto.createCipheriv("aes-128-cbc", k1, iv)
      cipher.setAutoPadding(false)
      const piccData = Buffer.concat([cipher.update(plaintext), cipher.final()])

      // Use wrong SunMAC
      const wrongMac = "deadbeefdeadbeef"

      const result = boltcardCrypto.verifyCardTap(
        piccData.toString("hex"),
        wrongMac,
        keys.k1,
        keys.k2,
        uid,
        0,
      )

      expect(result.valid).toBe(false)
      expect(result.error).toContain("SunMAC")
    })

    it("should reject counter replay", () => {
      const uid = TEST_VECTORS.uid
      const counter = 50
      const lastCounter = 100 // Last seen counter is higher!
      const keys = boltcardCrypto.deriveAllKeys(
        TEST_VECTORS.issuerKey,
        uid,
        TEST_VECTORS.version,
      )

      // Build and encrypt PICCData
      const plaintext = Buffer.alloc(16)
      plaintext[0] = 0xc7
      Buffer.from(uid, "hex").copy(plaintext, 1)
      plaintext[8] = counter & 0xff

      const k1 = Buffer.from(keys.k1, "hex")
      const iv = Buffer.alloc(16, 0)
      const cipher = crypto.createCipheriv("aes-128-cbc", k1, iv)
      cipher.setAutoPadding(false)
      const piccData = Buffer.concat([cipher.update(plaintext), cipher.final()])

      // Calculate correct SunMAC
      const sv2 = Buffer.concat([
        Buffer.from("3cc300010080", "hex"),
        Buffer.from(uid, "hex"),
        Buffer.from([counter & 0xff, 0, 0]),
      ])
      const sessionKey = boltcardCrypto.calculateCMAC(Buffer.from(keys.k2, "hex"), sv2)
      const fullMac = boltcardCrypto.calculateCMAC(sessionKey, Buffer.alloc(0))
      const sunMac = Buffer.from([
        fullMac[1],
        fullMac[3],
        fullMac[5],
        fullMac[7],
        fullMac[9],
        fullMac[11],
        fullMac[13],
        fullMac[15],
      ])

      const result = boltcardCrypto.verifyCardTap(
        piccData.toString("hex"),
        sunMac.toString("hex"),
        keys.k1,
        keys.k2,
        uid,
        lastCounter, // Counter replay - current is less than last
      )

      expect(result.valid).toBe(false)
      expect(result.error).toContain("replay")
    })
  })

  describe("generateKeysResponse", () => {
    it("should return uppercase keys per DEEPLINK.md spec", () => {
      const keys = {
        k0: "a29119fcb48e737d1591d3489557e49b",
        k1: "55da174c9608993dc27bb3f30a4a7314",
        k2: "f4b404be700ab285e333e32348fa3d3b",
        k3: "73610ba4afe45b55319691cb9489142f",
        k4: "addd03e52964369be7f2967736b7bdb5",
      }

      const response = boltcardCrypto.generateKeysResponse(
        "https://example.com/lnurlw",
        keys,
      )

      expect(response.K0).toBe(keys.k0.toUpperCase())
      expect(response.K1).toBe(keys.k1.toUpperCase())
      expect(response.K2).toBe(keys.k2.toUpperCase())
      expect(response.K3).toBe(keys.k3.toUpperCase())
      expect(response.K4).toBe(keys.k4.toUpperCase())
      expect(response.LNURLW).toBe("lnurlw://example.com/lnurlw")
    })
  })
})
