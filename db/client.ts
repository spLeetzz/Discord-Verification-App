/**
 * The database client.
 *
 * `db/` is the SQL layer of this bot. `repo/` is the Google Sheets layer.
 * Two directories, two meanings, no confusion.
 *
 * Everything that talks to the database imports the `db` instance from here
 * and nothing else. Modules own their own queries; this file owns the
 * connection.
 *
 * **The engine is SQLite.** The bot runs on a 1-CPU, 2 GB VPS, and a
 * Postgres server would not fit in that. The schema itself is dialect
 * neutral — see `db/dialect.ts` — so a later move to Postgres is a
 * configuration change, not a rewrite.
 *
 * **The database file lives outside the release directory.** The production
 * deploy clones into a *new* directory and swaps it, so a database file
 * inside the release tree would be deleted on every deploy. `DB_FILE`
 * points at a stable path; the default is under the project root, which is
 * fine for development and wrong for production.
 *
 * **Every write goes through one queue.** SQLite has one writer, and the
 * driver hands a transaction a connection of its own — so two writes that
 * overlap in this process do not queue, they collide, and the second one
 * is refused by the *driver* with `SQLITE_BUSY` rather than by the
 * *database* with the constraint it violated. The queue in
 * `db/write-queue.ts` is in front of every write, so the loser of a race
 * is told "already locked" rather than "database busy". No module has to
 * know that it exists.
 */

import { createClient } from "@libsql/client";
import type { ResultSet } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { SQLiteTransactionConfig } from "drizzle-orm/sqlite-core";
import type { SQLWrapper } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_ROOT } from "../utils/paths.js";
import { applyMigrations } from "./migrate.js";
import * as schema from "./schema.js";
import {
  QueuedClient,
  WriteQueue,
  transactionContext,
} from "./write-queue.js";

/**
 * The default database file.
 *
 * Under a test runner every worker gets its own file. The workers run in
 * parallel and SQLite serialises its writers, so two workers on one file
 * would lock each other out — and a test failure would then be a lock
 * error rather than the thing the test was about.
 */
function defaultDatabaseFile(): string {
  const worker = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID;

  return worker ? `data/test-${worker}.db` : "data/quotient.db";
}

/**
 * Where the database file lives.
 *
 * `DB_FILE` is the whole configuration. It may be a `file:` URL or a plain
 * path; a relative path is resolved against the project root, so the same
 * `.env` works whatever directory the bot is started from.
 *
 * **In production this must be outside the release directory.** The deploy
 * clones into a fresh directory and swaps it; a database file that travels
 * with the release is a database that is thrown away on every deploy.
 *
 * @returns the absolute path of the file, or `null` for an in-memory
 *          database.
 */
function resolveDatabasePath(): string | null {
  const configured = process.env.DB_FILE?.trim() || defaultDatabaseFile();

  if (configured === ":memory:") return null;

  if (configured.startsWith("file:")) {
    return fileURLToPath(new URL(configured));
  }

  return isAbsolute(configured)
    ? configured
    : resolve(PROJECT_ROOT, configured);
}

const databasePath = resolveDatabasePath();

/**
 * The URL the driver opens.
 *
 * libsql wants a URL, not a path. A local file is `file:<path>`; the
 * in-memory database has a URL of its own.
 */
const databaseUrl =
  databasePath === null ? ":memory:" : `file:${databasePath}`;

/**
 * Creates the directory the database file lives in.
 *
 * A missing directory is the one failure mode that would otherwise show up
 * as an opaque driver error on the first query — and it has to happen
 * *before* the driver opens the file.
 */
if (databasePath !== null) {
  mkdirSync(dirname(databasePath), { recursive: true });
}

/**
 * How long a contended write waits for the writer lock.
 *
 * SQLite has one writer. Two writes at the same instant — a slot claim and
 * a command-usage row, say — would otherwise fail immediately with
 * `SQLITE_BUSY` instead of waiting their turn. Five seconds is far longer
 * than any of our transactions takes, so a timeout here means something is
 * genuinely stuck rather than merely queued.
 *
 * **The busy timeout is not the queue.** It makes a contended *statement*
 * wait; it does nothing for a statement that collides with an *open
 * transaction* on another connection, because that transaction holds the
 * write lock for its whole body. The queue in `db/write-queue.ts` is what
 * covers that case, and the timeout is what covers the case of another
 * process — a deploy's migration, say — writing the same file.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * The libsql client.
 *
 * A local file, opened through the native libsql binding. There is no
 * server, no connection string and no pool: SQLite serialises its own
 * writes, and one bot process is one writer.
 *
 * **The busy timeout is set on the client, not only by a pragma.** The
 * pragma below reaches one connection of the pool; the `timeout` option
 * is applied by the driver to *every* connection it opens, which is the
 * only way the setting reaches the connection a transaction is given.
 */
const client = createClient({ url: databaseUrl, timeout: BUSY_TIMEOUT_MS });

await client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

/**
 * The queue of writes.
 *
 * One queue for the whole process, in front of every write — the query
 * builders, the raw statements, the migrations, the seed, the retention
 * prune and the scheduler's deletes. It is in front of the *client*, so
 * nothing above `db/` has to know that it exists.
 */
const writeQueue = new WriteQueue();

