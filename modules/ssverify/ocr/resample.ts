/**
 * Lanczos resampling, bit-compatible with Pillow.
 *
 * The perceptual hashes in `hash.ts` have to match the ones Quotient's
 * remote service produced, because the duplicate check inherits a Hamming
 * distance threshold (7) that was calibrated against the Python
 * `imagehash` library. `imagehash` resizes with Pillow, so this module is a
 * port of `Pillow/src/libImaging/Resample.c`.
 *
 * Why not `sharp`'s `resize`? Sharp's Lanczos is a different implementation
 * of the same idea: it does not round to 8 bits between the horizontal and
 * the vertical pass, and its filter weights differ in the last bits. The
 * result is a 9x8 grid that differs from Pillow's by up to a few grey
 * levels, which flips a handful of dHash bits and makes the measured
 * distance between two screenshots noticeably larger than the reference's.
 * The same screenshot, re-encoded as a different JPEG, has to stay at
 * distance 0; a slightly cropped one has to stay at distance 4. With
 * sharp's resampler those became 0 and 11.
 *
 * The port is exact: the same input produces the same bytes as
 * `PIL.Image.resize(..., Image.Resampling.LANCZOS)`.
 *
 * The algorithm, in short:
 *
 *   1. The horizontal and the vertical pass are separate, and each one
 *      writes an 8-bit intermediate. The order matters, so it is copied
 *      from Pillow: the vertical pass runs first when the image is much
 *      taller than the target, otherwise the horizontal pass does.
 *   2. For every output pixel the source pixels it covers are weighted by
 *      a Lanczos-3 kernel whose support is scaled by the reduction
 *      factor, then the weights are normalised so they sum to one.
 *   3. The weights are converted to 22-bit fixed point and the sum is
 *      rounded to the nearest 8-bit value, with the negative lobes of the
 *      kernel clamped to 0..255.
 */

const PRECISION_BITS = 22;
const PRECISION = 1 << PRECISION_BITS;
const ROUNDING_OFFSET = 1 << (PRECISION_BITS - 1);

/** Support of the Lanczos-3 kernel, in source pixels at 1:1 scale. */
const LANCZOS_SUPPORT = 3;

/** The source pixels one output pixel reads, and their weights. */
interface Coefficients {
  /** Source index the first tap of every output pixel reads. */
  readonly start: Int32Array;
  /** How many taps every output pixel reads. */
  readonly count: Int32Array;
  /** Fixed point weights, `ksize` per output pixel. */
  readonly weights: Int32Array;
}

/**
 * The sinc function, with the removable singularity at zero filled in.
 */
function sinc(x: number): number {
  if (x === 0) {
    return 1;
  }

  const scaled = x * Math.PI;
  return Math.sin(scaled) / scaled;
}

/**
 * The Lanczos-3 kernel. Zero outside its support.
 */
function lanczos(x: number): number {
  if (x >= -LANCZOS_SUPPORT && x < LANCZOS_SUPPORT) {
    return sinc(x) * sinc(x / LANCZOS_SUPPORT);
  }

  return 0;
}

/**
 * Works out the weights for one axis.
 *
 * `inSize` is the length of the source axis, `outSize` the length of the
 * target axis. The support of the kernel grows with the reduction factor,
 * so a 1360-pixel column squeezed into 8 rows reads over a thousand
 * pixels per output row.
 */
function precomputeCoefficients(inSize: number, outSize: number): Coefficients {
  const scale = inSize / outSize;
  const filterScale = scale < 1 ? 1 : scale;
  const support = LANCZOS_SUPPORT * filterScale;
  const ksize = Math.ceil(support) * 2 + 1;

  const start = new Int32Array(outSize);
  const count = new Int32Array(outSize);
  const raw = new Float64Array(outSize * ksize);

  for (let index = 0; index < outSize; index += 1) {
    const center = (index + 0.5) * scale;

    // Pillow rounds the window to the nearest source pixel and clamps it
    // to the image.
    let from = Math.trunc(center - support + 0.5);
    if (from < 0) {
      from = 0;
    }

    let to = Math.trunc(center + support + 0.5);
    if (to > inSize) {
      to = inSize;
    }

    const taps = to - from;
    const used = taps > 0 ? taps : 0;
    start[index] = from;
    count[index] = used;

    const base = index * ksize;

    for (let tap = 0; tap < used; tap += 1) {
      raw[base + tap] = lanczos((tap + from - center + 0.5) / filterScale);
    }
  }

  const weights = new Int32Array(outSize * ksize);

  for (let index = 0; index < outSize; index += 1) {
    const base = index * ksize;
    const taps = count[index] ?? 0;

    let total = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      total += raw[base + tap] ?? 0;
    }

    for (let tap = 0; tap < taps; tap += 1) {
      const weight = raw[base + tap] ?? 0;
      const normalised = total === 0 ? weight : weight / total;

      // Pillow rounds to fixed point, away from zero on a tie.
      weights[base + tap] =
        normalised < 0
          ? Math.trunc(-0.5 + normalised * PRECISION)
          : Math.trunc(0.5 + normalised * PRECISION);
    }
  }

  return { start, count, weights };
}

