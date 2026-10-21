/**
 * The identity service — the state machine and the rules.
 *
 * Everything a caller can do to a tag-check channel, an easy-tag channel or
 * a screenshot-verification setup goes through here. The command adapters
 * and the message listeners are thin on top of this file.
 *
 * The premium gates are in here too, and they are all the same shape:
 *
 *  - the **check happens before the mutation** (D15). A refusal that arrives
 *    after the state changed cannot be undone;
 *  - the check goes through {@link assertEntitled} and nothing else.
 */

import { RateLimiter } from "../../core/ratelimit.js";
import { PremiumFeature } from "../../core/constants.js";
import { logger } from "../../utils/logger.js";
import { assertEntitled } from "../premium/entitlements.js";
import { FREE_TIER } from "../premium/limits.js";
import * as repo from "./repo.js";
import * as cache from "./cache.js";
import { analyzeScreenshot, isOcrAvailable } from "./ocr.js";
import { checkDuplicate, resolveDuplicateThreshold, submissionJumpUrl } from "./duplicate.js";
import type { CorruptSubmission, DuplicateMatch } from "./duplicate.js";
import { verifyScreenshot } from "./verification.js";
import type { VerificationOutcome } from "./verification.js";
import type {
  EasyTagConfig,
  ScreenshotType,
  SsConfig,
  SsSubmission,
  TagCheckConfig,
} from "./types.js";
import { isPremiumScreenshotType } from "./types.js";

/* ------------------------------------------------------------------ *
 * Premium gates
 * ------------------------------------------------------------------ */

/**
 * The guild may have one more tag-check or easy-tag channel.
 *
 * The free tier allows one of each (D45); the `extra_channels`
 * entitlement lifts the limit. The count is read **before** anything is
 * written, so a refused command leaves nothing behind.
 */
export async function assertChannelAllowance(
  guildId: string,
  kind: "tagcheck" | "easytag",
): Promise<void> {
  const limit = kind === "tagcheck" ? FREE_TIER.tagcheckChannels : FREE_TIER.easytagChannels;

  const current =
    kind === "tagcheck"
      ? await repo.countTagCheckChannels(guildId)
      : await repo.countEasyTagChannels(guildId);

  if (current < limit) return;

  await assertEntitled(guildId, PremiumFeature.extraChannels);
}

/**
 * The guild may have one more screenshot-verification setup.
 *
 * The free tier allows one (D45). The entitlement that lifts the limit is
 * `extra_channels` — the same one that lifts the tag-check limit, because
 * both are "one more setup than the free tier allows". The log does not
 * name an entitlement for this count; this is the decision.
 */
export async function assertSsConfigAllowance(guildId: string): Promise<void> {
  const current = await repo.countSsConfigs(guildId);

  if (current < FREE_TIER.ssverifyConfigs) return;

  await assertEntitled(guildId, PremiumFeature.extraChannels);
}

/**
 * The guild may use this screenshot type.
 *
 * Quotient let YouTube be free and everything else behind the premium
 * check. The check happens **here**, before the caller assigns the type to
 * anything — Quotient assigned the type first and checked afterwards, and
 * the editor then wrote the premium type to a free guild's row (B8).
 */
export async function assertScreenshotTypeAllowed(
  guildId: string,
  type: ScreenshotType,
): Promise<void> {
  if (!isPremiumScreenshotType(type)) return;

  await assertEntitled(guildId, PremiumFeature.screenshotTypes);
}

/**
 * The guild may set a success message.
 *
 * Quotient disabled the editor's button for a free guild and had no guard
 * at all in the setup wizard, so the gate was bypassable (B12). One check
 * covers both paths now.
 */
export async function assertSuccessMessageAllowed(guildId: string): Promise<void> {
  await assertEntitled(guildId, PremiumFeature.successMessage);
}

/* ------------------------------------------------------------------ *
 * Tag check
 * ------------------------------------------------------------------ */

/**
 * Makes a channel a tag-check channel.
 *
 * @param ignoreRoleId the guild's ignore role, stored **by id** (D16).
 */
