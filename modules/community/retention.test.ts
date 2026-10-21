/**
 * The retention: what the area keeps, and what it prunes.
 *
 * Two things used to grow for ever:
 *
 *  - the **tags**. A tag is a row nobody removed, so a member could
 *    leave thousands of them behind. The allowance in `rules.ts` bounds
 *    how many a member may have *at once*; the prune in the daily pass
 *    bounds how many the table keeps over the months.
 *  - the **reminders**. A reminder is a row in the `jobs` table, and the
 *    dispatcher deletes that row *before* it hands the payload over
 *    (`handlers/jobs.ts`), so a reminder that has fired leaves nothing
 *    behind. That is the dispatcher's half of the contract and this file
 *    proves the area's half: the count follows the row.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Client } from "discord.js";
import { closeDatabase, db } from "../../db/client.js";
import { tags } from "../../db/schema.js";
import { onReminder } from "./jobs.js";
import * as repo from "./repo.js";
import * as service from "./service.js";

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `community-retention-test-${Date.now()}`;

/** The member the rows belong to. */
const OWNER = `88888888888888${String(Date.now()).slice(-4)}`;

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

/**
 * A client with no channels.
 *
 * The reminder is dropped when its channel is gone, which is the path
 * this file wants: the row is claimed by the dispatcher, and the handler
 * finds nothing to post to.
 */
const stubClient = {
  channels: {
    cache: new Map(),
    fetch: async () => {
      throw new Error("The channel is gone.");
    },
  },
} as unknown as Client;

beforeAll(async () => {
  if (!reachable) return;

  await db.delete(tags).where(eq(tags.guildId, GUILD_ID));
});

afterAll(async () => {
  if (reachable) {
    await db.delete(tags).where(eq(tags.guildId, GUILD_ID));

    await db.execute(
      sql`delete from jobs where user_id = ${OWNER} and event = 'reminder'`,
    );
  }

  await closeDatabase();
});

describe.skipIf(!reachable)("the tag prune", () => {
  it("removes a tag that was never used and has not been touched", async () => {
    const tag = await service.createTag({
      guildId: GUILD_ID,
      name: "unused",
      content: "Something.",
      isEmbed: false,
      ownerId: OWNER,
    });

    // Backdate it: a tag somebody made once and forgot about.
    await db
      .update(tags)
      .set({ updatedAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(tags.id, tag.id));

    const removed = await service.pruneUnusedTags(1);

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await service.findTag(GUILD_ID, "unused")).toBeNull();
  });

  it("keeps a tag that has been used", async () => {
    const tag = await service.createTag({
      guildId: GUILD_ID,
      name: "used",
      content: "Something.",
      isEmbed: false,
      ownerId: OWNER,
    });

    await service.countTagUse(GUILD_ID, "used");

    await db
      .update(tags)
      .set({ updatedAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(tags.id, tag.id));

    await service.pruneUnusedTags(1);

    // The usage counter is what keeps a tag alive.
    expect(await service.findTag(GUILD_ID, "used")).not.toBeNull();
  });

  it("keeps a tag that has been touched lately", async () => {
    const tag = await service.createTag({
      guildId: GUILD_ID,
      name: "edited",
      content: "Something.",
      isEmbed: false,
      ownerId: OWNER,
    });

    await db
      .update(tags)
      .set({ updatedAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(tags.id, tag.id));

    // The edit bumps `updated_at`, so the tag is not "untouched" any
    // more, even though nobody has used it.
    await service.editTag({
      guildId: GUILD_ID,
      name: "edited",
      content: "Something else.",
      isEmbed: false,
      callerId: OWNER,
      canManage: false,
    });

    await service.pruneUnusedTags(1);

    expect(await service.findTag(GUILD_ID, "edited")).not.toBeNull();
  });
});

describe.skipIf(!reachable)("the reminder rows", () => {
  it("leaves nothing behind once the reminder has fired", async () => {
    const id = await service.createReminder({
      guildId: GUILD_ID,
      channelId: "channel-1",
      userId: OWNER,
      message: "Something.",
      dueAt: new Date(Date.now() + 60_000),
    });

    expect(await service.countReminders(OWNER)).toBe(1);

    // The dispatcher claims a job by deleting its row and only then
    // hands the payload to the handler, so a fired reminder leaves no
    // row behind.
    await repo.deleteJob(id);

    await onReminder(stubClient, {
      channelId: "channel-1",
      userId: OWNER,
      message: "Something.",
      reminderId: id,
    });

    expect(await service.countReminders(OWNER)).toBe(0);
  });
});
