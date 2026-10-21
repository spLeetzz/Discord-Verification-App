import { describe, expect, it } from "vitest";

import {
  DEFAULT_DUPLICATE_THRESHOLD,
  HASH_HEX_LENGTH,
  UnusableHashError,
  compareHashes,
  hashToHex,
  hexToHash,
  hammingDistance,
  isHashHex,
  isPerceptualDuplicate,
} from "./hash.js";

const HASH_A = "0123456789abcdef";
const HASH_B = "0123456789abcdee";

/**
 * The hashes the Quotient-compatible service answers with.
 *
 * The duplicate check is over hashes the service returns, so these are the
 * values the comparison has to work with.
 */
const SERVICE_DHASH = "9c63949032868431";
const SERVICE_PHASH = "c0c0bf3f3bf0f090";

describe("hexToHash", () => {
  it("round-trips through hashToHex", () => {
    const hexes = [
      "0000000000000000",
      "ffffffffffffffff",
      "0123456789abcdef",
      "8000000000000000",
      "0000000000000001",
      "7fffffffffffffff",
    ];

    for (const hex of hexes) {
      expect(hashToHex(hexToHash(hex))).toBe(hex);
    }
  });

  it("reads the hex as one 64-bit number", () => {
    expect(hexToHash("0000000000000001")).toBe(1n);
    expect(hexToHash("00000000000000ff")).toBe(255n);
    expect(hexToHash("0000000000000100")).toBe(256n);
    expect(hexToHash("ffffffffffffffff")).toBe(0xffffffffffffffffn);
  });

  it("accepts upper case hex", () => {
    expect(hexToHash("ABCDEF0123456789")).toBe(hexToHash("abcdef0123456789"));
  });

  it("rejects a hash that is not exactly 16 characters", () => {
    // A truncated hash would compare as "a different picture", which is
    // exactly the bug this check exists to prevent.
    expect(() => hexToHash("")).toThrow();
    expect(() => hexToHash("0123456789abcde")).toThrow(/16-character/);
    expect(() => hexToHash("0123456789abcdef0")).toThrow(/16-character/);
    expect(() => hexToHash("0123456789abcdef00")).toThrow(/16-character/);
  });

  it("rejects characters that are not hex", () => {
    expect(() => hexToHash("0123456789abcdeg")).toThrow(/not a valid hex/);
    expect(() => hexToHash("0123456789abcde ")).toThrow(/not a valid hex/);
    expect(() => hexToHash("g123456789abcdef")).toThrow(/not a valid hex/);
    expect(() => hexToHash("0123456789abcde-")).toThrow(/not a valid hex/);
  });

  it("does not silently truncate a longer hash", () => {
    expect(() => hexToHash("0123456789abcdef0123")).toThrow();
  });

  it("throws an error that names the hash that was broken", () => {
    // The caller has to know *which* hash was the broken one, so that is
    // what the error carries.
    expect(() => hexToHash("abc")).toThrow(UnusableHashError);

    try {
      hexToHash("abc");
    } catch (error) {
      expect(error).toBeInstanceOf(UnusableHashError);
      expect((error as UnusableHashError).hash).toBe("abc");
    }
  });
});

describe("hashToHex", () => {
  it("renders 16 lower case hex characters, zero padded", () => {
    expect(hashToHex(0n)).toBe("0000000000000000");
    expect(hashToHex(1n)).toBe("0000000000000001");
    expect(hashToHex(0xffffffffffffffffn)).toBe("ffffffffffffffff");
  });

  it("keeps the length at 16 characters", () => {
    for (const value of [0n, 1n, 0x1234n, 0xffffffffffffffffn]) {
      expect(hashToHex(value)).toHaveLength(HASH_HEX_LENGTH);
    }
  });

  it("ignores bits above the 64th", () => {
    expect(hashToHex(0x1ffffffffffffffffn)).toBe("ffffffffffffffff");
  });
});

describe("isHashHex", () => {
  it("accepts sixteen hex characters", () => {
    expect(isHashHex("0000000000000000")).toBe(true);
    expect(isHashHex("ffffffffffffffff")).toBe(true);
    expect(isHashHex("9C63949032868431")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isHashHex("")).toBe(false);
    expect(isHashHex("abc")).toBe(false);
    expect(isHashHex("0123456789abcde")).toBe(false);
    expect(isHashHex("0123456789abcdef0")).toBe(false);
    expect(isHashHex("0123456789abcdeg")).toBe(false);
    expect(isHashHex("0123456789abcde ")).toBe(false);
  });
});

