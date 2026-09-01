/**
 * Guard: the dependency-override policy has exactly ONE authoritative source —
 * `pnpm-workspace.yaml#overrides`.
 *
 * pnpm does NOT merge `package.json#pnpm.overrides` with the workspace map: if
 * both exist, the package.json map silently REPLACES the workspace one. That
 * exact failure happened on PR #63: adding a single browserslist override to
 * package.json disabled the workspace map, downgraded protobufjs, and
 * resurfaced the already-patched sharp/postcss advisories.
 *
 * If you need a new override, add it to pnpm-workspace.yaml.
 */
import fs from "fs"
import path from "path"

describe("dependency override policy", () => {
  const root = path.resolve(__dirname, "..", "..")

  it("package.json does not define pnpm overrides (workspace map is the single source)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    expect(pkg.pnpm?.overrides).toBeUndefined()
    expect(pkg.overrides).toBeUndefined() // npm-style map is equally dead config
  })

  it("pnpm-workspace.yaml keeps the established security floors", () => {
    // The file is flat YAML: `overrides:` followed by `  "<selector>": "<range>"`
    // lines. A line-based parse avoids adding a YAML dependency for a guard.
    const workspaceYaml = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")
    const selectors = [...workspaceYaml.matchAll(/^\s+"?([^"\n:]+?)"?:\s/gm)].map(
      (m) => m[1],
    )
    const floors = [
      "protobufjs",
      "lodash",
      "ws",
      "@grpc/grpc-js",
      "sharp",
      "postcss",
      "nanoid",
      "browserslist",
    ]
    for (const dep of floors) {
      expect(selectors.some((s) => s === dep || s.startsWith(`${dep}@`))).toBe(true)
    }
  })
})
