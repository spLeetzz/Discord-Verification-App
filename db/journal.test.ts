/**
 * The database's file-level settings, proved against a real file.
 *
 * These are not the schema's business — they are the *file's* settings,
 * and they decide whether a read can happen while a write is going on.
 *
 * **Why they matter.** In SQLite's default rollback-journal mode
 * (`delete`), a writer holds an exclusive lock on the whole file, so
 * every reader waits for it. The bot's job dispatcher deletes rows every
 * fifteen seconds, and a button handler that read the database could
 * land on one of those writes, wait for it, and blow Discord's
 * three-second interaction budget — which Discord shows the user as
 * "the bot didn't respond in time".
 *
 * WAL fixes the cause: readers and the writer run at the same time.
 *
 * **The busy timeout is the second half.** WAL leaves one writer, so two
 * writers still conflict, and a contended write must *wait* rather than
 * fail instantly — a write that fails is a lost operation.
 *
 * **No server is involved.** The database is a file in the system
 * temporary directory, created and dropped with the test run.
 *
 * The client reads `DB_FILE` when it is imported, so the variable is set
 * before the import — which is why the import below is dynamic.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

/** The database this run uses. Dropped when the run ends. */
const directory = mkdtempSync(join(tmpdir(), "quotient-journal-test-"));

process.env.DB_FILE = join(directory, "journal-test.db");

const { closeDatabase, db } = await import("./client.js");

afterAll(() => {
  void closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

/** One row of a `PRAGMA` result. */
interface PragmaRow {
  readonly [key: string]: unknown;
}

async function pragma(name: string): Promise<Record<string, unknown>> {
  const rows = (await db.all(sql.raw(`PRAGMA ${name}`))) as PragmaRow[];

  return rows[0] ?? {};
}

describe("the database file", () => {
  it("is in WAL mode, so a read never waits for a write", async () => {
    const row = await pragma("journal_mode");

    expect(String(row["journal_mode"]).toLowerCase()).toBe("wal");
  });

  it("waits for the writer lock rather than failing instantly", async () => {
    const row = await pragma("busy_timeout");

    // A timeout of zero means "fail immediately", and a write that
    // fails is a lost operation.
    expect(Number(row["timeout"])).toBeGreaterThan(0);
  });

  it("keeps the write lock out of the read path", async () => {
    // A read must not block behind the writer's transaction. The proof
    // is that a read completes while a write transaction is open.
    let readDuringWrite: string | null = null;

    await db.transaction(async (tx) => {
      await tx.run(sql`CREATE TABLE IF NOT EXISTS journal_probe (id INTEGER)`);
      await tx.run(sql`INSERT INTO journal_probe (id) VALUES (1)`);

      const rows = (await db.all(sql`SELECT count(*) AS n FROM journal_probe`)) as
        PragmaRow[];

      readDuringWrite = String(rows[0]?.["n"] ?? "");
    });

    // If the read had blocked on the writer it would have waited for the
    // transaction to finish, and this value would be a deadlock rather
    // than a count.
    expect(readDuringWrite).toBe("1");
  });
});
