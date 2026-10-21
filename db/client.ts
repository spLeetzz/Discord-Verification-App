/**
 * The Postgres client.
 *
 * `db/` is the Postgres layer of this bot. `repo/` is the Google Sheets
 * layer. Two directories, two meanings, no confusion.
 *
 * Everything that talks to the database imports the `db` instance from here
 * and nothing else. Modules own their own queries; this file owns the
 * connection.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requireEnv } from "../utils/env.js";
import * as schema from "./schema.js";

/**
 * The pool.
 *
 * Ten connections is plenty for a single bot process: the bot issues a
 * handful of queries at a time and the scheduler runs one query per tick.
 * The connection timeout matters more than the size — without it, a database
 * that is down leaves every request hanging until the socket times out.
 */
const pool = new Pool({
  connectionString: requireEnv("DATABASE_URL"),
  max: 10,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

/**
 * A dropped connection (server restart, network blip) must not take the
 * process down. `pg` emits it here; without a listener Node would treat it
 * as an unhandled error and exit.
 */
pool.on("error", (error) => {
  console.error("[db] idle client error:", error);
});

/** The drizzle instance every module queries through. */
export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

/** The schema object, for `drizzle(pool, { schema })` and for `db.query.*`. */
export { schema };

/**
 * Runs `fn` inside a transaction.
 *
 * The transaction is committed when `fn` resolves and rolled back when it
 * throws or rejects — including a rejection from a call it forgot to await.
 * `fn` receives the transaction handle, so every statement inside it runs on
 * the same connection.
 *
 * Use it for anything that has to be atomic: claiming a slot and writing the
 * claim log, swapping two tourney slot numbers, activating a premium
 * purchase and writing the entitlement row.
 */
export async function withTransaction<T>(
  fn: (tx: NodePgDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}

/**
 * Closes the pool. Call it on shutdown so the process can exit instead of
 * waiting for the pool's idle timeout.
 */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}
