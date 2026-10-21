/**
 * The block list.
 *
 * The bug this prevents: Quotient looked records up by `block_id` alone,
 * so a user and a guild that happened to share an id collided — and
 * unblocking one of them unblocked the other.
 */

import { describe, expect, it } from "vitest";
import { BLOCK_ID_TYPE, BlocklistCache, blocklistKey } from "./blocklist.js";
import type { BlocklistEntry } from "./types.js";

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
