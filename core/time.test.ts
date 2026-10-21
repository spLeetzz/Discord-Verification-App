import { describe, expect, it } from "vitest";
import {
  dayName,
  discordTimestamp,
  formatRelativeTime,
  formatTimestamp,
  IST,
  parseDuration,
  parseNaturalTime,
  parseTimedText,
} from "./time.js";

/**
 * A fixed reference instant: 15:30 IST on Friday 15 March 2024.
 *
 * Every parse in this file is relative to it, so the tests do not depend on
 * when they run.
 */
const NOW = new Date("2024-03-15T10:00:00.000Z");

describe("IST", () => {
  it("is the Asia/Kolkata time zone", () => {
    expect(IST).toBe("Asia/Kolkata");
  });
});

describe("discordTimestamp", () => {
  it("renders the relative style by default", () => {
    expect(discordTimestamp(NOW)).toBe("<t:1710496800:R>");
  });

  it("takes a style", () => {
    expect(discordTimestamp(NOW, "F")).toBe("<t:1710496800:F>");
  });

  it("takes a millisecond timestamp", () => {
    expect(discordTimestamp(NOW.getTime())).toBe("<t:1710496800:R>");
  });
});

describe("parseDuration", () => {
  it("parses a compound duration", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000);
  });

  it("parses a single unit", () => {
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1w")).toBe(604_800_000);
  });

  it("ignores spaces between the units", () => {
    expect(parseDuration("1h 30m")).toBe(5_400_000);
  });

  it("is not case sensitive", () => {
    expect(parseDuration("1H30M")).toBe(5_400_000);
  });

  it("refuses a unit it does not know", () => {
    expect(parseDuration("1y")).toBeNull();
    expect(parseDuration("5x")).toBeNull();
  });

  it("refuses text that is not a duration", () => {
    expect(parseDuration("later")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });

  it("refuses a duration with trailing rubbish", () => {
    expect(parseDuration("1h nonsense")).toBeNull();
  });
});

describe("parseNaturalTime", () => {
  it("parses a time of day in the given time zone", () => {
    const parsed = parseNaturalTime("tomorrow at 5pm", {
      now: NOW,
      timeZone: IST,
    });

    // 17:00 IST on 16 March 2024.
    expect(parsed?.toISOString()).toBe("2024-03-16T11:30:00.000Z");
  });

  it("parses a relative time", () => {
    const parsed = parseNaturalTime("in 2 hours", { now: NOW, timeZone: IST });

    expect(parsed?.toISOString()).toBe("2024-03-15T12:00:00.000Z");
  });

  it("reads a wall-clock date as midday in the given time zone", () => {
    const parsed = parseNaturalTime("2024-04-01", {
      now: NOW,
      timeZone: IST,
      rollForward: false,
    });

    // chrono reads a date with no time as midday — 12:00 IST on 1 April
    // 2024 — which is the only reading that is the same day everywhere.
    expect(parsed?.toISOString()).toBe("2024-04-01T06:30:00.000Z");
  });

  it("rolls a past date forward by whole days", () => {
    const parsed = parseNaturalTime("15 March", { now: NOW, timeZone: IST });

    // Midday on 15 March 2024 has passed, so it rolls on to midday on the
    // 16th — the next occurrence of the same wall-clock time.
    expect(parsed?.toISOString()).toBe("2024-03-16T06:30:00.000Z");
  });

  it("leaves a past date alone when rolling is switched off", () => {
    const parsed = parseNaturalTime("15 March", {
      now: NOW,
      timeZone: IST,
      rollForward: false,
    });

    expect(parsed?.toISOString()).toBe("2024-03-15T06:30:00.000Z");
  });

  it("returns null when the text holds no time", () => {
    expect(parseNaturalTime("gibberish", { now: NOW })).toBeNull();
    expect(parseNaturalTime("", { now: NOW })).toBeNull();
  });
});

describe("parseTimedText", () => {
  it("takes the next occurrence of a time of day", () => {
    const parsed = parseTimedText("7 PM", { now: NOW, timeZone: IST });

    // 19:00 IST on 15 March 2024 — still to come.
    expect(parsed?.toISOString()).toBe("2024-03-15T13:30:00.000Z");
  });

  it("rolls a time of day that has passed to tomorrow", () => {
    const parsed = parseTimedText("9 AM", { now: NOW, timeZone: IST });

    // 09:00 IST has passed, so it is 09:00 IST tomorrow.
    expect(parsed?.toISOString()).toBe("2024-03-16T03:30:00.000Z");
  });

  it("takes a 24-hour time", () => {
    const parsed = parseTimedText("19:30", { now: NOW, timeZone: IST });

    expect(parsed?.toISOString()).toBe("2024-03-15T14:00:00.000Z");
  });

  it("returns null when there is no time of day in the text", () => {
    expect(parseTimedText("tomorrow", { now: NOW, timeZone: IST })).toBeNull();
    expect(parseTimedText("nonsense", { now: NOW, timeZone: IST })).toBeNull();
  });
});

describe("formatRelativeTime", () => {
  it("describes the past", () => {
    const earlier = new Date("2024-03-12T10:00:00.000Z");

    expect(formatRelativeTime(earlier, { now: NOW })).toBe("3 days ago");
  });

  it("describes the future", () => {
    const later = new Date("2024-03-18T10:00:00.000Z");

    expect(formatRelativeTime(later, { now: NOW })).toBe("in 3 days");
  });

  it("describes a difference of hours", () => {
    const earlier = new Date("2024-03-15T07:00:00.000Z");

    expect(formatRelativeTime(earlier, { now: NOW })).toBe("3 hours ago");
  });

  it("joins two units with 'and'", () => {
    const earlier = new Date("2024-03-12T07:00:00.000Z");

    expect(formatRelativeTime(earlier, { now: NOW })).toBe(
      "3 days and 3 hours ago",
    );
  });

  it("says 'now' when there is no difference", () => {
    expect(formatRelativeTime(NOW, { now: NOW })).toBe("now");
  });

  it("keeps to the requested accuracy", () => {
    const earlier = new Date("2024-03-12T07:00:00.000Z");

    expect(
      formatRelativeTime(earlier, { now: NOW, accuracy: 1 }),
    ).toBe("3 days ago");
  });
});

describe("formatTimestamp", () => {
  it("renders the shape Quotient used", () => {
    expect(formatTimestamp(NOW)).toBe("15-Mar-2024 03:30 PM");
  });

  it("takes a millisecond timestamp", () => {
    expect(formatTimestamp(NOW.getTime())).toBe("15-Mar-2024 03:30 PM");
  });

  it("takes another time zone", () => {
    expect(formatTimestamp(NOW, { timeZone: "UTC" })).toBe(
      "15-Mar-2024 10:00 AM",
    );
  });
});

describe("dayName", () => {
  it("reads the day in the given time zone", () => {
    expect(dayName(NOW)).toBe("friday");
  });

  it("does not slip a day the way naive local time did", () => {
    // 20:00 UTC on the 14th is already the 15th in IST.
    const instant = new Date("2024-03-14T20:00:00.000Z");

    expect(dayName(instant, { timeZone: "UTC" })).toBe("thursday");
    expect(dayName(instant, { timeZone: IST })).toBe("friday");
  });
});
