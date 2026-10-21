/**
 * The open schedule of a tournament.
 *
 * The schedule is a set of weekdays and a time of day, and the durable
 * `tourney_open` job is armed for the next occurrence of it. These
 * tests pin the arithmetic down, in the server's zone (IST by default,
 * D30).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPEN_TIME,
  invalidOpenDays,
  nextOpenInstant,
  opensOnDay,
  parseWallClock,
} from "./schedule.js";

describe("the open schedule", () => {
  it("parses a wall-clock time", () => {
    expect(parseWallClock("18:00")).toEqual({ hour: 18, minute: 0 });
    expect(parseWallClock("9:05")).toEqual({ hour: 9, minute: 5 });
  });

  it("refuses a time that is not one", () => {
    expect(parseWallClock("")).toBeNull();
    expect(parseWallClock("18")).toBeNull();
    expect(parseWallClock("25:00")).toBeNull();
    expect(parseWallClock("18:70")).toBeNull();
    expect(parseWallClock("half past six")).toBeNull();
  });

  it("finds the next occurrence of a daily time", () => {
    // 2024-03-11 is a Monday. 10:00 IST is 04:30 UTC.
    const now = new Date("2024-03-11T00:00:00.000Z");

    const next = nextOpenInstant({ openDays: [], openTime: "10:00" }, now);

    expect(next?.toISOString()).toBe("2024-03-11T04:30:00.000Z");
  });

  it("rolls over to tomorrow when the time has passed", () => {
    // 12:00 UTC is 17:30 IST, so 10:00 IST has already gone by.
    const now = new Date("2024-03-11T12:00:00.000Z");

    const next = nextOpenInstant({ openDays: [], openTime: "10:00" }, now);

    expect(next?.toISOString()).toBe("2024-03-12T04:30:00.000Z");
  });

  it("skips a day the tournament does not open on", () => {
    // 2024-03-11 is a Monday; the tournament only opens on a Wednesday.
    const now = new Date("2024-03-11T00:00:00.000Z");

    const next = nextOpenInstant(
      { openDays: ["wednesday"], openTime: "10:00" },
      now,
    );

    expect(next?.toISOString()).toBe("2024-03-13T04:30:00.000Z");
  });

  it("keeps the time of day when the job fires late", () => {
    // The bot was down from Monday to Thursday. 2024-03-14 is a Thursday.
    const now = new Date("2024-03-14T12:00:00.000Z");

    const next = nextOpenInstant(
      { openDays: ["monday"], openTime: "18:00" },
      now,
    );

    // The next Monday at 18:00 IST — 12:30 UTC.
    expect(next?.toISOString()).toBe("2024-03-18T12:30:00.000Z");

    // **Not** 24 hours from the fire. The source advanced `open_time` by
    // exactly 24 hours each time it fired, so every outage shifted the
    // whole schedule by its own length.
    expect(next?.getTime()).not.toBe(now.getTime() + 86_400_000);
  });

  it("does not drift across a month boundary", () => {
    // 2024-01-31, 19:30 IST — the day's 18:00 has already gone by.
    const now = new Date("2024-01-31T14:00:00.000Z");

    const next = nextOpenInstant({ openDays: [], openTime: "18:00" }, now);

    expect(next?.toISOString()).toBe("2024-02-01T12:30:00.000Z");
  });

  it("keeps the time of day across a daylight-saving change", () => {
    // 2024-03-04 and 2024-03-11 are both Mondays, and the United States
    // changed its clocks between them.
    const before = nextOpenInstant(
      { openDays: ["monday"], openTime: "18:00" },
      new Date("2024-03-01T12:00:00.000Z"),
      "America/New_York",
    );

    const after = nextOpenInstant(
      { openDays: ["monday"], openTime: "18:00" },
      new Date("2024-03-08T12:00:00.000Z"),
      "America/New_York",
    );

    // Both are 18:00 in New York, so the UTC instants are an hour apart.
    expect(before?.toISOString()).toBe("2024-03-04T23:00:00.000Z");
    expect(after?.toISOString()).toBe("2024-03-11T22:00:00.000Z");
  });

  it("opens every day when no day is listed", () => {
    expect(opensOnDay({ openDays: [], openTime: "10:00" }, "monday")).toBe(
      true,
    );
    expect(opensOnDay({ openDays: ["monday"], openTime: "10:00" }, "monday")).toBe(
      true,
    );
    expect(
      opensOnDay({ openDays: ["monday"], openTime: "10:00" }, "tuesday"),
    ).toBe(false);
  });

  it("names the weekdays that are not weekdays", () => {
    expect(invalidOpenDays(["monday", "funday", "sunday"])).toEqual(["funday"]);
    expect(invalidOpenDays([])).toEqual([]);
  });

  it("has a default open time", () => {
    expect(parseWallClock(DEFAULT_OPEN_TIME)).not.toBeNull();
  });
});
