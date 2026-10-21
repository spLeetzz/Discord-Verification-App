/**
 * The open schedule of a tournament.
 *
 * A tournament may open on schedule as well as by hand. The schedule is
 * a set of weekdays and a time of day, and the next occurrence of it is
 * what the durable `tourney_open` job is armed for.
 *
 * **The `tourneys` table has no schedule column** — the schema is
 * ratified and migrated — so the schedule lives in the payload of the
 * job row. That is where a schedule belongs anyway: a job row survives a
 * restart, and the dispatcher deletes it before dispatching it.
 *
 * All the arithmetic here is done in the server's zone (IST by default,
 * D30). A wall-clock time with no offset is read in that zone, and the
 * result is an instant.
 */

import { IST } from "../../core/time.js";
import type { TourneySchedule } from "./types.js";

/** The weekdays a tournament may open on, in the order they are shown. */
export const OPEN_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

/** A weekday name. */
export type OpenDay = (typeof OPEN_DAYS)[number];

/** The default open time, when the wizard does not set one. */
export const DEFAULT_OPEN_TIME = "18:00";

/** A parsed wall-clock time. */
export interface WallClock {
  readonly hour: number;
  readonly minute: number;
}

/**
 * Parses a `HH:MM` wall-clock time.
 *
 * @returns the time, or `null` when the text is not one.
 */
export function parseWallClock(input: string): WallClock | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.trim());

  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;

  return { hour, minute };
}

/**
 * The calendar date of an instant, in a zone.
 */
function zonedDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return { year: read("year"), month: read("month"), day: read("day") };
}

/**
 * The offset of a zone at an instant, in minutes.
 *
 * Positive east of Greenwich. The offset is read from the zone's own
 * calendar, so a daylight-saving change is accounted for.
 */
function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  );

  return Math.round((asUtc - date.getTime()) / 60_000);
}

/**
 * Turns a wall-clock time on a calendar date into an instant.
 *
 * The offset is resolved twice, because the first guess can land on the
 * wrong side of a daylight-saving change.
 */
function zonedToInstant(
  year: number,
  month: number,
  day: number,
  clock: WallClock,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, clock.hour, clock.minute);

  let instant = new Date(naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000);

  instant = new Date(
    naive - zoneOffsetMinutes(instant, timeZone) * 60_000,
  );

  return instant;
}

/**
 * The weekday of a calendar date.
 *
 * `Date.UTC` on the date gives the weekday; the calendar date itself is
 * a plain date, so the zone does not matter.
 */
function weekdayOf(year: number, month: number, day: number): OpenDay {
  const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  // `getUTCDay` is 0 for Sunday; the list starts at Monday.
  const names: readonly OpenDay[] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];

  return names[index] ?? "monday";
}

/**
 * The next instant the tournament should open.
 *
 * The search looks at the next fourteen days, which is enough for any
 * weekly schedule and enough to step over a daylight-saving change.
 *
 * @param schedule the weekdays and the time of day;
 * @param now      the reference instant;
 * @param timeZone the zone the wall-clock time is read in.
 * @returns the instant, or `null` when the schedule is unusable.
 */
export function nextOpenInstant(
  schedule: TourneySchedule,
  now: Date = new Date(),
  timeZone: string = IST,
): Date | null {
  const clock = parseWallClock(schedule.openTime);

  if (!clock) return null;

  const allowed = new Set(schedule.openDays);

  const start = zonedDateParts(now, timeZone);

  for (let offset = 0; offset < 14; offset += 1) {
    // Walk the calendar from the reference date.
    const probe = new Date(
      Date.UTC(start.year, start.month - 1, start.day + offset),
    );

    const year = probe.getUTCFullYear();
    const month = probe.getUTCMonth() + 1;
    const day = probe.getUTCDate();

    if (allowed.size > 0 && !allowed.has(weekdayOf(year, month, day))) {
      continue;
    }

    const instant = zonedToInstant(year, month, day, clock, timeZone);

    if (instant.getTime() > now.getTime()) return instant;
  }

  return null;
}

/**
 * May the tournament open today?
 *
 * The daily job asks this before it opens anything: a tournament whose
 * schedule does not include today stays shut.
 */
export function opensOnDay(
  schedule: TourneySchedule,
  day: string,
): boolean {
  if (schedule.openDays.length === 0) return true;

  return schedule.openDays.includes(day);
}

/**
 * Is a list of weekday names well formed?
 *
 * @returns the names that are not weekdays.
 */
export function invalidOpenDays(days: readonly string[]): string[] {
  const known = new Set<string>(OPEN_DAYS);

  return days.filter((day) => !known.has(day));
}
