/**
 * Easy tag — turning raw ids and `@names` into real mentions.
 *
 * Quotient's listener looked for tags with one regular expression:
 *
 * ```python
 * tags = set(re.findall(r"\b\d{18}\b|\b@\w+", message.content, re.IGNORECASE))
 * ```
 *
 * and told the user:
 *
 * > "You can write your teammate's id, @their_name or @their_full_discord_tag"
 *
 * ## Two bugs in that one line
 *
 *  1. **`\b@\w+` does not match a full tag.** It matches `@name` and stops
 *     before the `#1234` discriminator, so `@their_full_discord_tag` was
 *     silently truncated to `@their_full_discord_tag`'s first part — the
 *     very form the error message advertises. The full tag is matched now
 *     (B14).
 *  2. **`\b` in front of the `@` requires a word character before it.**
 *     "@name" at the start of a message, or after a space, has no word
 *     character in front of it, so there is no boundary and the pattern
 *     never fired. The `@` must instead **not** be preceded by a word
 *     character, which also stops an email address (`foo@bar.com`) from
 *     being read as a mention.
 *
 * The extraction and the resolution are pure functions over a small member
 * shape, so both can be tested without a Discord connection.
 */

/**
 * A full Discord tag: `@name` or `@name#1234`.
 *
 * The username is Discord's shape — letters, digits, underscores and dots,
 * up to 32 characters — and the discriminator is the last four digits of
 * the account's id.
 *
 * The lookbehind keeps the `@` from being preceded by a word character or
 * a dot, so `mail@example.com` is not a mention.
 */
const FULL_TAG_PATTERN = /(?<![\w.])@([A-Za-z0-9_][A-Za-z0-9_.]{0,31})(?:#(\d{4}))?/g;

/** A raw account id: seventeen to nineteen digits. */
const RAW_ID_PATTERN = /\b\d{17,19}\b/g;

/**
 * The `@` of a mention in front of a raw account id.
 *
 * A real Discord mention is `<@123456789012345678>`. The tag pattern sees
 * the `@123456789012345678` inside it, and the id pattern sees the digits
 * — the same member twice.
 */
const AT_RAW_ID_PATTERN = /^@\d{17,19}$/;

/**
 * A tag **or** a raw id, in one pass.
 *
 * The two are matched together so that the tokens come out in the order
 * they appear in the message, the way Quotient's single `findall` did.
 */
const TOKEN_PATTERN = new RegExp(
  `${FULL_TAG_PATTERN.source}|${RAW_ID_PATTERN.source}`,
  "g",
);

/** What the resolver needs to know about a member. */
export interface EasyTagMember {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

/**
 * Every tag in a message.
 *
 * @returns the raw ids and the `@tags`, in the order they appear, without
 *          duplicates.
 */
export function extractEasyTags(content: string): string[] {
  const found: string[] = [];

  // The pattern is global, so the state has to be reset before it is used
  // again — `String.match` with a global pattern does that, but `exec` in a
  // loop does not.
  TOKEN_PATTERN.lastIndex = 0;

  let match = TOKEN_PATTERN.exec(content);

  while (match !== null) {
    // A mention of a member is the member's id, not a name — the `@` is
    // how Discord writes it, not part of it.
    const token = AT_RAW_ID_PATTERN.test(match[0])
      ? match[0].slice(1)
      : match[0];

    if (!found.includes(token)) found.push(token);

    match = TOKEN_PATTERN.exec(content);
  }

  return found;
}

/**
 * The username and the discriminator of a full tag.
 *
 * @returns `null` when the token is not a full tag.
 */
export function parseFullTag(
  token: string,
): { readonly name: string; readonly discriminator: string } | null {
  const match = /^@([A-Za-z0-9_][A-Za-z0-9_.]{0,31})#(\d{4})$/.exec(token);

  const name = match?.[1];
  const discriminator = match?.[2];

  if (name === undefined || discriminator === undefined) return null;

  return { name, discriminator };
}

/**
 * Is the token a raw account id?
 */
export function isRawId(token: string): boolean {
  return /^\d{17,19}$/.test(token);
}

/**
 * Finds the member a tag refers to.
 *
 * Three shapes, in the order they are tried:
 *
 *  1. **A raw id** — the member whose id is exactly that.
 *  2. **A full tag** (`@name#1234`) — the member whose id ends with the
 *     discriminator. When several members share a discriminator the
 *     username decides; when none of them has that username the tag is
 *     ambiguous and nothing is returned.
 *  3. **A bare name** (`@name`) — the member whose username or display
 *     name matches, case-insensitively.
 *
 * @returns the member's id, or `null` when the tag refers to nobody.
 */
export function resolveEasyTag(
  token: string,
  members: readonly EasyTagMember[],
): string | null {
  // The token without its `@`. A real mention (`<@123>`) carries the `@`
  // in front of the id, and the id is what identifies the member.
  const bare = token.startsWith("@") ? token.slice(1) : token;

  if (isRawId(bare)) {
    const byId = members.find((member) => member.id === bare);

    return byId ? byId.id : null;
  }

  const full = parseFullTag(token);

  if (full) {
    const candidates = members.filter((member) =>
      member.id.endsWith(full.discriminator),
    );

    const exact = candidates.find(
      (member) => member.username.toLowerCase() === full.name.toLowerCase(),
    );

    if (exact) return exact.id;

    if (candidates.length === 1) {
      const only = candidates[0];

      return only ? only.id : null;
    }

    return null;
  }

  if (bare.length === 0) return null;

  const lowered = bare.toLowerCase();

  const byUsername = members.find(
    (member) => member.username.toLowerCase() === lowered,
  );

  if (byUsername) return byUsername.id;

  const byDisplayName = members.find(
    (member) => member.displayName.toLowerCase() === lowered,
  );

  return byDisplayName ? byDisplayName.id : null;
}

/**
 * The message Quotient showed when no tag was found.
 *
 * Kept verbatim — it is the wording the guild's members already know, and
 * it is the message that advertises the full-tag form.
 */
export const NO_TAG_MESSAGE =
  "I couldn't find any discord tag in this form.\nYou can write your teammate's id , @their_name or @their_full_discord_tag";

/**
 * The message the bot posts when it did convert a message.
 *
 * The original content is repeated so a captain can see what the bot made
 * of it.
 */
export function buildEasyTagReply(
  originalContent: string,
  mentions: readonly string[],
): string {
  return `\`\`\`${originalContent}\nDiscord Tags: ${mentions.join(", ")}\`\`\``;
}
