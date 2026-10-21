/**
 * The repository, against a real database.
 *
 * The keyword set is the interesting part. It used to be a `text[]` column
 * on `ss_configs`; it is rows in `ss_config_keywords` now, so every read
 * and every write of it goes through that table. A mocked database cannot
 * show that: the round trip **is** the thing under test.
 *
 * The threshold is the other half: `ss_configs.duplicate_threshold` is a
 * column of its own, and a column nobody reads is a trap for the next
 * reader. The setup a member submits to has to be checked with **its own**
 * threshold.
 *
 * **The database is a file in the system temporary directory**, created and
 * dropped with the test run. The client reads `DB_FILE` when it is
 * imported and applies the migrations as it goes, so the variable is set
 * before the import — which is why the imports below are dynamic.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

/** The database this run uses. Dropped when the run ends. */
const directory = mkdtempSync(join(tmpdir(), "quotient-identity-repo-"));

process.env.DB_FILE = join(directory, "identity-repo-test.db");

const { closeDatabase, db } = await import("../../db/client.js");
const { ssConfigKeywords, ssConfigs } = await import("../../db/schema.js");
const repo = await import("./repo.js");

afterAll(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

/** The guild every setup of this run belongs to. */
const GUILD_ID = "identity-repo-test-guild";

/** A suffix no other row of this run can have. */
let counter = 0;

function uniqueId(prefix: string): string {
  counter += 1;

  return `${prefix}-${process.pid}-${counter}`;
}

/**
 * Creates a setup.
 *
 * @returns the setup's row id.
 */
async function makeSetup(
  overrides: Partial<Parameters<typeof repo.insertSsConfig>[0]> = {},
): Promise<string> {
  return repo.insertSsConfig({
    guildId: GUILD_ID,
    channelId: uniqueId("channel"),
    roleId: "role-1",
    requiredSs: 2,
    channelName: "Team Phoenix",
    channelLink: "",
    keywords: [],
    allowSame: false,
    ssType: "youtube",
    successMessage: null,
    ...overrides,
  });
}

/**
 * The keyword rows of a setup, as the table holds them.
 */
async function keywordRows(ssConfigId: string): Promise<string[]> {
  const rows = await db
    .select({ keyword: ssConfigKeywords.keyword })
    .from(ssConfigKeywords)
    .where(eq(ssConfigKeywords.ssConfigId, ssConfigId));

  return rows.map((row) => row.keyword);
}

describe("the keywords of a setup", () => {
  it("comes back from the join table", async () => {
    const id = await makeSetup({
      keywords: ["Team Phoenix", "hardware"],
    });

    const config = await repo.findSsConfigById(GUILD_ID, id);

    expect(config?.keywords).toEqual(["Team Phoenix", "hardware"]);
  });

  it("is stored as it was given, not normalised", async () => {
    // The comparison normalises the keyword — case-insensitively, with the
    // spaces stripped — when it looks at it. What is stored is what the
    // operator typed.
    const id = await makeSetup({ keywords: ["Team Phoenix"] });

    expect(await keywordRows(id)).toEqual(["Team Phoenix"]);
  });

  it("is written with a conflict clause, so a repeated keyword is stored once", async () => {
    const id = await makeSetup({ keywords: ["Team Phoenix", "Team Phoenix"] });

    expect(await keywordRows(id)).toEqual(["Team Phoenix"]);

    const config = await repo.findSsConfigById(GUILD_ID, id);

    expect(config?.keywords).toEqual(["Team Phoenix"]);
  });

  it("is replaced by the editor, and the keyword that is gone goes with it", async () => {
    const id = await makeSetup({ keywords: ["Team Phoenix", "hardware"] });

    await repo.updateSsConfig(GUILD_ID, id, {
      keywords: ["Installation Screen"],
    });

    expect(await keywordRows(id)).toEqual(["Installation Screen"]);

    const config = await repo.findSsConfigById(GUILD_ID, id);

    expect(config?.keywords).toEqual(["Installation Screen"]);
  });

  it("keeps a keyword that the editor did not touch", async () => {
    const id = await makeSetup({ keywords: ["Team Phoenix", "hardware"] });

    await repo.updateSsConfig(GUILD_ID, id, { keywords: ["Team Phoenix"] });

    expect(await keywordRows(id)).toEqual(["Team Phoenix"]);
  });

  it("is empty when the editor empties it", async () => {
    const id = await makeSetup({ keywords: ["Team Phoenix"] });

    await repo.updateSsConfig(GUILD_ID, id, { keywords: [] });

    expect(await keywordRows(id)).toEqual([]);

    const config = await repo.findSsConfigById(GUILD_ID, id);

    expect(config?.keywords).toEqual([]);
  });

  it("is left alone when the editor does not mention it", async () => {
    const id = await makeSetup({ keywords: ["Team Phoenix"] });

    await repo.updateSsConfig(GUILD_ID, id, { channelName: "Team Phoenix II" });

    expect(await keywordRows(id)).toEqual(["Team Phoenix"]);
  });

  it("belongs to one setup only", async () => {
    const first = await makeSetup({ keywords: ["Team Phoenix"] });
    const second = await makeSetup({ keywords: ["hardware"] });

    await repo.updateSsConfig(GUILD_ID, first, { keywords: ["Installation Screen"] });

    expect(await keywordRows(first)).toEqual(["Installation Screen"]);
    expect(await keywordRows(second)).toEqual(["hardware"]);
  });

  it("is not written to a setup of another guild", async () => {
    const id = await makeSetup({ keywords: ["Team Phoenix"] });

    await repo.updateSsConfig("another-guild", id, { keywords: ["hardware"] });

    expect(await keywordRows(id)).toEqual(["Team Phoenix"]);
  });

  it("is read for every setup of the list", async () => {
    const first = await makeSetup({ keywords: ["Team Phoenix"] });
    const second = await makeSetup({ keywords: ["hardware"] });

    const configs = await repo.listSsConfigs(GUILD_ID);

    const byId = new Map(configs.map((config) => [config.id, config.keywords]));

    expect(byId.get(first)).toEqual(["Team Phoenix"]);
    expect(byId.get(second)).toEqual(["hardware"]);
  });

  it("is read for a setup that is looked up by its channel", async () => {
    const channelId = uniqueId("channel");

    const id = await repo.insertSsConfig({
      guildId: GUILD_ID,
      channelId,
      roleId: "role-1",
      requiredSs: 2,
      channelName: "Team Phoenix",
      channelLink: "",
      keywords: ["Team Phoenix"],
      allowSame: false,
      ssType: "youtube",
      successMessage: null,
    });

    const config = await repo.findSsConfigByChannel(channelId);

    expect(config?.id).toBe(id);
    expect(config?.keywords).toEqual(["Team Phoenix"]);
  });

  it("goes with the setup when the setup is deleted", async () => {
    const id = await makeSetup({ keywords: ["Team Phoenix"] });

    await repo.deleteSsConfig(GUILD_ID, id);

    expect(await keywordRows(id)).toEqual([]);
  });
});

describe("the threshold of a setup", () => {
  it("is the default when the setup does not have one of its own", async () => {
    const id = await makeSetup();

    const config = await repo.findSsConfigById(GUILD_ID, id);

    expect(config?.duplicateThreshold).toBe(7);
  });

  it("is the setup's own value when it has one", async () => {
    const id = await makeSetup();

    await db
      .update(ssConfigs)
      .set({ duplicateThreshold: 3 })
      .where(eq(ssConfigs.id, id));

    const config = await repo.findSsConfigById(GUILD_ID, id);

    expect(config?.duplicateThreshold).toBe(3);
  });

  it("is read for a setup that is looked up by its channel", async () => {
    const channelId = uniqueId("channel");

    const id = await repo.insertSsConfig({
      guildId: GUILD_ID,
      channelId,
      roleId: "role-1",
      requiredSs: 2,
      channelName: "Team Phoenix",
      channelLink: "",
      keywords: [],
      allowSame: false,
      ssType: "youtube",
      successMessage: null,
    });

    await db
      .update(ssConfigs)
      .set({ duplicateThreshold: 12 })
      .where(eq(ssConfigs.id, id));

    const config = await repo.findSsConfigByChannel(channelId);

    expect(config?.duplicateThreshold).toBe(12);
  });

  it("is read for every setup of the list", async () => {
    const id = await makeSetup();

    await db
      .update(ssConfigs)
      .set({ duplicateThreshold: 0 })
      .where(eq(ssConfigs.id, id));

    const configs = await repo.listSsConfigs(GUILD_ID);

    const found = configs.find((config) => config.id === id);

    expect(found?.duplicateThreshold).toBe(0);
  });
});