export async function setTagCheckChannel(input: {
  guildId: string;
  channelId: string;
  requiredMentions: number;
  ignoreRoleId: string;
}): Promise<TagCheckConfig> {
  await assertChannelAllowance(input.guildId, "tagcheck");

  const id = await repo.insertTagCheckChannel({
    guildId: input.guildId,
    channelId: input.channelId,
    requiredMentions: input.requiredMentions,
  });

  await repo.writeTagCheckIgnoreRole(id, input.ignoreRoleId);

  cache.cacheChannel("tagcheck", input.channelId);

  const created = await repo.findTagCheckById(id);

  if (!created) {
    throw new Error("the tag-check channel was created but could not be read back");
  }

  return created;
}

/** Removes a tag-check channel. */
export async function removeTagCheckChannel(channelId: string): Promise<void> {
  await repo.deleteTagCheckChannel(channelId);

  cache.uncacheChannel("tagcheck", channelId);
}

/** Turns the auto-delete of a tag-check channel on or off. */
export async function toggleTagCheckAutoDelete(
  channelId: string,
): Promise<boolean | null> {
  return repo.toggleTagCheckAutoDelete(channelId);
}

/** Every tag-check channel of a guild. */
export async function listTagCheckChannels(
  guildId: string,
): Promise<TagCheckConfig[]> {
  return repo.listTagCheckChannels(guildId);
}

/* ------------------------------------------------------------------ *
 * Easy tag
 * ------------------------------------------------------------------ */

/**
 * Makes a channel an easy-tag channel.
 *
 * @param ignoreRoleId the guild's ignore role, stored **by id** (D16).
 */
export async function setEasyTagChannel(input: {
  guildId: string;
  channelId: string;
  ignoreRoleId: string;
}): Promise<EasyTagConfig> {
  await assertChannelAllowance(input.guildId, "easytag");

  const id = await repo.insertEasyTagChannel({
    guildId: input.guildId,
    channelId: input.channelId,
  });

  await repo.writeEasyTagIgnoreRole(id, input.ignoreRoleId);

  cache.cacheChannel("easytag", input.channelId);

  const created = await repo.findEasyTagByChannel(input.channelId);

  if (!created) {
    throw new Error("the easy-tag channel was created but could not be read back");
  }

  return created;
}

/** Removes an easy-tag channel. */
export async function removeEasyTagChannel(channelId: string): Promise<void> {
  await repo.deleteEasyTagChannel(channelId);

  cache.uncacheChannel("easytag", channelId);
}

/** Turns the auto-delete of an easy-tag channel on or off. */
export async function toggleEasyTagAutoDelete(
  channelId: string,
): Promise<boolean | null> {
  return repo.toggleEasyTagAutoDelete(channelId);
}

/** Every easy-tag channel of a guild. */
export async function listEasyTagChannels(guildId: string): Promise<EasyTagConfig[]> {
  return repo.listEasyTagChannels(guildId);
}

/* ------------------------------------------------------------------ *
 * Screenshot verification — the setups
 * ------------------------------------------------------------------ */

/** Creates a screenshot-verification setup. */
export async function createSsConfig(input: {
  guildId: string;
  channelId: string;
  roleId: string;
  requiredSs: number;
  channelName: string;
  channelLink: string;
  keywords: readonly string[];
  allowSame: boolean;
  ssType: ScreenshotType;
  successMessage: string | null;
}): Promise<SsConfig> {
  await assertSsConfigAllowance(input.guildId);

  const id = await repo.insertSsConfig(input);

  // The channel only becomes live **after** the setup is saved. Quotient
  // added the channel to its live set as soon as the channel was picked,
  // so cancelling the wizard left a half-configured channel running (B11).
  cache.cacheChannel("ssverify", input.channelId);

  // The automatic half of the OCR decision is made at boot, so a setup that
  // is created after the boot does not switch the OCR on. Say so, rather
  // than leaving the guild with a refusal it cannot explain.
  if (!isOcrAvailable()) {
    logger.warn(
      "[Identity] A screenshot-verification setup was created, but the OCR " +
        "is switched off. Screenshots will be refused until the bot is " +
        "restarted with OCR_ENABLED=true, or until a setup exists when it " +
        "starts.",
    );
  }

  const created = await repo.findSsConfigById(input.guildId, id);

  if (!created) {
    throw new Error("the screenshot-verification setup was created but could not be read back");
  }

  return created;
}

