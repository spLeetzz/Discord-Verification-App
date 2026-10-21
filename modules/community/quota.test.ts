/**
 * The member allowances.
 *
 * A tag is a row in the `tags` table and a reminder is a row in the
 * `jobs` table, and nothing removed either of them by itself: a member
 * could put on the order of ten thousand rows a day, and every one of
 * them was scanned past by the dispatcher on every poll.
 *
 * The rule is in `rules.ts` and is pure, so it is checked on its own
 * here. The enforcement is in `service.ts` and needs the database, so
 * those tests are skipped when there is no Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDatabase, db } from "../../db/client.js";
import { tags } from "../../db/schema.js";
import * as repo from "./repo.js";
import * as service from "./service.js";
import { MAX_REMINDERS_PER_MEMBER, MAX_TAGS_PER_MEMBER } from "./rules.js";

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `community-quota-test-${Date.now()}`;

/** The member who owns the tags and the reminders. */
const OWNER = `555555555555555${String(Date.now()).slice(-4)}`;

/** Another member, who owns nothing. */
const OTHER = `666666666666666${String(Date.now()).slice(-4)}`;

/** The reminders this run created, so they can be cleaned up. */
const reminderIds: string[] = [];

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

  await db.delete(tags).where(eq(tags.guildId, GUILD_ID));
});

afterAll(async () => {
  if (reachable) {
    await db.delete(tags).where(eq(tags.guildId, GUILD_ID));

    for (const id of reminderIds) {
      await repo.deleteJob(id);
    }
  }

  await closeDatabase();
});

describe.skipIf(!reachable)("the tag allowance", () => {
  it("refuses the tag past the allowance", async () => {
    for (let index = 0; index < MAX_TAGS_PER_MEMBER; index += 1) {
      await service.createTag({
        guildId: GUILD_ID,
        name: `tag-${index}`,
        content: "Something.",
        isEmbed: false,
        ownerId: OWNER,
      });
    }

    await expect(
      service.createTag({
        guildId: GUILD_ID,
        name: "one-too-many",
        content: "Something.",
        isEmbed: false,
        ownerId: OWNER,
      }),
    ).rejects.toThrow(/at most 25 tags/i);
  });

  it("counts only the member's own tags", async () => {
    // Another member is not at the allowance, even though the guild is
    // full of somebody else's tags.
    const tag = await service.createTag({
      guildId: GUILD_ID,
      name: "somebody-elses",
      content: "Something.",
      isEmbed: false,
      ownerId: OTHER,
    });

    expect(tag.ownerId).toBe(OTHER);
  });

  it("lets a member at the allowance delete their own tag", async () => {
    const deleted = await service.deleteTag({
      guildId: GUILD_ID,
      name: "tag-0",
      callerId: OWNER,
      canManage: false,
    });

    expect(deleted.name).toBe("tag-0");

    // And there is room for another one now.
    const tag = await service.createTag({
      guildId: GUILD_ID,
      name: "after-the-delete",
      content: "Something.",
      isEmbed: false,
      ownerId: OWNER,
    });

    expect(tag.name).toBe("after-the-delete");
  });
});

describe.skipIf(!reachable)("the reminder allowance", () => {
  it("refuses the reminder past the allowance", async () => {
    const dueAt = new Date(Date.now() + 60 * 60 * 1000);

    for (let index = 0; index < MAX_REMINDERS_PER_MEMBER; index += 1) {
      reminderIds.push(
        await service.createReminder({
          guildId: GUILD_ID,
          channelId: "channel-1",
          userId: OWNER,
          message: "Something.",
          dueAt,
        }),
      );
    }

    await expect(
      service.createReminder({
        guildId: GUILD_ID,
        channelId: "channel-1",
        userId: OWNER,
        message: "Something.",
        dueAt,
      }),
    ).rejects.toThrow(/at most 25 reminders/i);
  });

  it("lets a member at the allowance delete their own reminder", async () => {
    const id = reminderIds[0] ?? "";

    expect(await service.deleteReminder({ id, userId: OWNER })).toBe(true);

    // And there is room for another one now.
    const newId = await service.createReminder({
      guildId: GUILD_ID,
      channelId: "channel-1",
      userId: OWNER,
      message: "Something.",
      dueAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    reminderIds.push(newId);

    expect(newId).not.toBe("");
  });

  it("will not delete somebody else's reminder", async () => {
    const id = reminderIds[1] ?? "";

    expect(await service.deleteReminder({ id, userId: OTHER })).toBe(false);
  });

  it("deletes every reminder of a member at once", async () => {
    const count = await service.deleteReminders(OWNER);

    expect(count).toBeGreaterThan(0);
    expect(await service.countReminders(OWNER)).toBe(0);
  });
});
