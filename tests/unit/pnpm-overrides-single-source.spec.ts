/**
 * Guard: the dependency-override policy has exactly ONE authoritative source —
 * `pnpm-workspace.yaml#overrides` — and the lockfile faithfully reflects it.
 *
 * pnpm does NOT merge `package.json#pnpm.overrides` with the workspace map: if
 * both exist, the package.json map silently REPLACES the workspace one. That
 * exact failure happened on PR #63: adding a single browserslist override to
 * package.json disabled the workspace map, downgraded protobufjs, and
 * resurfaced the already-patched sharp/postcss advisories — a change the
 * lockfile's `overrides:` block recorded but no test caught.
 *
 * This guard pins the *values*, not just the dependency names: the workspace
 * map must equal EXPECTED_OVERRIDES exactly, and the lockfile's regenerated
 * override map must equal the workspace map. Weakening a floor, pointing a
 * selector at a vulnerable replacement, or letting the two sources diverge all
 * fail here.
 *
 * If you need a new/changed override: edit pnpm-workspace.yaml, run
 * `pnpm install`, then update EXPECTED_OVERRIDES to match.
 */
import fs from "fs"
import path from "path"

// Selector -> replacement, exactly as it must appear in pnpm-workspace.yaml.
const EXPECTED_OVERRIDES: Record<string, string> = {
  "protobufjs": ">=8.4.1",
  "lodash@<4.18.0": ">=4.18.0",
  "ws@>=8.0.0 <8.21.0": ">=8.21.0",
  "@grpc/grpc-js@>=1.14.0 <1.14.4": ">=1.14.4",
  "sharp@<0.35.0": ">=0.35.3",
  "postcss@<8.5.18": ">=8.5.18",
  "nanoid@<3.3.18": "^3.3.18",
  "browserslist@<4.28.7": "^4.28.8",
}

const root = path.resolve(__dirname, "..", "..")

/**
 * Parse a flat `overrides:` block from either pnpm-workspace.yaml (top-level)
 * or pnpm-lock.yaml (top-level) into a selector -> replacement map. Both files
 * write one `  "<selector>": "<replacement>"` entry per line with no nesting,
 * so a line parser avoids adding a YAML dependency for a guard.
 *
 * An indented line inside the block that does not parse as a single
 * `selector: replacement` entry is REJECTED (throws), not silently skipped:
 * unsupported syntax (nested maps, list items, comments-as-entries) means the
 * guard can no longer vouch for the policy, so it must fail loudly rather than
 * quietly under-report the map.
 */
export function parseOverridesBlock(fileContents: string): Record<string, string> {
  const lines = fileContents.split("\n")
  const start = lines.findIndex((l) => l === "overrides:")
  if (start === -1) return {}

  const result: Record<string, string> = {}
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "") break // blank line ends the block
    if (!/^\s/.test(line)) break // dedent to column 0 ends the block
    const m = line.match(/^\s+'?"?(.+?)"?'?:\s*'?"?(.+?)"?'?\s*$/)
    if (!m) {
      throw new Error(
        `Unparsable line in overrides block (line ${i + 1}): ${JSON.stringify(line)}. ` +
          `The guard's parser only supports flat "selector: replacement" entries.`,
      )
    }
    result[m[1]] = m[2]
  }
  return result
}

describe("overrides parser", () => {
  it("returns an empty map when there is no overrides block", () => {
    expect(parseOverridesBlock("packages:\n  - app\n")).toEqual({})
  })

  it("ends the block at a blank line", () => {
    const yaml = 'overrides:\n  "a@<1": ">=1"\n\nother:\n  "b@<2": ">=2"\n'
    expect(parseOverridesBlock(yaml)).toEqual({ "a@<1": ">=1" })
  })

  it("ends the block at a dedent to column 0", () => {
    const yaml = 'overrides:\n  "a@<1": ">=1"\nother: value\n'
    expect(parseOverridesBlock(yaml)).toEqual({ "a@<1": ">=1" })
  })

  it("strips both single and double quotes from selector and replacement", () => {
    const yaml = "overrides:\n  'a@<1': '>=1'\n  b: \">=2\"\n"
    expect(parseOverridesBlock(yaml)).toEqual({ "a@<1": ">=1", "b": ">=2" })
  })

  it("throws on an unsupported indented line instead of silently skipping it", () => {
    const yaml = "overrides:\n  nested:\n    deep: value\n"
    expect(() => parseOverridesBlock(yaml)).toThrow(/Unparsable line/)
  })
})

describe("dependency override policy", () => {
  const workspace = parseOverridesBlock(
    fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"),
  )
  const lockfile = parseOverridesBlock(
    fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"),
  )

  it("package.json does not define overrides (workspace map is the single source)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    expect(pkg.pnpm?.overrides).toBeUndefined()
    expect(pkg.overrides).toBeUndefined() // npm-style map is equally dead config
  })

  it("pnpm-workspace.yaml matches the expected selector->replacement policy exactly", () => {
    expect(workspace).toEqual(EXPECTED_OVERRIDES)
  })

  it("the lockfile's override map equals the workspace map", () => {
    expect(lockfile).toEqual(workspace)
  })
})
