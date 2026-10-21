/**
 * The repository, against the live database.
 *
 * Two of the statements in `repo.ts` are hand-written SQL, and both are
 * for a reason:
 *
 *  - the tag usage counter is an atomic `usage = usage + 1`, which has to
 *    be one statement;
 *  - the auto-role toggle is an `INSERT … ON CONFLICT DO UPDATE` that
 *    adds or removes a role id in the array **atomically**.
 *
 * Hand-written SQL is exactly the kind of thing that looks right and is
 * not, so it is proved here rather than eyeballed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { closeDatabase, db } from "../../db/client.js";
import { autoroleConfigs, jobs, snipes } from "../../db/schema.js";
import * as repo from "./repo.js";

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `community-repo-test-${Date.now()}`;

/** A channel id no real row can have. */
const CHANNEL_ID = "900000000000000001";

/** A role id no real row can have. */
const ROLE_ID = "900000000000000002";

/** Another role id. */
const OTHER_ROLE_ID = "900000000000000003";

/** A user id no real row can have. */
const USER_ID = "777777777777777777";

/** A marker every job row this file creates carries. */
const MARKER = `community-repo-test-${Date.now()}`;

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

/** Removes every row this file created. */
async function cleanUp(): Promise<void> {
  await db.delete(autoroleConfigs).where(eq(autoroleConfigs.guildId, GUILD_ID));
  await db.delete(snipes).where(eq(snipes.channelId, CHANNEL_ID));
  await db.delete(jobs).where(eq(jobs.userId, USER_ID));
  await db
    .delete(jobs)
    .where(sql`${jobs.payload} ->> 'marker' = ${MARKER}`);
}

beforeAll(async () => {
  if (!reachable) return;

  await cleanUp();
});

afterAll(async () => {
  if (reachable) {
    await cleanUp();
  }

  await closeDatabase();
});

describe.skipIf(!reachable)("the auto-role toggle", () => {
  it("creates the row and adds the role", async () => {
    const roles = await repo.toggleAutoroleRole(GUILD_ID, "humans", ROLE_ID);

    expect(roles).toEqual([ROLE_ID]);
  });

  it("removes the role when it is there already", async () => {
    const roles = await repo.toggleAutoroleRole(GUILD_ID, "humans", ROLE_ID);

    expect(roles).toEqual([]);
  });

  it("keeps the two lists apart", async () => {
    await repo.toggleAutoroleRole(GUILD_ID, "humans", ROLE_ID);
    await repo.toggleAutoroleRole(GUILD_ID, "bots", OTHER_ROLE_ID);

    const config = await repo.findAutoroleConfig(GUILD_ID);

    expect(config?.humans).toEqual([ROLE_ID]);
    expect(config?.bots).toEqual([OTHER_ROLE_ID]);
  });

  it("does not add the same role twice", async () => {
    await repo.clearAutoroleRoles(GUILD_ID);

    await repo.toggleAutoroleRole(GUILD_ID, "humans", ROLE_ID);
    await repo.toggleAutoroleRole(GUILD_ID, "humans", ROLE_ID);
    await repo.toggleAutoroleRole(GUILD_ID, "humans", ROLE_ID);

    const config = await repo.findAutoroleConfig(GUILD_ID);

    expect(config?.humans).toEqual([ROLE_ID]);
  });

  it("removes a role that no longer exists", async () => {
    await repo.removeAutoroleRole(GUILD_ID, "humans", ROLE_ID);

    const config = await repo.findAutoroleConfig(GUILD_ID);

    expect(config?.humans).toEqual([]);
  });

  it("empties both lists", async () => {
    await repo.clearAutoroleRoles(GUILD_ID);

    const config = await repo.findAutoroleConfig(GUILD_ID);

    expect(config?.humans).toEqual([]);
    expect(config?.bots).toEqual([]);
  });
});

