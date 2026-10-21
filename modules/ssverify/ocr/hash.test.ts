import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DUPLICATE_THRESHOLD,
  HASH_HEX_LENGTH,
  computeDhash,
  computeHashes,
  computePhash,
  hashToHex,
  hexToHash,
  hammingDistance,
  isPerceptualDuplicate,
} from "./hash.js";

const HASH_A = "0123456789abcdef";
const HASH_B = "0123456789abcdee";

/**
 * A solid 16x16 image of one colour.
 */
function solidImage(red: number, green: number, blue: number): Promise<Buffer> {
  return sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: red, g: green, b: blue } },
  })
    .png()
    .toBuffer();
}

/**
 * A 16x16 image whose colour changes from pixel to pixel.
 */
function gradientImage(): Promise<Buffer> {
  const width = 16;
  const height = 16;
  const pixels = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 13) % 256;
      pixels[offset + 1] = (y * 7) % 256;
      pixels[offset + 2] = (x * y) % 256;
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

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

describe("computeHashes", () => {
  it("returns 16 hex characters for both hashes", async () => {
    const image = await solidImage(51, 102, 204);

    const { dhash, phash } = await computeHashes(image);

    expect(dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(phash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives the same answer for the same image every time", async () => {
    const image = await gradientImage();

    const first = await computeHashes(image);
    const second = await computeHashes(image);

    expect(second).toEqual(first);
  });

  it("gives different answers for different images", async () => {
    const solid = await solidImage(51, 102, 204);
    const gradient = await gradientImage();

    const a = await computeHashes(solid);
    const b = await computeHashes(gradient);

    expect(a.dhash).not.toBe(b.dhash);
    expect(a.phash).not.toBe(b.phash);
  });

  it("reads a file path as well as a buffer", async () => {
    const image = await gradientImage();

    const fromBuffer = await computeHashes(image);

    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const directory = await mkdtemp(join(tmpdir(), "ocr-hash-"));
    const file = join(directory, "image.png");
    await writeFile(file, image);

    const fromFile = await computeHashes(file);

    expect(fromFile).toEqual(fromBuffer);
  });

  it("computes the same hashes through the single hash helpers", async () => {
    const image = await gradientImage();

    const both = await computeHashes(image);

    expect(await computeDhash(image)).toBe(both.dhash);
    expect(await computePhash(image)).toBe(both.phash);
  });
});

describe("the reference hashes", () => {
  // These are the hashes the Python `imagehash` library produces for the
  // same two images, with Pillow doing the resampling. They are pinned here
  // because the duplicate check inherits a threshold that was calibrated
  // against that implementation: a hash that drifts away from it makes the
  // measured distance between two screenshots larger than it should be.
  it("matches imagehash for a solid image", async () => {
    const image = await solidImage(51, 102, 204);

    const { dhash, phash } = await computeHashes(image);

    expect(dhash).toBe("0000000000000000");
    expect(phash).toBe("8000000000000000");
  });

  it("matches imagehash for a gradient", async () => {
    const image = await gradientImage();

    const { dhash, phash } = await computeHashes(image);

    expect(dhash).toBe("ffffffffffffffff");
    expect(phash).toBe("a255e055ff555650");
  });
});
