import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOcrProvider,
  DisabledOcrProvider,
  DISABLED_PROVIDER_NAME,
  isOcrDisabled,
  ocrEnabledFromEnv,
} from "./index.js";

/**
 * The Tesseract worker factory, spied on.
 *
 * The point of these tests is that a switched-off provider starts no worker
 * at all, so the factory has to be observable. The mock is hoisted, which is
 * what lets the factory below refer to it.
 */
const tesseract = vi.hoisted(() => ({
  createWorker: vi.fn(),
}));

vi.mock("tesseract.js", () => ({
  default: {
    createWorker: tesseract.createWorker,
    OEM: { LSTM_ONLY: 3 },
  },
}));

/**
 * A worker that does nothing, for the control test.
 *
 * The control test proves the spy would notice a worker being started, so
 * that "no worker was started" is a fact about the provider and not about a
 * spy that never fires.
 */
const fakeWorker = {
  recognize: vi.fn(async () => ({ data: { text: "hello" } })),
  terminate: vi.fn(async () => undefined),
};

/**
 * A solid 16x16 image of one colour.
 *
 * The local provider hashes the image before it reads the text, so the
 * control test needs an image sharp can decode.
 */
function solidImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: 51, g: 102, b: 204 },
    },
  })
    .png()
    .toBuffer();
}

/**
 * A directory that does not exist yet.
 *
 * The local provider creates its cache directory before it downloads the
 * language model, so "the directory is still not there" is "the model was
 * not downloaded".
 */
async function missingDirectory(): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "ocr-disabled-"));
  const path = join(root, "tesseract");

  return {
    path,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

afterEach(() => {
  tesseract.createWorker.mockReset();
  vi.unstubAllGlobals();
});

describe("DisabledOcrProvider", () => {
  it("answers with empty text", async () => {
    const provider = new DisabledOcrProvider();

    const result = await provider.analyze(Buffer.from("not an image"));

    expect(result.text).toBe("");
    expect(result.rawText).toBe("");
  });

  it("reports itself as the disabled provider", () => {
    expect(new DisabledOcrProvider().name).toBe(DISABLED_PROVIDER_NAME);
    expect(DISABLED_PROVIDER_NAME).toBe("disabled");
  });

  it("starts no worker", async () => {
    const provider = new DisabledOcrProvider();

    await provider.analyze(Buffer.from("not an image"));

    expect(tesseract.createWorker).not.toHaveBeenCalled();
  });

  it("makes no network call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    const provider = new DisabledOcrProvider();

    await provider.analyze(Buffer.from("not an image"));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("can be shut down without having done anything", async () => {
    const provider = new DisabledOcrProvider();

    await expect(provider.shutdown()).resolves.toBeUndefined();
  });
});

describe("createOcrProvider with the switch off", () => {
  it("returns the disabled provider", () => {
    const provider = createOcrProvider({ enabled: false, env: {} });

    expect(provider).toBeInstanceOf(DisabledOcrProvider);
    expect(provider.name).toBe("disabled");
  });

  it("answers with empty text", async () => {
    const provider = createOcrProvider({ enabled: false, env: {} });

    const result = await provider.analyze(Buffer.from("not an image"));

    expect(result.text).toBe("");
  });

  it("starts no worker", async () => {
    const provider = createOcrProvider({ enabled: false, env: {} });

    await provider.analyze(Buffer.from("not an image"));

    expect(tesseract.createWorker).not.toHaveBeenCalled();
  });

  it("makes no network call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    const provider = createOcrProvider({ enabled: false, env: {} });

    await provider.analyze(Buffer.from("not an image"));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("downloads no language model", async () => {
    const cache = await missingDirectory();

    try {
      const provider = createOcrProvider({
        enabled: false,
        env: {},
        local: { cachePath: cache.path },
      });

      await provider.analyze(Buffer.from("not an image"));

      expect(existsSync(cache.path)).toBe(false);
    } finally {
      await cache.cleanup();
    }
  });

  it("is the disabled provider even when a remote service is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    const provider = createOcrProvider({
      enabled: false,
      env: { OCR_PROVIDER_URL: "https://example.com/ocr" },
    });

    expect(provider.name).toBe("disabled");

    await provider.analyze(Buffer.from("not an image"));

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createOcrProvider with the switch on", () => {
  it("uses the local provider when no remote service is configured", () => {
    const provider = createOcrProvider({ enabled: true, env: {} });

    expect(provider.name).toBe("local");
  });

  it("uses the remote service when one is configured", () => {
    const provider = createOcrProvider({
      enabled: true,
      env: { OCR_PROVIDER_URL: "https://example.com/ocr" },
    });

    expect(provider.name).toBe("http");
  });

  it("uses the local provider when the switch is not given", () => {
    const provider = createOcrProvider({ env: {} });

    expect(provider.name).toBe("local");
  });

  it("starts a worker, which is what the switched-off provider does not", async () => {
    tesseract.createWorker.mockResolvedValue(fakeWorker);

    const cache = await missingDirectory();

    try {
      const provider = createOcrProvider({
        enabled: true,
        env: {},
        local: { cachePath: cache.path },
      });

      await provider.analyze(await solidImage());

      // The control: the spy does notice a worker being started, so the
      // "no worker" assertions above are worth something.
      expect(tesseract.createWorker).toHaveBeenCalledTimes(1);
    } finally {
      await cache.cleanup();
    }
  });
});

describe("ocrEnabledFromEnv", () => {
  it("forces OCR on for \"true\"", () => {
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "true" })).toBe(true);
  });

  it("forces OCR on for \"1\"", () => {
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "1" })).toBe(true);
  });

  it("forces OCR off for \"false\"", () => {
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "false" })).toBe(false);
  });

  it("forces OCR off for \"0\"", () => {
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "0" })).toBe(false);
  });

  it("leaves the decision to the caller when it is not set", () => {
    expect(ocrEnabledFromEnv({})).toBeUndefined();
  });

  it("does not guess at a value it does not understand", () => {
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "yes" })).toBeUndefined();
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "" })).toBeUndefined();
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "2" })).toBeUndefined();
    expect(ocrEnabledFromEnv({ OCR_ENABLED: "off" })).toBeUndefined();
  });

  it("ignores the case and the spaces around the value", () => {
    expect(ocrEnabledFromEnv({ OCR_ENABLED: " TRUE " })).toBe(true);
    expect(ocrEnabledFromEnv({ OCR_ENABLED: " False " })).toBe(false);
  });

  it("reads the process environment when it is given none", () => {
    const previous = process.env.OCR_ENABLED;

    try {
      process.env.OCR_ENABLED = "false";

      expect(ocrEnabledFromEnv()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.OCR_ENABLED;
      } else {
        process.env.OCR_ENABLED = previous;
      }
    }
  });
});

describe("isOcrDisabled", () => {
  it("recognises the switched-off provider", () => {
    expect(isOcrDisabled(new DisabledOcrProvider())).toBe(true);
  });

  it("does not mistake another provider for it", () => {
    const provider = createOcrProvider({ env: {} });

    expect(isOcrDisabled(provider)).toBe(false);
  });

  it("counts a missing provider as switched off", () => {
    expect(isOcrDisabled(null)).toBe(true);
    expect(isOcrDisabled(undefined)).toBe(true);
  });
});
