/**
 * @jest-environment node
 *
 * Citrusrate currency definitions and routing (Track 1 re-enable, Sept 2026).
 *
 * Guards the invariants the live Citrusrate V1 API was verified against:
 * - deprecated ISO codes (MRO, SLL, STD, ZWD) must NOT be offered — the live
 *   API no longer returns them, so they would 400 at runtime
 * - VUV (Vanuatu) is present as a Citrusrate-exclusive currency
 * - EGP_CITRUS exists as an alternative for Blink-served EGP
 * - the server definitions and the client mirror stay in sync
 * - all 13 street-rate currencies route to citrusrate_street and resolve
 *   their base currency (incl. the RWF edge case: street variant whose base
 *   is itself Citrusrate-exclusive, not Blink-served)
 */

import {
  CITRUSRATE_EXCLUSIVE_CURRENCIES as CLIENT_EXCLUSIVE,
  CITRUSRATE_ALT_CURRENCIES as CLIENT_ALT,
} from "../../lib/citrusrate-currencies-client"
import {
  STREET_RATE_CURRENCIES as CLIENT_STREET_CURRENCIES,
  getStreetRateCurrency,
} from "../../lib/currency-utils"
import {
  CITRUSRATE_EXCLUSIVE_CURRENCIES,
  CITRUSRATE_ALT_CURRENCIES,
  getProviderForCurrency,
  getBaseCurrency,
  isStreetRateCurrency,
  STREET_RATE_CURRENCIES as SERVER_STREET_CURRENCIES,
} from "../../lib/rate-providers/index"

const DEAD_CODES = ["MRO", "SLL", "STD", "ZWD"]

// All 13 currencies the live /v1/btc/blackmarket endpoint supports
const BLACK_MARKET_BASES = [
  "EGP",
  "ETB",
  "GHS",
  "MWK",
  "MZN",
  "NAD",
  "RWF",
  "TZS",
  "UGX",
  "XAF",
  "XOF",
  "ZAR",
  "ZMW",
]

describe("Citrusrate exclusive currencies", () => {
  it("contains exactly 21 currencies (20 African + VUV)", () => {
    expect(CITRUSRATE_EXCLUSIVE_CURRENCIES).toHaveLength(21)
  })

  it.each(DEAD_CODES)("does not offer deprecated code %s", (code) => {
    expect(CITRUSRATE_EXCLUSIVE_CURRENCIES.find((c) => c.id === code)).toBeUndefined()
  })

  it("includes VUV (Vanuatu Vatu) with correct metadata", () => {
    const vuv = CITRUSRATE_EXCLUSIVE_CURRENCIES.find((c) => c.id === "VUV")
    expect(vuv).toBeDefined()
    expect(vuv).toMatchObject({
      id: "VUV",
      symbol: "VT",
      flag: "🇻🇺",
      fractionDigits: 0,
      rateProvider: "citrusrate_official",
    })
    expect(vuv?.name).toContain("(Citrusrate)")
  })

  it("every exclusive currency routes to citrusrate_official", () => {
    for (const currency of CITRUSRATE_EXCLUSIVE_CURRENCIES) {
      expect(getProviderForCurrency(currency.id).id).toBe("citrusrate_official")
    }
  })
})

describe("Citrusrate alternative currencies", () => {
  it("contains exactly 17 currencies", () => {
    expect(CITRUSRATE_ALT_CURRENCIES).toHaveLength(17)
  })

  it("includes EGP_CITRUS (EGP is served by both Blink and Citrusrate)", () => {
    const egp = CITRUSRATE_ALT_CURRENCIES.find((c) => c.id === "EGP_CITRUS")
    expect(egp).toMatchObject({ baseId: "EGP", rateProvider: "citrusrate_official" })
  })

  it("every alt currency routes to citrusrate_official and resolves its base", () => {
    for (const alt of CITRUSRATE_ALT_CURRENCIES) {
      expect(getProviderForCurrency(alt.id).id).toBe("citrusrate_official")
      expect(getBaseCurrency(alt.id)).toBe(alt.baseId)
    }
  })
})

