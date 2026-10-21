/**
 * The OCR switch: the decision at boot, and the refusal when it is off.
 *
 * Two halves of one switch:
 *
 *  - **the decision** — made once, at boot, from `OCR_ENABLED` and from
 *    whether any screenshot-verification setup exists;
 *  - **the refusal** — a screenshot submitted while the OCR is off is
 *    refused outright, and nothing is stored.
 *
 * The refusal is the half that matters. The rules cannot do it: `any_ss`
 * has no rules at all, and a `loco` or `rooter` setup whose channel name
 * is empty has none that look at the text either — so an empty text would
 * be *accepted* there. The tests below pin that hole down and then show
 * that the submission is refused anyway.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import { verifyScreenshot } from "./verification.js";
import type { SsConfig } from "./types.js";

/**
 * The Tesseract worker factory, spied on.
 *
 * "No worker was started" is only worth something when the spy would
 * notice one, so the factory has to be observable.
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

/** A stored submission, as the repository hands it back. */
interface StoredRow {
  readonly id: string;
  readonly ssConfigId: string;
  readonly authorId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly dhash: string | null;
  readonly phash: string | null;
  readonly createdAt: Date;
}

/** The row a submission is written as. */
interface NewRow {
  readonly ssConfigId: string;
  readonly authorId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly dhash: string | null;
  readonly phash: string | null;
}

const mocks = vi.hoisted(() => ({
  repo: {
    hasSsConfig: vi.fn<() => Promise<boolean>>(),
    listSsSubmissions: vi.fn<() => Promise<StoredRow[]>>(),
    insertSsSubmission: vi.fn<(input: NewRow) => Promise<string>>(),
    countSsSubmissions: vi.fn<() => Promise<number>>(),
  },
  cache: {
    cacheChannel: vi.fn(),
    uncacheChannel: vi.fn(),
  },
  entitlements: {
    assertEntitled: vi.fn(),
  },
}));

vi.mock("./repo.js", () => mocks.repo);
vi.mock("./cache.js", () => mocks.cache);
vi.mock("../premium/entitlements.js", () => mocks.entitlements);

/**
 * A worker that reads one fixed line of text.
 *
 * The line says "videos", so the YouTube rule is satisfied, and it does not
 * say "subscribe", so the button rule is not.
 */
const fakeWorker = {
  recognize: vi.fn(async () => ({ data: { text: "Team Phoenix videos" } })),
  terminate: vi.fn(async () => undefined),
};

/**
 * A solid 16x16 picture.
 *
 * The local provider hashes the image before it reads the text, so the
 * "the OCR is on" test needs a picture sharp can decode.
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

/** The setup the tests submit against. */
function ssConfig(overrides: Partial<SsConfig> = {}): SsConfig {
  return {
    id: "config-1",
    guildId: "guild-1",
    channelId: "channel-1",
    roleId: "role-1",
    requiredSs: 1,
    channelName: "Team Phoenix",
    channelLink: "",
    keywords: [],
    allowSame: false,
    ssType: "youtube",
    successMessage: null,
    ...overrides,
  };
}

/** The screenshot the tests submit. */
function submittedImage(buffer: Buffer): {
  readonly buffer: Buffer;
  readonly channelId: string;
  readonly messageId: string;
} {
  return { buffer, channelId: "channel-1", messageId: "message-1" };
}

/** The area, loaded fresh so the boot decision starts from nothing. */
interface Area {
  readonly ocr: typeof import("./ocr.js");
  readonly service: typeof import("./service.js");
}

async function loadArea(): Promise<Area> {
  // The provider and the decision live in module state, so every test needs
  // its own copy of the module.
  vi.resetModules();

  const ocr = await import("./ocr.js");
  const service = await import("./service.js");

  return { ocr, service };
}

/** The rows the repository holds, so the count is a real count. */
let stored: StoredRow[] = [];

/** The environment the decision reads. */
const environment = {
  ocrEnabled: process.env.OCR_ENABLED,
  ocrProviderUrl: process.env.OCR_PROVIDER_URL,
};

