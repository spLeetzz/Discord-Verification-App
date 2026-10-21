/**
 * The screenshot verification rules.
 *
 * Quotient kept them on the `SSVerify` model, one method per screenshot
 * type, each a chain of `if`/`elif` checks on the OCR text:
 *
 * ```python
 * async def verify_yt(self, ctx, image):
 *     if not any(_ in image.lower_text for _ in ("subscribe", "videos")):
 *         return "... not a valid youtube ss."
 *     elif not self.channel_name.lower().replace(" ", "") in image.lower_text:
 *         return "... must belong to ... channel."
 *     elif "SUBSCRIBE " in image.text.replace("\n", " "):
 *         return "... you must subscribe ..."
 * ```
 *
 * Here every type is an **ordered list of guards**. The first guard that
 * refuses wins and the rest do not fire, which is what the `elif` chain
 * did — but as data, so it can be tested without a Discord connection and
 * so a new type is one list rather than one method.
 *
 * ## The OCR engine changed
 *
 * Quotient's rules were calibrated against a remote OCR service that is not
 * in its repository. This port uses the local Tesseract provider, and the
 * two read a screenshot differently. Three rules changed because of it:
 *
 *  1. **The page-name check is tolerant of noise.** Quotient asked for the
 *     page name as one contiguous piece of the OCR text. An icon that the
 *     engine reads as a character *inside* the name ("Team | Phoenix" read
 *     as `team|phoenix`) broke a check a human would pass. The check now
 *     also accepts the name with a couple of stray characters in it.
 *  2. **The literal button checks are case-insensitive.** Quotient looked
 *     for `"SUBSCRIBE "` and `"FOLLOW "` in the raw text. Tesseract does
 *     not guarantee the same casing the screen shows, so the checks are
 *     case-insensitive word matches now. They still refuse "SUBSCRIBED" and
 *     "Following", exactly as Quotient's trailing space did.
 *  3. **The raw text is used for the literals and the normalised text for
 *     the contains checks.** `OcrResult.text` has its whitespace stripped,
 *     which destroys `"SUBSCRIBE "`; `OcrResult.rawText` keeps it. Both
 *     sides of a contains check are normalised with the *same* function, so
 *     a space in the configured name cannot make the comparison fail.
 */

import { normaliseText } from "../ssverify/ocr/index.js";
import type { OcrResult } from "../ssverify/ocr/index.js";
import type { ScreenshotType } from "./types.js";
import { SCREENSHOT_TYPE_LABELS } from "./types.js";

/* ------------------------------------------------------------------ *
 * The shape of a rule
 * ------------------------------------------------------------------ */

/** What a guard is given. */
export interface VerificationInput {
  /** What the OCR provider made of the screenshot. */
  readonly image: OcrResult;
  /** The configuration the screenshot is checked against. */
  readonly config: VerificationConfig;
}

/**
 * The part of a configuration the rules look at.
 *
 * A narrow shape on purpose: the rules never see the whole row, so they
 * cannot accidentally depend on something they should not.
 */
export interface VerificationConfig {
  readonly ssType: ScreenshotType;
  /** The page or channel the screenshot has to belong to. */
  readonly channelName: string;
  /** The link to that page or channel. */
  readonly channelLink: string;
  /** The words a custom filter matches on. */
  readonly keywords: readonly string[];
}

/**
 * One rule.
 *
 * @returns `null` when the screenshot passes this rule, or the refusal
 *          message when it does not.
 */
export type VerificationGuard = (input: VerificationInput) => string | null;

/** What a verification decided. */
export type VerificationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/* ------------------------------------------------------------------ *
 * Text matching
 * ------------------------------------------------------------------ */

/**
 * How many characters may sit between the matched parts of a page name.
 *
 * One icon read as one character is the realistic case; two is the budget.
 */
export const MAX_NAME_NOISE = 2;

/**
 * A name shorter than this is never matched with noise.
 *
 * The tolerant match is a bounded subsequence, so a two-letter name would
 * match almost anything. Four characters is the shortest name that is
 * specific enough for the tolerance to be safe.
 */
export const MIN_NOISY_NAME_LENGTH = 4;

/**
 * Removes everything that is neither a letter nor a digit.
 *
 * The OCR engine reads an icon as punctuation often enough that a name can
 * arrive as `team|phoenix` instead of `team phoenix`.
 */