/**
 * Writes the given fields of a setup.
 *
 * The patch is an explicit list of fields (B18): the source wrote
 * `dict(self.record)` and relied on Tortoise internals to leave the right
 * columns alone.
 *
 * The guild is part of the key: a setup of another server is not written,
 * whatever the row id says.
 */
export async function updateSsConfig(
  guildId: string,
  id: string,
  patch: repo.SsConfigPatch,
): Promise<void> {
  await repo.updateSsConfig(guildId, id, patch);
}

/** Removes a setup and everything that belongs to it. */
export async function deleteSsConfig(
  guildId: string,
  id: string,
): Promise<void> {
  const existing = await repo.findSsConfigById(guildId, id);

  await repo.deleteSsConfig(guildId, id);

  if (existing) {
    cache.uncacheChannel("ssverify", existing.channelId);
  }
}

/** Every setup of a guild. */
export async function listSsConfigs(guildId: string): Promise<SsConfig[]> {
  return repo.listSsConfigs(guildId);
}

/**
 * One setup, by its row id **and** its guild.
 *
 * A setup of another guild is not found: the panel's buttons carry a row
 * id, and the row id alone must never be enough to reach another
 * server's configuration.
 */
export async function findSsConfig(
  guildId: string,
  id: string,
): Promise<SsConfig | null> {
  return repo.findSsConfigById(guildId, id);
}

/** One setup, by its channel id. */
export async function findSsConfigByChannel(
  channelId: string,
): Promise<SsConfig | null> {
  return repo.findSsConfigByChannel(channelId);
}

/* ------------------------------------------------------------------ *
 * Screenshot verification — the rate limits
 * ------------------------------------------------------------------ */

/**
 * One submission per member every seven seconds.
 *
 * A simple timestamp, not a window: a member who posts three screenshots
 * a second is slowed down, not counted.
 */
export const MEMBER_SUBMISSION_WINDOW_MS = 7_000;

/**
 * Ten submissions per guild every minute.
 *
 * A sliding window: ten submissions spread over a minute is different from
 * ten submissions inside three seconds, and only a sliding window can tell
 * the difference.
 */
export const GUILD_SUBMISSION_WINDOW_MS = 60_000;

/** The two limiters, together. */
export interface SubmissionLimiters {
  readonly member: RateLimiter;
  readonly guild: RateLimiter;
}

/**
 * Builds the two limiters.
 *
 * The clock is injectable so the tests do not have to sleep.
 */
export function createSubmissionLimiters(now?: () => number): SubmissionLimiters {
  return {
    member: new RateLimiter({
      limit: 1,
      windowMs: MEMBER_SUBMISSION_WINDOW_MS,
      bucket: "member",
      ...(now ? { now } : {}),
    }),
    guild: new RateLimiter({
      limit: 10,
      windowMs: GUILD_SUBMISSION_WINDOW_MS,
      bucket: "guild",
      ...(now ? { now } : {}),
    }),
  };
}

/** The limiters the bot runs with. */
export const submissionLimiters: SubmissionLimiters = createSubmissionLimiters();

/* ------------------------------------------------------------------ *
 * Screenshot verification — the flow
 * ------------------------------------------------------------------ */

/** One screenshot that was submitted. */
export interface SubmittedImage {
  /**
   * The publicly reachable URL of the image.
   *
   * The OCR service **fetches the image itself**, so this is a URL and not
   * the picture's bytes: the bot never downloads the attachment, which
   * saves the bandwidth and the memory of a ten-megabyte screenshot.
   */
  readonly url: string;
  /** The channel the screenshot was posted in. */
  readonly channelId: string;
  /** The message the screenshot came with. */
  readonly messageId: string;
}

/** What one submission produced. */
export interface SubmissionOutcome {
  /** How many screenshots were accepted. */
  readonly accepted: number;
  /** The lines of the report. */
  readonly lines: readonly string[];
  /** Whether the member has now submitted enough screenshots. */
  readonly verified: boolean;
  /** How many screenshots the member has submitted in total. */
  readonly submitted: number;
}

