/**
 * Reading Discord mentions out of free text.
 *
 * The claim modal, the reserved-slot form and the moderator's team form
 * all take a line of free text and need the member ids out of it.
 *
 * Two forms are recognised: `<@123456>` and `<@!123456>`. The second is
 * what the Discord client produces when it mentions a member by their
 * display name, and it is what a user who copies a mention out of the
 * client gets.
 */

/** A user mention, with or without the nickname marker. */
const MENTION_PATTERN = /<@!?(\d{17,20})>/g;

/**
 * The member ids mentioned in a piece of text.
 *
 * The ids come out in the order they appear, and none appears twice.
 * Anything that is not a mention is ignored — the text may hold a team
 * name as well.
 */
export function parseMentionIds(text: string): string[] {
  const ids: string[] = [];

  for (const match of text.matchAll(MENTION_PATTERN)) {
    const id = match[1];

    if (!id) continue;
    if (ids.includes(id)) continue;

    ids.push(id);
  }

  return ids;
}

/**
 * The first member mentioned in a piece of text, or `null`.
 *
 * The moderator's team form asks for "the leader of that team", so only
 * the first mention matters.
 */
export function firstMentionId(text: string): string | null {
  return parseMentionIds(text)[0] ?? null;
}
