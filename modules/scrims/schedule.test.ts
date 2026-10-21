import { describe, expect, it } from "vitest";

import {
  AUTOCLEAN_GRACE_MS,
  DAY_MS,
  isStaleJob,
  nextDailyInstant,
  nextDailySchedule,
  nextMatchTime,
  shouldRunAutoclean,
} from "./schedule.js";

describe("the daily re-arm", () => {
  it("advances by exactly 24 hours", () => {
    const current = new Date("2026-03-01T09:00:00.000Z");

    expect(nextDailyInstant(current).toISOString()).toBe(
      "2026-03-02T09:00:00.000Z",
    );
  });

  it("arms the next job at the new schedule time", () => {
    const current = new Date("2026-03-01T09:00:00.000Z");
    const { nextTime, nextRunAt } = nextDailySchedule(current);

    expect(nextTime.getTime()).toBe(current.getTime() + DAY_MS);
    expect(nextRunAt.getTime()).toBe(nextTime.getTime());
  });

  it("keeps the time of day, because a day is 24 hours in IST", () => {
    const current = new Date("2026-03-01T09:00:00.000Z");
    const next = nextDailyInstant(current);

    expect(next.getUTCHours()).toBe(current.getUTCHours());
    expect(next.getUTCMinutes()).toBe(current.getUTCMinutes());
  });

  it("knows a stale job", () => {
    const schedule = new Date("2026-03-01T09:00:00.000Z");

    expect(isStaleJob(schedule, new Date(schedule.getTime()))).toBe(false);
    expect(isStaleJob(schedule, new Date(schedule.getTime() - DAY_MS))).toBe(
      true,
    );
  });
});

describe("the autoclean window", () => {
  const now = new Date("2026-03-10T12:00:00.000Z");

  it("runs for a scrim that was never closed", () => {
    expect(shouldRunAutoclean({ closedAt: null, now })).toBe(true);
  });

  it("runs for a scrim that closed just now", () => {
    expect(shouldRunAutoclean({ closedAt: now, now })).toBe(true);
  });

  it("runs for a scrim that closed 47 hours ago", () => {
    const closedAt = new Date(now.getTime() - 47 * 60 * 60 * 1000);

    expect(shouldRunAutoclean({ closedAt, now })).toBe(true);
  });

  it("does not run for a scrim that closed more than 48 hours ago", () => {
    const closedAt = new Date(now.getTime() - 49 * 60 * 60 * 1000);

    expect(shouldRunAutoclean({ closedAt, now })).toBe(false);
  });

  it("uses a 48 hour grace window", () => {
    expect(AUTOCLEAN_GRACE_MS).toBe(48 * 60 * 60 * 1000);
  });
});

describe("the match time", () => {
  it("rolls forward by a whole day until it is in the future", () => {
    const now = new Date("2026-03-10T12:00:00.000Z");
    const current = new Date("2026-03-08T12:00:00.000Z");

    expect(nextMatchTime(current, now).toISOString()).toBe(
      "2026-03-11T12:00:00.000Z",
    );
  });

  it("leaves a future match time alone", () => {
    const now = new Date("2026-03-10T12:00:00.000Z");
    const current = new Date("2026-03-11T12:00:00.000Z");

    expect(nextMatchTime(current, now).toISOString()).toBe(
      "2026-03-11T12:00:00.000Z",
    );
  });
});