describe("street rate currencies", () => {
  it("covers all 13 black-market currencies in both definition files", () => {
    expect(SERVER_STREET_CURRENCIES).toHaveLength(13)
    expect(CLIENT_STREET_CURRENCIES).toHaveLength(13)

    const serverIds = SERVER_STREET_CURRENCIES.map((c) => c.id).sort()
    const clientIds = CLIENT_STREET_CURRENCIES.map((c) => c.id).sort()
    expect(serverIds).toEqual(clientIds)
    expect(serverIds).toEqual(BLACK_MARKET_BASES.map((b) => `${b}_STREET`).sort())
  })

  it("both files agree on baseId/displayId/fractionDigits per street currency", () => {
    for (const serverEntry of SERVER_STREET_CURRENCIES) {
      const clientEntry = CLIENT_STREET_CURRENCIES.find((c) => c.id === serverEntry.id)
      expect(clientEntry).toBeDefined()
      expect(clientEntry).toMatchObject({
        baseId: serverEntry.baseId,
        displayId: serverEntry.displayId,
        symbol: serverEntry.symbol,
        fractionDigits: serverEntry.fractionDigits,
        rateProvider: "citrusrate_street",
      })
    }
  })

  it.each(BLACK_MARKET_BASES)("%s_STREET routes to citrusrate_street", (base) => {
    expect(getProviderForCurrency(`${base}_STREET`).id).toBe("citrusrate_street")
    expect(isStreetRateCurrency(`${base}_STREET`)).toBe(true)
    expect(getBaseCurrency(`${base}_STREET`)).toBe(base)
    expect(getStreetRateCurrency(`${base}_STREET`)?.baseId).toBe(base)
  })

  it("RWF_STREET base (RWF) is Citrusrate-exclusive, so dropdown injection finds it", () => {
    // useCurrencies.getAllCurrencies() injects street variants right after their
    // base currency. RWF is NOT in the Blink API list — it only exists as a
    // Citrusrate exclusive, which is what the injection loop iterates over.
    expect(CITRUSRATE_EXCLUSIVE_CURRENCIES.find((c) => c.id === "RWF")).toBeDefined()
  })

  it("every other street base has a _CITRUS alt (base is Blink-served)", () => {
    const altBases = CITRUSRATE_ALT_CURRENCIES.map((c) => c.baseId)
    for (const base of BLACK_MARKET_BASES.filter((b) => b !== "RWF")) {
      expect(altBases).toContain(base)
    }
  })
})

describe("server/client definition sync", () => {
  it("exclusive currency ids match across both files", () => {
    expect(CITRUSRATE_EXCLUSIVE_CURRENCIES.map((c) => c.id).sort()).toEqual(
      CLIENT_EXCLUSIVE.map((c) => c.id).sort(),
    )
  })

  it("alt currency ids and baseIds match across both files", () => {
    const serverPairs = CITRUSRATE_ALT_CURRENCIES.map((c) => `${c.id}:${c.baseId}`)
    const clientPairs = CLIENT_ALT.map((c) => `${c.id}:${c.baseId}`)
    expect(serverPairs.sort()).toEqual(clientPairs.sort())
  })

  it("metadata matches per exclusive currency", () => {
    for (const serverEntry of CITRUSRATE_EXCLUSIVE_CURRENCIES) {
      const clientEntry = CLIENT_EXCLUSIVE.find((c) => c.id === serverEntry.id)
      expect(clientEntry).toMatchObject({
        name: serverEntry.name,
        flag: serverEntry.flag,
        symbol: serverEntry.symbol,
        fractionDigits: serverEntry.fractionDigits,
        rateProvider: serverEntry.rateProvider,
      })
    }
  })
})

describe("Blink currencies are unaffected", () => {
  it("standard currencies still route to blink", () => {
    for (const id of ["USD", "EUR", "NGN", "KES", "EGP"]) {
      expect(getProviderForCurrency(id).id).toBe("blink")
    }
  })
})
