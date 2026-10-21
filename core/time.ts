/**
 * Time — one parser, one time zone, no naive local time.
 *
 * D30: Quotient mixed four time libraries and had two real bugs from it.
 * `day_today()` used naive local time while everything else used IST, and
 * `TimeText` mislabelled a naive-local datetime as IST. The fix is a
 * single natural-language parser, an explicit time zone, and no naive
 * datetimes anywhere.
 *
 * Every timestamp in the database is an instant. `Asia/Kolkata` is a
 * *presentation* concern: it is used when rendering, and when a user gives
 * a wall-clock time with no offset.
 *
 * The parsing itself is `chrono-node` (D6). It takes a reference instant
 * and a time zone, so "tomorrow at 7 PM" means what the user thinks it
 * means no matter where the process runs.
 */

import * as chrono from "chrono-node";
import { humanJoin, plural } from "./text.js";

/**
 * The time zone the bot presents times in.
 *
 * India has no daylight saving, so a wall-clock time in this zone maps to
 * exactly one instant all year.
 */
export const IST = "Asia/Kolkata";

/** The styles Discord's timestamp markup understands. */
export type DiscordTimestampStyle =
  | "t"
  | "T"
  | "d"
  | "D"
  | "f"
  | "F"
  | "s"
  | "S"
  | "R";

const DAY_MS = 86_400_000;

/** How a parse is configured. */
export interface ParseTimeOptions {
  /**
   * The instant the parse is relative to.
   *
   * "in 2 hours" and "tomorrow" are both relative to it. Defaults to now.
   */
  now?: Date;
  /**
   * The time zone a wall-clock time without an offset is read in.
   *
   * Defaults to {@link IST}.
   */
  timeZone?: string;
  /**
   * Whether a result in the past rolls forward.
   *
   * Defaults to `true`: "7 PM" asked at 8 PM means 7 PM tomorrow. This is
   * Quotient's rule — `time_input` added 24 hours until the time was in
   * the future.
   */
  rollForward?: boolean;
}

/**
 * Renders an instant as Discord's timestamp markup.
 *
 * `<t:1700000000:R>` renders as "2 days ago" in each reader's own locale
 * and time zone, which is exactly what a user-facing time should do.
 *
 * @param date  the instant, as a `Date` or a millisecond timestamp.
 * @param style the Discord style. Defaults to `"R"` (relative).
 */
