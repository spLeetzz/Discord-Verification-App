/**
 * The duplicate-screenshot check.
 *
 * Quotient stored two 64-bit hashes per submission and refused a second
 * screenshot when the Hamming distance between the new dHash and a stored
 * one was 7 or less:
 *
 * ```python
 * async def _match_for_duplicate(self, dhash, phash, author_id):
 *     _dhash = imagehash.hex_to_hash(dhash)
 *     async for record in self.data.filter(author_id=author_id).order_by("submitted_at"):
 *         if _dhash - imagehash.hex_to_hash(record.dhash) <= 7:
 *             return True, "You've already submitted this screenshot ..."
 *     if r := await self.data.filter(dhash=dhash, phash=phash).first():
 *         return True, "<@...> already submitted the same ss ..."
 *     return False, False
 * ```
 *
 * Two checks, in that order:
 *
 *  1. **the same member** — is this member's own picture within the
 *     threshold of one they already submitted?
 *  2. **the same picture** — has anybody submitted exactly this picture
 *     (both hashes equal)?
 *
 * The threshold is a parameter, not a constant (D20). It is only meaningful
 * for a 64-bit hash, so it has to move with the hash implementation rather
 * than being baked into the comparison — which is why the hashing lives in
 * `modules/ssverify/ocr/` and every stored hash comes from it.
 *
 * The threshold a submission is checked against is the **setup's own**
 * (`ss_configs.duplicate_threshold`), with the global default as the
 * fallback — see {@link resolveDuplicateThreshold}. The check is still on
 * the **dHash**: the pHash is stored beside it, but the threshold of 7 was
 * calibrated on the dHash.
 *
 * ## The check never throws
 *
 * Quotient's `imagehash.hex_to_hash` **raises** on a stored hash that is
 * not sixteen hex characters, and the exception left the submission with no
 * answer at all. Here the check is **total**: it answers with a decision,
 * and every hash that cannot be compared is reported rather than thrown
 * over.
 *
 * Two kinds of "cannot be compared", and they are not the same:
 *
 *  - **the screenshot's own hash** (from the service) is not a hash. The
 *    screenshot cannot be verified at all, so it is **refused**. The
 *    service's own provider refuses such an answer before it gets here, so
 *    this is the second line of defence.
 *  - **a stored row** is corrupt. One row is broken, not the screenshot:
 *
 *    - when it is the **member's own** row, the check cannot tell whether
 *      this screenshot repeats one of their own, so the submission is
 *      **refused** — the same answer the check gave before, only a message
 *      instead of a crash;
 *    - when it is **somebody else's** row, the submission goes through and
 *      the row is **reported**. Refusing there would let one bad row block
 *      every member of the setup, and the row can only hide one exact
 *      re-submission.
 *
 * Every corrupt row is reported either way, with enough detail to find it
 * and fix it.
 */

import {
  DEFAULT_DUPLICATE_THRESHOLD,
  compareHashes,
  isHashHex,
} from "../ssverify/ocr/hash.js";

/* ------------------------------------------------------------------ *
 * The threshold
 * ------------------------------------------------------------------ */

/**
 * The smallest Hamming distance a setup may use.
 *
 * Zero means "only the very same hash is a duplicate" — a setup that
 * refuses to forgive a single changed pixel.
 */
export const MIN_DUPLICATE_THRESHOLD = 0;

/**
 * The largest Hamming distance a setup may use.
 *
 * The hash is 64 bits wide, so two hashes are never more than 64 bits
 * apart: a threshold of 64 can never fire, and nothing is ever a
 * duplicate. It is the last value that still means something.
 */
export const MAX_DUPLICATE_THRESHOLD = 64;

/**
 * The threshold a setup's duplicate check runs with.
 *
 * The setup has a threshold of its own (`ss_configs.duplicate_threshold`),
 * and the global default is only the fallback:
 *
 *  - **no threshold at all** — the setup has no value of its own, so the
 *    default is used;
 *  - **a value that cannot be a Hamming distance** — it is not a whole
 *    number, or it is outside `0…64`, so the default is used.
 *
 * A bad number falls back to the default rather than failing: a column
 * with a nonsense value must not stop a member from being verified, and
 * the check itself is total — it answers with a decision, never an
 * exception (see the note at the top of this file).
 *
 * @param value the setup's own threshold, if it has one.
 */
export function resolveDuplicateThreshold(
  value: number | null | undefined,
): number {
  if (value === null || value === undefined) {
    return DEFAULT_DUPLICATE_THRESHOLD;
  }

  if (!Number.isInteger(value)) {
    return DEFAULT_DUPLICATE_THRESHOLD;
  }

  if (value < MIN_DUPLICATE_THRESHOLD || value > MAX_DUPLICATE_THRESHOLD) {
    return DEFAULT_DUPLICATE_THRESHOLD;
  }

  return value;
}

/** The stored submission a new screenshot is compared against. */
export interface StoredSubmission {
  readonly id: string;
  readonly authorId: string;
  readonly channelId: string;
  readonly messageId: string;
  /** 16 hex characters of dHash, or `null` when the provider produced none. */
  readonly dhash: string | null;
  /** 16 hex characters of pHash. */
  readonly phash: string | null;
  readonly createdAt: Date;
}