/** The client the application actually talks to. */
const queuedClient = new QueuedClient(client, writeQueue);

/** The raw drizzle instance. */
const raw = drizzle(queuedClient, { schema });

/**
 * The shape of a raw statement's result.
 *
 * The Postgres driver returns `{ rows }`; libsql returns the rows
 * directly. The modules were written against the Postgres shape, so the
 * SQLite driver is given the same one and nothing above `db/` has to
 * change.
 */
export interface RawResult<TRow extends Record<string, unknown>> {
  rows: TRow[];
}

/**
 * Runs a raw statement.
 *
 * `all()` is the read path; a statement that writes returns no rows, so
 * the result is an empty list. This is the one method the SQLite driver
 * does not have under the name the modules use, so it is bolted on here
 * rather than in every call site.
 */
async function execute<TRow extends Record<string, unknown> = Record<string, unknown>>(
  query: SQLWrapper | string,
): Promise<RawResult<TRow>> {
  const rows = await raw.all<TRow>(query);

  return { rows: rows as TRow[] };
}

/**
 * The transaction handle, as drizzle spells it.
 */
type DrizzleTransaction = Parameters<
  Parameters<LibSQLDatabase<typeof schema>["transaction"]>[0]
>[0];

/**
 * drizzle's own transaction method, captured before it is replaced.
 *
 * The wrapper below calls it, and the wrapper is what `db.transaction`
 * becomes.
 */
const beginTransaction = raw.transaction as (
  body: (tx: DrizzleTransaction) => Promise<unknown>,
  config?: SQLiteTransactionConfig,
) => Promise<unknown>;

/**
 * Runs a transaction with its body inside the transaction context.
 *
 * **This is what makes the queue re-entrant.** A transaction's body
 * calls repository functions that write; those writes belong to the
 * transaction and must not go back into the queue, or the transaction
 * would wait for itself. The context carries the open transaction
 * through the async call chain, so a write issued anywhere inside the
 * body finds the transaction it belongs to.
 *
 * The signature is drizzle's, unchanged.
 */
async function transactionInContext<T>(
  body: (tx: DrizzleTransaction) => Promise<T>,
  config?: SQLiteTransactionConfig,
): Promise<T> {
  const result = await beginTransaction.call(
    raw,
    async (tx) => {
      const handle = tx as Transaction;

      if (typeof handle.execute !== "function") {
        handle.execute = execute;
      }

      return transactionContext.run(queuedClient.activeTransaction, () =>
        body(handle),
      );
    },
    config,
  );

  return result as T;
}

/** The drizzle instance every module queries through. */
export const db: LibSQLDatabase<typeof schema> & {
  execute: typeof execute;
} = Object.assign(raw, { execute, transaction: transactionInContext });

/** The schema object, for `drizzle(client, { schema })` and for `db.query.*`. */
export { schema };

/**
 * The migrations, applied.
 *
 * The bot brings its own schema up to date before it does anything else,
 * and refuses to start if it cannot. There is no migration step in the
 * deploy pipeline, so the schema and the code can never disagree.
 *
 * The failure is loud on purpose: a bot running against a schema it does
 * not understand is worse than a bot that does not start.
 */
try {
  await applyMigrations(db);
} catch (error) {
  console.error(
    "[db] The schema could not be brought up to date. Refusing to start.",
    error,
  );

  throw error;
}

/**
 * The transaction handle.
 *
 * The same handle the Postgres driver handed out, plus the raw-statement
 * method.
 */
export type Transaction = DrizzleTransaction & {
  execute: typeof execute;
};

/**
 * Anything that can run a statement: the database or a transaction.
 *
 * The Postgres driver handed out one type for both, and so does this one:
 * a drizzle transaction *is* a database, as far as the query builder is
 * concerned. The modules take an executor so that a statement can run
 * inside a transaction or outside one.
 */
export type DbExecutor = BaseSQLiteDatabase<
  "async",
  ResultSet,
  typeof schema
> & {
  execute: typeof execute;
};

/**
 * Runs `fn` inside a transaction.
 *
 * The transaction is committed when `fn` resolves and rolled back when it
 * throws or rejects — including a rejection from a call it forgot to await.
 * `fn` receives the transaction handle, so every statement inside it runs
 * on the same connection.
 *
 * Use it for anything that has to be atomic: claiming a slot and writing
 * the claim log, swapping two tourney slot numbers, activating a premium
 * purchase and writing the entitlement row.
 *
 * **A transaction holds the write queue for its whole body**, so no other
 * write in the process runs while it is open. That is the same rule
 * SQLite itself applies — there is one writer — except that the loser of
 * a race now waits its turn instead of being refused by the driver.
 *
 * SQLite has no `SELECT … FOR UPDATE`; the write lock the transaction
 * takes is the equivalent, and the premium grant's conditional `UPDATE`
 * is the real protection.
 */
export async function withTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return transactionInContext(async (tx) => fn(tx as Transaction));
}

/**
 * Closes the database. Call it on shutdown so the process can exit instead
 * of waiting for the driver's idle timeout.
 *
 * The queue is drained first, so a write that is already in flight is not
 * cut off by the close.
 */
export async function closeDatabase(): Promise<void> {
  await writeQueue.drain();

  queuedClient.close();
}
