/**
 * The OCR switch: the decision at boot, and what happens to a submission.
 *
 * Three halves of one switch:
 *
 *  - **the decision** — made once, at boot, from `OCR_ENABLED` and from
 *    whether any screenshot-verification setup exists;
 *  - **the effective state** — the provider is the last word, so a
 *    deployment that asked for the OCR and configured no service has no
 *    OCR, whatever the flag said;
 *  - **the refusal** — a screenshot that cannot be read is refused
 *    outright, and nothing is stored.
 *
 * The refusal is the half that matters. The rules cannot do it: `any_ss`
 * has no rules at all, and a `loco` or `rooter` setup whose channel name
 * is empty has none that look at the text either — so an empty text would
 * be *accepted* there. The tests below pin that hole down and then show
 * that the submission is refused anyway.
 *
 * There is no local engine any more: the provider is a remote service, so
 * the "OCR is on" cases point `OCR_PROVIDER_URL` at a fake service and the
 * `fetch` is replaced. The suite needs no network and no service.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyScreenshot } from "./verification.js";
import type { SsConfig } from "./types.js";

/** Where the fake service lives. */
const SERVICE_URL = "https://ocr.example.com/ocr";

/** The URL of the screenshot the tests submit. */
const IMAGE_URL = "https://cdn.discordapp.com/attachments/1/2/screenshot.png";

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
 * The answer the fake service gives for one image.
 *
 * The text says "videos", so the YouTube rule is satisfied, and it does
 * not say "subscribe", so the button rule is not.
 */
function serviceAnswer(overrides: Record<string, unknown> = {}): unknown {
  return [
    {
      url: IMAGE_URL,
      dhash: "9c63949032868431",
      phash: "c0c0bf3f3bf0f090",
      text: "Team Phoenix videos",
      ...overrides,
    },
  ];
}

/** A fake service that answers with one result. */
function serviceThatAnswers(
  answer: unknown = serviceAnswer(),
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify(answer), { status: 200 }),
  );
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
function submittedImage(): {
  readonly url: string;
  readonly channelId: string;
  readonly messageId: string;
} {
  return { url: IMAGE_URL, channelId: "channel-1", messageId: "message-1" };
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
  vi.unstubAllGlobals();

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
    process.env.OCR_PROVIDER_URL = SERVICE_URL;
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr } = await loadArea();

    await expect(ocr.decideOcr()).resolves.toBe(true);
    expect(ocr.isOcrAvailable()).toBe(true);
    expect(ocr.getOcrProvider().name).toBe("http");
  });

  it("is automatic when OCR_ENABLED is not set and no setup exists", async () => {
    mocks.repo.hasSsConfig.mockResolvedValue(false);

    const { ocr } = await loadArea();

    await expect(ocr.decideOcr()).resolves.toBe(false);
    expect(ocr.isOcrAvailable()).toBe(false);
    expect(ocr.getOcrProvider().name).toBe("disabled");
  });

  it("is off when a setup exists but no service is configured", async () => {
    // The provider is the last word: there is no local engine, so a
    // deployment without a service has no OCR at all — whatever the
    // decision asked for.
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr } = await loadArea();

    await expect(ocr.decideOcr()).resolves.toBe(false);
    expect(ocr.isOcrAvailable()).toBe(false);
    expect(ocr.getOcrProvider().name).toBe("disabled");
  });

  it("makes no network call when no service is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr } = await loadArea();

    await ocr.decideOcr();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forces the OCR on even when no setup exists", async () => {
    process.env.OCR_ENABLED = "true";
    process.env.OCR_PROVIDER_URL = SERVICE_URL;
    mocks.repo.hasSsConfig.mockResolvedValue(false);

    const { ocr } = await loadArea();

    await expect(ocr.decideOcr()).resolves.toBe(true);
    expect(ocr.isOcrAvailable()).toBe(true);
  });

  it("forces the OCR on but stays off without a service", async () => {
    // The flag says on; the provider says there is no engine. The
    // provider is right: the screenshot would have nothing to read it.
    process.env.OCR_ENABLED = "true";
    mocks.repo.hasSsConfig.mockResolvedValue(false);

    const { ocr } = await loadArea();

    await expect(ocr.decideOcr()).resolves.toBe(false);
    expect(ocr.isOcrAvailable()).toBe(false);
  });

  it("forces the OCR off even when a setup exists", async () => {
    process.env.OCR_ENABLED = "false";
    process.env.OCR_PROVIDER_URL = SERVICE_URL;
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr } = await loadArea();

    await expect(ocr.decideOcr()).resolves.toBe(false);
    expect(ocr.isOcrAvailable()).toBe(false);
    expect(ocr.getOcrProvider().name).toBe("disabled");
  });

  it("does not read the database when the environment decides", async () => {
    process.env.OCR_ENABLED = "true";
    process.env.OCR_PROVIDER_URL = SERVICE_URL;

    const { ocr } = await loadArea();

    await ocr.decideOcr();

    expect(mocks.repo.hasSsConfig).not.toHaveBeenCalled();
  });

  it("treats a value it does not understand as unset", async () => {
    process.env.OCR_ENABLED = "yes";
    process.env.OCR_PROVIDER_URL = SERVICE_URL;
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

  it("refuses a screenshot when the decision has not been made yet", async () => {
    // A decision that has not been made is not a crash: the screenshot
    // cannot be read, and that is a decision.
    const { ocr } = await loadArea();

    const analysis = await ocr.analyzeScreenshot(IMAGE_URL);

    expect(analysis.ok).toBe(false);

    if (analysis.ok) return;

    expect(analysis.reason).toMatch(/decided on yet/);
  });
});

