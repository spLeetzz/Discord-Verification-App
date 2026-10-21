/**
 * The migration runner.
 *
 * The bot applies its own migrations at boot, before it does anything
 * else. There is no separate migration step in the deploy pipeline, and
 * that is deliberate: the schema and the code can never disagree, because
 * the schema is brought up to date before a single query runs.
 *
 * A migration that cannot be applied is a fatal error. The bot refuses to
 * start rather than run against a schema it does not understand.
 *
 * **Where the SQL comes from.** `db/migrations/` is a folder of generated
 * `.sql` files and a `meta/_journal.json`. It is read from the *project
 * root*, not from `dist/`, because `tsc` does not copy `.sql` files into
 * the build output — the release keeps the folder, and the runner points
 * at it.
 */

import { migrate } from "drizzle-orm/libsql/migrator";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../utils/paths.js";

/** Where the generated migrations live. */
export const MIGRATIONS_FOLDER = resolve(PROJECT_ROOT, "db/migrations");

/**
 * Applies every migration that has not been applied yet.
 *
 * Applying it twice is safe: the runner records what it has applied in a
 * `__drizzle_migrations` table and skips the rest.
 *
 * @param db the database to bring up to date.
 */
export async function applyMigrations<TSchema extends Record<string, unknown>>(
  db: LibSQLDatabase<TSchema>,
): Promise<void> {
  if (!existsSync(MIGRATIONS_FOLDER)) {
    throw new Error(
      `The migrations folder is missing: ${MIGRATIONS_FOLDER}. ` +
        "The bot cannot start without its schema.",
    );
  }

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
