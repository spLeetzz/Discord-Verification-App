/**
 * The write queue, proved against a real SQLite database.
 *
 * The hazard this file exists for: SQLite has one writer, the libsql
 * driver gives a transaction a connection of its own, and two writes
 * that overlap in one process do not queue — they collide. The second
 * one is refused by the *driver* with `SQLITE_BUSY`, which is not an
 * answer a caller can act on. The loser of a race has to be told
 * "already locked", because only that is the database's answer.
 *
 * So these tests assert three things:
 *
 *  - two writes that overlap do not produce a busy error;
 *  - a transaction and a write outside it do not collide — the outside
 *    write waits its turn;
 *  - a transaction whose body writes does not deadlock against itself,
 *    and the race it loses is still the constraint's to decide.
 *
 * **No server is involved.** The database is a file in the system
 * temporary directory, created and dropped with the test run.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";

/** The database this run uses. Dropped when the run ends. */
const directory = mkdtempSync(join(tmpdir(), "quotient-queue-test-"));

process.env.DB_FILE = join(directory, "queue-test.db");

const { closeDatabase, db, withTransaction } = await import("./client.js");
const { tags } = await import("./schema.js");

/**
 * A guild id no real row can have, unique to this test run.
 *
 * Every test gets one of its own, so that a test only ever sees the
 * rows it wrote.
 */
