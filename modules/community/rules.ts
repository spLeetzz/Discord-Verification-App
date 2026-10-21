/**
 * The decisions that need neither a database nor Discord.
 *
 * Everything in here is a pure function: the same input always gives the
 * same output, and nothing here talks to Postgres or to the gateway. That
 * makes the rules the interesting part of the area testable on their own,
 * which is where the source's bugs were.
 *
 * Three of them are the source's bugs, fixed:
 *
 *  - the tag name was validated in lower case and stored in the original
 *    case, so the lookup was case-*sensitive* while the reserved-word
 *    check was case-*insensitive*;
 *  - the auto-purge free-tier check ran **before** the "this channel is
 *    already an auto-purge channel" check;
 *  - the reminder's `all` command said "the 10 latest" and showed
 *    everything, soonest first.
 */

import * as chrono from "chrono-node";
import { parseDuration, parseNaturalTime, parseTimedText } from "../../core/time.js";
import type { ParseTimeOptions } from "../../core/time.js";

/* ------------------------------------------------------------------ *
 * Tag names
 * ------------------------------------------------------------------ */

/**
 * The longest a tag name may be.
 *
 * The source had two limits: 99 in the command and 100 in the converter.
 * One number is used everywhere (99), and it is the *name* limit — the
 * body of a tag may be up to {@link TAG_CONTENT_MAX_LENGTH} characters.
 */
export const TAG_NAME_MAX_LENGTH = 99;

/**
 * The longest a tag body may be.
 *
 * The source's limit, kept: it leaves room for the message around it in
 * Discord's 2000 character budget.
 */
export const TAG_CONTENT_MAX_LENGTH = 1990;

/**
 * The names a tag may not have.
 *
 * These are the subcommands of `/tag`. A tag called `raw` would make
 * `/tag raw` ambiguous, so the name is refused.
 *
 * The check is on the **first space-separated word**, exactly as the
 * source did it: `"raw stuff"` is refused, `"rawstuff"` is allowed.
 */
export const RESERVED_TAG_WORDS = [
  "show",
  "raw",
  "list",
  "info",
  "claim",
  "create",
  "delete",
  "transfer",
  "nsfw",
  "mine",
  "purge",
  "edit",
  "search",
  "stats",
] as const;

/** One of the reserved words. */
export type ReservedTagWord = (typeof RESERVED_TAG_WORDS)[number];

/**
 * The canonical form of a tag name.
 *
 * Trimmed and lower-cased. The canonical form is the **only** form that
 * is stored, so the database's `UNIQUE (guild_id, name)` constraint is
 * the case-insensitive constraint the area wants — see `service.ts` for
 * the whole argument.
 */
