/**
 * The duplicate threshold of a setup.
 *
 * The threshold is the **setup's own** (`ss_configs.duplicate_threshold`),
 * not the global default: a guild whose screenshots rescale differently
 * may need a different one (D20). The check is still on the **dHash** —
 * the pHash is stored beside it, but the threshold of 7 was calibrated on
 * the dHash — so the same distance, over the same hash.
 *
 * These tests are **end to end**: the setups are rows in a real database,
 * they are read back through the repository, and the configuration the
 * service sees is the one the database holds. A mocked repository could
 * not show that the value the service uses is the value the column has.
 *
 * The database is a file in the system temporary directory, created and
 * dropped with the test run. The client reads `DB_FILE` when it is
 * imported and applies the migrations as it goes, so the variable is set
 * before the import — which is why the imports below are dynamic.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

vi.mock("../premium/entitlements.js", () => ({
  assertEntitled: vi.fn(),
}));

/** The database this run uses. Dropped when the run ends. */
const directory = mkdtempSync(join(tmpdir(), "quotient-identity-threshold-"));

process.env.DB_FILE = join(directory, "identity-threshold-test.db");

const { closeDatabase, db } = await import("../../db/client.js");
const { ssConfigs } = await import("../../db/schema.js");
const repo = await import("./repo.js");
const ocr = await import("./ocr.js");
const service = await import("./service.js");
import type { SsConfig } from "./types.js";

/** Where the fake OCR service lives. */
const SERVICE_URL = "https://ocr.example.com/ocr";

/** The URL of the screenshot the tests submit. */
const IMAGE_URL = "https://cdn.discordapp.com/attachments/1/2/screenshot.png";

/** The dHash the fake service answers with. */
const CANDIDATE_DHASH = "9c63949032868431";

/** The pHash the fake service answers with. */
const CANDIDATE_PHASH = "c0c0bf3f3bf0f090";

/** The member who submits. */
const AUTHOR_ID = "author-1";

/** The guild every setup of this run belongs to. */
const GUILD_ID = "identity-threshold-test-guild";

/** A suffix no other row of this run can have. */
let counter = 0;

function uniqueId(prefix: string): string {
  counter += 1;

  return `${prefix}-${process.pid}-${counter}`;
}

/**
 * A hash that is exactly `bits` bits away from `base`.
 *
 * The first `bits` bits of the hex are flipped one by one, from the most
 * significant end.
 */
function bitsAway(base: string, bits: number): string {
  let value = BigInt(`0x${base}`);

  for (let index = 0; index < bits; index += 1) {
    value ^= 1n << BigInt(64 - 1 - index);
  }

  return value.toString(16).padStart(16, "0");
}

/**
 * What the fake OCR service answers with.
 *
 * The provider holds on to the `fetch` it was built with, so the answer
 * is a variable the tests change rather than a second stub.
 */
let answer: Record<string, string>[] = [
  {
    url: IMAGE_URL,
    dhash: CANDIDATE_DHASH,
    phash: CANDIDATE_PHASH,
    text: "Team Phoenix videos",
  },
];

/**
 * The fake OCR service.
 *
 * The text says "videos" and names the page, so the YouTube rules pass;
 * it does not say "subscribe", so the button rule does not fire.
 */
function serviceThatAnswers(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify(answer), { status: 200 }),
  );
}

/**
 * Creates a setup with a threshold of its own.
 *
 * The threshold is written to the column directly: the column is the
 * setup's own, and nothing in the panel writes it yet.
 */
async function makeSetup(threshold: number): Promise<SsConfig> {
  const id = await repo.insertSsConfig({
    guildId: GUILD_ID,
    channelId: uniqueId("channel"),
    roleId: "role-1",
    requiredSs: 3,
    channelName: "Team Phoenix",
    channelLink: "",
    keywords: ["Team Phoenix"],
    allowSame: false,
    ssType: "youtube",
    successMessage: null,
  });

  await db
    .update(ssConfigs)
    .set({ duplicateThreshold: threshold })
    .where(eq(ssConfigs.id, id));

  const config = await repo.findSsConfigById(GUILD_ID, id);

  if (!config) {
    throw new Error("the setup could not be read back");
  }

  return config;
}

/**
 * Stores a submission of the member.
 *
 * The default is a picture **three bits** away from the one the service
 * answers with: far enough for a threshold of 0, close enough for the
 * default of 7.
 */
async function storeSubmission(
  config: SsConfig,
  overrides: Partial<Parameters<typeof repo.insertSsSubmission>[0]> = {},
): Promise<void> {
  await repo.insertSsSubmission({
    ssConfigId: config.id,
    authorId: AUTHOR_ID,
    channelId: "channel-1",
    messageId: "message-0",
    dhash: bitsAway(CANDIDATE_DHASH, 3),
    phash: CANDIDATE_PHASH,
    ...overrides,
  });
}

/** The screenshot the tests submit. */
function submittedImage(): {
  readonly url: string;
  readonly channelId: string;
  readonly messageId: string;
} {
  return { url: IMAGE_URL, channelId: "channel-1", messageId: "message-1" };
}

