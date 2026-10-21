/**
 * The registration requirements matrix.
 *
 * A registration message is checked against an **ordered list of guards**.
 * Each guard answers one question and returns a deny reason or `null`.
 * The first reason wins; the rest do not fire.
 *
 * The source's tourney matrix (`src/cogs/esports/helpers/tourney.py:55-86`)
 * is not a list — it is two independent `if`s followed by an `elif` chain
 * hanging off the second one:
 *
 * ```python
 * if tourney.teamname_compulsion:                          # independent
 *     ...
 * if tourney.required_mentions and not all(...bot...):     # independent
 *     ...
 * elif not len(message.mentions) >= tourney.required_mentions:   # chain
 *     ...
 * elif message.author.id in tourney.banned_users:                # chain
 *     ...
 * elif len(message.content.splitlines()) < tourney.required_lines: # chain
 *     ...
 * elif not tourney.allow_duplicate_tags:                        # chain
 *     ...
 * ```
 *
 * and the *process* stage (`src/cogs/esports/events/tourneys.py:37-100`)
 * added two more, in this order:
 *
 * ```python
 * if tourney.no_duplicate_name and check_duplicate: ...   # duplicate team name
 * if not tourney.multiregister and message.author.id in ...: ...  # one registration
 * ```
 *
 * Two consequences of that shape are load-bearing and are reproduced here
 * exactly:
 *
 *  1. **The `elif` chain only runs when the second `if` is false.** The
 *     second `if` is `tourney.required_mentions and not all(mentions
 *     are humans)`. When `required_mentions` is `0` the whole `if` is
 *     falsy, so *the entire chain is skipped* — the banned-user check,
 *     the line check and the fake-tag check all stop firing. A guild
 *     that sets `required_mentions` to `0` gets exactly this behaviour
 *     here too.
 *
 *  2. **The two process-stage guards are outside the chain.** They run
 *     whatever `required_mentions` is, and they run *after* the whole
 *     matrix — so a message with no mentions at all is refused for the
 *     mention count before the duplicate-name check is reached.
 *
 * The team-name check is independent of everything else, exactly as in the
 * source. The port reports one reason (the first match wins), which is
 * the behaviour the decision log asks for; the source dispatched up to
 * two events.
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
  /** How many mentions a registration needs. `0` disables the chain. */
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
  /** The users banned from this tournament. */
  readonly bannedUserIds: ReadonlySet<string>;
  /** The users who lead a registered slot in this tournament. */
  readonly claimedOwnerIds: ReadonlySet<string>;
  /** The team names already claimed in this tournament. */
  readonly claimedTeamNames: ReadonlySet<string>;
  /** How many claimed slots already contain one of the mentioned users. */
  readonly fakeTagMatches: number;
  /**
   * The team name the message produces.
   *
   * The same value the group list will show, so the duplicate check
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
 *
 * (The scrims area has the same helper. It is duplicated here rather
 * than imported, because one area may not depend on another area's
 * code — the manager may move it to `core/`.)
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
 * Does the `elif` chain apply?
 *
 * The chain hangs off `if tourney.required_mentions and not all(mentions
 * are humans)`. It runs when that condition is **false**, which means:
 * the tournament asks for mentions, and nobody mentioned a bot.
 */
export function elifChainApplies(context: RegistrationContext): boolean {
  if (context.settings.requiredMentions <= 0) return false;

  return !context.mentions.some((mention) => mention.isBot);
}

/**
 * Wraps a check so it only runs as part of the `elif` chain.
 */
function chainGuard(
  check: (context: RegistrationContext) => RegDenyType | null,
): RegistrationGuard {
  return (context) => {
    if (!elifChainApplies(context)) return null;

    return check(context);
  };
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
 * `tourney.required_mentions and not all(mentions are humans)`, so a
 * tournament that asks for no mentions never rejects a bot mention.
 */
export function botMentionsRejected(
  context: RegistrationContext,
): RegDenyType | null {
  if (context.settings.requiredMentions <= 0) return null;

  if (!context.mentions.some((mention) => mention.isBot)) return null;

  return RegDeny.botmention;
}

/** Guard 3 — enough mentions. */
export function mentionCount(
  context: RegistrationContext,
): RegDenyType | null {
  if (context.mentions.length < context.settings.requiredMentions) {
    return RegDeny.nomention;
  }

  return null;
}

/** Guard 4 — the author is not banned from this tournament. */
export function bannedUser(context: RegistrationContext): RegDenyType | null {
  if (!context.bannedUserIds.has(context.authorId)) return null;

  return RegDeny.banned;
}

/** Guard 5 — the message has enough lines. */
export function requiredLines(
  context: RegistrationContext,
): RegDenyType | null {
  const lines = countLines(normalisedContent(context));

  if (lines < context.settings.requiredLines) return RegDeny.nolines;

  return null;
}

/**
 * Guard 6 — no two teams share a member.
 *
 * The source's check was a raw SQL statement with an array-overlap
 * operator, against a schema-qualified join table, quoting the
 * qualified names as single identifiers — so it would raise
 * `relation does not exist` at runtime. It is a typed query here (S6,
 * row 14), and the guard itself is unchanged.
 */
export function duplicateTags(context: RegistrationContext): RegDenyType | null {
  if (context.settings.allowDuplicateTags) return null;

  if (context.fakeTagMatches <= 0) return null;

  return RegDeny.faketag;
}

/**
 * Guard 7 — no two teams share a name.
 *
 * This one is from the source's *process* stage, so it runs whatever
 * `required_mentions` is.
 *
 * The name compared is the one the *team-name* derivation produces, so
 * the comparison is with the same normalisation the group list shows.
 */
export function duplicateTeamName(
  context: RegistrationContext,
): RegDenyType | null {
  if (!context.settings.noDuplicateName) return null;

  if (!context.claimedTeamNames.has(context.teamName ?? "")) return null;

  return RegDeny.duplicate;
}

/** Guard 8 — one registration per person. */
export function oneRegistrationPerPerson(
  context: RegistrationContext,
): RegDenyType | null {
  if (context.settings.multiregister) return null;

  if (!context.claimedOwnerIds.has(context.authorId)) return null;

  return RegDeny.multiregister;
}

/**
 * The requirements matrix.
 *
 * The order is the source's order: the matrix first, then the two
 * process-stage guards. The chain guards carry the chain's precondition
 * with them.
 */
export const REGISTRATION_GUARDS: readonly RegistrationGuard[] = [
  teamNameRequired,
  botMentionsRejected,
  chainGuard(mentionCount),
  chainGuard(bannedUser),
  chainGuard(requiredLines),
  chainGuard(duplicateTags),
  duplicateTeamName,
  oneRegistrationPerPerson,
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
