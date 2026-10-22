/**
 * PGlite SQL probe — runs SQL against real (wasm) Postgres in plain Node.
 *
 * Jest's CJS runtime cannot run PGlite (dynamic import callback), so specs
 * shell out to this script instead. The caller passes a JSON program via the
 * PROBE_PROGRAM env var:
 *
 *   {
 *     "ddl": ["CREATE TABLE ...", ...],          // run once
 *     "seeds": [["INSERT ...", [params]], ...],  // run in order
 *     "query": "SELECT ...",                     // the probed statement
 *     "params": [...]                            // its parameters
 *   }
 *
 * Prints the query's rows as JSON on stdout. Exit code is non-zero on any
 * error (the message goes to stderr), so callers assert both sides.
 */

import { PGlite } from "@electric-sql/pglite"

const program = JSON.parse(process.env.PROBE_PROGRAM || "{}")

const db = new PGlite()
try {
  for (const ddl of program.ddl ?? []) {
    await db.query(ddl)
  }
  for (const [sql, params] of program.seeds ?? []) {
    await db.query(sql, params)
  }
  const result = await db.query(program.query, program.params ?? [])
  process.stdout.write(JSON.stringify({ ok: true, rows: result.rows }))
} catch (err) {
  process.stderr.write(String(err && err.message ? err.message : err))
  process.exitCode = 1
} finally {
  await db.close()
}
