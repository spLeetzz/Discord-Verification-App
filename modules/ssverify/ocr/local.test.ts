import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { LocalOcrProvider } from "./local.js";
import { createOcrProvider } from "./index.js";

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

/**
 * A provider whose text extraction is replaced.
 *
 * The real one starts a Tesseract worker, which downloads a language model
 * on first use. The tests must not depend on that, so the extractor is
 * injected and the worker is never started.
 */
function providerWithText(text: string): {
  provider: LocalOcrProvider;
  state: { calls: number };
} {
  const state = { calls: 0 };

  const provider = new LocalOcrProvider({
    extractText: async () => {
      state.calls += 1;
      return text;
    },
  });

  return { provider, state };
}

describe("LocalOcrProvider", () => {
  it("returns 16 hex characters for both hashes", async () => {
    const { provider } = providerWithText("");

    const result = await provider.analyze(await solidImage(51, 102, 204));

    expect(result.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.phash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns 16 hex characters for a gradient too", async () => {
    const { provider } = providerWithText("");

    const result = await provider.analyze(await gradientImage());

    expect(result.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.phash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives the same hashes for the same image every time", async () => {
    const { provider } = providerWithText("");
    const image = await gradientImage();

    const first = await provider.analyze(image);
    const second = await provider.analyze(image);

    expect(second.dhash).toBe(first.dhash);
    expect(second.phash).toBe(first.phash);
  });

  it("gives different hashes for different images", async () => {
    const { provider } = providerWithText("");

    const solid = await provider.analyze(await solidImage(51, 102, 204));
    const gradient = await provider.analyze(await gradientImage());

    expect(solid.dhash).not.toBe(gradient.dhash);
    expect(solid.phash).not.toBe(gradient.phash);
  });

  it("returns the text as a string", async () => {
    const { provider } = providerWithText("Some Channel Name");

    const result = await provider.analyze(await solidImage(51, 102, 204));

    expect(typeof result.text).toBe("string");
  });

  it("normalises the text the way Quotient did", async () => {
    const { provider } = providerWithText("Some Channel Name\n");

    const result = await provider.analyze(await solidImage(51, 102, 204));

    expect(result.text).toBe("somechannelname");
  });

  it("keeps the raw text next to the normalised one", async () => {
    const { provider } = providerWithText("Some Channel Name\n");

    const result = await provider.analyze(await solidImage(51, 102, 204));

    expect(result.rawText).toBe("Some Channel Name\n");
  });

  it("never starts Tesseract when an extractor is injected", async () => {
    const { provider, state } = providerWithText("hello");

    await provider.analyze(await solidImage(51, 102, 204));

    expect(state.calls).toBe(1);
  });

  it("extracts the text once per image", async () => {
    const { provider, state } = providerWithText("hello");
    const image = await solidImage(51, 102, 204);

    await provider.analyze(image);
    await provider.analyze(image);

    expect(state.calls).toBe(2);
  });

  it("reports a failure in the text extraction and answers with empty text", async () => {
    const errors: Error[] = [];

    const provider = new LocalOcrProvider({
      extractText: async () => {
        throw new Error("the model is missing");
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    const result = await provider.analyze(await solidImage(51, 102, 204));

    // The hashes are still there, and the text is empty. Every text rule
    // in the verification feature rejects an empty text, so a broken OCR
    // rejects the screenshot instead of waving it through.
    expect(result.text).toBe("");
    expect(result.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("the model is missing");
  });

  it("runs one analysis at a time", async () => {
    const order: string[] = [];

    const first = await solidImage(51, 102, 204);
    const second = await gradientImage();

    const labels = new Map<Buffer, string>([
      [first, "first"],
      [second, "second"],
    ]);

    const provider = new LocalOcrProvider({
      extractText: async (image) => {
        const label = labels.get(image as Buffer) ?? "unknown";
        order.push(`start ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end ${label}`);
        return "done";
      },
    });

    await Promise.all([provider.analyze(first), provider.analyze(second)]);

    expect(order).toEqual([
      "start first",
      "end first",
      "start second",
      "end second",
    ]);
  });

  it("can be shut down without having ever started", async () => {
    const { provider } = providerWithText("hello");

    await provider.shutdown();

    expect(provider.name).toBe("local");
  });
});

describe("createOcrProvider", () => {
  it("uses the local provider when no remote service is configured", () => {
    const provider = createOcrProvider({ env: {} });

    expect(provider.name).toBe("local");
  });

  it("uses the remote service when one is configured", () => {
    const provider = createOcrProvider({
      env: { OCR_PROVIDER_URL: "https://example.com/ocr" },
    });

    expect(provider.name).toBe("http");
  });

  it("ignores a blank remote service url", () => {
    const provider = createOcrProvider({ env: { OCR_PROVIDER_URL: "   " } });

    expect(provider.name).toBe("local");
  });
});
