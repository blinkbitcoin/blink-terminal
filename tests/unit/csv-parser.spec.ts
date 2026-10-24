/**
 * Unit Tests for lib/batch-payments/csv-parser.js
 *
 * Tests CSV parsing, recipient type detection, and validation.
 */

import {
  parseCSV,
  parseCSVLine,
  detectRecipientType,
  normalizeRecipient,
  generateTemplate,
  quickValidate,
  RECIPIENT_TYPES,
} from "../../lib/batch-payments/csv-parser"

describe("CSV Parser", () => {
  describe("RECIPIENT_TYPES", () => {
    it("should have correct type constants", () => {
      expect(RECIPIENT_TYPES.BLINK).toBe("BLINK")
      expect(RECIPIENT_TYPES.LN_ADDRESS).toBe("LN_ADDRESS")
      expect(RECIPIENT_TYPES.LNURL).toBe("LNURL")
    })
  })

  describe("detectRecipientType()", () => {
    it("should detect Blink username", () => {
      expect(detectRecipientType("hermann")).toBe(RECIPIENT_TYPES.BLINK)
      expect(detectRecipientType("user123")).toBe(RECIPIENT_TYPES.BLINK)
      expect(detectRecipientType("test_user")).toBe(RECIPIENT_TYPES.BLINK)
    })

    it("should detect Lightning Address", () => {
      expect(detectRecipientType("user@getalby.com")).toBe(RECIPIENT_TYPES.LN_ADDRESS)
      expect(detectRecipientType("satoshi@blink.sv")).toBe(RECIPIENT_TYPES.LN_ADDRESS)
      expect(detectRecipientType("test@8333.mobi")).toBe(RECIPIENT_TYPES.LN_ADDRESS)
    })

    it("should detect LNURL", () => {
      expect(detectRecipientType("lnurl1dp68gurn...")).toBe(RECIPIENT_TYPES.LNURL)
      expect(detectRecipientType("LNURL1DP68GURN...")).toBe(RECIPIENT_TYPES.LNURL)
    })

    it("should handle UTF-7 encoded @ symbol", () => {
      expect(detectRecipientType("user+AEA-domain.com")).toBe(RECIPIENT_TYPES.LN_ADDRESS)
    })

    it("should treat incomplete email-like strings as Blink users", () => {
      // No domain part
      expect(detectRecipientType("user@")).toBe(RECIPIENT_TYPES.BLINK)
      // No TLD
      expect(detectRecipientType("user@domain")).toBe(RECIPIENT_TYPES.BLINK)
    })
  })

  describe("normalizeRecipient()", () => {
    it("should normalize Blink usernames to lowercase", () => {
      expect(normalizeRecipient("HERMANN", RECIPIENT_TYPES.BLINK)).toBe("hermann")
      expect(normalizeRecipient("@user", RECIPIENT_TYPES.BLINK)).toBe("user")
    })

    it("should normalize Lightning addresses to lowercase", () => {
      expect(normalizeRecipient("User@Domain.COM", RECIPIENT_TYPES.LN_ADDRESS)).toBe(
        "user@domain.com",
      )
    })

    it("should preserve LNURL case", () => {
      const lnurl = "LNURL1DP68GURN..."
      expect(normalizeRecipient(lnurl, RECIPIENT_TYPES.LNURL)).toBe(lnurl)
    })

    it("should decode UTF-7 encoded strings", () => {
      expect(normalizeRecipient("user+AEA-domain.com", RECIPIENT_TYPES.LN_ADDRESS)).toBe(
        "user@domain.com",
      )
    })
  })

  describe("parseCSVLine()", () => {
    it("should parse simple comma-separated values", () => {
      const result = parseCSVLine("a,b,c,d")
      expect(result).toEqual(["a", "b", "c", "d"])
    })

    it("should handle quoted values", () => {
      const result = parseCSVLine('"hello, world",value2')
      expect(result).toEqual(["hello, world", "value2"])
    })

    it("should handle escaped quotes", () => {
      const result = parseCSVLine('"say ""hello""",value2')
      expect(result).toEqual(['say "hello"', "value2"])
    })

    it("should handle empty values", () => {
      const result = parseCSVLine("a,,c,")
      expect(result).toEqual(["a", "", "c", ""])
    })

    it("should handle mixed quoted and unquoted", () => {
      const result = parseCSVLine('plain,"quoted value",another')
      expect(result).toEqual(["plain", "quoted value", "another"])
    })
  })

  describe("parseCSV()", () => {
    it("should parse valid CSV with all columns", () => {
      const csv = `recipient,amount,currency,memo
hermann,1000,SATS,Test payment
user@alby.com,500,SATS,Another payment`

      const result = parseCSV(csv)

      expect(result.success).toBe(true)
      expect(result.records).toHaveLength(2)
      expect(result.records![0].normalized).toBe("hermann")
      expect(result.records![0].type).toBe(RECIPIENT_TYPES.BLINK)
      expect(result.records![0].amount).toBe(1000)
      expect(result.records![0].currency).toBe("SATS")
      expect(result.records![1].type).toBe(RECIPIENT_TYPES.LN_ADDRESS)
    })

    it("should handle CSV without optional columns", () => {
      const csv = `recipient,amount
hermann,1000
alice,500`

      const result = parseCSV(csv)

      expect(result.success).toBe(true)
      expect(result.records).toHaveLength(2)
      expect(result.records![0].currency).toBe("SATS") // Default
      expect(result.records![0].memo).toBe("") // Default
    })

    it("should return error for missing required headers", () => {
      const csv = `name,value
hermann,1000`

      const result = parseCSV(csv)

      expect(result.success).toBe(false)
      expect(result.errors).toContain(
        "Missing required headers: recipient, amount. Expected: recipient,amount,currency,memo",
      )
    })

    it("should return error for empty CSV", () => {
      const result = parseCSV("")

      expect(result.success).toBe(false)
      expect(result.errors).toContain("CSV content is empty or invalid")
    })

    it("should return error for header-only CSV", () => {
      const csv = "recipient,amount,currency,memo"

      const result = parseCSV(csv)

      expect(result.success).toBe(false)
      expect(result.errors).toContain(
        "CSV must have a header row and at least one data row",
      )
    })

    it("should skip empty lines", () => {
      const csv = `recipient,amount,currency,memo
hermann,1000,SATS,Test

alice,500,SATS,Test2`

      const result = parseCSV(csv)

      expect(result.success).toBe(true)
      expect(result.records).toHaveLength(2)
    })

    it("should validate missing recipient", () => {
      const csv = `recipient,amount
,1000
alice,500`

      const result = parseCSV(csv)

      expect(result.success).toBe(false)
      expect(result.errors!.some((e: string) => e.includes("Missing recipient"))).toBe(
        true,
      )
      expect(result.records).toHaveLength(1) // Only valid row
    })

    it("should validate missing amount", () => {
      const csv = `recipient,amount
hermann,
alice,500`

      const result = parseCSV(csv)

      expect(result.success).toBe(false)
      expect(result.errors!.some((e: string) => e.includes("Missing amount"))).toBe(true)
    })

    it("should validate invalid amount", () => {
      const csv = `recipient,amount
hermann,abc
alice,-100`

      const result = parseCSV(csv)

      expect(result.success).toBe(false)
      expect(result.errors!.some((e: string) => e.includes("Invalid amount"))).toBe(true)
    })

    it("should validate currency", () => {
      const csv = `recipient,amount,currency
hermann,1000,EUR`

      const result = parseCSV(csv)

      expect(result.success).toBe(false)
      expect(result.errors!.some((e: string) => e.includes("Invalid currency"))).toBe(
        true,
      )
    })

    it("should convert BTC to sats", () => {
      const csv = `recipient,amount,currency
hermann,0.001,BTC`

      const result = parseCSV(csv)

      expect(result.success).toBe(true)
      expect(result.records![0].amountSats).toBe(100000) // 0.001 BTC = 100,000 sats
    })

    it("should leave USD amount as null for later conversion", () => {
      const csv = `recipient,amount,currency
hermann,10,USD`

      const result = parseCSV(csv)

      expect(result.success).toBe(true)
      expect(result.records![0].amountSats).toBeNull()
      expect(result.records![0].amount).toBe(10)
    })

    it("should provide summary with type breakdown", () => {
      const csv = `recipient,amount,currency,memo
hermann,1000,SATS,Blink user
user@alby.com,500,SATS,LN address
lnurl1test,200,SATS,LNURL`

      const result = parseCSV(csv)

      expect(result.summary!.total).toBe(3)
      expect(result.summary!.byType[RECIPIENT_TYPES.BLINK]).toBe(1)
      expect(result.summary!.byType[RECIPIENT_TYPES.LN_ADDRESS]).toBe(1)
      expect(result.summary!.byType[RECIPIENT_TYPES.LNURL]).toBe(1)
    })

    it("should handle Windows line endings", () => {
      const csv = "recipient,amount\r\nhermann,1000\r\nalice,500"

      const result = parseCSV(csv)

      expect(result.success).toBe(true)
      expect(result.records).toHaveLength(2)
    })

    it("should handle case-insensitive headers", () => {
      const csv = `RECIPIENT,AMOUNT,Currency,MEMO
hermann,1000,sats,test`

      const result = parseCSV(csv)

      expect(result.success).toBe(true)
      expect(result.records).toHaveLength(1)
    })
  })

  describe("quickValidate()", () => {
    it("should pass for valid CSV", () => {
      const csv = `recipient,amount
hermann,1000`

      const result = quickValidate(csv)

      expect(result.valid).toBe(true)
    })

    it("should fail for empty content", () => {
      const result = quickValidate("")

      expect(result.valid).toBe(false)
      expect(result.error).toContain("empty")
    })

    it("should fail for non-string content", () => {
      // Deliberately invalid input: quickValidate must reject it at runtime
      const result = quickValidate(null as unknown as string)

      expect(result.valid).toBe(false)
    })

    it("should fail for missing headers", () => {
      const csv = `name,value
hermann,1000`

      const result = quickValidate(csv)

      expect(result.valid).toBe(false)
      expect(result.error).toContain("recipient")
    })

    it("should fail for header-only content", () => {
      const csv = "recipient,amount"

      const result = quickValidate(csv)

      expect(result.valid).toBe(false)
    })

    it("should fail for too many recipients", () => {
      let csv = "recipient,amount\n"
      for (let i = 0; i < 1001; i++) {
        csv += `user${i},100\n`
      }

      const result = quickValidate(csv)

      expect(result.valid).toBe(false)
      expect(result.error).toContain("1000")
    })

    it("should fail for file too large", () => {
      // Create a string larger than 5MB
      const largeContent = "recipient,amount\n" + "a".repeat(6 * 1024 * 1024)

      const result = quickValidate(largeContent)

      expect(result.valid).toBe(false)
      expect(result.error).toContain("large")
    })
  })

  describe("generateTemplate()", () => {
    it("should generate valid CSV template", () => {
      const template = generateTemplate()

      expect(template).toContain("recipient,amount,currency,memo")
      expect(template).toContain("hermann")
      expect(template).toContain("@getalby.com")
      expect(template).toContain("SATS")
    })

    it("should be parseable", () => {
      const template = generateTemplate()
      const result = parseCSV(template)

      expect(result.success).toBe(true)
      expect(result.records!.length).toBeGreaterThan(0)
    })
  })
})