/**
 * Rounds a fixed point sum to an 8-bit value.
 */
function clip8(value: number): number {
  const shifted = Math.floor(value / PRECISION);

  if (shifted < 0) {
    return 0;
  }

  if (shifted > 255) {
    return 255;
  }

  return shifted;
}

/**
 * Resamples every row of the source, keeping its height.
 */
function resampleHorizontal(
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  coefficients: Coefficients,
): Buffer {
  const output = Buffer.alloc(targetWidth * sourceHeight);
  const ksize = coefficients.weights.length / targetWidth;

  for (let y = 0; y < sourceHeight; y += 1) {
    const sourceRow = y * sourceWidth;
    const outputRow = y * targetWidth;

    for (let x = 0; x < targetWidth; x += 1) {
      const from = coefficients.start[x] ?? 0;
      const taps = coefficients.count[x] ?? 0;
      const base = x * ksize;

      let total = ROUNDING_OFFSET;

      for (let tap = 0; tap < taps; tap += 1) {
        total += (source[sourceRow + from + tap] ?? 0) * (coefficients.weights[base + tap] ?? 0);
      }

      output[outputRow + x] = clip8(total);
    }
  }

  return output;
}

/**
 * Resamples every column of the source, keeping its width.
 *
 * The accumulation runs tap by tap over a whole row so that the source is
 * read in order. The order of the additions per output pixel is the same
 * as the pixel-by-pixel loop Pillow uses, so the result is identical.
 */
function resampleVertical(
  source: Buffer,
  sourceWidth: number,
  targetHeight: number,
  coefficients: Coefficients,
): Buffer {
  const output = Buffer.alloc(sourceWidth * targetHeight);
  const ksize = coefficients.weights.length / targetHeight;
  const accumulator = new Float64Array(sourceWidth);

  for (let y = 0; y < targetHeight; y += 1) {
    const from = coefficients.start[y] ?? 0;
    const taps = coefficients.count[y] ?? 0;
    const base = y * ksize;

    accumulator.fill(0);

    for (let tap = 0; tap < taps; tap += 1) {
      const weight = coefficients.weights[base + tap] ?? 0;
      const sourceRow = (from + tap) * sourceWidth;

      for (let x = 0; x < sourceWidth; x += 1) {
        accumulator[x] = (accumulator[x] ?? 0) + (source[sourceRow + x] ?? 0) * weight;
      }
    }

    const outputRow = y * sourceWidth;

    for (let x = 0; x < sourceWidth; x += 1) {
      output[outputRow + x] = clip8((accumulator[x] ?? 0) + ROUNDING_OFFSET);
    }
  }

  return output;
}

/**
 * Resamples a grayscale raster to an exact size.
 *
 * The result is identical to
 * `PIL.Image.frombytes("L", (width, height), data).resize(
 *    (targetWidth, targetHeight), Image.Resampling.LANCZOS)`.
 */
export function resizeLanczos(
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Buffer {
  if (targetWidth === sourceWidth && targetHeight === sourceHeight) {
    return source;
  }

  const needHorizontal = targetWidth !== sourceWidth;
  const needVertical = targetHeight !== sourceHeight;

  // Pillow runs the vertical pass first when the image is much taller
  // than the target, because that keeps the intermediate small. A phone
  // screenshot squeezed into 9x8 is the case this exists for.
  const horizontalFirst = !(
    sourceHeight - targetHeight > 0 &&
    sourceHeight - targetHeight > (sourceWidth - targetWidth) * 2
  );

  const horizontal = needHorizontal
    ? precomputeCoefficients(sourceWidth, targetWidth)
    : null;
  const vertical = needVertical
    ? precomputeCoefficients(sourceHeight, targetHeight)
    : null;

  if (horizontalFirst) {
    const intermediate = horizontal
      ? resampleHorizontal(source, sourceWidth, sourceHeight, targetWidth, horizontal)
      : source;

    if (!vertical) {
      return intermediate;
    }

    return resampleVertical(intermediate, targetWidth, targetHeight, vertical);
  }

  const intermediate = vertical
    ? resampleVertical(source, sourceWidth, targetHeight, vertical)
    : source;

  if (!horizontal) {
    return intermediate;
  }

  return resampleHorizontal(intermediate, sourceWidth, targetHeight, targetWidth, horizontal);
}