function guildId(name: string): string {
  return `queue-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The guilds this file used, so they can be cleaned up. */
const usedGuilds: string[] = [];

/**
 * The extended SQLite error code of a failure.
 *
 * `SQLITE_CONSTRAINT_UNIQUE` for a unique index, `SQLITE_BUSY` for a
 * contended write. Drizzle wraps the driver's error, so the code is on
 * the `cause`.
 */
function sqliteErrorCode(error: unknown): string | undefined {
  const candidate = error as
    | { extendedCode?: string; code?: string; cause?: unknown }
    | undefined;

  if (candidate?.extendedCode) return candidate.extendedCode;
  if (candidate?.code) return candidate.code;

  return sqliteErrorCode(candidate?.cause);
}

/** Is this the "the database is locked" error? */
function isBusy(error: unknown): boolean {
  const code = sqliteErrorCode(error);

  if (code === "SQLITE_BUSY") return true;

  const message = (error as { readonly message?: unknown } | undefined)?.message;

  return (
    typeof message === "string" &&
    (message.includes("SQLITE_BUSY") || message.includes("database is locked"))
  );
}

/** Waits for a while, so that a queued write has had its chance. */
function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The names of the tags of one guild. */
async function tagNames(guild: string): Promise<string[]> {
  const rows = await db
    .select({ name: tags.name })
    .from(tags)
    .where(eq(tags.guildId, guild));

  return rows.map((row) => row.name).sort();
}

afterAll(async () => {
  if (usedGuilds.length > 0) {
    await db.delete(tags).where(inArray(tags.guildId, usedGuilds));
  }

  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

describe("db/write-queue", () => {
  it("answers a contended write with the constraint, not with SQLITE_BUSY", async () => {
    const guild = guildId("contended");

    usedGuilds.push(guild);

    const attempts = await Promise.allSettled([
      db.insert(tags).values({
        guildId: guild,
        name: "contended",
        content: "the first one",
        ownerId: "1",
      }),
      db.insert(tags).values({
        guildId: guild,
        name: "contended",
        content: "the second one",
        ownerId: "2",
      }),
    ]);

    const refused = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );

    // One of them won; the other was refused.
    expect(refused).toHaveLength(1);

    const failure = refused[0]?.reason as unknown;

    // **The important assertion.** The loser was told what the database
    // says — the unique constraint — and not what the driver says.
    expect(isBusy(failure)).toBe(false);
    expect(sqliteErrorCode(failure)).toBe("SQLITE_CONSTRAINT_UNIQUE");
  });

  it("makes a write outside a transaction wait for the transaction", async () => {
    const guild = guildId("outside");

    usedGuilds.push(guild);

    let openTheGate!: () => void;

    const gate = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });

    const transaction = withTransaction(async (tx) => {
      await tx.insert(tags).values({
        guildId: guild,
        name: "inside",
        content: "written inside the transaction",
        ownerId: "1",
      });

      // The transaction holds the write lock — and the queue — until it
      // is finished.
      await gate;
    });

    // Let the transaction take the lock.
    await pause(50);

    let outsideDone = false;

    const outside = db
      .insert(tags)
      .values({
        guildId: guild,
        name: "outside",
        content: "written outside the transaction",
        ownerId: "2",
      })
      .then(() => {
        outsideDone = true;
      });

    // The write outside the transaction is waiting for its turn: it did
    // not collide with the open transaction.
    await pause(50);

    expect(outsideDone).toBe(false);

    openTheGate();

    await transaction;
    await outside;

    expect(outsideDone).toBe(true);
    expect(await tagNames(guild)).toEqual(["inside", "outside"]);
  });

  it("lets a transaction body write through the database handle", async () => {
    const guild = guildId("inner");

    usedGuilds.push(guild);

    // The body writes through the transaction handle, and then through
    // the database handle — the way a repository function that writes
    // would. The second write must not go back into the queue: the
    // transaction is holding it.
    await withTransaction(async (tx) => {
      await tx.insert(tags).values({
        guildId: guild,
        name: "outer",
        content: "written through the transaction handle",
        ownerId: "1",
      });

      await db.insert(tags).values({
        guildId: guild,
        name: "inner",
        content: "written through the database handle",
        ownerId: "2",
      });
    });

    // Both writes are there: the inner one joined the transaction rather
    // than waiting for it.
    expect(await tagNames(guild)).toEqual(["inner", "outer"]);
  });

  it("rolls the inner write back with the transaction that made it", async () => {
    const guild = guildId("rollback");

    usedGuilds.push(guild);

    await expect(
      withTransaction(async (tx) => {
        await tx.insert(tags).values({
          guildId: guild,
          name: "outer",
          content: "written through the transaction handle",
          ownerId: "1",
        });

        await db.insert(tags).values({
          guildId: guild,
          name: "inner",
          content: "written through the database handle",
          ownerId: "2",
        });

        throw new Error("the body failed");
      }),
    ).rejects.toThrow("the body failed");

    // Neither write survived: the inner one was part of the transaction.
    expect(await tagNames(guild)).toEqual([]);
  });

  it("lets a transaction inside a transaction join it", async () => {
    const guild = guildId("nested");

    usedGuilds.push(guild);

    // The nested transaction cannot take the queue — the outer one is
    // holding it — so it becomes a savepoint on the outer connection.
    await withTransaction(async (tx) => {
      await tx.insert(tags).values({
        guildId: guild,
        name: "outer",
        content: "written by the outer transaction",
        ownerId: "1",
      });

      await withTransaction(async (nested) => {
        await nested.insert(tags).values({
          guildId: guild,
          name: "inner",
          content: "written by the nested transaction",
          ownerId: "2",
        });
      });
    });

    expect(await tagNames(guild)).toEqual(["inner", "outer"]);
  });

  it("lets the constraint decide the race, not the driver", async () => {
    const guild = guildId("locked");

    usedGuilds.push(guild);

    // The shape the moderation area uses: a subject that may only be
    // locked once, and a second attempt that has to be told "already
    // locked" rather than "database busy".
    const outcomes = await Promise.all([claim(guild), claim(guild)]);

    expect(outcomes.sort()).toEqual(["already locked", "claimed"]);
    expect(await tagNames(guild)).toEqual(["locked"]);
  });

  it("does not make a read wait for a write", async () => {
    const guild = guildId("read");

    usedGuilds.push(guild);

    let openTheGate!: () => void;

    const gate = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });

    const transaction = withTransaction(async (tx) => {
      await tx.insert(tags).values({
        guildId: guild,
        name: "read-behind",
        content: "written inside the transaction",
        ownerId: "1",
      });

      await gate;
    });

    await pause(50);

    let readDone = false;

    const read = db
      .select({ count: sql<number>`count(*)` })
      .from(tags)
      .where(eq(tags.guildId, guild))
      .then((rows) => {
        readDone = true;

        return rows;
      });

    // The read did not wait for the transaction: a read must not be
    // behind a long write.
    await pause(50);

    expect(readDone).toBe(true);

    openTheGate();

    await transaction;
    await read;
  });
});

/**
 * Claims a subject that may only be claimed once.
 *
 * @returns "claimed" for the winner and "already locked" for the loser.
 *          The loser is told what the *constraint* says; a busy error
 *          would escape as a failure instead.
 */
async function claim(guild: string): Promise<"claimed" | "already locked"> {
  const rows = await withTransaction(async (tx) =>
    tx
      .insert(tags)
      .values({
        guildId: guild,
        name: "locked",
        content: "claimed",
        ownerId: "1",
      })
      .onConflictDoNothing()
      .returning({ id: tags.id }),
  );

  return rows.length === 0 ? "already locked" : "claimed";
}
