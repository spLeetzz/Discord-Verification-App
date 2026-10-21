import { describe, expect, it } from "vitest";

import { resizeLanczos } from "./resample.js";

/**
 * The expected values are what Pillow produces for the same input:
 *
 *     PIL.Image.frombytes("L", (width, height), data).resize(
 *         (targetWidth, targetHeight), Image.Resampling.LANCZOS)
 *
 * They are pinned here because the duplicate check inherits a Hamming
 * distance threshold that was calibrated against hashes produced with
 * Pillow's resampling. A resampler that drifts from it makes the measured
 * distance between two screenshots of the same thing larger than the
 * reference measures it, and the threshold stops meaning what it meant.
 */
describe("resizeLanczos", () => {
  it("matches Pillow when the image is shrunk", () => {
    const source = Buffer.from([
      0, 10, 20, 30,
      40, 50, 60, 70,
      80, 90, 100, 110,
      120, 130, 140, 150,
    ]);

    expect([...resizeLanczos(source, 4, 4, 2, 2)]).toEqual([27, 47, 103, 123]);
    expect([...resizeLanczos(source, 4, 4, 3, 3)]).toEqual([
      8, 21, 34,
      62, 75, 88,
      116, 129, 142,
    ]);
  });

  it("matches Pillow when the image is grown", () => {
    const source = Buffer.from([
      0, 10, 20, 30,
      40, 50, 60, 70,
      80, 90, 100, 110,
      120, 130, 140, 150,
    ]);

    expect([...resizeLanczos(source, 4, 4, 8, 8)]).toEqual([
      0, 0, 3, 9, 13, 19, 25, 27,
      6, 7, 13, 19, 23, 29, 35, 37,
      26, 28, 34, 40, 44, 50, 56, 58,
      50, 52, 58, 64, 68, 74, 80, 82,
      68, 70, 76, 82, 86, 92, 98, 100,
      92, 94, 100, 106, 110, 116, 122, 124,
      113, 115, 121, 127, 131, 137, 143, 145,
      123, 125, 131, 137, 141, 147, 153, 155,
    ]);
  });

  it("matches Pillow on an image that is not square", () => {
    const source = Buffer.from([
      255, 0, 128, 64, 192,
      10, 20, 30, 40, 50,
      90, 80, 70, 60, 50,
    ]);

    expect([...resizeLanczos(source, 5, 3, 2, 2)]).toEqual([76, 87, 53, 47]);
    expect([...resizeLanczos(source, 5, 3, 4, 4)]).toEqual([
      209, 46, 103, 167,
      76, 25, 58, 94,
      18, 43, 39, 34,
      99, 80, 67, 54,
    ]);
  });

  it("keeps the values inside the 8-bit range", () => {
    const source = Buffer.alloc(16 * 16, 255);

    const result = resizeLanczos(source, 16, 16, 4, 4);

    for (const value of result) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(255);
    }
  });

  it("does not change the image when it is already the right size", () => {
    const source = Buffer.from([1, 2, 3, 4]);

    expect(resizeLanczos(source, 2, 2, 2, 2)).toBe(source);
  });
});
