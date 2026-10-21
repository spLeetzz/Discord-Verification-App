/**
 * Retention policies.
 *
 * `command_usage` grows by one row per command invocation and nothing ever
 * removed those rows in the source. S10 gives the table a 30-day window and
 * a daily prune.
 *
 * The prune itself is a delete, so it is idempotent: running it twice in a
 * row deletes nothing the second time, and a crash halfway through leaves
 * the table in a valid state.
 */

import { lt } from "drizzle-orm";
import { db } from "./client.js";
import { commandUsage } from "./schema.js";

/** How long a command-usage row is kept. */
export const COMMAND_USAGE_RETENTION_DAYS = 30;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes command-usage rows older than the retention window.
 *
 * Returns the number of rows removed, so the caller can log it. The
 * scheduler calls this once a day; the function does not schedule anything
 * itself.
 */
export async function pruneCommandUsage(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - COMMAND_USAGE_RETENTION_DAYS * DAY_IN_MS);

  // `lt()` rather than a hand-written fragment: the comparison goes through
  // the column, so the `Date` is encoded the way the column stores it —
  // epoch milliseconds on SQLite, a timestamp on Postgres.
  const deleted = await db
    .delete(commandUsage)
    .where(lt(commandUsage.createdAt, cutoff))
    .returning({ id: commandUsage.id });

  return deleted.length;
}
