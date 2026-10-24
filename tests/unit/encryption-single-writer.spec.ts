/** @jest-environment node */

/**
 * blink-wip#1587: lib/crypto/keyring.js is the only writer of secrets at
 * rest. A direct CryptoJS AES.encrypt elsewhere would create legacy
 * ciphertext under whatever key is current, which the keyring reads with the
 * oldest configured key — unreadable after a rotation, and invisible to the
 * re-encryption gate. Fail the build if one appears.
 *
 * The same goes for Node's createCipheriv: lib/network/crypto.ts was such a
 * second writer (its own NETWORK_ENCRYPTION_KEY, never used) and the
 * CryptoJS-only check above could not see it.
 *
 * This is a tripwire for the common shapes (direct AES.encrypt /
 * createCipheriv calls), not a complete crypto policy: an aliased call or
 * another cipher API would not be caught.
 */

import fs from "fs"
import path from "path"

const ROOT = process.cwd()
const DIRS = ["lib", "pages", "components", "scripts"]
const ALLOWED = new Set([path.join("lib", "crypto", "keyring.js")])

const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/

const files = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(rel)
    return SOURCE.test(entry.name) ? [rel] : []
  })

/** The source directories plus root-level entrypoints (env.ts, instrumentation, print-server, ...). */
const sources = (): string[] => [
  ...fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && SOURCE.test(e.name) && !e.name.endsWith(".d.ts"))
    .map((e) => e.name),
  ...DIRS.flatMap(files),
]

const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8")

// The Bolt Card protocol file may use Node ciphers, but only the NTAG424
// card protocol's AES-128 (SUN decryption / CMAC). Secrets at rest use
// AES-256 through the keyring, so an AES-256 (or any non-AES-128) cipher
// there fails the check below instead of hiding behind the exemption.
const BOLTCARD_PROTOCOL = path.join("lib", "boltcard", "crypto.ts")
const CIPHER_CALL = /\bcreate(?:Cipheriv|Decipheriv)\s*\(\s*([^,]*),/g

describe("single writer of encrypted secrets", () => {
  it("no code outside lib/crypto/keyring.js calls AES.encrypt", () => {
    const offenders = sources()
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => /\bAES\s*\.\s*encrypt\s*\(/.test(read(f)))
    expect(offenders).toEqual([])
  })

  it("no code outside lib/crypto/keyring.js creates a Node cipher (except the Bolt Card protocol)", () => {
    const offenders = sources()
      .filter((f) => !ALLOWED.has(f) && f !== BOLTCARD_PROTOCOL)
      .filter((f) => /\bcreateCipheriv\s*\(/.test(read(f)))
    expect(offenders).toEqual([])
  })

  it("the Bolt Card protocol file only uses AES-128 ciphers (its exemption's reason)", () => {
    const source = read(BOLTCARD_PROTOCOL)
    const algorithms = [...source.matchAll(CIPHER_CALL)].map((m) => m[1].trim())
    // Every cipher call was parsed: a pattern miss must not pass silently.
    expect(algorithms.length).toBe((source.match(/cipheriv\s*\(/gi) || []).length)
    expect(algorithms.length).toBeGreaterThan(0)
    for (const algorithm of algorithms) {
      expect(algorithm).toMatch(/^["']aes-128-(ecb|cbc)["']$/)
    }
  })

  it("the retired NETWORK_ENCRYPTION_KEY module stays gone", () => {
    expect(fs.existsSync(path.join(ROOT, "lib", "network", "crypto.ts"))).toBe(false)
  })

  it("the retired JSON voucher migration (hardcoded fallback key) stays gone", () => {
    expect(
      fs.existsSync(path.join(ROOT, "scripts", "migrate-vouchers-to-postgres.js")),
    ).toBe(false)
  })
})
