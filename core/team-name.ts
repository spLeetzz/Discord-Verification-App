/**
 * Derives a team name from free text.
 *
 * This is a verbatim port of Quotient's `find_team`
 * (`src/utils/default.py:30-43`). It decides a name a user sees on a
 * slotlist, so the behaviour — including its quirks — is preserved exactly.
 *
 * The Python original, for reference:
 *
 * ```python
 * teamname = re.search(r"team.*", message.content)
 * if teamname is None:
 *     return f"{author}'s team"
 * teamname = re.sub(r"<@*#*!*&*\d+>|team|name|[^\w\s]", "", teamname.group()).strip()
 * teamname = f"Team {teamname.title()}" if teamname else f"{author}'s team"
 * ```
 *
 * Three details survive the port:
 *
 *  1. The search is for the literal lowercase word `team`, so the text has
 *     to be lowercased first. Quotient lowercased the message in place
 *     before calling this; we lowercase a copy (D27).
 *  2. `.` does not match a newline, so the match stops at the end of the
 *     line it started on — a second line is never part of the name.
 *  3. The fallback is the author's *mention* followed by `'s team`, because
 *     Python interpolated `str(author)`.
 */

import { titleCase } from "./text.js";

/**
 * The first `team` on the text, up to the end of that line.
 *
 * JavaScript's `.` also excludes newlines, so this behaves like Python's
 * `re.search(r"team.*", content)` without the `s` flag.
 */
const TEAM_PATTERN = /team.*/;

/**
 * Removes mentions, the words `team` and `name`, and every character that
 * is neither a word character nor whitespace.
 *
 * Python's `\w` is `[A-Za-z0-9_]` plus Unicode letters and digits, so the
 * JavaScript equivalent is `[\p{L}\p{N}_]`.
 */
const STRIP_PATTERN = /<@*#*!*&*\d+>|team|name|[^\p{L}\p{N}_\s]/gu;

/**
 * Quotient truncated team names to 30 characters at the model boundary.
 * The truncation lives at the call site, not inside `find_team`, so it is
 * not applied here either.
 */
export const TEAM_NAME_MAX_LENGTH = 30;

/** Anything that renders as a Discord user mention (`User.toString()` → `<@id>`). */
export interface TeamNameAuthor {
  toString(): string;
}

/** The message a team name is derived from. */
export interface TeamNameSource {
  /** The raw message content. */
  readonly content: string;
  /** The message author, used for the fallback name. */
  readonly author: TeamNameAuthor;
}

/**
 * Normalises a message the way Quotient did before deriving a team name:
 * lowercased and NFKC-normalised.
 *
 * Quotient did this by mutating `message.content` in place. We never mutate
 * the message; we pass a normalised copy around instead (D27).
 */
export function normaliseMessageContent(content: string): string {
  // Order matters and matches the original: lower first, then NFKC.
  return content.toLowerCase().normalize("NFKC");
}

/**
 * Strips the noise out of a team-name fragment and title-cases what is
 * left. Returns an empty string when nothing usable survives.
 */
function cleanTeamName(fragment: string): string {
  return fragment.replace(STRIP_PATTERN, "").trim();
}

/**
 * The name Quotient fell back to when no team name could be derived.
 */
export function teamNameFallback(author: TeamNameAuthor): string {
  return `${String(author)}'s team`;
}

/**
 * Derives a team name from a message.
 *
 * @param source    the message content and its author
 * @param options   `normalise: false` reproduces Quotient's raw-content
 *                  path, where the search for `team` is case-sensitive.
 *                  Defaults to `true`, which is what D27 ratifies.
 */
export function findTeam(
  source: TeamNameSource,
  options: { normalise?: boolean } = {},
): string {
  const content =
    options.normalise === false
      ? source.content
      : normaliseMessageContent(source.content);

  const match = TEAM_PATTERN.exec(content);

  if (!match) return teamNameFallback(source.author);

  const cleaned = cleanTeamName(match[0]);

  if (!cleaned) return teamNameFallback(source.author);

  return `Team ${titleCase(cleaned)}`;
}

/**
 * Applies the same normalisation to a name a user typed.
 *
 * Used by the slot-claim modal, where the user types a team name instead
 * of writing a registration message. The result carries the same `Team `
 * prefix as `find_team`.
 *
 * @returns the normalised name, or an empty string when the input holds
 *          nothing usable (the caller decides what to do then — a typed
 *          name has no author to fall back to).
 */
export function normaliseTeamName(raw: string): string {
  const cleaned = cleanTeamName(normaliseMessageContent(raw));

  if (!cleaned) return "";

  return `Team ${titleCase(cleaned)}`;
}