export function normaliseTagName(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Is the first word of a name one of the reserved words?
 *
 * @param name the name, in any case. It is normalised first.
 */
export function isReservedTagName(name: string): boolean {
  const firstWord = normaliseTagName(name).split(/\s+/, 1)[0] ?? "";

  return (RESERVED_TAG_WORDS as readonly string[]).includes(firstWord);
}

/** Why a tag name was refused. */
export type TagNameRejection = "empty" | "too_long" | "reserved";

/** The result of checking a tag name. */
export interface TagNameValidation {
  /** Whether the name may be used. */
  readonly ok: boolean;
  /** The canonical name. Empty when the name was empty. */
  readonly name: string;
  /** Why it was refused, or `null` when it was accepted. */
  readonly reason: TagNameRejection | null;
  /** The refusal to show the user. Empty when the name was accepted. */
  readonly message: string;
}

/**
 * Checks a tag name and gives back its canonical form.
 *
 * The three rules, in the order the source applied them:
 *
 *  1. the name is not empty;
 *  2. the name is at most {@link TAG_NAME_MAX_LENGTH} characters;
 *  3. the first word is not a reserved word.
 */
export function validateTagName(input: string): TagNameValidation {
  const name = normaliseTagName(input);

  if (!name) {
    return {
      ok: false,
      name: "",
      reason: "empty",
      message: "Please give the tag a name.",
    };
  }

  if (name.length > TAG_NAME_MAX_LENGTH) {
    return {
      ok: false,
      name,
      reason: "too_long",
      message: `A tag name may be at most ${TAG_NAME_MAX_LENGTH} characters.`,
    };
  }

  if (isReservedTagName(name)) {
    return {
      ok: false,
      name,
      reason: "reserved",
      message: "That tag name starts with a reserved word.",
    };
  }

  return { ok: true, name, reason: null, message: "" };
}

/* ------------------------------------------------------------------ *
 * Auto-purge admission
 * ------------------------------------------------------------------ */

/** Why a channel may not become an auto-purge channel. */
export type AutoPurgeRefusal = "already_configured" | "limit_reached";

/** The result of the auto-purge admission check. */
export interface AutoPurgeAdmission {
  /** Whether the channel may be configured. */
  readonly allowed: boolean;
  /** Why it may not, or `null` when it may. */
  readonly refusal: AutoPurgeRefusal | null;
  /** The refusal to show the user. Empty when the channel may be used. */
  readonly message: string;
}

/**
 * Decides whether a channel may become an auto-purge channel.
 *
 * **The order matters, and it is the source's bug fixed.** Quotient ran
 * the free-tier check first, so a free guild that ran the command on a
 * channel it had *already* configured was told it had reached the channel
 * limit — a message that describes a limit it has not reached, for a
 * channel that is already set up. The "already configured" check comes
 * first here, because it is the more specific answer.
 *
 * @param options.alreadyConfigured whether the channel is already one.
 * @param options.currentCount      how many auto-purge channels the guild
 *                                  already has.
 * @param options.limit             the free-tier allowance.
 * @param options.entitled          whether the guild is past the limit.
 * @param options.channelName       the channel's name, for the message.
 */
export function checkAutoPurgeAdmission(options: {
  alreadyConfigured: boolean;
  currentCount: number;
  limit: number;
  entitled: boolean;
  channelName: string;
}): AutoPurgeAdmission {
  if (options.alreadyConfigured) {
    return {
      allowed: false,
      refusal: "already_configured",
      message: `**${options.channelName}** is already an auto-purge channel.`,
    };
  }

  if (!options.entitled && options.currentCount >= options.limit) {
    return {
      allowed: false,
      refusal: "limit_reached",
      message: `You cannot set auto-purge in more than ${options.limit} channel${
        options.limit === 1 ? "" : "s"
      } on the free tier. Run \`/premium\` to lift the limit.`,
    };
  }

  return { allowed: true, refusal: null, message: "" };
}

/* ------------------------------------------------------------------ *
 * The reminder's time and text
 * ------------------------------------------------------------------ */

/** The result of splitting a time out of a free-text reminder. */
export interface TimedText {
  /** The instant, or `null` when the text holds no time at all. */
  readonly time: Date | null;
  /** The text that is left over once the time has been taken out. */
  readonly text: string;
  /** The part of the input the time was read from. */
  readonly matched: string;
}

/**
 * The duration units `parseDuration` understands, longest first.
 *
 * The negative lookahead after the unit is what keeps `3 dec` (a date)
 * from being read as `3 d` (three days).
 */
const DURATION_UNITS = [
  "weeks",
  "week",
  "wks",
  "wk",
  "w",
  "days",
  "day",
  "d",
  "hours",
  "hour",
  "hrs",
  "hr",
  "h",
  "minutes",
  "minute",
  "mins",
  "min",
  "m",
  "seconds",
  "second",
  "secs",
  "sec",
  "s",
].join("|");

/** A leading duration such as `2d`, `1h30m` or `45 minutes`. */
const LEADING_DURATION = new RegExp(
  `^\\s*((?:\\d+(?:\\.\\d+)?\\s*(?:${DURATION_UNITS})(?![a-z])\\s*)+)`,
  "i",
);

/** The prefixes the source stripped before it looked for a time. */
const ME_PREFIX = /^me\s+(?:to|in|at)\s+/i;

/** The punctuation that is trimmed off the front of the leftover text. */
const LEADING_PUNCTUATION = /^[\s,.:;!•\-–—]+/;

/**
 * Splits a free-text reminder into the time and the message.
 *
 * `"2d unmute someone"` is a time (`2d`) and a message (`unmute
 * someone`). The source did this in its `TimeText` converter; the port
 * does it with `core/time.ts`:
 *
 *  - a leading **duration** (`2d`, `1h30m`) goes through `parseDuration`;
 *  - a **time of day** (`7pm`, `at 9pm`) goes through `parseTimedText`;
 *  - anything else (`tomorrow`, `in 3 days`, `next thursday`) goes through
 *    `parseNaturalTime`.
 *
 * The time of day is tried first because it carries the rule that a time
 * which has already passed today means the same time tomorrow.
 *
 * @param options `now` is the instant the parse is relative to and
 *                `timeZone` is the zone a wall-clock time is read in.
 */
export function splitTimedText(
  input: string,
  options: ParseTimeOptions = {},
): TimedText {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone;

  // The source let the user write "me at 9pm to get laid" and dropped the
  // "me at" before it looked for the time.
  const text = input.trim().replace(ME_PREFIX, "").trim();

  if (!text) {
    return { time: null, text: "", matched: "" };
  }

  const durationMatch = LEADING_DURATION.exec(text);

  if (durationMatch) {
    const matched = durationMatch[1] ?? "";
    const milliseconds = parseDuration(matched);

    if (milliseconds !== null) {
      return {
        time: new Date(now.getTime() + milliseconds),
        text: cleanLeftover(text.slice(matched.length)),
        matched: matched.trim(),
      };
    }
  }

  const results = chrono.parse(text, {
    instant: now,
    timezone: timeZone,
  });

  const first = results[0];

  if (!first) {
    return { time: null, text, matched: "" };
  }

  const matched = first.text;
  const end = first.index + matched.length;

  const leftover = `${text.slice(0, first.index)} ${text.slice(end)}`;

  const time =
    parseTimedText(matched, { now, timeZone }) ??
    parseNaturalTime(matched, { now, timeZone }) ??
    first.date();

  return {
    time,
    text: cleanLeftover(leftover),
    matched,
  };
}

/**
 * Tidies the text that is left over: no leading punctuation, no double
 * spaces, no trailing whitespace.
 */
function cleanLeftover(text: string): string {
  return text.replace(LEADING_PUNCTUATION, "").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * Snipes
 * ------------------------------------------------------------------ */

/**
 * May a snipe be shown in this channel?
 *
 * The source refused to show an NSFW snipe outside an NSFW channel, and
 * that rule is kept: the message was deleted in a channel the reader was
 * not allowed to see the contents of.
 */
export function canShowSnipe(options: {
  /** Whether the snipe was deleted in an NSFW channel. */
  snipeIsNsfw: boolean;
  /** Whether the channel the snipe is shown in is NSFW. */
  channelIsNsfw: boolean;
}): boolean {
  if (options.snipeIsNsfw && !options.channelIsNsfw) return false;

  return true;
}

/* ------------------------------------------------------------------ *
 * Auto-roles
 * ------------------------------------------------------------------ */

/**
 * The role ids of an auto-role list that no longer exist.
 *
 * A role that was deleted while the bot was down would fail **every**
 * join, because the grant is refused for a role that is not there. The
 * self-healing path drops those ids instead.
 */
export function staleRoleIds(
  configured: readonly string[],
  existing: readonly string[],
): string[] {
  const known = new Set(existing);

  return configured.filter((id) => !known.has(id));
}
