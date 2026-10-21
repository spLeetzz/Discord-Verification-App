/**
 * The block list.
 *
 * The bug this prevents: Quotient looked records up by `block_id` alone,
 * so a user and a guild that happened to share an id collided — and
 * unblocking one of them unblocked the other.
 *
 * The last block of this file is proved against the live database: the
 * key is the id *and* the kind, and the database says so.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { closeDatabase } from "../../db/client.js";
import { BLOCK_ID_TYPE, BlocklistCache, blocklistKey } from "./blocklist.js";
import {
  deleteBlocklistEntry,
  insertBlocklistEntry,
  loadBlocklist,
} from "./repo.js";
import type { BlocklistEntry } from "./types.js";

/**
 * The database this file runs against.
 *
 * **A file of its own.** SQLite has one writer, so two test files that
 * shared a database file would fight over it and fail with
 * `SQLITE_BUSY`. The file is in the system temporary directory, and it is
 * dropped when the run ends.
 *
 * The client reads `DB_FILE` when it is imported and applies the
 * migrations to it as it goes, so the variable has to be set *before*
 * the import of `db/client.js` — which is what `vi.hoisted` is for.
 */
const { databaseFile } = vi.hoisted(() => {
  const directory = process.env.TMPDIR || process.env.TEMP || "/tmp";
  const file = `${directory}/quotient-moderation-blocklist-${process.pid}-${Math.random().toString(36).slice(2)}.db`;

  process.env.DB_FILE = file;

  return { databaseFile: file };
});

/** An id no real row can have. */
const SHARED_ID = "blocklist-test-shared-id";

/** An entry, with the parts a test cares about overridden. */
function entry(overrides: Partial<BlocklistEntry> = {}): BlocklistEntry {
  return {
    blockId: "123",
    blockIdType: BLOCK_ID_TYPE.user,
    blockedBy: "moderator",
    reason: "being rude",
    ...overrides,
  };
}

describe("blocklistKey", () => {
  it("keeps a user and a guild apart when they share an id", () => {
    expect(blocklistKey("123", BLOCK_ID_TYPE.user)).not.toBe(
      blocklistKey("123", BLOCK_ID_TYPE.guild),
    );
  });
});

describe("BlocklistCache", () => {
  it("starts empty", () => {
    const cache = new BlocklistCache(async () => []);

    expect(cache.size).toBe(0);
    expect(cache.isBlocked("123")).toBe(false);
  });

  it("blocks what the loader returned", async () => {
    const cache = new BlocklistCache(async () => [entry()]);

    await cache.refresh();

    expect(cache.isBlocked("123", BLOCK_ID_TYPE.user)).toBe(true);
    expect(cache.size).toBe(1);
  });

  it("does not block a guild that shares an id with a blocked user", async () => {
    const cache = new BlocklistCache(async () => [
      entry({ blockId: "123", blockIdType: BLOCK_ID_TYPE.user }),
    ]);

    await cache.refresh();

    expect(cache.isBlocked("123", BLOCK_ID_TYPE.user)).toBe(true);
    expect(cache.isBlocked("123", BLOCK_ID_TYPE.guild)).toBe(false);
  });

  it("blocks a guild that shares an id with a blocked user", async () => {
    // The other direction: the guild is blocked, the user is not.
    const cache = new BlocklistCache(async () => [
      entry({ blockId: "123", blockIdType: BLOCK_ID_TYPE.guild }),
    ]);

    await cache.refresh();

    expect(cache.isBlocked("123", BLOCK_ID_TYPE.guild)).toBe(true);
    expect(cache.isBlocked("123", BLOCK_ID_TYPE.user)).toBe(false);
  });

  it("defaults to asking about a user", async () => {
    const cache = new BlocklistCache(async () => [
      entry({ blockId: "123", blockIdType: BLOCK_ID_TYPE.user }),
    ]);

    await cache.refresh();

    expect(cache.isBlocked("123")).toBe(true);
  });

  it("keeps what it had when the loader fails", async () => {
    let fail = false;

    const cache = new BlocklistCache(async () => {
      if (fail) throw new Error("the database is down");
      return [entry()];
    });

    await cache.refresh();
    expect(cache.isBlocked("123")).toBe(true);

    fail = true;
    await cache.refresh();

    // A database blip must not unblock everybody.
    expect(cache.isBlocked("123")).toBe(true);
  });

  it("hands out the entry, so the reason can be shown", async () => {
    const cache = new BlocklistCache(async () => [entry()]);

    await cache.refresh();

    expect(cache.get("123")?.reason).toBe("being rude");
  });
});

describe("the block list in the database", () => {
  afterAll(async () => {
    await closeDatabase();

    rmSync(databaseFile, { force: true });
  });

  it("keeps a user and a guild with the same id apart", async () => {
    await insertBlocklistEntry({
      blockId: SHARED_ID,
      blockIdType: BLOCK_ID_TYPE.user,
      blockedBy: "moderator",
      reason: "a user",
    });

    await insertBlocklistEntry({
      blockId: SHARED_ID,
      blockIdType: BLOCK_ID_TYPE.guild,
      blockedBy: "moderator",
      reason: "a guild",
    });

    const stored = (await loadBlocklist()).filter(
      (row) => row.blockId === SHARED_ID,
    );

    // Two entries, not one: the key is the id *and* the kind.
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.blockIdType).sort()).toEqual(["1", "2"]);
  });

  it("unblocks one kind without unblocking the other", async () => {
    const id = "blocklist-test-unblock-id";

    await insertBlocklistEntry({
      blockId: id,
      blockIdType: BLOCK_ID_TYPE.user,
      blockedBy: "moderator",
      reason: "a user",
    });

    await insertBlocklistEntry({
      blockId: id,
      blockIdType: BLOCK_ID_TYPE.guild,
      blockedBy: "moderator",
      reason: "a guild",
    });

    await deleteBlocklistEntry(id, BLOCK_ID_TYPE.guild);

    const stored = (await loadBlocklist()).filter((row) => row.blockId === id);

    // The user is still blocked.
    expect(stored).toHaveLength(1);
    expect(stored[0]?.blockIdType).toBe(BLOCK_ID_TYPE.user);
  });

  it("refuses a second entry for the same id and kind", async () => {
    const id = "blocklist-test-twin-id";

    await insertBlocklistEntry({
      blockId: id,
      blockIdType: BLOCK_ID_TYPE.user,
      blockedBy: "moderator",
      reason: "the first one",
    });

    await insertBlocklistEntry({
      blockId: id,
      blockIdType: BLOCK_ID_TYPE.user,
      blockedBy: "moderator",
      reason: "the second one",
    });

    const stored = (await loadBlocklist()).filter((row) => row.blockId === id);

    expect(stored).toHaveLength(1);
    expect(stored[0]?.reason).toBe("the first one");
  });
});
