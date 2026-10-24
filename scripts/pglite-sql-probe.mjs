/**
 * PGlite SQL probe — runs SQL against real (wasm) Postgres in plain Node.
 *
 * Jest's CJS runtime cannot run PGlite (dynamic import callback), so specs
 * shell out to this script instead. The caller passes a JSON program via the
 * PROBE_PROGRAM env var:
 *
 *   {
 *     "ddl": ["CREATE TABLE ...", ...],          // run once
 *     "exec": ["BEGIN; ...; COMMIT;", ...],      // multi-statement scripts
 *     "seeds": [["INSERT ...", [params]], ...],  // run in order
 *     "query": "SELECT ...",                     // the probed statement
 *     "params": [...]                            // its parameters
 *   }
 *
 * Prints the query's rows as JSON on stdout. Exit code is non-zero on any
 * error ({ message, code } JSON goes to stderr), so callers assert both sides.
 */

import { PGlite } from "@electric-sql/pglite"

const program = JSON.parse(process.env.PROBE_PROGRAM || "{}")

const db = new PGlite()
try {
  for (const ddl of program.ddl ?? []) {
    await db.query(ddl)
  }
  // Multi-statement scripts (e.g. a whole migration file)
  for (const script of program.exec ?? []) {
    await db.exec(script)
  }
  for (const [sql, params] of program.seeds ?? []) {
    await db.query(sql, params)
  }
  const result = await db.query(program.query, program.params ?? [])
  process.stdout.write(JSON.stringify({ ok: true, rows: result.rows }))
} catch (err) {
  // Message plus SQLSTATE (when Postgres supplied one), so callers can assert
  // on the error code the application maps, not only on the text.
  const message = String(err && err.message ? err.message : err)
  const code = err && typeof err.code === "string" ? err.code : null
  process.stderr.write(JSON.stringify({ message, code }))
  process.exitCode = 1
} finally {
  await db.close()
}
