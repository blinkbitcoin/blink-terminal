/**
 * Real-Postgres test harness (blink-wip#1616).
 *
 * Mocked pools and single-connection PGlite cannot exercise what matters for
 * the voucher and Bolt Card stores: concurrent transactions, advisory locks,
 * lock_timeout, and the planner's index choice. These suites run against a
 * real server.
 *
 * Opt-in, like the Redis suite: set PG_TEST_URL to an admin connection string
 * (a role that may CREATE DATABASE and CREATE EXTENSION). Without it every
 * `describePg` suite is skipped. CI provides a postgres:15 service container.
 *
 *   docker run -d --name bt-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:15-alpine
 *   PG_TEST_URL=postgres://postgres:postgres@localhost:55432/postgres npx jest tests/unit/pg
 *
 * Each suite gets a fresh database with database/init.sql and every
 * database/migrations/*.sql applied in sorted order — the same order the
 * chart's run-migrations init container uses — so the harness also proves the
 * migration chain applies end to end. DATABASE_URL is pointed at it before
 * lib/db creates its (lazy) shared pool; teardown closes the pool and drops
 * the database.
 *
 * Specs import "./env" first (the env lib/auth reads at load), then this.
 */

import fs from "fs"
import path from "path"

import { Client } from "pg"

import "./env"

export const PG_TEST_URL = process.env.PG_TEST_URL
export const describePg: jest.Describe = PG_TEST_URL ? describe : describe.skip

const ROOT = path.join(__dirname, "..", "..", "..")

/** init.sql followed by every migration, in the order production applies them. */
export function migrationFiles(): string[] {
  const dir = path.join(ROOT, "database", "migrations")
  return [
    path.join(ROOT, "database", "init.sql"),
    ...fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => path.join(dir, f)),
  ]
}

function urlForDatabase(adminUrl: string, database: string): string {
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  return url.toString()
}

export interface TestDatabase {
  name: string
  url: string
  /** A dedicated client on the test database (caller ends it). */
  connect: () => Promise<Client>
  /** Close lib/db's shared pool and drop the database. */
  teardown: () => Promise<void>
}

/**
 * Create and migrate a fresh database, and point lib/db at it. Call from
 * beforeAll (allow ~30 s) inside a describePg suite.
 */
export async function setupTestDatabase(suite: string): Promise<TestDatabase> {
  if (!PG_TEST_URL) throw new Error("PG_TEST_URL is not set")
  const name = `bt_test_${suite.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`

  const admin = new Client({ connectionString: PG_TEST_URL })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }

  const url = urlForDatabase(PG_TEST_URL, name)
  const client = new Client({ connectionString: url })
  await client.connect()
  client.on("notice", () => undefined) // migrations RAISE NOTICE
  try {
    for (const file of migrationFiles()) {
      try {
        await client.query(fs.readFileSync(file, "utf8"))
      } catch (err: unknown) {
        throw new Error(
          `Migration failed: ${path.basename(file)}: ${(err as Error).message}`,
        )
      }
    }
  } finally {
    await client.end()
  }

  // lib/db builds its pool lazily from DATABASE_URL on first use.
  process.env.DATABASE_URL = url

  return {
    name,
    url,
    connect: async () => {
      const c = new Client({ connectionString: url })
      await c.connect()
      return c
    },
    teardown: async () => {
      const { closePool } = await import("../../../lib/db")
      await closePool()
      const a = new Client({ connectionString: PG_TEST_URL })
      await a.connect()
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      } finally {
        await a.end()
      }
    },
  }
}

/** Start `n` calls of `fn` as simultaneously as the event loop allows. */
export async function concurrently<T>(
  n: number,
  fn: (i: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const runs = Array.from({ length: n }, (_, i) => gate.then(() => fn(i)))
  release()
  return Promise.allSettled(runs)
}

/**
 * Index names the planner uses for `sql` when sequential scans are
 * discouraged — i.e. whether an index is usable for this query shape at all
 * (a handful of test rows would otherwise always seq-scan).
 */
export async function indexesUsed(
  client: Client,
  sql: string,
  params: unknown[],
): Promise<string[]> {
  await client.query("BEGIN")
  try {
    await client.query("SET LOCAL enable_seqscan = off")
    const result = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)
    const names: string[] = []
    const walk = (node: Record<string, unknown>) => {
      if (typeof node["Index Name"] === "string") names.push(node["Index Name"] as string)
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? [])
        walk(child)
    }
    walk(
      (result.rows[0]["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>)[0].Plan,
    )
    return names
  } finally {
    await client.query("ROLLBACK")
  }
}
