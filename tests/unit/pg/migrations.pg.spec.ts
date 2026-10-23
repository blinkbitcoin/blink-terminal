/** @jest-environment node */

/**
 * The migration chain on a fresh Postgres (blink-wip#1616): init.sql plus
 * every database/migrations/*.sql, in the order the chart's run-migrations
 * init container applies them, reaches the newest schema_version — so a
 * migration that only works on top of a hand-patched database fails here
 * before it reaches production.
 */

// Must stay first: sets the env lib/auth reads at module load.
import "./env"

import path from "path"

import {
  describePg,
  migrationFiles,
  setupTestDatabase,
  type TestDatabase,
} from "./harness"

jest.setTimeout(60_000)

describePg("migration chain on real Postgres", () => {
  let db: TestDatabase

  beforeAll(async () => {
    db = await setupTestDatabase("migrations")
  })
  afterAll(async () => {
    await db?.teardown()
  })

  it("applies cleanly and records the newest schema_version", async () => {
    const newest = Math.max(
      ...migrationFiles()
        .map((f) => parseInt(path.basename(f).split("_")[0], 10))
        .filter(Number.isFinite),
    )
    const client = await db.connect()
    try {
      const { rows } = await client.query(
        `SELECT MAX(metric_value)::int AS version FROM system_metrics
         WHERE metric_name = 'schema_version'`,
      )
      expect(rows[0].version).toBe(newest)
    } finally {
      await client.end()
    }
  })
})
