/**
 * Perceptual hashing and hash comparison.
 *
 * Quotient stored two 64-bit hashes per submitted screenshot and rejected a
 * second screenshot when the Hamming distance between the new hash and a
 * stored one was 7 or less. The hashes came from the Python `imagehash`
 * library, which is not available here, so this module is a port of the two
 * pieces of `imagehash` that the feature actually used:
 *
 *   - `dhash` — grayscale, resize to 9x8, one bit per horizontally adjacent
 *     pixel pair.
 *   - `phash` — grayscale, resize to 32x32, discrete cosine transform, one
 *     bit per low-frequency coefficient against the median.
 *
 * The bit layout matches `imagehash` 4.x exactly, which is what the hashes
 * Quotient stored were produced with:
 *
 *   - The dHash bit is set when the pixel on the *right* is brighter than
 *     the one on the left (`imagehash` computes `pixels[:, 1:] >
 *     pixels[:, :-1]`).
 *   - The first comparison is the most significant bit of the 64-bit value
 *     and the hash is rendered as 16 lowercase hex characters, the way
 *     `imagehash` 4.x renders it. (`imagehash` 3.x rendered the bits of
 *     every byte the other way round; the distance between two hashes is
 *     the same either way, only the stored text differs.)
 *
 * Both of those matter because a Hamming distance is only meaningful when
 * both sides count the same 64 bits in the same order, and because the
 * threshold of 7 was calibrated against the reference implementation.
 *
 * The resampling is Pillow's, not `sharp`'s — see `resample.ts`. With
 * `sharp`'s Lanczos the hashes drift a few bits away from the reference,
 * and the measured distance between two screenshots of the same thing grows
 * well past what the reference measures, which moves the threshold.
 */

import sharp from "sharp";

import { resizeLanczos } from "./resample.js";

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

const HASH_BITS = 64;

/** Difference hash: 8x8 bits, read out of a 9x8 grayscale image. */
const DHASH_COLUMNS = 8;
const DHASH_ROWS = 8;
const DHASH_SAMPLE_WIDTH = DHASH_COLUMNS + 1;

/** Perceptual hash: 8x8 bits taken from the low-frequency corner of a 32x32 DCT. */
const PHASH_COLUMNS = 8;
const PHASH_ROWS = 8;
const PHASH_SAMPLE_SIZE = 32;

/**
 * The magnitude below which a DCT coefficient counts as zero.
 *
 * The transform sums 32 products of 8-bit values and cosines, so a
 * coefficient that is mathematically zero comes out as a rounding error of
 * a few times 1e-12. A coefficient that carries any information at all is
 * at least a hundredth of a grey level, so nothing real is lost by
 * dropping everything below this.
 */
const COEFFICIENT_NOISE_FLOOR = 1e-6;

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/** A 64-bit perceptual hash and its phash counterpart. */
export interface ImageHashes {
  dhash: string;
  phash: string;
}

/**
 * Parses a 64-bit hash from its hex form.
 *
 * The length is checked before the content: a truncated hash would silently
 * compare as "a different picture" (or, worse, as "the same one"), and
 * `imagehash` only ever produced 16 characters, so anything else is a bug
 * rather than a hash.
 */