/**
 * What the bot says when the OCR is switched off.
 *
 * A refusal the member can understand, in the voice of the other answers.
 * Not a crash and not a silent pass: the screenshot was not accepted, and
 * this is why.
 */
export const OCR_UNAVAILABLE_MESSAGE =
  "**Screenshot verification is not currently available. Please try again later.**";

/**
 * What the bot says when a stored hash cannot be compared.
 *
 * A different refusal from the one above, and it has to be: the OCR is
 * working, but the bot cannot tell whether this screenshot repeats one of
 * the member's own, because one of their stored submissions is corrupt.
 * The member is not at fault, and the operator has to fix the row — so the
 * message says so.
 */
export const DUPLICATE_CHECK_FAILED_MESSAGE =
  "**A previous screenshot of yours could not be checked, so this one cannot be verified either. Please contact a moderator.**";

/**
 * How many corrupt rows one log line names.
 *
 * A badly broken table can hold thousands of them, and a log line that
 * lists every one of them is unreadable.
 */
const MAX_REPORTED_CORRUPT_ROWS = 5;

/**
 * Checks the screenshots of one message and records the good ones.
 *
 * The order is Quotient's:
 *
 *  1. the duplicate check — unless the setup allows the same screenshot
 *     twice;
 *  2. the type's rules;
 *  3. the submission is recorded.
 *
 * The stored submissions are re-read after every accepted screenshot, so a
 * second screenshot in the same message cannot be a duplicate of the first
 * one.
 *
 * ## The threshold is the setup's own
 *
 * The duplicate check runs with the setup's own threshold
 * (`ss_configs.duplicate_threshold`), not with the global default — a
 * guild whose screenshots rescale differently may need a different one
 * (D20). A setup with no threshold of its own, or with a value that
 * cannot be a Hamming distance over a 64-bit hash, falls back to the
 * global default: a bad number in a column must not fail a submission.
 *
 * ## The OCR being off refuses the submission
 *
 * When the OCR is switched off the submission is refused **before** the
 * duplicate check and before the rules run, and **nothing is stored**: no
 * submission row, and no hash.
 *
 * The refusal cannot be left to the rules. An `any_ss` setup has no rules
 * at all, and a `loco` or `rooter` setup whose channel name is empty has
 * none that look at the text — so an empty text would be *accepted* there.
 * The switched-off provider's zero hashes are the hash of nothing, and a
 * hash of nothing must never reach the database.
 *
 * ## A provider that fails refuses the submission
 *
 * The service is down, it answers with rubbish, it sends a hash nobody can
 * compare — the screenshot cannot be verified, so it is refused and
 * **nothing is stored**. The member gets an answer either way: a refusal
 * is a decision, not a crash.
 */
