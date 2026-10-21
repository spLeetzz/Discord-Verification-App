/**
 * The duplicate-screenshot check.
 *
 * The threshold is the interesting part: the check has to fire **at** the
 * threshold and not one bit later.
 *
 * The second part is the check's **totality**. A hash that cannot be
 * compared — the member's own stored one, or the screenshot's own — is not
 * an exception any more: the check answers with a decision, and the
 * decision is either a refusal or a report.
 */

import { describe, expect, it } from "vitest";
import { checkDuplicate, submissionJumpUrl } from "./duplicate.js";
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

describe("checkDuplicate", () => {
  it("finds the member's own picture", () => {
    const candidate = {
      authorId: "author-1",
      dhash: bitsAway("0000000000000000", 3),
      phash: "2222222222222222",
    };

    const outcome = checkDuplicate(candidate, [stored()], THRESHOLD);

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    expect(outcome.duplicate?.kind).toBe("own");
    expect(outcome.duplicate?.submission.id).toBe("row-1");
  });

  it("fires exactly at the threshold", () => {
    const candidate = {
      authorId: "author-1",
      dhash: bitsAway("0000000000000000", THRESHOLD),
      phash: "2222222222222222",
    };

    const outcome = checkDuplicate(candidate, [stored()], THRESHOLD);

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    expect(outcome.duplicate?.kind).toBe("own");
  });

  it("does not fire one bit past the threshold", () => {
    const candidate = {
      authorId: "author-1",
      dhash: bitsAway("0000000000000000", THRESHOLD + 1),
      phash: "2222222222222222",
    };

    const outcome = checkDuplicate(candidate, [stored()], THRESHOLD);

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    expect(outcome.duplicate).toBeNull();
  });

  it("finds somebody else's identical picture", () => {
    const candidate = {
      authorId: "author-2",
      dhash: "0000000000000000",
      phash: "1111111111111111",
    };

    const outcome = checkDuplicate(candidate, [stored()], THRESHOLD);

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    expect(outcome.duplicate?.kind).toBe("same");
    expect(outcome.duplicate?.submission.authorId).toBe("author-1");
  });

  it("ignores another member's near-identical picture", () => {
    // The first check is about the member's **own** submissions. Somebody
    // else's picture that is a bit off is a different picture.
    const candidate = {
      authorId: "author-2",
      dhash: bitsAway("0000000000000000", 2),
      phash: "2222222222222222",
    };

    const outcome = checkDuplicate(candidate, [stored()], THRESHOLD);

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    expect(outcome.duplicate).toBeNull();
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

    const outcome = checkDuplicate(candidate, rows, THRESHOLD);

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    expect(outcome.duplicate?.kind).toBe("own");
    expect(outcome.duplicate?.submission.id).toBe("row-2");
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

    const outcome = checkDuplicate(candidate, rows, THRESHOLD);

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    expect(outcome.duplicate).toBeNull();
    expect(outcome.corrupt).toHaveLength(0);
  });

  it("answers that there is no duplicate when there is nothing stored", () => {
    const candidate = {
      authorId: "author-1",
      dhash: "0000000000000000",
      phash: "1111111111111111",
    };

    const outcome = checkDuplicate(candidate, [], THRESHOLD);

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    expect(outcome.duplicate).toBeNull();
  });
});

describe("a hash that cannot be compared", () => {
  it("refuses the screenshot when the member's own stored hash is broken", () => {
    // A truncated row must not compare as "a different picture" — a
    // duplicate that hides itself lets a member farm the role. The
    // member's own history cannot be compared, so the screenshot is
    // refused.
    const candidate = {
      authorId: "author-1",
      dhash: "0000000000000000",
      phash: "1111111111111111",
    };

    const outcome = checkDuplicate(candidate, [stored({ dhash: "abc" })], THRESHOLD);

    expect(outcome.ok).toBe(false);

    if (outcome.ok) return;

    expect(outcome.kind).toBe("corrupt-history");
    expect(outcome.corrupt).toHaveLength(1);
    expect(outcome.corrupt[0]?.value).toBe("abc");
    expect(outcome.corrupt[0]?.field).toBe("dhash");
    expect(outcome.corrupt[0]?.submission.id).toBe("row-1");
  });

  it("refuses the screenshot when the member's own stored hash is not hex", () => {
    const candidate = {
      authorId: "author-1",
      dhash: "0000000000000000",
      phash: "1111111111111111",
    };

    const outcome = checkDuplicate(
      candidate,
      [stored({ dhash: "zzzzzzzzzzzzzzzz" })],
      THRESHOLD,
    );

    expect(outcome.ok).toBe(false);

    if (outcome.ok) return;

    expect(outcome.kind).toBe("corrupt-history");
  });

  it("passes over another member's broken row and reports it", () => {
    // One corrupt row must not block every member of the setup, so the
    // row is reported and the screenshot goes through.
    const candidate = {
      authorId: "author-2",
      dhash: "0000000000000000",
      phash: "1111111111111111",
    };

    const outcome = checkDuplicate(
      candidate,
      [stored({ authorId: "author-1", dhash: "abc" })],
      THRESHOLD,
    );

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    expect(outcome.duplicate).toBeNull();
    expect(outcome.corrupt).toHaveLength(1);
    expect(outcome.corrupt[0]?.value).toBe("abc");
    expect(outcome.corrupt[0]?.submission.authorId).toBe("author-1");
  });

  it("reports another member's broken hash even when it cannot match", () => {
    // The broken dhash can never be "the same picture", but the row is
    // still broken and the operator has to know about it.
    const candidate = {
      authorId: "author-2",
      dhash: "9c63949032868431",
      phash: "c0c0bf3f3bf0f090",
    };

    const outcome = checkDuplicate(
      candidate,
      [stored({ authorId: "author-1", dhash: "abc" })],
      THRESHOLD,
    );

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    expect(outcome.corrupt).toHaveLength(1);
  });

  it("refuses the screenshot when its own hash is not a hash", () => {
    // A hash the service sent that cannot be compared verifies nothing.
    const candidate = {
      authorId: "author-1",
      dhash: "not-a-hash",
      phash: "1111111111111111",
    };

    const outcome = checkDuplicate(candidate, [stored()], THRESHOLD);

    expect(outcome.ok).toBe(false);

    if (outcome.ok) return;

    expect(outcome.kind).toBe("unusable-hash");
  });

  it("never throws, whatever the table holds", () => {
    const candidate = {
      authorId: "author-1",
      dhash: "0000000000000000",
      phash: "1111111111111111",
    };

    const rows = [
      stored({ id: "row-1", authorId: "author-1", dhash: "abc" }),
      stored({ id: "row-2", authorId: "author-1", phash: "nope" }),
      stored({ id: "row-3", authorId: "author-2", dhash: "", phash: "" }),
    ];

    expect(() => checkDuplicate(candidate, rows, THRESHOLD)).not.toThrow();
  });
});

describe("submissionJumpUrl", () => {
  it("builds the link to the submission", () => {
    expect(submissionJumpUrl("guild", "channel", "message")).toBe(
      "https://discord.com/channels/guild/channel/message",
    );
  });
});
