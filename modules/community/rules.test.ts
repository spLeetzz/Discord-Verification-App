/**
 * The community rules.
 *
 * These are the decisions that need neither a database nor Discord, and
 * they are where the source's bugs were:
 *
 *  - the tag name was validated in lower case and looked up in the
 *    original case, so the lookup was case-*sensitive* while the
 *    reserved-word check was case-*insensitive*;
 *  - the auto-purge free-tier check ran **before** the "this channel is
 *    already an auto-purge channel" check;
 *  - the reminder's text and time were split by a converter that only
 *    understood a handful of shapes.
 */

import { describe, expect, it } from "vitest";
import {
  RESERVED_TAG_WORDS,
  TAG_CONTENT_MAX_LENGTH,
  TAG_NAME_MAX_LENGTH,
  canShowSnipe,
  checkAutoPurgeAdmission,
  isReservedTagName,
  normaliseTagName,
  readReminder,
  splitTimedText,
  staleRoleIds,
  validateTagName,
} from "./rules.js";

/** A fixed instant, so the tests never depend on the clock. */
const NOW = new Date("2026-03-10T12:00:00.000Z");

describe("normaliseTagName", () => {
  it("trims and lower-cases", () => {
    expect(normaliseTagName("  Rules  ")).toBe("rules");
    expect(normaliseTagName("RULES")).toBe("rules");
  });

  it("keeps the spaces inside a name", () => {
    expect(normaliseTagName("Server Rules")).toBe("server rules");
  });
});

describe("validateTagName", () => {
  it("accepts an ordinary name and gives back the canonical form", () => {
    const result = validateTagName("  Server Rules ");

    expect(result.ok).toBe(true);
    expect(result.name).toBe("server rules");
    expect(result.reason).toBeNull();
  });

  it("refuses an empty name", () => {
    const result = validateTagName("   ");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty");
  });

  it("refuses a name of more than 99 characters", () => {
    const result = validateTagName("a".repeat(TAG_NAME_MAX_LENGTH + 1));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_long");
  });

  it("accepts a name of exactly 99 characters", () => {
    const result = validateTagName("a".repeat(TAG_NAME_MAX_LENGTH));

    expect(result.ok).toBe(true);
    expect(result.name.length).toBe(TAG_NAME_MAX_LENGTH);
  });

  it("refuses a name that starts with a reserved word", () => {
    const result = validateTagName("raw");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("reserved");
  });

  it("refuses a reserved word whatever its case", () => {
    // The source's bug: the reserved-word check was case-insensitive and
    // the lookup was not, so `Raw` and `raw` were two different tags.
    expect(validateTagName("Raw").reason).toBe("reserved");
    expect(validateTagName("RAW").reason).toBe("reserved");
  });

  it("refuses a name whose first word is reserved", () => {
    expect(validateTagName("raw stuff").reason).toBe("reserved");
    expect(validateTagName("list of things").reason).toBe("reserved");
  });

  it("allows a name that merely starts with a reserved word", () => {
    expect(validateTagName("rawstuff").ok).toBe(true);
    expect(validateTagName("listing").ok).toBe(true);
    expect(validateTagName("create").ok).toBe(false);
  });

  it("refuses every subcommand of /tag", () => {
    for (const word of RESERVED_TAG_WORDS) {
      expect(isReservedTagName(word), word).toBe(true);
    }
  });
});

