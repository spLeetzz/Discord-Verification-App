/**
 * The duplicate-screenshot check.
 *
 * The threshold is the interesting part: the check has to fire **at** the
 * threshold and not one bit later, and a stored hash that is not a hash has
 * to fail loudly rather than compare as "a different picture".
 */

import { describe, expect, it } from "vitest";
import {
  findDuplicate,
  MalformedHashError,
  safeHammingDistance,
  submissionJumpUrl,
} from "./duplicate.js";
import type { StoredSubmission } from "./duplicate.js";

/** The threshold the port runs with. */
const THRESHOLD = 7;

/**
 * A stored submission.
 *
 * The default hashes are two different pictures that are far apart; every
 * test says what it needs.
 */
function stored(overrides: Partial<StoredSubmission> = {}): StoredSubmission {
  return {
    id: "row-1",
    authorId: "author-1",
    channelId: "channel-1",
    messageId: "message-1",
    dhash: "0000000000000000",
    phash: "1111111111111111",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * A hash that is exactly `bits` bits away from `base`.
 *
 * The first `bits` bits of the hex are flipped one by one, from the most
 * significant end.
 */
function bitsAway(base: string, bits: number): string {
  let value = BigInt(`0x${base}`);

  for (let index = 0; index < bits; index += 1) {
    value ^= 1n << BigInt(64 - 1 - index);
  }

  return value.toString(16).padStart(16, "0");
}

describe("safeHammingDistance", () => {
  it("counts the bits that differ", () => {
    expect(safeHammingDistance("0000000000000000", "0000000000000001")).toBe(1);
  });

  it("is zero for the same hash", () => {
    expect(safeHammingDistance("abcdef0123456789", "abcdef0123456789")).toBe(0);
  });

  it("refuses a hash that is too short", () => {
    expect(() => safeHammingDistance("abc", "0000000000000000")).toThrow(
      MalformedHashError,
    );
  });

  it("refuses a hash that is not hex", () => {
    expect(() =>
      safeHammingDistance("zzzzzzzzzzzzzzzz", "0000000000000000"),
    ).toThrow(MalformedHashError);
  });
});

describe("findDuplicate", () => {
  it("finds the member's own picture", () => {
    const candidate = {
      authorId: "author-1",
      dhash: bitsAway("0000000000000000", 3),
      phash: "2222222222222222",
    };

    const duplicate = findDuplicate(candidate, [stored()], THRESHOLD);

    expect(duplicate?.kind).toBe("own");
    expect(duplicate?.submission.id).toBe("row-1");
  });

  it("fires exactly at the threshold", () => {
    const candidate = {
      authorId: "author-1",
      dhash: bitsAway("0000000000000000", THRESHOLD),
      phash: "2222222222222222",
    };

    expect(findDuplicate(candidate, [stored()], THRESHOLD)?.kind).toBe("own");
  });

  it("does not fire one bit past the threshold", () => {
    const candidate = {
      authorId: "author-1",
      dhash: bitsAway("0000000000000000", THRESHOLD + 1),
      phash: "2222222222222222",
    };

    expect(findDuplicate(candidate, [stored()], THRESHOLD)).toBeNull();
  });

  it("finds somebody else's identical picture", () => {
    const candidate = {
      authorId: "author-2",
      dhash: "0000000000000000",
      phash: "1111111111111111",
    };

    const duplicate = findDuplicate(candidate, [stored()], THRESHOLD);

    expect(duplicate?.kind).toBe("same");
    expect(duplicate?.submission.authorId).toBe("author-1");
  });

  it("ignores another member's near-identical picture", () => {
    // The first check is about the member's **own** submissions. Somebody
    // else's picture that is a bit off is a different picture.
    const candidate = {
      authorId: "author-2",
      dhash: bitsAway("0000000000000000", 2),
      phash: "2222222222222222",
    };

    expect(findDuplicate(candidate, [stored()], THRESHOLD)).toBeNull();
  });

  it("finds the member's own picture among other people's", () => {
    const candidate = {
      authorId: "author-2",
      dhash: bitsAway("ffffffffffffffff", 1),
      phash: "3333333333333333",
    };

    const rows = [
      stored({ id: "row-1", authorId: "author-1" }),
      stored({ id: "row-2", authorId: "author-2", dhash: "ffffffffffffffff" }),
    ];

    const duplicate = findDuplicate(candidate, rows, THRESHOLD);

    expect(duplicate?.kind).toBe("own");
    expect(duplicate?.submission.id).toBe("row-2");
  });

  it("skips a submission that has no hash at all", () => {
    // An absent hash is not a malformed hash: there is nothing to
    // compare, so the row is passed over.
    const candidate = {
      authorId: "author-1",
      dhash: "0000000000000000",
      phash: "1111111111111111",
    };

    const rows = [stored({ dhash: null, phash: null })];

    expect(findDuplicate(candidate, rows, THRESHOLD)).toBeNull();
  });

  it("refuses a stored hash that is malformed", () => {
    // A truncated row must not compare as "a different picture" — a
    // duplicate that hides itself lets a member farm the role.
    const candidate = {
      authorId: "author-1",
      dhash: "0000000000000000",
      phash: "1111111111111111",
    };

    expect(() =>
      findDuplicate(candidate, [stored({ dhash: "abc" })], THRESHOLD),
    ).toThrow(MalformedHashError);
  });

  it("names the stored hash that was malformed", () => {
    const candidate = {
      authorId: "author-1",
      dhash: "0000000000000000",
      phash: "1111111111111111",
    };

    try {
      findDuplicate(candidate, [stored({ dhash: "abc" })], THRESHOLD);
      expect.unreachable("the malformed hash should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedHashError);
      // The malformed hash is the **stored** one, not the candidate's.
      expect((error as MalformedHashError).hash).toBe("abc");
    }
  });

  it("answers null when there is nothing stored", () => {
    const candidate = {
      authorId: "author-1",
      dhash: "0000000000000000",
      phash: "1111111111111111",
    };

    expect(findDuplicate(candidate, [], THRESHOLD)).toBeNull();
  });
});

describe("submissionJumpUrl", () => {
  it("builds the link to the submission", () => {
    expect(submissionJumpUrl("guild", "channel", "message")).toBe(
      "https://discord.com/channels/guild/channel/message",
    );
  });
});
