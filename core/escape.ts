/**
 * Escaping for user-supplied text.
 *
 * discord.js has no markdown escaper and no mention escaper. Quotient got
 * both from discord.py (`discord.utils.escape_markdown` and
 * `discord.utils.escape_mentions`), and its `tag raw` command needs them:
 * a tag whose body is stored verbatim must not be able to ping `@everyone`
 * or turn a stored line into bold text.
 *
 * The markdown escaper is a port of discord.py's implementation, including
 * its two modes:
 *
 *  - the *stock* mode (the default) escapes every markdown character;
 *  - the *as-needed* mode escapes only the characters that actually start a
 *    formatting run, so `**bold**` becomes `\*\*bold**` instead of
 *    `\*\*bold\*\*`.
 *
 * The mention escaper follows discord.py — a zero-width space after the `@`
 * — and additionally neutralises the `<@id>` form, which is the syntax
 * Discord actually turns into a ping. discord.py leaves that alone because
 * it was written for a bot that also set `allowed_mentions`; here the text
 * is stored and re-sent later, so it has to be safe on its own.
 */

/**
 * The markdown characters Discord reacts to.
 *
 * `_`, `\`, `~`, `|`, `*` and the backtick. Written as a string rather than
 * a regex literal because it is spliced into a larger pattern.
 */
const MARKDOWN_STOCK_SOURCE = "[_\\\\~|*`]";

/**
 * The markdown constructs that only count at the start of a line, plus the
 * `[text](url)` link form.
 *
 * `^` is line-anchored because the pattern is used with the multiline flag.
 */
const MARKDOWN_COMMON_SOURCE = String.raw`^>(?:>>)?\s|\[.+\]\(.+\)|^#{1,3}|^\s*-`;

/**
 * A URL, in the two shapes Discord renders as a link.
 *
 * The first alternative is Discord's own `<scheme:url>` form.
 */
const URL_SOURCE = String.raw`<[^: >]+:\/[^ >]+>|(?:https?|steam):\/\/[^\s<]+[^<.,:;\"'\]\s]`;

/** The stock escaper: markdown characters, with URLs left alone. */
const STOCK_ESCAPE = new RegExp(
  `(?<url>${URL_SOURCE})|(?<markdown>${MARKDOWN_STOCK_SOURCE}|${MARKDOWN_COMMON_SOURCE})`,
  "gm",
);

/** The stock escaper with URLs escaped too. */
const STOCK_ESCAPE_ALL = new RegExp(
  `(?<markdown>${MARKDOWN_STOCK_SOURCE}|${MARKDOWN_COMMON_SOURCE})`,
  "gm",
);

/**
 * The as-needed escaper.
 *
 * Each character is matched only when a later, unescaped copy of it exists
 * — so a matched pair is escaped once at the front and once at the back,
 * and a lone character in the middle of a word is left alone.
 */
const AS_NEEDED_ESCAPE = new RegExp(
  `(?<markdown>${[
    String.raw`\*(?=([\s\S]*((?<!\*)\*)))`,
    String.raw`\`(?=([\s\S]*((?<!\`)\`)))`,
    String.raw`_(?=([\s\S]*((?<!_)_)))`,
    String.raw`~(?=([\s\S]*((?<!~)~)))`,
    String.raw`\|(?=([\s\S]*((?<!\|)\|)))`,
    MARKDOWN_COMMON_SOURCE,
  ].join("|")})`,
  "gm",
);

/** The bare mention forms: `@everyone`, `@here` and `@<snowflake>`. */
const BARE_MENTION = /@(everyone|here|[!&]?[0-9]{17,20})/g;

/** The mention syntax that actually pings: `<@id>`, `<@!id>`, `<@&id>`, `<#id>`. */
const ANGLE_MENTION = /<([@#][!&]?\d{15,25})>/g;

/**
 * Escapes Discord markdown.
 *
 * @param text    the text to escape.
 * @param options `asNeeded` escapes only the characters that open a
 *                formatting run (discord.py's `as_needed`); `ignoreLinks`
 *                leaves URLs alone, which is the default and what
 *                `tag raw` wants.
 */
export function escapeMarkdown(
  text: string,
  options: { asNeeded?: boolean; ignoreLinks?: boolean } = {},
): string {
  if (options.asNeeded) {
    // A backslash is doubled first so it cannot swallow the escapes added
    // afterwards.
    const doubled = text.replace(/\\/g, "\\\\");

    return doubled.replace(AS_NEEDED_ESCAPE, "\\$<markdown>");
  }

  const regex =
    options.ignoreLinks === false ? STOCK_ESCAPE_ALL : STOCK_ESCAPE;

  return text.replace(regex, (match: string, ...rest: unknown[]) => {
    const named = rest[rest.length - 1] as
      | Record<string, string | undefined>
      | undefined;

    // The URL alternative matched — leave the link alone.
    if (named?.["url"]) return named["url"];

    return `\\${match}`;
  });
}

/**
 * Escapes mentions so the text cannot ping anyone.
 *
 * Two things happen:
 *
 *  1. the bare forms (`@everyone`, `@here`, `@123456789012345678`) get a
 *     zero-width space after the `@`, exactly as discord.py does;
 *  2. the angle-bracket forms (`<@id>`, `<@&id>`, `<#id>`) get their `<`
 *     escaped, because that is the syntax Discord actually resolves.
 *
 * Channel mentions are escaped as well. discord.py leaves them alone; here
 * the text is stored and re-sent, and a channel ping is a ping.
 */
export function escapeMentions(text: string): string {
  const bare = text.replace(BARE_MENTION, "@\u200b$1");

  return bare.replace(
    ANGLE_MENTION,
    (_match: string, inner: string) => `\\<${inner}>`,
  );
}
