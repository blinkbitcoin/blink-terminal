/** @jest-environment node */

/**
 * blink-wip#1587: lib/crypto/keyring.js is the only writer of secrets at
 * rest. A direct CryptoJS AES.encrypt elsewhere would create legacy
 * ciphertext under whatever key is current, which the keyring reads with the
 * oldest configured key — unreadable after a rotation, and invisible to the
 * re-encryption gate. Fail the build if one appears.
 */

import fs from "fs"
import path from "path"

const ROOT = process.cwd()
const DIRS = ["lib", "pages", "components", "scripts"]
const ALLOWED = new Set([path.join("lib", "crypto", "keyring.js")])

const files = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(rel)
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [rel] : []
  })

describe("single writer of encrypted secrets", () => {
  it("no code outside lib/crypto/keyring.js calls AES.encrypt", () => {
    const offenders = DIRS.flatMap(files)
      .filter((f) => !ALLOWED.has(f))
      .filter((f) =>
        /\bAES\s*\.\s*encrypt\s*\(/.test(fs.readFileSync(path.join(ROOT, f), "utf8")),
      )
    expect(offenders).toEqual([])
  })

  it("the retired JSON voucher migration (hardcoded fallback key) stays gone", () => {
    expect(
      fs.existsSync(path.join(ROOT, "scripts", "migrate-vouchers-to-postgres.js")),
    ).toBe(false)
  })
})