export function hexToHash(hex: string): bigint {
  if (hex.length !== HASH_HEX_LENGTH) {
    throw new Error(
      `Expected a ${HASH_HEX_LENGTH}-character hex hash, got ${hex.length} characters: "${hex}"`,
    );
  }

  if (!HEX_PATTERN.test(hex)) {
    throw new Error(`"${hex}" is not a valid hex hash.`);
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
 */
export function isPerceptualDuplicate(
  a: string,
  b: string,
  threshold: number = DEFAULT_DUPLICATE_THRESHOLD,
): boolean {
  return hammingDistance(a, b) <= threshold;
}

/**
 * Both hashes for one image, decoded once.
 */
export async function computeHashes(
  source: Buffer | string,
): Promise<ImageHashes> {
  const image = await readGrayscale(source);

  return {
    dhash: dhashFromGrayscale(image),
    phash: phashFromGrayscale(image),
  };
}

/**
 * Difference hash of an image: 64 bits, one per horizontally adjacent pixel
 * pair of a 9x8 grayscale image.
 */
export async function computeDhash(source: Buffer | string): Promise<string> {
  return dhashFromGrayscale(await readGrayscale(source));
}

/**
 * Perceptual hash of an image: 64 bits taken from the low-frequency corner
 * of the DCT of a 32x32 grayscale image.
 */
export async function computePhash(source: Buffer | string): Promise<string> {
  return phashFromGrayscale(await readGrayscale(source));
}

interface GrayscaleImage {
  pixels: Buffer;
  width: number;
  height: number;
}

/**
 * Reads an image as an 8-bit grayscale raster.
 *
 * The luma coefficients are the ones PIL's `convert("L")` uses (ITU-R
 * 601-2). `imagehash` greyscales with PIL before hashing, so using the same
 * formula keeps this step identical to the reference implementation.
 * `sharp`'s own `greyscale()` is a *linear* operation and would produce a
 * different picture for saturated colours.
 */
async function readGrayscale(
  source: Buffer | string,
): Promise<GrayscaleImage> {
  const { data, info } = await sharp(source, { failOn: "none" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixels = Buffer.allocUnsafe(width * height);

  for (let i = 0, p = 0; p < pixels.length; i += channels, p += 1) {
    if (channels <= 2) {
      // Already greyscale (possibly with an alpha channel that is dropped).
      pixels[p] = data[i] ?? 0;
      continue;
    }

    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;

    pixels[p] = (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;
  }

  return { pixels, width, height };
}

/**
 * Resamples a grayscale raster to an exact size.
 *
 * The image is stretched to the requested size and the aspect ratio is
 * ignored, which is what PIL's `resize((9, 8))` does.
 */
function resizeGrayscale(
  image: GrayscaleImage,
  width: number,
  height: number,
): Buffer {
  return resizeLanczos(image.pixels, image.width, image.height, width, height);
}

/**
 * The difference hash of an already decoded grayscale image.
 */
function dhashFromGrayscale(image: GrayscaleImage): string {
  const sample = resizeGrayscale(image, DHASH_SAMPLE_WIDTH, DHASH_ROWS);

  let hash = 0n;

  for (let y = 0; y < DHASH_ROWS; y += 1) {
    for (let x = 0; x < DHASH_COLUMNS; x += 1) {
      const left = sample[y * DHASH_SAMPLE_WIDTH + x] ?? 0;
      const right = sample[y * DHASH_SAMPLE_WIDTH + x + 1] ?? 0;

      if (right > left) {
        // The first comparison is the most significant bit, the same order
        // `imagehash` writes its bit string in.
        const index = y * DHASH_COLUMNS + x;
        hash |= 1n << BigInt(HASH_BITS - 1 - index);
      }
    }
  }

  return hashToHex(hash);
}

/**
 * The perceptual hash of an already decoded grayscale image.
 */
function phashFromGrayscale(image: GrayscaleImage): string {
  const sample = resizeGrayscale(image, PHASH_SAMPLE_SIZE, PHASH_SAMPLE_SIZE);

  // Two-dimensional DCT-II, the transform `scipy.fftpack.dct` applies in
  // `imagehash.phash`. The unnormalised form is deliberate: only the
  // comparison against the median decides a bit, and a constant factor would
  // not change the result.
  const coefficients = dct2d(sample, PHASH_SAMPLE_SIZE);

  const lowFrequency: number[] = [];

  for (let row = 0; row < PHASH_ROWS; row += 1) {
    for (let column = 0; column < PHASH_COLUMNS; column += 1) {
      const value = coefficients[row * PHASH_SAMPLE_SIZE + column] ?? 0;

      // A coefficient that is mathematically zero comes out of the transform
      // as a rounding error of a few times 1e-12. Left alone, those errors
      // move the median off zero, and then every coefficient that *is*
      // exactly zero falls on the wrong side of it. The reference
      // implementation gets exact zeros out of its transform, so the errors
      // are dropped here to land on the same answer.
      lowFrequency.push(Math.abs(value) < COEFFICIENT_NOISE_FLOOR ? 0 : value);
    }
  }

  const median = medianOf(lowFrequency);

  let hash = 0n;

  for (let index = 0; index < lowFrequency.length; index += 1) {
    if ((lowFrequency[index] ?? 0) > median) {
      hash |= 1n << BigInt(HASH_BITS - 1 - index);
    }
  }

  return hashToHex(hash);
}

/**
 * One-dimensional DCT-II.
 */
function dct1d(input: Float64Array, size: number): Float64Array {
  const output = new Float64Array(size);

  for (let k = 0; k < size; k += 1) {
    let sum = 0;

    for (let n = 0; n < size; n += 1) {
      sum +=
        (input[n] ?? 0) * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * size));
    }

    output[k] = 2 * sum;
  }

  return output;
}

/**
 * Two-dimensional DCT-II over a square grayscale raster.
 */
function dct2d(input: Buffer, size: number): Float64Array {
  const rows = new Float64Array(size * size);
  const line = new Float64Array(size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      line[x] = input[y * size + x] ?? 0;
    }

    const transformed = dct1d(line, size);

    for (let x = 0; x < size; x += 1) {
      rows[y * size + x] = transformed[x] ?? 0;
    }
  }

  const output = new Float64Array(size * size);

  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      line[y] = rows[y * size + x] ?? 0;
    }

    const transformed = dct1d(line, size);

    for (let y = 0; y < size; y += 1) {
      output[y * size + x] = transformed[y] ?? 0;
    }
  }

  return output;
}

/**
 * Median of a list of numbers.
 *
 * For an even number of values the median is the mean of the two middle
 * ones, which is what `numpy.median` returns — and `imagehash` compares
 * against `numpy.median`.
 */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
