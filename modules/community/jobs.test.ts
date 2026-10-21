/**
 * The job handlers.
 *
 * The dispatcher deletes the row before it dispatches it, so a handler
 * that fires twice cannot do its work twice. These tests are about the
 * part that is the area's own: which event is which, what the payloads
 * say, and that the daily pass is a **row in the database** rather than
 * a timer.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Client } from "discord.js";
import { closeDatabase, db } from "../../db/client.js";
import { jobs } from "../../db/schema.js";
import * as repo from "./repo.js";
import {
  COMMUNITY_JOB_EVENTS,
  DAILY_INTERVAL_MS,
  DAILY_JOB_ID,
  ensureDailyJob,
  handleCommunityJobEvent,
  parseAutoPurgePayload,
  parseReminderPayload,
  rearmDailyJob,
} from "./jobs.js";

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
 * A client the handlers in this file never touch.
 *
 * The daily pass does not talk to Discord, and the auto-purge handler
 * refuses a payload it cannot read before it goes near the client.
 */
const stubClient = {} as unknown as Client;

beforeAll(async () => {
  if (!reachable) return;

  await repo.deleteJob(DAILY_JOB_ID);
});

afterAll(async () => {
  if (reachable) {
    // The daily row is **left armed for tomorrow**: deleting it would
    // take the running bot's daily job away until its next restart.
    await rearmDailyJob();
  }

  await closeDatabase();
});

describe("the job payloads", () => {
  it("reads a message deletion", () => {
    expect(parseAutoPurgePayload({ channelId: "1", messageId: "2" })).toEqual({
      channelId: "1",
      messageId: "2",
    });
  });

  it("refuses a message deletion it cannot read", () => {
    expect(parseAutoPurgePayload({ channelId: "1" })).toBeNull();
    expect(parseAutoPurgePayload({ kind: "daily" })).toBeNull();
    expect(parseAutoPurgePayload(null)).toBeNull();
  });

  it("reads a reminder", () => {
    expect(
      parseReminderPayload({
        channelId: "1",
        userId: "2",
        message: "unmute someone",
        reminderId: "abc",
      }),
    ).toEqual({
      channelId: "1",
      userId: "2",
      message: "unmute someone",
      reminderId: "abc",
    });
  });

  it("refuses a reminder it cannot read", () => {
    expect(parseReminderPayload({ channelId: "1" })).toBeNull();
    expect(parseReminderPayload("nope")).toBeNull();
  });
});

describe("the event names", () => {
  it("gives the daily sweep an event of its own", () => {
    expect(COMMUNITY_JOB_EVENTS).toContain("community_daily");
    expect(COMMUNITY_JOB_EVENTS).toContain("autopurge");
    expect(COMMUNITY_JOB_EVENTS).toContain("reminder");
  });

  it("does not make the auto-purge event mean two things", async () => {
    // The event says which work it is. The payload does not.
    const handled = await handleCommunityJobEvent(stubClient, "autopurge", {
      kind: "daily",
    });

    expect(handled).toBe(true);
  });

  it("ignores an event it does not own", async () => {
    const handled = await handleCommunityJobEvent(stubClient, "vote", {});

    expect(handled).toBe(false);
  });
});

describe.skipIf(!reachable)("the daily job", () => {
  it("is armed at startup", async () => {
    await ensureDailyJob();

    const row = await repo.findJob(DAILY_JOB_ID);

    expect(row?.event).toBe("community_daily");
  });

  it("is a row in the jobs table, not a timer", async () => {
    await rearmDailyJob(new Date("2026-01-01T00:00:00.000Z"));

    const rows = await db
      .select({ event: jobs.event, expiresAt: jobs.expiresAt })
      .from(jobs)
      .where(eq(jobs.id, DAILY_JOB_ID));

    // The row is in the table, which is what survives a restart.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe("community_daily");
    expect(rows[0]?.expiresAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("re-arms itself, a day later", async () => {
    const first = new Date("2026-01-01T00:00:00.000Z");

    await rearmDailyJob(first);

    const armed = await repo.findJob(DAILY_JOB_ID);

    expect(armed?.expiresAt.getTime()).toBe(
      first.getTime() + DAILY_INTERVAL_MS,
    );
  });

  it("replaces the row rather than adding one", async () => {
    const first = new Date("2026-01-01T00:00:00.000Z");
    const second = new Date("2026-02-01T00:00:00.000Z");

    await rearmDailyJob(first);
    await rearmDailyJob(second);

    const rows = await db
      .select({ id: jobs.id, expiresAt: jobs.expiresAt })
      .from(jobs)
      .where(eq(jobs.id, DAILY_JOB_ID));

    // One row, due a day after the last re-arm: the pass cannot end up
    // running twice a day.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiresAt.getTime()).toBe(
      second.getTime() + DAILY_INTERVAL_MS,
    );
  });

  it("runs the sweep under its own event, and arms the next run", async () => {
    await rearmDailyJob(new Date("2026-01-01T00:00:00.000Z"));

    const handled = await handleCommunityJobEvent(
      stubClient,
      "community_daily",
      {},
    );

    expect(handled).toBe(true);

    const after = await repo.findJob(DAILY_JOB_ID);

    expect(after?.event).toBe("community_daily");
    // The next run is due tomorrow, not in January.
    expect(after?.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 23 * 60 * 60 * 1000,
    );
  });

  it("does not run the sweep under the auto-purge event", async () => {
    await rearmDailyJob(new Date("2026-01-01T00:00:00.000Z"));

    await handleCommunityJobEvent(stubClient, "autopurge", { kind: "daily" });

    // The pass did not run, so the row it would have armed is untouched.
    const row = await repo.findJob(DAILY_JOB_ID);

    expect(row?.expiresAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });
});
