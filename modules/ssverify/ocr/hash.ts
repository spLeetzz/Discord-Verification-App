/**
 * Comparing the perceptual hashes the OCR service returns.
 *
 * Quotient stored two 64-bit hashes per submitted screenshot and rejected a
 * second screenshot when the Hamming distance between the new hash and a
 * stored one was 7 or less. The hashes came from the Python `imagehash`
 * library; here they come from the OCR service, which answers with them
 * ready made.
 *
 * So this module does **not** read pixels any more. It holds the half of
 * the job that is arithmetic: the hex form of a hash, the distance between
 * two hashes, and the question "are these two the same picture?".
 *
 * ## The shape of a hash
 *
 * A hash is 64 bits, written as **16 hex characters**, zero padded:
 * `0000000000000000` through `ffffffffffffffff`. The service is expected to
 * answer in that form, and {@link hexToHash} refuses anything else: a
 * truncated hash would compare as "a different picture", which is a bug
 * that hides itself.
 *
 * ## A hash we cannot compare
 *
 * A refusal is the point of the module, not an afterthought. A hash that is
 * not sixteen hex characters is a hash the duplicate check cannot compare,
 * and a screenshot whose hash cannot be compared is a screenshot that cannot
 * be verified — so it must not be accepted.
 *
 * Two ways to handle that, and both are here:
 *
 *  - {@link compareHashes} is **total**: it never throws. It answers "I
 *    cannot compare these" instead, and the caller refuses the screenshot.
 *  - {@link hexToHash} and {@link hammingDistance} throw
 *    {@link UnusableHashError}, for the callers that would rather catch it.
 *
 * The threshold is only meaningful for a 64-bit hash, so it is a parameter
 * and not a constant: it has to move with the hash implementation rather
 * than being baked into a comparison.
 */

/** Number of hex characters in a 64-bit perceptual hash. */
export const HASH_HEX_LENGTH = 16;

/**
 * Hamming distance at or below which two screenshots count as the same
 * picture.
 *
 * Quotient hard-coded 7. It is a parameter here because the number is only
 * meaningful for a 64-bit hash, and it has to move with the hash
 * implementation rather than being baked into a comparison.
 */
export const DEFAULT_DUPLICATE_THRESHOLD = 7;

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/** What a hash looks like: exactly sixteen hex characters. */
const HASH_PATTERN = new RegExp(
  `^[0-9a-fA-F]{${HASH_HEX_LENGTH}}$`,
);

/**
 * A hash that cannot be compared.
 *
 * Thrown by {@link hexToHash} and {@link hammingDistance} when a hash is not
 * sixteen hex characters. It carries the offending value, so the caller can
 * say **which** hash was the broken one.
 */
export class UnusableHashError extends Error {
  /** The hash that could not be read. */
  readonly hash: string;

  constructor(hash: string, detail: string) {
    super(`A hash cannot be compared: ${detail}`);

    this.name = "UnusableHashError";
    this.hash = hash;
  }
}

/**
 * Is this the hex form of a 64-bit hash?
 *
 * The question a caller asks before it compares two hashes, when it would
 * rather refuse than throw.
 */
export function isHashHex(value: string): boolean {
  return HASH_PATTERN.test(value);
}

/**
 * Parses a 64-bit hash from its hex form.
 *
 * The length is checked before the content: a truncated hash would silently
 * compare as "a different picture" (or, worse, as "the same one"), and the
 * service only ever answers with 16 characters, so anything else is a bug
 * rather than a hash.
 *
 * @throws UnusableHashError when the value is not sixteen hex characters.
 */
export function hexToHash(hex: string): bigint {
  if (hex.length !== HASH_HEX_LENGTH) {
    throw new UnusableHashError(
      hex,
      `Expected a ${HASH_HEX_LENGTH}-character hex hash, got ${hex.length} characters: "${hex}"`,
    );
  }

  if (!HEX_PATTERN.test(hex)) {
    throw new UnusableHashError(hex, `"${hex}" is not a valid hex hash.`);
  }

  return BigInt(`0x${hex}`);
}

/** Renders a 64-bit hash as 16 lowercase hex characters. */
export function hashToHex(hash: bigint): string {
  return (hash & 0xffffffffffffffffn)
    .toString(16)
    .padStart(HASH_HEX_LENGTH, "0");
}

/**
 * Number of bits that differ between two hashes.
 *
 * This is what `imagehash` computes when one hash is subtracted from
 * another, and what Quotient compared against 7.
 *
 * @throws UnusableHashError when either side is not sixteen hex characters.
 *         A caller that must not crash on a malformed hash wants
 *         {@link compareHashes} instead.
 */
export function hammingDistance(a: string, b: string): number {
  let difference = hexToHash(a) ^ hexToHash(b);
  let distance = 0;

  while (difference !== 0n) {
    // Kernighan's algorithm: each step clears the lowest set bit.
    difference &= difference - 1n;
    distance += 1;
  }

  return distance;
}

/**
 * True when two hashes are close enough to be the same picture.
 *
 * @throws UnusableHashError when either side is not sixteen hex characters.
 */
export function isPerceptualDuplicate(
  a: string,
  b: string,
  threshold: number = DEFAULT_DUPLICATE_THRESHOLD,
): boolean {
  return hammingDistance(a, b) <= threshold;
}

/**
 * The outcome of comparing two hashes.
 *
 * A discriminated union rather than a number, because "how far apart are
 * these" and "these cannot be compared" are two different answers and only
 * one of them is a distance.
 */
export type HashComparison =
  | {
      /** The two hashes could be compared. */
      readonly ok: true;
      /** How many of the 64 bits differ. */
      readonly distance: number;
      /** Whether the distance is at or below the threshold. */
      readonly duplicate: boolean;
    }
  | {
      /** The two hashes could not be compared. */
      readonly ok: false;
      /** Why not, in words. */
      readonly reason: string;
    };

/**
 * Compares two hashes without ever throwing.
 *
 * This is the comparison the duplicate check wants: a hash the service sent
 * that cannot be read is a hash that cannot be verified, and the answer has
 * to be a **refusal** rather than an exception. An exception in the middle
 * of a submission is a crash, and a crash that lets a screenshot through
 * unchecked is the one outcome that must not happen.
 *
 * @param a        the first hash.
 * @param b        the second hash.
 * @param threshold the distance at or below which the two count as the same
 *                  picture.
 */
export function compareHashes(
  a: string,
  b: string,
  threshold: number = DEFAULT_DUPLICATE_THRESHOLD,
): HashComparison {
  try {
    const distance = hammingDistance(a, b);

    return { ok: true, distance, duplicate: distance <= threshold };
  } catch (error) {
    // The message of `UnusableHashError` names the hash that was broken,
    // so the caller is told which one it was without having to guess.
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