/** The hashes of the screenshot being submitted. */
export interface CandidateHashes {
  /** The member who submitted it. */
  readonly authorId: string;
  readonly dhash: string;
  readonly phash: string;
}

/** Which check found the duplicate. */
export type DuplicateKind =
  /** The member submitted this picture themselves before. */
  | "own"
  /** Somebody else submitted exactly this picture. */
  | "same";

/** A duplicate that was found. */
export interface DuplicateMatch {
  readonly kind: DuplicateKind;
  /** The submission that was duplicated. */
  readonly submission: StoredSubmission;
}

/**
 * A stored row whose hash cannot be compared.
 *
 * The row is corrupt: a truncated hash, a column written by an older
 * version, a hand-edited row. It is reported rather than skipped in
 * silence, because a row that cannot be compared is a row that cannot be
 * trusted.
 */
export interface CorruptSubmission {
  /** The row that is corrupt. */
  readonly submission: StoredSubmission;
  /** Which hash of it is broken. */
  readonly field: "dhash" | "phash";
  /** The value that is not a hash. */
  readonly value: string;
}

/** Why the check could not be made. */
export type DuplicateFailure =
  /** The screenshot's own hash is not a hash, so it verifies nothing. */
  | "unusable-hash"
  /** The member's own stored submission cannot be compared. */
  | "corrupt-history";

/** What the duplicate check found. */
export type DuplicateOutcome =
  | {
      /** The check could be made. */
      readonly ok: true;
      /** The submission the screenshot duplicates, if there is one. */
      readonly duplicate: DuplicateMatch | null;
      /** The stored rows that could not be compared. */
      readonly corrupt: readonly CorruptSubmission[];
    }
  | {
      /** The check could not be made, so the screenshot is refused. */
      readonly ok: false;
      /** Which of the two reasons it is. */
      readonly kind: DuplicateFailure;
      /** Why not, in words. */
      readonly reason: string;
      /** The stored rows that could not be compared. */
      readonly corrupt: readonly CorruptSubmission[];
    };

/**
 * Finds the submission a new screenshot duplicates.
 *
 * @param candidate the hashes of the new screenshot.
 * @param stored    every submission of the configuration, oldest first.
 * @param threshold the Hamming distance at or below which two screenshots
 *                  count as the same picture.
 * @returns the decision: the duplicate that was found (if any), the rows
 *          that could not be compared, or the reason the check could not be
 *          made at all. It never throws.
 */
export function checkDuplicate(
  candidate: CandidateHashes,
  stored: readonly StoredSubmission[],
  threshold: number,
): DuplicateOutcome {
  // The screenshot's own hashes have to be usable. A hash that cannot be
  // compared verifies nothing, so the screenshot is refused.
  if (!isHashHex(candidate.dhash) || !isHashHex(candidate.phash)) {
    return {
      ok: false,
      kind: "unusable-hash",
      reason:
        `The screenshot's hashes cannot be compared: ` +
        `dhash="${candidate.dhash}", phash="${candidate.phash}".`,
      corrupt: [],
    };
  }

  const corrupt: CorruptSubmission[] = [];

  // 1. The member's own submissions.
  for (const submission of stored) {
    if (submission.authorId !== candidate.authorId) continue;

    const dhash = submission.dhash;

    // A submission with no hash at all cannot be compared. It is not a
    // malformed hash — it is an absent one — so it is skipped.
    if (dhash === null) continue;

    if (!isHashHex(dhash)) {
      // The member's own history cannot be compared, so the check cannot
      // tell whether this screenshot repeats one of their own. That is a
      // refusal, and the row is reported so it can be cleaned up.
      return {
        ok: false,
        kind: "corrupt-history",
        reason:
          `A stored screenshot hash of the member cannot be compared: ` +
          `dhash="${dhash}".`,
        corrupt: [...corrupt, { submission, field: "dhash", value: dhash }],
      };
    }

    const comparison = compareHashes(candidate.dhash, dhash, threshold);

    // Both sides are hashes, so this cannot happen — but the comparison
    // is total, and a comparison that could not be made is a comparison
    // that cannot clear the screenshot.
    if (!comparison.ok) {
      return {
        ok: false,
        kind: "unusable-hash",
        reason: comparison.reason,
        corrupt,
      };
    }

    if (comparison.duplicate) {
      return { ok: true, duplicate: { kind: "own", submission }, corrupt };
    }
  }

  // 2. The same picture, whoever submitted it.
  for (const submission of stored) {
    const dhash = submission.dhash;
    const phash = submission.phash;

    if (dhash === null || phash === null) continue;

    // A row that cannot be compared cannot be "the same picture" either.
    // It is reported and passed over: refusing here would let one corrupt
    // row block every member of the setup.
    if (!isHashHex(dhash)) {
      corrupt.push({ submission, field: "dhash", value: dhash });
      continue;
    }

    if (dhash !== candidate.dhash) continue;

    if (!isHashHex(phash)) {
      corrupt.push({ submission, field: "phash", value: phash });
      continue;
    }

    if (phash !== candidate.phash) continue;

    return { ok: true, duplicate: { kind: "same", submission }, corrupt };
  }

  return { ok: true, duplicate: null, corrupt };
}

/**
 * The jump URL of a submission.
 *
 * The same shape Quotient built by hand.
 */
export function submissionJumpUrl(
  guildId: string,
  channelId: string,
  messageId: string,
): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
