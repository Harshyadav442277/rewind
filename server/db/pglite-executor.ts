/**
 * Test-only executor: a real Postgres engine, compiled to WebAssembly, running in this Node
 * process. No Docker, no service, no install beyond one dev dependency.
 *
 * Nothing in `api/` or `server/` outside the tests imports this file, and `@electric-sql/pglite`
 * is a devDependency, so it cannot reach a deployment.
 *
 * PGlite is a single-backend Postgres: it runs one session, so two overlapping JS promises
 * interleave at their await points but never execute two statements at literally the same
 * instant. That is enough to prove every compare-and-set and every unique constraint in this
 * schema, because each of those is decided inside ONE statement — which Postgres executes
 * atomically whether or not another backend exists. What it cannot reproduce is multi-session
 * lock contention and serialisation failures. That limitation is recorded in README-DEV.md.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SqlExecutor, SqlRow } from './sql-executor.js';

const here = dirname(fileURLToPath(import.meta.url));

export const SCHEMA_PATH = join(here, 'schema.sql');

/** Every table the schema creates, child-first, so one TRUNCATE can clear the lot. */
const TABLES = [
  'demo_refunds',
  'refund_executions',
  'refund_challenges',
  'merchant_nonces',
  'orders',
  'merchants',
] as const;

export interface EmbeddedPostgres extends SqlExecutor {
  /** e.g. `PostgreSQL 18.3 (PGlite 0.5.8)`. Printed by the test so the evidence names it. */
  readonly engine: string;
  /** Runs `schema.sql` verbatim. */
  applySchema(): Promise<void>;
  /** Between tests. Cheaper and stricter than dropping and recreating the schema. */
  truncateAll(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Starts an in-memory PGlite instance, or returns null when the package is not installed or
 * cannot start on this machine. The caller skips its suite in that case rather than failing —
 * `npm test` must stay runnable with no database of any kind.
 */
export async function pgliteExecutor(): Promise<EmbeddedPostgres | null> {
  // Escape hatch, and the only way to exercise the skip path on a machine where the engine
  // does start: `REWIND_NO_EMBEDDED_PG=1 npm test`.
  if (process.env.REWIND_NO_EMBEDDED_PG === '1') return null;

  let PGlite: typeof import('@electric-sql/pglite').PGlite;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch {
    return null;
  }

  let db: import('@electric-sql/pglite').PGlite;
  try {
    db = await PGlite.create();
  } catch {
    return null;
  }

  const version = await db.query<{ v: string }>('SELECT version() AS v');
  const raw = version.rows[0]?.v ?? 'unknown';
  const engine = /^([^,]+?)\s+on\s/.exec(raw)?.[1] ?? raw;

  return {
    engine,
    async query(text: string, params: readonly unknown[]): Promise<SqlRow[]> {
      const result = await db.query<SqlRow>(text, [...params]);
      return result.rows;
    },
    async applySchema(): Promise<void> {
      await db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    },
    async truncateAll(): Promise<void> {
      await db.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}
