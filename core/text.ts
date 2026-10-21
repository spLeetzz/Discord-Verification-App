/**
 * Small string helpers.
 *
 * These are ports of Quotient's `utils/formats.py` and `utils/time.py`
 * (`human_join`). They exist because the same shapes are needed in several
 * modules and because the originals are not available in JavaScript.
 */

/**
 * Shortens a string to at most `maxLength` characters.
 *
 * Quotient's `truncate_string` always cut `len(suffix)` characters off the
 * end, even when the string already fitted — a 127 character name in a
 * 128 character field came out as 125 characters. This version only cuts
 * when the string is genuinely too long, and the result never exceeds
 * `maxLength`.
 */
export function truncate(
  value: string,
  maxLength = 128,
  suffix = "...",
): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;

  // A suffix longer than the budget leaves no room for content.
  if (suffix.length >= maxLength) return value.slice(0, maxLength);

  return value.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Renders a count with its noun, e.g. `plural(3, "day")` → `"3 days"`.
 *
 * The number is included, matching Quotient's `plural` format helper, which
 * was used as `format(plural(n), "day")`.
 */
export function plural(
  value: number,
  singular: string,
  pluralForm?: string,
): string {
  // Quotient compared `abs(v) != 1`, so `-1` still reads as the singular.
  const word = Math.abs(value) === 1 ? singular : (pluralForm ?? `${singular}s`);

  return `${value} ${word}`;
}

/**
 * Joins a list the way a human would: `"a, b and c"`.
 *
 * Ported from Quotient's `human_join`, including its two-element special
 * case (`"a or b"`, not `"a, b"`).
 */
export function humanJoin(
  seq: readonly string[],
  delim = ", ",
  final = "or",
): string {
  if (seq.length === 0) return "";
  if (seq.length === 1) return seq[0] ?? "";

  if (seq.length === 2) {
    return `${seq[0] ?? ""} ${final} ${seq[1] ?? ""}`;
  }

  const head = seq.slice(0, -1).join(delim);
  const tail = seq[seq.length - 1] ?? "";

  return `${head} ${final} ${tail}`;
}

/**
 * Title-cases a string the way Python's `str.title()` does.
 *
 * JavaScript has no `toTitleCase`, and Quotient's team-name normaliser
 * depends on Python's exact behaviour: every run of letters is a word, the
 * first letter of the word is upper-cased and the rest are lower-cased.
 * Non-letters (digits, punctuation, whitespace) break words apart, so
 * `"don't"` becomes `"Don'T"` and `"abc123def"` becomes `"Abc123Def"`.
 */
export function titleCase(value: string): string {
  return value.replace(/\p{L}+/gu, (word) => {
    const first = word.charAt(0);
    const upper = first.toUpperCase();

    // Python's title-casing never expands one character into several
    // ("ß" stays "ß"), while JavaScript's upper-casing does ("SS"). Keep
    // the original character when the expansion would change the length.
    const head = upper.length === 1 ? upper : first;

    return head + word.slice(1).toLowerCase();
  });
}
