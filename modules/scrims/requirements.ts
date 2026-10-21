/**
 * The registration requirements matrix.
 *
 * A registration message is checked against an **ordered list of guards**.
 * Each guard answers one question and returns a deny reason or `null`.
 * The first reason wins.
 *
 * Quotient's `check_scrim_requirements` (`src/cogs/esports/helpers/utils.py:82-131`)
 * is not a list — it is two independent `if`s followed by an `elif` chain
 * hanging off the second one:
 *
 * ```python
 * if scrim.teamname_compulsion:      # independent
 *     ...
 * if scrim.required_mentions and not all(...bot...):   # independent
 *     ...
 * elif not len(message.mentions) >= scrim.required_mentions:   # chain
 *     ...
 * elif message.author.id in await scrim.banned_user_ids():    # chain
 *     ...
 * elif len(message.content.splitlines()) < scrim.required_lines:
 *     ...
 * elif not scrim.multiregister and message.author.id in get_slots(...):
 *     ...
 * elif scrim.no_duplicate_name:
 *     ...
 * elif not scrim.allow_duplicate_tags:
 *     ...
 * ```
 *
 * Two consequences of that shape are load-bearing and are reproduced here
 * exactly:
 *
 *  1. **The team-name check is independent of everything else.** It can
 *     fire alongside the bot-mention check. The port reports one reason
 *     (the first match wins), which is the behaviour the decision log
 *     asks for; the source dispatched up to two events.
 *
 *  2. **Only the two mention checks depend on `required_mentions`.** The
 *     source's second `if` is `scrim.required_mentions and not all(mentions
 *     are humans)`, and the whole `elif` chain hangs off it. In Python an
 *     `elif` chain runs when the `if` is **false**, so the chain ran
 *     whenever the scrim asked for no mentions, and it did *not* run when
 *     somebody mentioned a bot — the bot-mention reason simply won.
 *
 *     The first port of this file misread that shape: it made the whole
 *     chain conditional on the second `if` being **true**, so a scrim
 *     with `required_mentions = 0` skipped the banned-user check, the
 *     line check, the one-registration check, the duplicate-name check and
 *     the fake-tag check. A banned user could register on such a scrim.
 *     That is a bypass, not a quirk, and it is closed here.
 *
 *     The port is now a flat list of guards and the first match wins, so
 *     the source's "the bot-mention reason wins" case is reproduced by
 *     the ordering rather than by a chain.
 *
 * The module is pure: the caller gathers the facts, the guards decide.
 */

import { RegDeny } from "../../core/constants.js";
import { normaliseMessageContent } from "../../core/team-name.js";
import type { RegDeny as RegDenyType } from "../../core/constants.js";

/** A user mentioned in a registration message. */
export interface MentionSummary {
  readonly id: string;
  readonly isBot: boolean;
}

/** The settings a guard may read. */
export interface RegistrationSettings {
  /**
   * How many mentions a registration needs.
   *
   * `0` turns the two mention checks off — the bot-mention check and the
   * mention count. It does **not** turn any other check off.
   */
  readonly requiredMentions: number;
  /** How many lines the message needs. */
  readonly requiredLines: number;
  /** Is a team name required? */
  readonly teamnameCompulsion: boolean;
  /** May one person register more than once? */
  readonly multiregister: boolean;
  /** Are two teams with the same name allowed? */
  readonly noDuplicateName: boolean;
  /** May two teams share a member? */
  readonly allowDuplicateTags: boolean;
}

/** Everything the guards read, gathered once by the caller. */
export interface RegistrationContext {
  readonly settings: RegistrationSettings;
  /** The raw message content. */
  readonly rawContent: string;
  readonly mentions: readonly MentionSummary[];
  readonly authorId: string;
  /** The users banned from this scrim. */
  readonly bannedUserIds: ReadonlySet<string>;
  /** The users who own a claimed slot in this scrim. */
  readonly claimedOwnerIds: ReadonlySet<string>;
  /** The team names already claimed in this scrim. */
  readonly claimedTeamNames: ReadonlySet<string>;
  /** How many claimed slots already contain one of the mentioned users. */
  readonly fakeTagMatches: number;
  /**
   * The team name the message produces.
   *
   * The same value the slotlist will show, so the duplicate check
   * compares like with like.
   */
  readonly teamName: string;
}

/**
 * A guard.
 *
 * @returns the reason to refuse, or `null` when the guard is satisfied.
 */
export type RegistrationGuard = (
  context: RegistrationContext,
) => RegDenyType | null | Promise<RegDenyType | null>;

/**
 * The normalised content the guards read.
 *
 * Quotient lowercased and NFKC-normalised `message.content` *in place*
 * before checking it. discord.js messages are frozen, so we normalise a
 * copy (D27) and never touch the message.
 */
export function normalisedContent(context: RegistrationContext): string {
  return normaliseMessageContent(context.rawContent);
}

/**
 * The number of lines in the content.
 *
 * Python's `str.splitlines()` splits on more than `\n` — it also breaks on
 * `\r`, the vertical tab, the form feed, the file/group/record/unit
 * separators, the next line, the line separator and the paragraph
 * separator. The regex below is the same set, so "how many lines" means
 * the same thing in both ports.
 */