export async function processSubmission(
  config: SsConfig,
  authorId: string,
  images: readonly SubmittedImage[],
): Promise<SubmissionOutcome> {
  // The OCR is off, or was never decided on. The submission is refused
  // outright: there is nothing to check the screenshot against, and a
  // screenshot that cannot be checked must not be accepted.
  if (!isOcrAvailable()) {
    return {
      accepted: 0,
      lines: [OCR_UNAVAILABLE_MESSAGE],
      submitted: await repo.countSsSubmissions(config.id, authorId),
      // A refused submission verifies nobody: nothing was accepted, so
      // nothing was verified.
      verified: false,
    };
  }

  const stored = await repo.listSsSubmissions(config.id);

  // The setup's **own** threshold (D20), with the global default as the
  // fallback when it has none or when the value cannot be a Hamming
  // distance. The check is still on the dHash — the pHash is stored
  // beside it, but the threshold was calibrated on the dHash.
  const threshold = resolveDuplicateThreshold(config.duplicateThreshold);

  const lines: string[] = [];

  let accepted = 0;

  for (const image of images) {
    // The service fetches the image itself, so it is handed the URL and
    // not the picture's bytes. A provider that cannot do its job answers
    // with a reason rather than an exception.
    const analysis = await analyzeScreenshot(image.url);

    if (!analysis.ok) {
      logger.warn(
        `[Identity] A screenshot could not be read, so it is refused: ${analysis.reason}`,
      );

      lines.push(OCR_UNAVAILABLE_MESSAGE);

      continue;
    }

    const result = analysis.result;

    if (!config.allowSame) {
      const checked = checkDuplicate(
        {
          authorId,
          dhash: result.dhash,
          phash: result.phash,
        },
        stored,
        threshold,
      );

      if (!checked.ok) {
        reportCorruptRows(config, checked.corrupt);

        lines.push(
          checked.kind === "corrupt-history"
            ? DUPLICATE_CHECK_FAILED_MESSAGE
            : OCR_UNAVAILABLE_MESSAGE,
        );

        continue;
      }

      if (checked.corrupt.length > 0) {
        reportCorruptRows(config, checked.corrupt);
      }

      if (checked.duplicate) {
        lines.push(describeDuplicate(config, checked.duplicate));

        continue;
      }
    }

    const outcome: VerificationOutcome = verifyScreenshot(config, result);

    if (!outcome.ok) {
      lines.push(outcome.reason);

      continue;
    }

    await repo.insertSsSubmission({
      ssConfigId: config.id,
      authorId,
      channelId: image.channelId,
      messageId: image.messageId,
      dhash: result.dhash,
      phash: result.phash,
    });

    stored.push({
      id: "",
      ssConfigId: config.id,
      authorId,
      channelId: image.channelId,
      messageId: image.messageId,
      dhash: result.dhash,
      phash: result.phash,
      createdAt: new Date(),
    });

    accepted += 1;

    lines.push("✅ | Successfully Verified.");
  }

  const submitted = await repo.countSsSubmissions(config.id, authorId);

  return {
    accepted,
    lines,
    submitted,
    verified: submitted >= config.requiredSs,
  };
}

/**
 * Reports the stored rows that could not be compared.
 *
 * A corrupt row is a broken row in the database, and the operator has to
 * fix it — so the report names the setup, the row and the value, and says
 * how many rows there are when there are more than the log line lists.
 */
function reportCorruptRows(
  config: SsConfig,
  corrupt: readonly CorruptSubmission[],
): void {
  if (corrupt.length === 0) return;

  const named = corrupt
    .slice(0, MAX_REPORTED_CORRUPT_ROWS)
    .map(
      (entry) =>
        `row ${entry.submission.id} (member ${entry.submission.authorId}, ` +
        `${entry.field}="${entry.value}")`,
    )
    .join(", ");

  const rest = corrupt.length - MAX_REPORTED_CORRUPT_ROWS;

  logger.error(
    `[Identity] A stored screenshot hash cannot be compared, so the duplicate ` +
      `check is incomplete. Setup ${config.id} in guild ${config.guildId}: ` +
      `${named}${rest > 0 ? ` and ${rest} more` : ""}. ` +
      `The row has to be repaired or deleted.`,
  );
}

/**
 * The line a duplicate produces.
 *
 * Quotient's two wordings, kept:
 *
 *  - the member's own picture: "You've already submitted this screenshot";
 *  - somebody else's picture: "<@id>, already submitted the same ss".
 */
function describeDuplicate(
  config: SsConfig,
  duplicate: DuplicateMatch,
): string {
  const submission = duplicate.submission;

  const url = submissionJumpUrl(
    config.guildId,
    submission.channelId,
    submission.messageId,
  );

  if (duplicate.kind === "own") {
    return `⚠️ | You've already submitted this screenshot [here](${url}).`;
  }

  return `⚠️ | <@${submission.authorId}>, already submitted the [same ss](${url}).`;
}

/**
 * Has the member already submitted enough screenshots?
 */
export async function isUserVerified(
  config: SsConfig,
  authorId: string,
): Promise<boolean> {
  const count = await repo.countSsSubmissions(config.id, authorId);

  return count >= config.requiredSs;
}

/**
 * Every submission of a setup, oldest first.
 */
export async function listSubmissions(
  ssConfigId: string,
): Promise<SsSubmission[]> {
  return repo.listSsSubmissions(ssConfigId);
}
