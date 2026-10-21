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
 */

import { hammingDistance, HASH_HEX_LENGTH } from "../ssverify/ocr/hash.js";

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
 * A stored hash that is not a hash.
 *
 * `hexToHash` throws on anything that is not exactly sixteen hex
 * characters, and that is deliberate: a truncated row must fail loudly
 * instead of comparing as "a different picture", because a duplicate that
 * hides itself is a duplicate that lets a member farm a role.
 */
export class MalformedHashError extends Error {
  /** The hash that could not be read. */
  readonly hash: string;

  constructor(hash: string, detail: string) {
    super(`A screenshot hash is malformed and cannot be compared: ${detail}`);

    this.name = "MalformedHashError";
    this.hash = hash;
  }
}

/** What a hash looks like: sixteen hex characters. */
const HASH_PATTERN = new RegExp(
  `^[0-9a-fA-F]{${HASH_HEX_LENGTH}}$`,
);

/**
 * Is this a hash?
 */
function isHashHex(value: string): boolean {
  return HASH_PATTERN.test(value);
}

/**
 * The Hamming distance between two hashes.
 *
 * @throws MalformedHashError when either side is not sixteen hex
 *         characters. The error names the hash that is actually
 *         malformed, which is the one the caller has to look at.
 */
export function safeHammingDistance(a: string, b: string): number {
  try {
    return hammingDistance(a, b);
  } catch (error) {
    // `hammingDistance` reads the first argument first, so the first
    // argument is the one that is malformed when only one of them is.
    const malformed = isHashHex(a) ? b : a;

    throw new MalformedHashError(
      malformed,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Finds the submission a new screenshot duplicates.
 *
 * @param candidate the hashes of the new screenshot.
 * @param stored    every submission of the configuration, oldest first.
 * @param threshold the Hamming distance at or below which two screenshots
 *                  count as the same picture.
 * @returns the duplicate, or `null` when the screenshot is new.
 * @throws MalformedHashError when a stored dHash is not a hash. A row that
 *         cannot be compared must not be skipped silently: the check would
 *         wave the screenshot through.
 */
export function findDuplicate(
  candidate: CandidateHashes,
  stored: readonly StoredSubmission[],
  threshold: number,
): DuplicateMatch | null {
  // 1. The member's own submissions.
  for (const submission of stored) {
    if (submission.authorId !== candidate.authorId) continue;

    const dhash = submission.dhash;

    // A submission with no hash at all cannot be compared. It is not a
    // malformed hash — it is an absent one — so it is skipped.
    if (dhash === null) continue;

    const distance = safeHammingDistance(candidate.dhash, dhash);

    if (distance <= threshold) {
      return { kind: "own", submission };
    }
  }

  // 2. The same picture, whoever submitted it.
  for (const submission of stored) {
    if (submission.dhash !== candidate.dhash) continue;
    if (submission.phash !== candidate.phash) continue;

    return { kind: "same", submission };
  }

  return null;
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