beforeEach(() => {
  vi.clearAllMocks();

  stored = [];

  delete process.env.OCR_ENABLED;
  delete process.env.OCR_PROVIDER_URL;

  tesseract.createWorker.mockResolvedValue(fakeWorker);

  mocks.repo.hasSsConfig.mockResolvedValue(false);
  mocks.repo.listSsSubmissions.mockImplementation(async () => [...stored]);
  mocks.repo.insertSsSubmission.mockImplementation(async (input) => {
    const id = `row-${stored.length + 1}`;

    stored.push({ ...input, id, createdAt: new Date() });

    return id;
  });
  mocks.repo.countSsSubmissions.mockImplementation(async () => stored.length);
});

afterEach(() => {
  if (environment.ocrEnabled === undefined) {
    delete process.env.OCR_ENABLED;
  } else {
    process.env.OCR_ENABLED = environment.ocrEnabled;
  }

  if (environment.ocrProviderUrl === undefined) {
    delete process.env.OCR_PROVIDER_URL;
  } else {
    process.env.OCR_PROVIDER_URL = environment.ocrProviderUrl;
  }
});

describe("the decision at boot", () => {
  it("is automatic when OCR_ENABLED is not set", async () => {
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr } = await loadArea();

    await ocr.decideOcr();

    expect(ocr.isOcrAvailable()).toBe(true);
    expect(ocr.getOcrProvider().name).not.toBe("disabled");
  });

  it("is automatic when OCR_ENABLED is not set and no setup exists", async () => {
    mocks.repo.hasSsConfig.mockResolvedValue(false);

    const { ocr } = await loadArea();

    await ocr.decideOcr();

    expect(ocr.isOcrAvailable()).toBe(false);
    expect(ocr.getOcrProvider().name).toBe("disabled");
  });

  it("starts no worker when no setup exists", async () => {
    mocks.repo.hasSsConfig.mockResolvedValue(false);

    const { ocr } = await loadArea();

    await ocr.decideOcr();
    await ocr.warmupOcr();

    expect(tesseract.createWorker).not.toHaveBeenCalled();
  });

  it("forces the OCR on even when no setup exists", async () => {
    process.env.OCR_ENABLED = "true";
    mocks.repo.hasSsConfig.mockResolvedValue(false);

    const { ocr } = await loadArea();

    await ocr.decideOcr();

    expect(ocr.isOcrAvailable()).toBe(true);
  });

  it("forces the OCR off even when a setup exists", async () => {
    process.env.OCR_ENABLED = "false";
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr } = await loadArea();

    await ocr.decideOcr();

    expect(ocr.isOcrAvailable()).toBe(false);
    expect(ocr.getOcrProvider().name).toBe("disabled");
  });

  it("does not read the database when the environment decides", async () => {
    process.env.OCR_ENABLED = "true";

    const { ocr } = await loadArea();

    await ocr.decideOcr();

    expect(mocks.repo.hasSsConfig).not.toHaveBeenCalled();
  });

  it("treats a value it does not understand as unset", async () => {
    process.env.OCR_ENABLED = "yes";
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr } = await loadArea();

    await ocr.decideOcr();

    expect(mocks.repo.hasSsConfig).toHaveBeenCalledTimes(1);
    expect(ocr.isOcrAvailable()).toBe(true);
  });

  it("switches the OCR off when the database cannot be reached", async () => {
    // The automatic decision cannot be made, so the OCR stays off: a
    // screenshot that cannot be checked has to be refused.
    mocks.repo.hasSsConfig.mockRejectedValue(new Error("the database is down"));

    const { ocr } = await loadArea();

    await expect(ocr.decideOcr()).resolves.toBe(false);
    expect(ocr.isOcrAvailable()).toBe(false);
  });

  it("keeps the decision it already made", async () => {
    mocks.repo.hasSsConfig.mockResolvedValue(false);

    const { ocr } = await loadArea();

    // Two callers that arrive together wait for the same decision rather
    // than building two providers.
    await Promise.all([ocr.decideOcr(), ocr.decideOcr()]);

    mocks.repo.hasSsConfig.mockResolvedValue(true);

    await ocr.decideOcr();

    expect(ocr.isOcrAvailable()).toBe(false);
    expect(mocks.repo.hasSsConfig).toHaveBeenCalledTimes(1);
  });

  it("refuses to hand out a provider before the decision has been made", async () => {
    // The provider is not built on first use any more: it is built with the
    // setting the decision made, and the decision is made at boot.
    const { ocr } = await loadArea();

    expect(() => ocr.getOcrProvider()).toThrow(/decided on yet/);
    expect(ocr.isOcrAvailable()).toBe(false);
  });
});