beforeAll(async () => {
  vi.stubGlobal("fetch", serviceThatAnswers());

  // The decision is made once, at boot: the OCR is forced on, and the
  // service is the fake one above.
  process.env.OCR_ENABLED = "true";
  process.env.OCR_PROVIDER_URL = SERVICE_URL;

  await ocr.decideOcr();
});

afterAll(async () => {
  await ocr.shutdownOcr();

  vi.unstubAllGlobals();

  delete process.env.OCR_ENABLED;
  delete process.env.OCR_PROVIDER_URL;

  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

describe("the threshold of the setup", () => {
  it("is the setup's own, and not the global default", async () => {
    // A threshold of 0 forgives nothing: three bits apart is a different
    // picture, and the submission goes through.
    const strict = await makeSetup(0);

    await storeSubmission(strict);

    const outcome = await service.processSubmission(strict, AUTHOR_ID, [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(1);
    expect(outcome.verified).toBe(false);
  });

  it("makes the same picture a duplicate for a setup with a wider one", async () => {
    // The very same three bits, and a threshold of 7: the picture is a
    // duplicate and the submission is refused.
    const lenient = await makeSetup(7);

    await storeSubmission(lenient);

    const outcome = await service.processSubmission(lenient, AUTHOR_ID, [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(outcome.verified).toBe(false);
    expect(outcome.lines[0]).toContain("already submitted this screenshot");
  });

  it("is read from the row, not from the setup the tests built", async () => {
    // The configuration the service is given is the one the database
    // holds — the threshold is on the row, and the row is what is read.
    const strict = await makeSetup(0);

    expect(strict.duplicateThreshold).toBe(0);

    await storeSubmission(strict);

    const outcome = await service.processSubmission(strict, AUTHOR_ID, [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(1);
  });
});

describe("a threshold that cannot be a Hamming distance", () => {
  it("falls back to the default when it is too large", async () => {
    // 65 bits is more than a 64-bit hash has. The default of 7 is used
    // instead, and the submission is refused as a duplicate rather than
    // failing.
    const broken = await makeSetup(65);

    await storeSubmission(broken);

    const outcome = await service.processSubmission(broken, AUTHOR_ID, [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(outcome.lines[0]).toContain("already submitted this screenshot");
  });

  it("falls back to the default when it is negative", async () => {
    const broken = await makeSetup(-1);

    await storeSubmission(broken);

    const outcome = await service.processSubmission(broken, AUTHOR_ID, [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(outcome.lines[0]).toContain("already submitted this screenshot");
  });

  it("falls back to the default when the setup has no threshold of its own", async () => {
    const broken = await makeSetup(7);

    // A configuration that was built by hand, without the column.
    const withoutThreshold = { ...broken, duplicateThreshold: null };

    await storeSubmission(broken);

    const outcome = await service.processSubmission(withoutThreshold, AUTHOR_ID, [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(outcome.lines[0]).toContain("already submitted this screenshot");
  });
});

describe("a stored row that cannot be compared", () => {
  it("refuses the member's own submission, whatever the threshold is", async () => {
    // The threshold says nothing about a row that cannot be read: the
    // member's own history is broken, so the check cannot be made and the
    // submission is refused.
    const strict = await makeSetup(0);

    await storeSubmission(strict, { dhash: "abc" });

    const outcome = await service.processSubmission(strict, AUTHOR_ID, [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(0);
    expect(outcome.verified).toBe(false);
    expect(outcome.lines).toEqual([service.DUPLICATE_CHECK_FAILED_MESSAGE]);
  });

  it("passes over somebody else's broken row, whatever the threshold is", async () => {
    // One bad row must not block every member of the setup: the row is
    // reported and the submission goes through.
    const strict = await makeSetup(0);

    await storeSubmission(strict, { authorId: "author-2", dhash: "abc" });

    const outcome = await service.processSubmission(strict, AUTHOR_ID, [
      submittedImage(),
    ]);

    expect(outcome.accepted).toBe(1);
  });

  it("still refuses a screenshot whose own hash is not a hash", async () => {
    // The threshold says nothing about the screenshot's own hash either:
    // a hash nobody can compare verifies nothing.
    const strict = await makeSetup(0);

    answer = [
      {
        url: IMAGE_URL,
        dhash: "not-a-hash",
        phash: CANDIDATE_PHASH,
        text: "Team Phoenix videos",
      },
    ];

    try {
      const outcome = await service.processSubmission(strict, AUTHOR_ID, [
        submittedImage(),
      ]);

      expect(outcome.accepted).toBe(0);
      expect(outcome.lines).toEqual([service.OCR_UNAVAILABLE_MESSAGE]);
    } finally {
      answer = [
        {
          url: IMAGE_URL,
          dhash: CANDIDATE_DHASH,
          phash: CANDIDATE_PHASH,
          text: "Team Phoenix videos",
        },
      ];
    }
  });
});