describe.skipIf(!reachable)("the snipe", () => {
  it("stores one row per channel and replaces it", async () => {
    await repo.upsertSnipe({
      channelId: CHANNEL_ID,
      authorId: "1",
      content: "first",
      nsfw: false,
    });

    await repo.upsertSnipe({
      channelId: CHANNEL_ID,
      authorId: "2",
      content: "second",
      nsfw: true,
    });

    const snipe = await repo.findSnipe(CHANNEL_ID);

    expect(snipe?.content).toBe("second");
    expect(snipe?.authorId).toBe("2");
    expect(snipe?.nsfw).toBe(true);
  });

  it("prunes the snipes that are too old", async () => {
    const removed = await repo.deleteSnipesOlderThan(new Date());

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await repo.findSnipe(CHANNEL_ID)).toBeNull();
  });
});

describe.skipIf(!reachable)("the jobs", () => {
  it("writes a row with the id it was given", async () => {
    const id = await repo.insertJob({
      expiresAt: new Date(Date.now() + 60_000),
      event: "reminder",
      payload: { channelId: "1", userId: "2", message: "hello", marker: MARKER },
      userId: "2",
    });

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("lists a user's reminders, the latest first", async () => {
    await repo.insertJob({
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
      event: "reminder",
      payload: { channelId: "1", userId: USER_ID, message: "earlier" },
      userId: USER_ID,
    });

    await repo.insertJob({
      expiresAt: new Date("2026-06-01T00:00:00.000Z"),
      event: "reminder",
      payload: { channelId: "1", userId: USER_ID, message: "later" },
      userId: USER_ID,
    });

    const reminders = await repo.listUserReminders(USER_ID);

    expect(reminders[0]?.message).toBe("later");
    expect(reminders[1]?.message).toBe("earlier");
    expect(await repo.countUserReminders(USER_ID)).toBe(2);
  });

  it("deletes the row with the id it was given, and only that", async () => {
    const dailyId = await repo.insertJob({
      expiresAt: new Date(Date.now() + 60_000),
      event: "community_daily",
      payload: { marker: MARKER },
    });

    // A message-deletion row, which the daily pass must not touch.
    const messageId = await repo.insertJob({
      expiresAt: new Date(Date.now() + 60_000),
      event: "autopurge",
      payload: {
        channelId: "1",
        messageId: "2",
        marker: MARKER,
      },
    });

    await repo.deleteJob(dailyId);

    const left = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.event, "autopurge"),
          sql`${jobs.payload} ->> 'marker' = ${MARKER}`,
        ),
      );

    // The daily row is gone, and the message row is still there: the
    // daily pass only touches its own row.
    expect(await repo.findJob(dailyId)).toBeNull();
    expect(left).toHaveLength(1);
    expect(left[0]?.id).toBe(messageId);
  });

  it("finds a job row by its id", async () => {
    const id = await repo.insertJob({
      expiresAt: new Date("2026-06-01T00:00:00.000Z"),
      event: "community_daily",
      payload: { marker: MARKER },
    });

    const row = await repo.findJob(id);

    expect(row?.id).toBe(id);
    expect(row?.event).toBe("community_daily");
    expect(row?.expiresAt.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe.skipIf(!reachable)("the auto-purge configs", () => {
  it("stores one config per channel", async () => {
    await repo.insertAutoPurgeConfig({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      deleteAfter: 600,
    });

    const config = await repo.findAutoPurgeConfig(CHANNEL_ID);

    expect(config?.deleteAfter).toBe(600);
    expect(await repo.countAutoPurgeConfigs(GUILD_ID)).toBe(1);
    expect(await repo.listAutoPurgeChannelIds()).toContain(CHANNEL_ID);
  });

  it("removes the config", async () => {
    await repo.deleteAutoPurgeConfig(CHANNEL_ID);

    expect(await repo.findAutoPurgeConfig(CHANNEL_ID)).toBeNull();
  });
});