describe("a submission while the OCR is off", () => {
  it("is refused", async () => {
    process.env.OCR_ENABLED = "false";
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(await solidImage()),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(outcome.verified).toBe(false);
    expect(outcome.lines).toEqual([service.OCR_UNAVAILABLE_MESSAGE]);
  });

  it("stores nothing", async () => {
    // The `any_ss` setup is the one that makes the row count worth
    // asserting: its rules have no opinion, so without the refusal a row
    // would be written — with the hash of nothing in it.
    process.env.OCR_ENABLED = "false";
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    await service.processSubmission(
      ssConfig({ ssType: "any_ss", channelName: "" }),
      "author-1",
      [submittedImage(await solidImage())],
    );

    expect(stored).toHaveLength(0);
    expect(mocks.repo.insertSsSubmission).not.toHaveBeenCalled();
  });

  it("never asks the provider for a hash", async () => {
    // The disabled provider answers with the hash of nothing. The
    // submission is refused before it is even looked at, so no hash of
    // nothing can reach the database.
    process.env.OCR_ENABLED = "false";
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const analyze = vi.spyOn(ocr.getOcrProvider(), "analyze");

    await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(await solidImage()),
    ]);

    expect(analyze).not.toHaveBeenCalled();
  });

  it("is refused for an any_ss setup, the one the rules would have accepted", async () => {
    const config = ssConfig({ ssType: "any_ss", channelName: "" });

    // The rules on their own would have accepted the empty text: `any_ss`
    // has no rules at all. This is the hole the refusal closes.
    expect(
      verifyScreenshot(config, {
        text: "",
        dhash: "0000000000000000",
        phash: "0000000000000000",
      }),
    ).toEqual({ ok: true });

    process.env.OCR_ENABLED = "false";
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(config, "author-1", [
      submittedImage(await solidImage()),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(outcome.lines).toEqual([service.OCR_UNAVAILABLE_MESSAGE]);
    expect(stored).toHaveLength(0);
  });

  it("is refused when the OCR was switched off automatically", async () => {
    // No setup exists, so the automatic decision switched the OCR off.
    mocks.repo.hasSsConfig.mockResolvedValue(false);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(await solidImage()),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(stored).toHaveLength(0);
  });
});

describe("a submission while the OCR is on", () => {
  it("is processed normally", async () => {
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(await solidImage()),
    ]);

    expect(outcome.accepted).toBe(1);
    expect(outcome.verified).toBe(true);
    expect(outcome.submitted).toBe(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(stored[0]?.phash).toMatch(/^[0-9a-f]{16}$/);

    // The OCR really ran: a worker was started and the text was read.
    expect(tesseract.createWorker).toHaveBeenCalledTimes(1);
    expect(fakeWorker.recognize).toHaveBeenCalled();

    await ocr.shutdownOcr();
  });

  it("is processed normally when the environment forces the OCR on", async () => {
    process.env.OCR_ENABLED = "true";
    mocks.repo.hasSsConfig.mockResolvedValue(false);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(await solidImage()),
    ]);

    expect(outcome.accepted).toBe(1);
    expect(stored).toHaveLength(1);

    await ocr.shutdownOcr();
  });
});