export function stripNoise(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Is `needle` a subsequence of `haystack` with at most `maxNoise` extra
 * characters between the matched ones?
 *
 * The characters have to appear **in order**. "teamphoenix" is a
 * subsequence of "teamxyzphoenix" with one gap; it is not a subsequence of
 * "phoenixteam".
 */
export function isBoundedSubsequence(
  needle: string,
  haystack: string,
  maxNoise: number,
): boolean {
  let index = 0;
  let noise = 0;
  let started = false;

  for (const character of haystack) {
    const expected = needle[index];

    if (expected !== undefined && character === expected) {
      index += 1;
      started = true;
      continue;
    }

    // Characters before the first match are not "noise": the name may sit
    // anywhere in the text.
    if (!started) continue;

    noise += 1;

    if (noise > maxNoise) return false;
  }

  return index === needle.length;
}

/**
 * Does the OCR text contain the expected page name?
 *
 * Three passes, in order:
 *
 *  1. the name as one contiguous piece of the text;
 *  2. the name with the punctuation removed from the text — this is what
 *     catches an icon read as `|` or `•`;
 *  3. the name with up to {@link MAX_NAME_NOISE} stray characters inside
 *     it — this is what catches an icon read as a *letter*.
 *
 * Both sides are normalised with the same function first, so a space in the
 * configured name cannot make the comparison fail.
 */
export function matchesName(expected: string, text: string): boolean {
  const needle = normaliseText(expected);

  if (needle.length === 0) return true;

  if (text.includes(needle)) return true;

  const bare = stripNoise(needle);
  const haystack = stripNoise(text);

  if (bare.length === 0) return false;

  if (haystack.includes(bare)) return true;

  if (bare.length < MIN_NOISY_NAME_LENGTH) return false;

  return isBoundedSubsequence(bare, haystack, MAX_NAME_NOISE);
}

/**
 * The raw text of a screenshot, with the newlines flattened.
 *
 * Quotient did `image.text.replace("\n", " ")` before looking for a button,
 * so that a button at the end of a line still had a space after it.
 */
function flattenedRawText(image: OcrResult): string {
  return (image.rawText ?? "").replace(/\r?\n/g, " ");
}

/**
 * Does the raw text contain the word "subscribe"?
 *
 * The button on a YouTube channel says "SUBSCRIBE"; once the channel is
 * subscribed it says "SUBSCRIBED", which must **not** trigger the refusal.
 * The word boundary does that, and the case-insensitive match survives an
 * engine that reads the label in title case.
 */
export function hasSubscribeButton(image: OcrResult): boolean {
  return /\bsubscribe\b/i.test(flattenedRawText(image));
}

/**
 * Does the raw text contain the word "follow"?
 *
 * "Following" must not trigger the refusal — the member *has* followed the
 * page — and "Unfollow" is not a follow button either.
 */
export function hasFollowButton(image: OcrResult): boolean {
  return /\bfollow(?!ing)\b/i.test(flattenedRawText(image));
}

/* ------------------------------------------------------------------ *
 * The messages
 * ------------------------------------------------------------------ */

/**
 * How the configured page is named in a refusal.
 *
 * `[name](link)` when there is a link, `` `name` `` when there is not — a
 * markdown link with an empty target renders as a broken link.
 */
export function pageLabel(config: VerificationConfig): string {
  const name = config.channelName;

  if (!config.channelLink) return `\`${name}\``;

  return `[\`${name}\`](${config.channelLink})`;
}

/* ------------------------------------------------------------------ *
 * The guards
 * ------------------------------------------------------------------ */

/**
 * The words that prove the screenshot is of the right app.
 *
 * Quotient's YouTube rule wanted "subscribe" or "videos"; the Instagram
 * rule wanted "followers". The other types have no marker of their own —
 * they are identified by the page name.
 */
const TYPE_MARKERS: Readonly<
  Record<ScreenshotType, readonly string[]>
> = {
  youtube: ["subscribe", "videos"],
  instagram: ["followers"],
  rooter: [],
  loco: [],
  any_ss: [],
  custom: [],
};

/**
 * "This is not a valid <flavour> ss."
 *
 * The flavour is the type's own name, as Quotient wrote it (`youtube`,
 * `instagram`).
 */
function notAValidScreenshot(type: ScreenshotType): VerificationGuard {
  return ({ image }) => {
    const markers = TYPE_MARKERS[type];

    const found = markers.some((marker) =>
      image.text.includes(normaliseText(marker)),
    );

    if (found) return null;

    return `This is not a valid ${type} ss.`;
  };
}

/**
 * "Screenshot must belong to <page> channel." (or "page." for Instagram).
 */
function requirePageName(noun: "channel" | "page"): VerificationGuard {
  return ({ image, config }) => {
    if (config.channelName.length === 0) return null;

    if (matchesName(config.channelName, image.text)) return null;

    return `Screenshot must belong to ${pageLabel(config)} ${noun}.`;
  };
}

/**
 * "You must subscribe <page> to get verified."
 *
 * The refusal fires when the button says "SUBSCRIBE", which means the
 * member has **not** subscribed yet.
 */
function forbidSubscribeButton(): VerificationGuard {
  return ({ image, config }) => {
    if (!hasSubscribeButton(image)) return null;

    return `You must subscribe ${pageLabel(config)} to get verified.`;
  };
}

/**
 * "You must follow <page> to get verified."
 */
function forbidFollowButton(): VerificationGuard {
  return ({ image, config }) => {
    if (!hasFollowButton(image)) return null;

    return `You must follow ${pageLabel(config)} to get verified.`;
  };
}

/**
 * "This is not a valid <name> ss."
 *
 * The custom filter accepts a screenshot when it mentions the filter's name
 * **or** any of the extra keywords. The name is matched tolerantly (it is a
 * name); the keywords are matched literally (they are the operator's own
 * words, and a tolerant match on a two-letter keyword would accept
 * anything).
 */
function requireCustomKeywords(): VerificationGuard {
  return ({ image, config }) => {
    if (config.channelName.length > 0) {
      if (matchesName(config.channelName, image.text)) return null;
    }

    for (const keyword of config.keywords) {
      const needle = normaliseText(keyword);

      if (needle.length === 0) continue;

      if (image.text.includes(needle)) return null;
    }

    const label = config.keywords[0] ?? config.channelName;

    return `This is not a valid ${label} ss.`;
  };
}

/* ------------------------------------------------------------------ *
 * The matrix
 * ------------------------------------------------------------------ */

/**
 * The rules of every screenshot type, in the order they are checked.
 *
 * The order is Quotient's: the "is this even the right app" check comes
 * first, then "is this the right page", then "has the member done the one
 * thing we asked".
 */
export const VERIFICATION_RULES: Readonly<
  Record<ScreenshotType, readonly VerificationGuard[]>
> = {
  youtube: [
    notAValidScreenshot("youtube"),
    requirePageName("channel"),
    forbidSubscribeButton(),
  ],
  instagram: [
    notAValidScreenshot("instagram"),
    requirePageName("page"),
    forbidFollowButton(),
  ],
  loco: [requirePageName("channel"), forbidFollowButton()],
  rooter: [requirePageName("channel"), forbidFollowButton()],
  any_ss: [],
  custom: [requireCustomKeywords()],
};

/**
 * The rules of one type.
 *
 * @throws RangeError when the type is not one of the six — an unknown type
 *         must not silently pass every check.
 */
export function rulesFor(type: ScreenshotType): readonly VerificationGuard[] {
  const rules = VERIFICATION_RULES[type];

  if (!rules) {
    throw new RangeError(`Unknown screenshot type: ${type}`);
  }

  return rules;
}

/**
 * Checks one screenshot against one configuration.
 *
 * @returns `{ ok: true }` when the screenshot is accepted, or the refusal
 *          message of the **first** rule that refused it.
 */
export function verifyScreenshot(
  config: VerificationConfig,
  image: OcrResult,
): VerificationOutcome {
  for (const guard of rulesFor(config.ssType)) {
    const refusal = guard({ image, config });

    if (refusal) return { ok: false, reason: refusal };
  }

  return { ok: true };
}

/**
 * The label of a type, as the setup panel shows it.
 */
export function screenshotTypeLabel(type: ScreenshotType): string {
  return SCREENSHOT_TYPE_LABELS[type];
}