describe("checkAutoPurgeAdmission", () => {
  const base = {
    alreadyConfigured: false,
    currentCount: 0,
    limit: 1,
    entitled: false,
    channelName: "#general",
  };

  it("allows a channel when the guild is under the limit", () => {
    const result = checkAutoPurgeAdmission(base);

    expect(result.allowed).toBe(true);
    expect(result.refusal).toBeNull();
  });

  it("refuses a channel that is already an auto-purge channel", () => {
    const result = checkAutoPurgeAdmission({
      ...base,
      alreadyConfigured: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.refusal).toBe("already_configured");
  });

  it("refuses a second channel on the free tier", () => {
    const result = checkAutoPurgeAdmission({
      ...base,
      currentCount: 1,
    });

    expect(result.allowed).toBe(false);
    expect(result.refusal).toBe("limit_reached");
  });

  it("says the channel is already configured before it says the limit is reached", () => {
    // This is the source's bug, fixed: the free-tier check ran first, so
    // a free guild re-running the command on a channel it had already
    // configured was told it had reached the channel limit.
    const result = checkAutoPurgeAdmission({
      ...base,
      alreadyConfigured: true,
      currentCount: 1,
    });

    expect(result.refusal).toBe("already_configured");
    expect(result.message).toContain("already an auto-purge channel");
    expect(result.message).not.toContain("free tier");
  });

  it("lets an entitled guild past the limit", () => {
    const result = checkAutoPurgeAdmission({
      ...base,
      currentCount: 9,
      entitled: true,
    });

    expect(result.allowed).toBe(true);
  });
});

describe("splitTimedText", () => {
  it("splits a duration off the front", () => {
    const result = splitTimedText("2d unmute someone", { now: NOW });

    expect(result.time?.toISOString()).toBe("2026-03-12T12:00:00.000Z");
    expect(result.text).toBe("unmute someone");
  });

  it("splits a relative time off the front", () => {
    const result = splitTimedText("in 3 days do the thing", { now: NOW });

    expect(result.time?.toISOString()).toBe("2026-03-13T12:00:00.000Z");
    expect(result.text).toBe("do the thing");
  });

  it("splits a time of day off the front", () => {
    const result = splitTimedText("tomorrow at 7pm do something funny", {
      now: NOW,
    });

    expect(result.time?.toISOString()).toBe("2026-03-11T13:30:00.000Z");
    expect(result.text).toBe("do something funny");
  });

  it("drops the `me at` the source let people write", () => {
    const result = splitTimedText("me at 9pm to get laid", { now: NOW });

    expect(result.text).toBe("to get laid");
    expect(result.time).not.toBeNull();
  });

  it("keeps the text that comes before the time", () => {
    const result = splitTimedText("do the dishes tomorrow", { now: NOW });

    expect(result.text).toBe("do the dishes");
    expect(result.time).not.toBeNull();
  });

  it("rolls a time of day that has already passed forward to tomorrow", () => {
    // 18:00 IST already, so 5 PM today has gone and 7 PM has not.
    const later = new Date("2026-03-10T12:30:00.000Z");

    const past = splitTimedText("5pm", { now: later });
    const future = splitTimedText("7pm", { now: later });

    expect(past.time?.toISOString()).toBe("2026-03-11T11:30:00.000Z");
    expect(future.time?.toISOString()).toBe("2026-03-10T13:30:00.000Z");
  });

  it("finds no time in a text that holds none", () => {
    const result = splitTimedText("unmute somebody", { now: NOW });

    expect(result.time).toBeNull();
    expect(result.text).toBe("unmute somebody");
  });

  it("does not read a date as a duration", () => {
    // `3 dec` is a date, not three days.
    const result = splitTimedText("3 dec party", { now: NOW });

    expect(result.matched).not.toBe("3 d");
  });
});

describe("readReminder", () => {
  it("takes the message from what is left of the time option", () => {
    const result = readReminder("2d unmute someone", null, { now: NOW });

    expect(result.time.toISOString()).toBe("2026-03-12T12:00:00.000Z");
    expect(result.message).toBe("unmute someone");
  });

  it("prefers the text option when there is one", () => {
    const result = readReminder("2d", "call bob", { now: NOW });

    expect(result.message).toBe("call bob");
  });

  it("falls back to a placeholder when there is no text at all", () => {
    const result = readReminder("2d", null, { now: NOW });

    expect(result.message).toBe("(no text)");
  });

  it("refuses a time it cannot read", () => {
    expect(() => readReminder("sometime", null, { now: NOW })).toThrow();
  });
});

describe("canShowSnipe", () => {
  it("shows a normal snipe anywhere", () => {
    expect(canShowSnipe({ snipeIsNsfw: false, channelIsNsfw: false })).toBe(
      true,
    );
  });

  it("refuses an NSFW snipe outside an NSFW channel", () => {
    expect(canShowSnipe({ snipeIsNsfw: true, channelIsNsfw: false })).toBe(
      false,
    );
  });

  it("shows an NSFW snipe in an NSFW channel", () => {
    expect(canShowSnipe({ snipeIsNsfw: true, channelIsNsfw: true })).toBe(true);
  });
});

describe("staleRoleIds", () => {
  it("finds the roles that no longer exist", () => {
    expect(staleRoleIds(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
  });

  it("finds nothing when every role is still there", () => {
    expect(staleRoleIds(["a"], ["a", "b"])).toEqual([]);
  });
});

describe("the tag limits", () => {
  it("uses 99 characters for the name everywhere", () => {
    expect(TAG_NAME_MAX_LENGTH).toBe(99);
  });

  it("keeps the source's limit for the body", () => {
    expect(TAG_CONTENT_MAX_LENGTH).toBe(1990);
  });
});