export function discordTimestamp(
  date: Date | number,
  style: DiscordTimestampStyle = "R",
): string {
  const ms = typeof date === "number" ? date : date.getTime();

  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/**
 * The breakdown of the time between two instants.
 */
interface TimeBreakdown {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/**
 * The calendar-aware difference between two instants.
 *
 * Months and years are not fixed lengths, so they are counted with the
 * calendar rather than with a number of milliseconds. The frame is UTC:
 * both sides are instants, and UTC has no daylight saving to distort the
 * borrow.
 */
function breakDown(from: Date, to: Date): TimeBreakdown {
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  let months = to.getUTCMonth() - from.getUTCMonth();
  let days = to.getUTCDate() - from.getUTCDate();
  let hours = to.getUTCHours() - from.getUTCHours();
  let minutes = to.getUTCMinutes() - from.getUTCMinutes();
  let seconds = to.getUTCSeconds() - from.getUTCSeconds();

  if (seconds < 0) {
    seconds += 60;
    minutes -= 1;
  }

  if (minutes < 0) {
    minutes += 60;
    hours -= 1;
  }

  if (hours < 0) {
    hours += 24;
    days -= 1;
  }

  if (days < 0) {
    // Borrow the length of the month before the later date.
    const previousMonth = new Date(
      Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 0),
    );

    days += previousMonth.getUTCDate();
    months -= 1;
  }

  if (months < 0) {
    months += 12;
    years -= 1;
  }

  const wholeDays = days;
  const weeks = Math.floor(wholeDays / 7);

  return {
    years,
    months,
    weeks,
    days: wholeDays - weeks * 7,
    hours,
    minutes,
    seconds,
  };
}

/**
 * Renders an instant relative to another one, in words.
 *
 * "3 days and 2 hours ago" for the past, "in 3 days and 2 hours" for the
 * future.
 *
 * Quotient's `human_timedelta` had the same shape but left the future
 * unqualified — "3 days" reads as three days ago. The "in" is added here
 * because the difference is a genuine ambiguity, not a style choice.
 *
 * @param date   the instant to describe.
 * @param options `now` is the instant to compare against; `accuracy` is
 *                how many units to show (three by default, as in
 *                Quotient); `brief` shortens the unit names.
 */
export function formatRelativeTime(
  date: Date | number,
  options: { now?: Date; accuracy?: number; brief?: boolean } = {},
): string {
  const target = typeof date === "number" ? new Date(date) : date;
  const now = options.now ?? new Date();
  const accuracy = options.accuracy ?? 3;
  const brief = options.brief ?? false;

  const isPast = target.getTime() <= now.getTime();
  const parts = breakDown(isPast ? target : now, isPast ? now : target);

  const units: { value: number; long: string; short: string }[] = [
    { value: parts.years, long: "year", short: "y" },
    { value: parts.months, long: "month", short: "mo" },
    { value: parts.weeks, long: "week", short: "w" },
    { value: parts.days, long: "day", short: "d" },
    { value: parts.hours, long: "hour", short: "h" },
    { value: parts.minutes, long: "minute", short: "m" },
    { value: parts.seconds, long: "second", short: "s" },
  ];

  const shown: string[] = [];

  for (const unit of units) {
    if (unit.value <= 0) continue;

    shown.push(
      brief
        ? `${unit.value}${unit.short}`
        : plural(unit.value, unit.long),
    );

    if (accuracy > 0 && shown.length >= accuracy) break;
  }

  if (shown.length === 0) return "now";

  const duration = humanJoin(shown, ", ", "and");

  return isPast ? `${duration} ago` : `in ${duration}`;
}

/**
 * Parses a duration such as `1h30m` into milliseconds.
 *
 * The fixed-length units are supported: weeks, days, hours, minutes and
 * seconds. Years and months are deliberately not — they are not a fixed
 * number of milliseconds, and a duration that silently means "30 days" is
 * worse than one that is refused.
 *
 * @returns the duration in milliseconds, or `null` when the input is not a
 *          duration.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();

  if (!text) return null;

  const unit = /([0-9]+)\s*([a-z]+)/y;

  let total = 0;
  let matched = 0;
  let index = 0;

  while (index < text.length) {
    // Skip whitespace between the units.
    while (index < text.length && /\s/.test(text[index] ?? "")) index++;

    if (index >= text.length) break;

    unit.lastIndex = index;

    const match = unit.exec(text);

    if (!match) return null;

    const amount = Number(match[1]);
    const name = match[2];

    if (!Number.isFinite(amount)) return null;
    if (name === undefined) return null;

    const factor = durationUnit(name);

    if (factor === null) return null;

    total += amount * factor;
    matched += match[0].length;
    index += match[0].length;
  }

  if (matched === 0 || index !== text.length) return null;

  return total;
}

/**
 * The length of one duration unit, in milliseconds.
 */
function durationUnit(name: string): number | null {
  switch (name) {
    case "w":
    case "wk":
    case "wks":
    case "week":
    case "weeks":
      return 7 * DAY_MS;
    case "d":
    case "day":
    case "days":
      return DAY_MS;
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return 3_600_000;
    case "m":
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return 60_000;
    case "s":
    case "sec":
    case "secs":
    case "second":
    case "seconds":
      return 1_000;
    default:
      return null;
  }
}

/**
 * Parses a natural-language time.
 *
 * This is the one parser D30 asks for. "tomorrow at 7 PM", "in 2 hours",
 * "next friday 9pm" and "15 March" all go through here, always with an
 * explicit reference instant and an explicit time zone.
 *
 * A result in the past rolls forward by whole days until it is in the
 * future, which is Quotient's rule: a time of day that has already passed
 * today means the same time tomorrow.
 *
 * @returns the instant, or `null` when the text holds no time at all.
 */
export function parseNaturalTime(
  input: string,
  options: ParseTimeOptions = {},
): Date | null {
  const text = input.trim();

  if (!text) return null;

  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? IST;

  const parsed = chrono.parseDate(text, {
    instant: now,
    timezone: timeZone,
  });

  if (!parsed) return null;

  if (options.rollForward === false) return parsed;

  return rollForward(parsed, now);
}

/**
 * Parses a time of day.
 *
 * "7 PM", "19:30", "7:30 pm" — the wall-clock time a match starts at. The
 * date comes from the reference instant; if the time has already passed
 * today, the next occurrence is tomorrow.
 *
 * This is the port of Quotient's `TimeText` converter, which is what the
 * match-time editor used. Unlike `parseNaturalTime` it requires a time of
 * day to be present, so "tomorrow" on its own is not a time.
 *
 * @returns the instant, or `null` when the text holds no time of day.
 */
export function parseTimedText(
  input: string,
  options: ParseTimeOptions = {},
): Date | null {
  const text = input.trim();

  if (!text) return null;

  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? IST;

  const results = chrono.parse(text, { instant: now, timezone: timeZone });
  const first = results[0];

  if (!first) return null;

  // Without an hour there is no time of day in the text.
  if (!first.start.isCertain("hour")) return null;

  const parsed = first.date();

  if (parsed.getTime() > now.getTime()) return parsed;

  return new Date(parsed.getTime() + DAY_MS);
}

/**
 * Moves an instant forward by whole days until it is in the future.
 *
 * The step is 24 hours, exactly as Quotient's `timedelta(hours=24)` loop
 * was. India has no daylight saving, so a day is always 24 hours there.
 */
function rollForward(parsed: Date, now: Date): Date {
  const nowMs = now.getTime();
  const parsedMs = parsed.getTime();

  if (parsedMs > nowMs) return parsed;

  const behind = nowMs - parsedMs;
  const days = Math.floor(behind / DAY_MS) + 1;

  return new Date(parsedMs + days * DAY_MS);
}

/**
 * Renders an instant as a readable date and time.
 *
 * The shape is Quotient's `strtime`: `15-Mar-2024 07:30 PM`.
 *
 * @param options `timeZone` defaults to {@link IST}.
 */
export function formatTimestamp(
  date: Date | number,
  options: { timeZone?: string } = {},
): string {
  const target = typeof date === "number" ? new Date(date) : date;
  const timeZone = options.timeZone ?? IST;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(target);

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${read("day")}-${read("month")}-${read("year")} ${read("hour")}:${read("minute")} ${read("dayPeriod")}`;
}

/**
 * The weekday of an instant, in the given time zone.
 *
 * Quotient's `day_today()` read the *local* time of the server while
 * everything else read IST, which put the day boundary in the wrong place
 * for a few hours every day. This reads the named zone, so the boundary is
 * where the users think it is (D30).
 *
 * @returns the lower-cased English weekday, e.g. `"monday"`.
 */
export function dayName(
  date: Date | number = new Date(),
  options: { timeZone?: string } = {},
): string {
  const target = typeof date === "number" ? new Date(date) : date;
  const timeZone = options.timeZone ?? IST;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
  }).formatToParts(target);

  const name = parts.find((part) => part.type === "weekday")?.value ?? "";

  return name.toLowerCase();
}