describe("a submission while the OCR is off", () => {
  it("is refused", async () => {
    process.env.OCR_ENABLED = "false";
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(),
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
      [submittedImage()],
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
      submittedImage(),
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
      submittedImage(),
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
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(stored).toHaveLength(0);
  });

  it("is refused when a setup exists but no service is configured", async () => {
    // The default of a fresh deployment: the feature is there, and it
    // refuses every screenshot.
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(outcome.lines).toEqual([service.OCR_UNAVAILABLE_MESSAGE]);
    expect(stored).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("a submission while the OCR is on", () => {
  it("is processed normally", async () => {
    process.env.OCR_PROVIDER_URL = SERVICE_URL;
    vi.stubGlobal("fetch", serviceThatAnswers());
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(1);
    expect(outcome.verified).toBe(true);
    expect(outcome.submitted).toBe(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.dhash).toBe("9c63949032868431");
    expect(stored[0]?.phash).toBe("c0c0bf3f3bf0f090");

    await ocr.shutdownOcr();
  });

  it("sends the image url to the service", async () => {
    // The service fetches the image itself, so the URL is what reaches it
    // — the bot never downloads the picture.
    process.env.OCR_PROVIDER_URL = SERVICE_URL;

    const fetchImpl = serviceThatAnswers();
    vi.stubGlobal("fetch", fetchImpl);
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    await service.processSubmission(ssConfig(), "author-1", [submittedImage()]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(SERVICE_URL);
    expect(JSON.parse(String(init?.body))).toEqual([{ url: IMAGE_URL }]);

    await ocr.shutdownOcr();
  });

  it("is processed normally when the environment forces the OCR on", async () => {
    process.env.OCR_ENABLED = "true";
    process.env.OCR_PROVIDER_URL = SERVICE_URL;
    vi.stubGlobal("fetch", serviceThatAnswers());
    mocks.repo.hasSsConfig.mockResolvedValue(false);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(1);
    expect(stored).toHaveLength(1);

    await ocr.shutdownOcr();
  });
});

describe("a provider that cannot do its job", () => {
  it("refuses the screenshot when the service is down", async () => {
    // A refusal, not an exception: the member gets an answer and nothing
    // is stored.
    process.env.OCR_PROVIDER_URL = SERVICE_URL;

    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("connection refused");
    });

    vi.stubGlobal("fetch", fetchImpl);
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(outcome.verified).toBe(false);
    expect(outcome.lines).toEqual([service.OCR_UNAVAILABLE_MESSAGE]);
    expect(stored).toHaveLength(0);

    await ocr.shutdownOcr();
  });

  it("refuses the screenshot when the service answers with rubbish", async () => {
    process.env.OCR_PROVIDER_URL = SERVICE_URL;
    vi.stubGlobal("fetch", serviceThatAnswers("not an array of results"));
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(outcome.lines).toEqual([service.OCR_UNAVAILABLE_MESSAGE]);
    expect(stored).toHaveLength(0);

    await ocr.shutdownOcr();
  });

  it("refuses the screenshot when the service sends a hash that is not a hash", async () => {
    // A hash that cannot be compared verifies nothing.
    process.env.OCR_PROVIDER_URL = SERVICE_URL;
    vi.stubGlobal(
      "fetch",
      serviceThatAnswers(serviceAnswer({ dhash: "not-a-hash" })),
    );
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(outcome.lines).toEqual([service.OCR_UNAVAILABLE_MESSAGE]);
    expect(stored).toHaveLength(0);

    await ocr.shutdownOcr();
  });
});

describe("a stored hash that cannot be compared", () => {
  it("refuses the member's own submission instead of crashing", async () => {
    // The member's own stored row is corrupt, so the check cannot tell
    // whether this screenshot repeats one of their own. The submission is
    // refused — nothing is stored, and the member gets an answer.
    process.env.OCR_PROVIDER_URL = SERVICE_URL;
    vi.stubGlobal("fetch", serviceThatAnswers());
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    stored = [
      {
        id: "row-1",
        ssConfigId: "config-1",
        authorId: "author-1",
        channelId: "channel-1",
        messageId: "message-0",
        dhash: "abc",
        phash: "c0c0bf3f3bf0f090",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(
      ssConfig({ requiredSs: 2 }),
      "author-1",
      [submittedImage()],
    );

    expect(outcome.accepted).toBe(0);
    expect(outcome.verified).toBe(false);
    expect(outcome.lines).toEqual([service.DUPLICATE_CHECK_FAILED_MESSAGE]);
    expect(stored).toHaveLength(1);

    await ocr.shutdownOcr();
  });

  it("lets another member's corrupt row through", async () => {
    // One corrupt row must not block every member of the setup: the row
    // is reported and the submission goes through.
    process.env.OCR_PROVIDER_URL = SERVICE_URL;
    vi.stubGlobal("fetch", serviceThatAnswers());
    mocks.repo.hasSsConfig.mockResolvedValue(true);

    stored = [
      {
        id: "row-1",
        ssConfigId: "config-1",
        authorId: "author-2",
        channelId: "channel-1",
        messageId: "message-0",
        dhash: "abc",
        phash: "c0c0bf3f3bf0f090",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];

    const { ocr, service } = await loadArea();
    await ocr.decideOcr();

    const outcome = await service.processSubmission(ssConfig(), "author-1", [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(1);
    expect(stored).toHaveLength(2);

    await ocr.shutdownOcr();
  });
});
