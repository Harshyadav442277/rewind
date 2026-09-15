/**
 * The one seam between `PostgresRepository` and a database engine.
 *
 * The repository used to construct a Neon client itself, which made it impossible to run a
 * single statement in a test: the only way to execute anything was to reach a Neon endpoint
 * over the network. Everything below the tagged template is now behind `SqlExecutor`, so the
 * *same* SQL text and the *same* parameters go to Neon in production and to an embedded
 * Postgres in the test suite.
 *
 * The tag is deliberately kept, rather than rewriting every statement as a string plus an
 * array, because the SQL in `postgres.ts` is the thing under test. It must not be edited into
 * a different shape just to make it testable.
 */

import { neon } from '@neondatabase/serverless';

export type SqlRow = Record<string, unknown>;

/**
 * Minimal contract an engine has to meet: run parameterised SQL, give back rows.
 * `$1 … $n` placeholders, positional parameters, one statement per call.
 */
export interface SqlExecutor {
  query(text: string, params: readonly unknown[]): Promise<SqlRow[]>;
  /** Optional: embedded engines hold a handle a test has to release. */
  close?(): Promise<void>;
}

/** What the repository actually calls. A tagged template over an executor. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<SqlRow[]>;

/**
 * Turns `sql\`SELECT … WHERE id = ${id}\`` into `("SELECT … WHERE id = $1", [id])`.
 * Nothing is interpolated into the text, so there is no injection surface: every value
 * becomes a bind parameter, exactly as with the Neon tag it replaces.
 */
export function taggedFor(executor: SqlExecutor): SqlTag {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? '';
    for (let i = 0; i < values.length; i += 1) {
      text += `$${i + 1}${strings[i + 1] ?? ''}`;
    }
    return executor.query(text, values);
  };
}

/**
 * Production executor. Wraps `@neondatabase/serverless`'s HTTP driver.
 *
 * The driver's callable form takes `(text, params)` and resolves to rows, which is exactly
 * `SqlExecutor`. It has run in production on Vercel against Neon since 2026-09-14: orders,
 * merchants, challenges and refund executions are written and read back through it (for
 * example order `a002870307c998de`, REFUNDED). What production has NOT shown is the unique-
 * violation path (`code 23505` plus `constraint`) under a real race, or a dropped connection;
 * the embedded-Postgres tests pin the SQL and the row mapping, not the driver.
 */
export function neonExecutor(connectionString: string): SqlExecutor {
  if (!connectionString) throw new Error('neonExecutor: empty connection string');
  const sql = neon(connectionString);
  return {
    async query(text: string, params: readonly unknown[]): Promise<SqlRow[]> {
      return (await sql(text, [...params])) as SqlRow[];
    },
  };
}
