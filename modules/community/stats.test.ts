/**
 * The usage-log statistics, against the live database.
 *
 * The source wrote these as hand-written SQL over its `commands` table.
 * The port keeps them as typed queries (S6) and gives the table the two
 * composite indexes the queries filter on (S10).
 *
 * These are not unit tests with a mocked database: the point of the
 * statistics is the shape of the query and the index it uses, and only a
 * real database can show that.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDatabase, db } from "../../db/client.js";
import { commandUsage, tags } from "../../db/schema.js";
import * as repo from "./repo.js";

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `community-stats-test-${Date.now()}`;

/** The ids the fixtures use. */
const USER_A = "111111111111111111";
const USER_B = "222222222222222222";
const USER_C = "333333333333333333";
const USER_D = "444444444444444444";

/**
 * Is the database there?
 *
 * The test is skipped rather than failed when it is not, so the unit
 * tests still run on a machine without Postgres.
 */
async function databaseIsReachable(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);

    return true;
  } catch {
    return false;
  }
}

const reachable = await databaseIsReachable();

beforeAll(async () => {
  if (!reachable) return;

  // Three uses of the tag command by A, one by B, and one command that
  // is not the tag command at all.
  await db.insert(commandUsage).values([
    { guildId: GUILD_ID, channelId: "1", userId: USER_A, cmd: "tag" },
    { guildId: GUILD_ID, channelId: "1", userId: USER_A, cmd: "tag" },
    { guildId: GUILD_ID, channelId: "1", userId: USER_A, cmd: "tag" },
    { guildId: GUILD_ID, channelId: "1", userId: USER_B, cmd: "tag" },
    { guildId: GUILD_ID, channelId: "1", userId: USER_A, cmd: "snipe" },
    // A qualified name counts too: the dispatcher may write either.
    { guildId: GUILD_ID, channelId: "1", userId: USER_B, cmd: "tag show" },
  ]);

  // Two tags for C and one for D.
  await db.insert(tags).values([
    { guildId: GUILD_ID, name: "alpha", content: "a", ownerId: USER_C, usage: 5 },
    { guildId: GUILD_ID, name: "beta", content: "b", ownerId: USER_C, usage: 1 },
    { guildId: GUILD_ID, name: "gamma", content: "c", ownerId: USER_D, usage: 3 },
  ]);
});

afterAll(async () => {
  if (reachable) {
    await db.delete(tags).where(eq(tags.guildId, GUILD_ID));
    await db.delete(commandUsage).where(eq(commandUsage.guildId, GUILD_ID));
  }

  await closeDatabase();
});

describe.skipIf(!reachable)("the tag statistics", () => {
  it("counts the tag command per member, most used first", async () => {
    const counts = await repo.countTagUsesByUser(GUILD_ID);

    expect(counts[0]).toEqual({ userId: USER_A, uses: 3 });
    expect(counts[1]).toEqual({ userId: USER_B, uses: 2 });
    expect(counts).toHaveLength(2);
  });

  it("counts one member's uses of the tag command", async () => {
    expect(await repo.countTagCommandUses(GUILD_ID, USER_A)).toBe(3);
    expect(await repo.countTagCommandUses(GUILD_ID, USER_B)).toBe(2);
    expect(await repo.countTagCommandUses(GUILD_ID, USER_D)).toBe(0);
  });

  it("counts the tags each member owns", async () => {
    const counts = await repo.countTagsByOwner(GUILD_ID);

    expect(counts[0]).toEqual({ ownerId: USER_C, count: 2 });
    expect(counts[1]).toEqual({ ownerId: USER_D, count: 1 });
  });

  it("lists a member's tags with the totals over the whole set", async () => {
    const stats = await repo.listMemberTagStats(GUILD_ID, USER_C);

    expect(stats).toHaveLength(2);
    expect(stats[0]?.name).toBe("alpha");
    expect(stats[0]?.usage).toBe(5);

    // The window functions run over every row of the member's tags, not
    // over the two that survived the limit.
    expect(stats[0]?.totalTags).toBe(2);
    expect(stats[0]?.totalUses).toBe(6);
  });

  it("reports the guild's totals", async () => {
    const stats = await repo.getGuildTagStats(GUILD_ID);

    expect(stats.totalTags).toBe(3);
    expect(stats.totalUses).toBe(9);
    expect(stats.topTags[0]).toEqual({ name: "alpha", usage: 5 });
    expect(stats.topUsers[0]).toEqual({ userId: USER_A, uses: 3 });
    expect(stats.topCreators[0]).toEqual({ ownerId: USER_C, count: 2 });
  });

  it("counts a tag use atomically", async () => {
    const before = await repo.findTagByName(GUILD_ID, "alpha");

    await repo.incrementTagUsage(GUILD_ID, "alpha");
    await repo.incrementTagUsage(GUILD_ID, "alpha");

    const after = await repo.findTagByName(GUILD_ID, "alpha");

    expect(after?.usage).toBe((before?.usage ?? 0) + 2);
  });
});