describe("hammingDistance", () => {
  it("is 0 for two identical hashes", () => {
    expect(hammingDistance(HASH_A, HASH_A)).toBe(0);
    expect(hammingDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingDistance("ffffffffffffffff", "ffffffffffffffff")).toBe(0);
  });

  it("is 1 when a single bit is flipped", () => {
    expect(hammingDistance(HASH_A, HASH_B)).toBe(1);
    expect(hammingDistance("0000000000000000", "0000000000000001")).toBe(1);
    expect(hammingDistance("0000000000000000", "8000000000000000")).toBe(1);
    expect(hammingDistance("0000000000000000", "0000000000000002")).toBe(1);
  });

  it("is 64 for two complementary hashes", () => {
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hammingDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
    expect(hammingDistance("aaaaaaaaaaaaaaaa", "5555555555555555")).toBe(64);
  });

  it("counts the bits that differ", () => {
    // The low nibbles differ in 4, 8 and 12 bits.
    expect(hammingDistance("0000000000000000", "000000000000000f")).toBe(4);
    expect(hammingDistance("0000000000000000", "00000000000000ff")).toBe(8);
    expect(hammingDistance("0000000000000000", "0000000000000fff")).toBe(12);
  });

  it("is symmetric", () => {
    expect(hammingDistance(HASH_A, HASH_B)).toBe(hammingDistance(HASH_B, HASH_A));
  });

  it("refuses a hash that is not 16 hex characters", () => {
    expect(() => hammingDistance(HASH_A, "0123")).toThrow();
    expect(() => hammingDistance("0123", HASH_A)).toThrow();
  });
});

describe("isPerceptualDuplicate", () => {
  it("counts a distance of exactly the threshold as a duplicate", () => {
    const a = "0000000000000000";
    // Seven bits set.
    const b = "000000000000007f";

    expect(hammingDistance(a, b)).toBe(7);
    expect(isPerceptualDuplicate(a, b, 7)).toBe(true);
    expect(isPerceptualDuplicate(a, b)).toBe(true);
  });

  it("does not count a distance of one more than the threshold", () => {
    const a = "0000000000000000";
    // Eight bits set.
    const b = "00000000000000ff";

    expect(hammingDistance(a, b)).toBe(8);
    expect(isPerceptualDuplicate(a, b, 7)).toBe(false);
    expect(isPerceptualDuplicate(a, b)).toBe(false);
  });

  it("uses a threshold of 7 by default", () => {
    expect(DEFAULT_DUPLICATE_THRESHOLD).toBe(7);
    expect(isPerceptualDuplicate("0000000000000000", "000000000000007f")).toBe(true);
    expect(isPerceptualDuplicate("0000000000000000", "00000000000000ff")).toBe(false);
  });

  it("takes the threshold as a parameter, not a constant", () => {
    const a = "0000000000000000";
    const b = "00000000000000ff";

    expect(isPerceptualDuplicate(a, b, 8)).toBe(true);
    expect(isPerceptualDuplicate(a, b, 0)).toBe(false);
  });
});

describe("compareHashes", () => {
  it("compares the hashes the service returns", () => {
    const comparison = compareHashes(SERVICE_DHASH, SERVICE_PHASH);

    expect(comparison.ok).toBe(true);

    if (!comparison.ok) return;

    expect(comparison.distance).toBe(
      hammingDistance(SERVICE_DHASH, SERVICE_PHASH),
    );
    expect(comparison.duplicate).toBe(
      comparison.distance <= DEFAULT_DUPLICATE_THRESHOLD,
    );
  });

  it("is 0 for the same hash twice", () => {
    const comparison = compareHashes(SERVICE_DHASH, SERVICE_DHASH);

    expect(comparison).toEqual({ ok: true, distance: 0, duplicate: true });
  });

  it("finds the duplicate when the hashes are close enough", () => {
    // Seven bits set: at the threshold.
    const comparison = compareHashes("0000000000000000", "000000000000007f");

    expect(comparison).toEqual({ ok: true, distance: 7, duplicate: true });
  });

  it("does not find the duplicate one bit further away", () => {
    const comparison = compareHashes("0000000000000000", "00000000000000ff");

    expect(comparison).toEqual({ ok: true, distance: 8, duplicate: false });
  });

  it("takes the threshold as a parameter", () => {
    const a = "0000000000000000";
    const b = "00000000000000ff";

    expect(compareHashes(a, b, 8).ok).toBe(true);
    expect(compareHashes(a, b, 0).ok).toBe(true);
  });

  it("refuses a hash it cannot read instead of throwing", () => {
    // The judgement call: a service that answers with a hash of a
    // different length must not crash the duplicate check. It has to
    // refuse, because a hash that cannot be compared verifies nothing.
    const comparison = compareHashes("abc", SERVICE_DHASH);

    expect(comparison.ok).toBe(false);

    if (comparison.ok) return;

    expect(comparison.reason).toMatch(/16-character/);
    expect(comparison.reason).toContain("abc");
  });

  it("refuses when the second hash is the broken one", () => {
    const comparison = compareHashes(SERVICE_DHASH, "zzzzzzzzzzzzzzzz");

    expect(comparison.ok).toBe(false);

    if (comparison.ok) return;

    expect(comparison.reason).toMatch(/not a valid hex/);
    expect(comparison.reason).toContain("zzzzzzzzzzzzzzzz");
  });

  it("never throws, whatever it is given", () => {
    for (const broken of ["", "abc", "0123456789abcdeg", "0123456789abcde"]) {
      expect(() => compareHashes(broken, SERVICE_DHASH)).not.toThrow();
      expect(() => compareHashes(SERVICE_DHASH, broken)).not.toThrow();
    }
  });
});