const PYTHON_SPLITLINES =
  /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u;

export function countLines(content: string): number {
  if (content.length === 0) return 0;

  return content.split(PYTHON_SPLITLINES).length;
}
/**
 * Does the content contain a `team` match?
 *
 * The source searched for `r"team.*"` and refused when there was no match
 * *or* when the matched text was blank. Because the match always starts
 * with the literal `team`, the second condition can never be true — so
 * the effective rule is "the content contains `team` somewhere", and
 * "steam" passes it.
 *
 * That quirk is preserved: the port refuses exactly when the source did.
 */
export function hasTeamToken(content: string): boolean {
  const match = /team.*/.exec(content);

  if (!match) return false;

  return match[0].trim().length > 0;
}

/**
 * Do the mention checks apply?
 *
 * The two checks that read `required_mentions` — the bot-mention check
 * and the mention count — only apply when the scrim asks for at least
 * one mention. A scrim that asks for no mentions does not care about
 * mentions at all.
 *
 * **Nothing else is conditional.** The banned-user, line,
 * one-registration, duplicate-name and fake-tag checks run whatever the
 * scrim asks for.
 */
export function mentionsAreChecked(context: RegistrationContext): boolean {
  return context.settings.requiredMentions > 0;
}

/**
 * Guard 1 — a team name is required.
 *
 * Independent of everything else, exactly as in the source.
 */
export function teamNameRequired(
  context: RegistrationContext,
): RegDenyType | null {
  if (!context.settings.teamnameCompulsion) return null;

  if (hasTeamToken(normalisedContent(context))) return null;

  return RegDeny.noteamname;
}

/**
 * Guard 2 — bots may not be mentioned.
 *
 * Independent of everything else. The source's condition was
 * `scrim.required_mentions and not all(mentions are humans)`, so a scrim
 * that asks for no mentions never rejects a bot mention.
 */
export function botMentionsRejected(
  context: RegistrationContext,
): RegDenyType | null {
  if (!mentionsAreChecked(context)) return null;

  if (!context.mentions.some((mention) => mention.isBot)) return null;

  return RegDeny.botmention;
}

/**
 * Guard 3 — enough mentions.
 *
 * Only when the scrim asks for mentions. A scrim that asks for none
 * cannot fall short of none.
 */
export function mentionCount(
  context: RegistrationContext,
): RegDenyType | null {
  if (!mentionsAreChecked(context)) return null;

  if (context.mentions.length < context.settings.requiredMentions) {
    return RegDeny.nomention;
  }

  return null;
}

/**
 * Guard 4 — the author is not banned from this scrim.
 *
 * **Always.** A ban is a ban, whatever the scrim asks for.
 */
export function bannedUser(context: RegistrationContext): RegDenyType | null {
  if (!context.bannedUserIds.has(context.authorId)) return null;

  return RegDeny.banned;
}

/**
 * Guard 5 — the message has enough lines.
 *
 * **Always.**
 */
export function requiredLines(
  context: RegistrationContext,
): RegDenyType | null {
  const lines = countLines(normalisedContent(context));

  if (lines < context.settings.requiredLines) return RegDeny.nolines;

  return null;
}

/**
 * Guard 6 — one registration per person.
 *
 * **Always.**
 */
export function oneRegistrationPerPerson(
  context: RegistrationContext,
): RegDenyType | null {
  if (context.settings.multiregister) return null;

  if (!context.claimedOwnerIds.has(context.authorId)) return null;

  return RegDeny.multiregister;
}

/**
 * Guard 7 — no two teams share a name.
 *
 * The name compared is the one the *team-name* derivation produces, so
 * the comparison is with the same normalisation the slotlist shows.
 *
 * **Always.**
 */
export function duplicateTeamName(
  context: RegistrationContext,
): RegDenyType | null {
  if (!context.settings.noDuplicateName) return null;

  if (!context.claimedTeamNames.has(context.teamName ?? "")) return null;

  return RegDeny.duplicate;
}

/**
 * Guard 8 — no two teams share a member.
 *
 * **Always.**
 */
export function duplicateTags(context: RegistrationContext): RegDenyType | null {
  if (context.settings.allowDuplicateTags) return null;

  if (context.fakeTagMatches <= 0) return null;

  return RegDeny.faketag;
}

/**
 * The requirements matrix.
 *
 * The order is the source's order, and the first match wins.
 *
 * Only the two mention checks are conditional (on `required_mentions >
 * 0`); every other guard always runs.
 */
export const REGISTRATION_GUARDS: readonly RegistrationGuard[] = [
  teamNameRequired,
  botMentionsRejected,
  mentionCount,
  bannedUser,
  requiredLines,
  oneRegistrationPerPerson,
  duplicateTeamName,
  duplicateTags,
];

/**
 * Runs the matrix.
 *
 * @returns the first reason to refuse, or `null` when the registration
 *          is acceptable.
 */
export async function evaluateRegistration(
  context: RegistrationContext,
  guards: readonly RegistrationGuard[] = REGISTRATION_GUARDS,
): Promise<RegDenyType | null> {
  for (const guard of guards) {
    const reason = await guard(context);

    if (reason) return reason;
  }

  return null;
}
