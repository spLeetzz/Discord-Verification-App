/**
 * The purge rules.
 *
 * These are the tests that matter most in this area: the filters decide
 * what gets deleted, and Discord's fourteen-day rule decides what it is
 * even allowed to delete. A filter that selects the wrong messages is
 * data loss.
 */

import { describe, expect, it } from "vitest";
import {
  BULK_DELETE_BATCH_SIZE,
  BULK_DELETE_MAX_AGE_MS,
  CONTAINS_MIN_LENGTH,
  chunkForBulkDelete,
  isTooOld,
  matchesFilter,
  partitionByAge,
  validateContains,
} from "./purge.js";
import type { PurgeMessage } from "./types.js";

/** A fixed instant, so the tests never depend on the clock. */
const NOW = 1_700_000_000_000;

/** A message, with the parts a test cares about overridden. */
function message(overrides: Partial<PurgeMessage> = {}): PurgeMessage {
  return {
    id: "1",
    createdAt: NOW - 1_000,
    pinned: false,
    content: "hello",
    authorId: "user-1",
    authorIsBot: false,
    webhookId: null,
    embedCount: 0,
    attachmentCount: 0,
    reactionCount: 0,
    ...overrides,
  };
}

describe("matchesFilter", () => {
  it("`all` takes everything that is not pinned", () => {
    expect(matchesFilter(message(), { kind: "all" })).toBe(true);
    expect(matchesFilter(message({ pinned: true }), { kind: "all" })).toBe(
      false,
    );
  });

  it("`embeds` takes the messages that carry an embed", () => {
    expect(matchesFilter(message({ embedCount: 1 }), { kind: "embeds" })).toBe(
      true,
    );
    expect(matchesFilter(message(), { kind: "embeds" })).toBe(false);
  });

  it("`files` takes the messages that carry an attachment", () => {
    expect(
      matchesFilter(message({ attachmentCount: 1 }), { kind: "files" }),
    ).toBe(true);
    expect(matchesFilter(message(), { kind: "files" })).toBe(false);
  });

  it("`images` takes the messages that carry either", () => {
    expect(matchesFilter(message({ embedCount: 1 }), { kind: "images" })).toBe(
      true,
    );
    expect(
      matchesFilter(message({ attachmentCount: 2 }), { kind: "images" }),
    ).toBe(true);
    expect(matchesFilter(message(), { kind: "images" })).toBe(false);
  });

  it("`user` takes one author's messages", () => {
    expect(
      matchesFilter(message({ authorId: "user-2" }), {
        kind: "user",
        userId: "user-1",
      }),
    ).toBe(false);
    expect(
      matchesFilter(message({ authorId: "user-1" }), {
        kind: "user",
        userId: "user-1",
      }),
    ).toBe(true);
  });

  it("`contains` takes the messages that hold the substring", () => {
    expect(
      matchesFilter(message({ content: "the quick brown fox" }), {
        kind: "contains",
        text: "quick",
      }),
    ).toBe(true);
    expect(
      matchesFilter(message({ content: "the quick brown fox" }), {
        kind: "contains",
        text: "slow",
      }),
    ).toBe(false);
  });

  it("`bot` takes a bot's own messages", () => {
    expect(
      matchesFilter(message({ authorIsBot: true }), {
        kind: "bot",
        prefix: null,
      }),
    ).toBe(true);
    expect(
      matchesFilter(message({ authorIsBot: false }), {
        kind: "bot",
        prefix: null,
      }),
    ).toBe(false);
  });

  it("`bot` does not take a bot's webhooks", () => {
    // Quotient's predicate: a webhook is not a bot, unless the message
    // starts with the prefix the moderator gave.
    expect(
      matchesFilter(
        message({ authorIsBot: true, webhookId: "webhook-1" }),
        { kind: "bot", prefix: null },
      ),
    ).toBe(false);
  });

  it("`bot` takes a webhook's message when it starts with the prefix", () => {
    expect(
      matchesFilter(
        message({
          authorIsBot: true,
          webhookId: "webhook-1",
          content: "!ping",
        }),
        { kind: "bot", prefix: "!" },
      ),
    ).toBe(true);
  });

  it("`emoji` takes the messages that hold a custom emoji", () => {
    expect(
      matchesFilter(message({ content: "hi <:check:123456789012345678>" }), {
        kind: "emoji",
      }),
    ).toBe(true);
    expect(
      matchesFilter(message({ content: "hi <a:check:123456789012345678>" }), {
        kind: "emoji",
      }),
    ).toBe(true);
    expect(
      matchesFilter(message({ content: "hi <@123456789012345678>" }), {
        kind: "emoji",
      }),
    ).toBe(false);
  });

  it("`reactions` takes the messages that carry a reaction", () => {
    expect(
      matchesFilter(message({ reactionCount: 1 }), { kind: "reactions" }),
    ).toBe(true);
    expect(matchesFilter(message(), { kind: "reactions" })).toBe(false);
  });
});

describe("the fourteen-day cutoff", () => {
  it("a message exactly at the boundary is still deletable", () => {
    const atBoundary = message({ createdAt: NOW - BULK_DELETE_MAX_AGE_MS });

    expect(isTooOld(atBoundary, NOW)).toBe(false);
  });

  it("a message a millisecond past the boundary is not", () => {
    const tooOld = message({
      createdAt: NOW - BULK_DELETE_MAX_AGE_MS - 1,
    });

    expect(isTooOld(tooOld, NOW)).toBe(true);
  });

  it("splits a list into the deletable and the too old", () => {
    const fresh = message({ id: "fresh" });
    const old = message({
      id: "old",
      createdAt: NOW - BULK_DELETE_MAX_AGE_MS - 1,
    });

    const { deletable, tooOld } = partitionByAge([fresh, old], NOW);

    expect(deletable.map((m) => m.id)).toEqual(["fresh"]);
    expect(tooOld.map((m) => m.id)).toEqual(["old"]);
  });
});

describe("chunkForBulkDelete", () => {
  it("cuts a list into batches of a hundred", () => {
    const messages = Array.from({ length: 250 }, (_, index) => index);

    const chunks = chunkForBulkDelete(messages);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(BULK_DELETE_BATCH_SIZE);
    expect(chunks[1]).toHaveLength(BULK_DELETE_BATCH_SIZE);
    expect(chunks[2]).toHaveLength(50);
  });

  it("keeps every message exactly once", () => {
    const messages = Array.from({ length: 250 }, (_, index) => index);

    const flat = chunkForBulkDelete(messages).flat();

    expect(flat).toEqual(messages);
  });

  it("returns nothing for an empty list", () => {
    expect(chunkForBulkDelete([])).toEqual([]);
  });

  it("refuses a batch size of zero", () => {
    expect(() => chunkForBulkDelete([1], 0)).toThrow(RangeError);
  });
});

describe("validateContains", () => {
  it("refuses a substring of fewer than three characters", () => {
    expect(validateContains("ab")).toBe(
      `The substring length must be at least ${CONTAINS_MIN_LENGTH} characters.`,
    );
  });

  it("accepts a substring of exactly three characters", () => {
    expect(validateContains("abc")).toBeNull();
  });

  it("refuses an empty substring", () => {
    expect(validateContains("")).not.toBeNull();
  });
});
