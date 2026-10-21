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
import { InputError } from "../../core/errors.js";
import {
  embedTemplateToJSON,
  parseEmbedTemplate,
} from "../../core/embed-builder.js";
import type { EmbedTemplate } from "../../core/embed-builder.js";

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
 * The member quotas
 * ------------------------------------------------------------------ */

/**
 * How many tags a member may own in one guild.
 *
 * A tag is a row in the `tags` table and nothing ever removed one, so a
 * member could fill the table with rows nobody would ever read. The
 * allowance is per **guild**, because the tag namespace is per guild:
 * twenty-five tags in one server is a lot of canned messages, and it is
 * the same twenty-five in every server the member is in.
 *
 * The number is the area's own limit, not a premium one: the free tier
 * (`FREE_TIER`) is about what a *guild* may configure, and this is about
 * what a *member* may leave lying around.
 */
export const MAX_TAGS_PER_MEMBER = 25;

/**
 * How many reminders a member may have running at once.
 *
 * A reminder is a row in the `jobs` table, which the dispatcher polls
 * every fifteen seconds, so the rows are not free. The allowance is per
 * **member across every server**, because that is how the jobs table is
 * keyed: `jobs.user_id` says who a reminder is for, and `/reminder list`
 * lists all of a member's reminders wherever they were set.
 *
 * Twenty-five running reminders is more than anybody needs at once, and
 * the allowance empties itself: the dispatcher deletes a reminder's row
 * when it fires.
 */
export const MAX_REMINDERS_PER_MEMBER = 25;

/** The things a member may have an allowance of. */
export type QuotaSubject = "tag" | "reminder";

/** Why a member may not have another one. */
export type QuotaRefusal = "limit_reached";

/** The result of the allowance check. */
export interface QuotaAdmission {
  /** Whether the member may have another one. */
  readonly allowed: boolean;
  /** Why they may not, or `null` when they may. */
  readonly refusal: QuotaRefusal | null;
  /** The refusal to show the user. Empty when the member may have one. */
  readonly message: string;
}

/**
 * How each subject is named in the refusal.
 *
 * The wording is here rather than in the service, so the rule is one
 * pure function and the message cannot drift between the two callers.
 */
const QUOTA_SUBJECTS: Record<
  QuotaSubject,
  {
    readonly plural: string;
    readonly scope: string;
    readonly command: string;
    readonly verb: string;
  }
> = {
  tag: {
    plural: "tags",
    scope: "in this server",
    command: "/tag delete",
    verb: "make",
  },
  reminder: {
    plural: "reminders",
    scope: "running",
    command: "/reminder delete",
    verb: "set",
  },
};

/**
 * Decides whether a member may have one more of a thing.
 *
 * The refusal says how to get out of it, because a member at the
 * allowance has to be able to make room: the answer names the command
 * that frees a slot.
 *
 * @param options.subject      what the member is asking for.
 * @param options.currentCount how many they have now.
 * @param options.limit        how many they may have.
 */
export function checkMemberQuota(options: {
  subject: QuotaSubject;
  currentCount: number;
  limit: number;
}): QuotaAdmission {
  if (options.currentCount < options.limit) {
    return { allowed: true, refusal: null, message: "" };
  }

  const subject = QUOTA_SUBJECTS[options.subject];

  return {
    allowed: false,
    refusal: "limit_reached",
    message: `You can have at most ${options.limit} ${subject.plural} ${subject.scope}. Delete one with \`${subject.command}\` before you ${subject.verb} another.`,
  };
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
 * The tag body
 * ------------------------------------------------------------------ */

/**
 * What a tag's stored body turns into.
 *
 * The union is closed: a tag renders as text, as an embed, or it is
 * broken. A broken template is a third state and not an error — the
 * source re-parsed the column with `ast.literal_eval` on every use, so a
 * template written by any other code path crashed the next render.
 */
export type TagRender =
  /** A plain-text tag. */
  | { readonly kind: "text"; readonly content: string }
  /** An embed tag, with a template that parsed. */
  | { readonly kind: "embed"; readonly template: EmbedTemplate }
  /** An embed tag whose stored template does not parse. */
  | { readonly kind: "broken"; readonly reason: string };

/**
 * Works out what a tag renders as.
 *
 * @param tag the stored body and whether it is an embed.
 */
export function renderTagBody(tag: {
  content: string;
  isEmbed: boolean;
}): TagRender {
  if (!tag.isEmbed) {
    return { kind: "text", content: tag.content };
  }

  const template = parseEmbedTemplate(tag.content);

  if (!template) {
    return {
      kind: "broken",
      reason:
        "This tag's embed template is broken, so it cannot be shown. Its owner has to edit it.",
    };
  }

  return { kind: "embed", template };
}

/**
 * The body a new tag is stored with.
 *
 * An embed tag's body is a **JSON template** (D32), never a Python
 * literal string.
 *
 * @throws {InputError} when the body is too long, or when an embed
 *         template does not parse.
 */
export function buildTagBody(
  content: string,
  isEmbed: boolean,
): { body: string; isEmbed: boolean } {
  if (!isEmbed) {
    if (content.length > TAG_CONTENT_MAX_LENGTH) {
      throw new InputError(
        `A tag may hold at most ${TAG_CONTENT_MAX_LENGTH} characters.`,
      );
    }

    return { body: content, isEmbed: false };
  }

  const template = parseEmbedTemplate(content);

  if (!template) {
    throw new InputError(
      "That is not a valid embed template. It has to be a JSON object, for example `{\"title\": \"Rules\", \"description\": \"Be nice.\"}`.",
    );
  }

  return { body: embedTemplateToJSON(template), isEmbed: true };
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

/**
 * The message a reminder carries when nothing else was said.
 */
export const NO_REMINDER_TEXT = "(no text)";

/**
 * Reads the time and the message out of a reminder's options.
 *
 * When the `text` option is given it wins; the leftover of the time
 * option is ignored. When it is not, the leftover is the message — which
 * is what makes `"2d unmute someone"` work.
 *
 * @throws {InputError} when the input holds no time.
 */
export function readReminder(
  when: string,
  text: string | null,
  options: ParseTimeOptions = {},
): { time: Date; message: string } {
  const split = splitTimedText(when, options);

  if (!split.time) {
    throw new InputError(
      "I could not find a time in your input. Try something like `2d`, `9pm` or `tomorrow at 7pm`.",
    );
  }

  const explicit = text?.trim();

  return {
    time: split.time,
    message:
      explicit && explicit.length > 0 ? explicit : (split.text || NO_REMINDER_TEXT),
  };
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
