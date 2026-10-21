/**
 * The daily open job, end to end.
 *
 * The `tourney_open` event exists in the schema, so the arming of the
 * job is no longer a write the database refuses. These tests prove the
 * whole path rather than asserting it:
 *
 *  1. the database accepts a `tourney_open` row — and still refuses one
 *     with an event that is not on the list, so the test would notice if
 *     the constraint had gone away;
 *  2. the **real** dispatcher picks the row up, deletes it and hands the
 *     payload to the area's handler, which opens the tournament and
 *     re-arms itself;
 *  3. the next open is the **next occurrence of the schedule**, not
 *     "24 hours after the job fired" — which is what the source did, and
 *     what drifted by the length of every outage.
 *
 * The Discord half is stubbed: `openTourneyInGuild` needs a guild, and
 * a guild is not what is under test. The stub performs the same state
 * change the real one does — `service.openTourney` — so the tournament
 * really is open afterwards.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Client, Guild } from "discord.js";
import { closeDatabase, db } from "../../db/client.js";
import { jobs, tourneys } from "../../db/schema.js";
import { dispatchJob, registerJobHandler } from "../../handlers/jobs.js";
import * as repo from "./repo.js";
import * as service from "./service.js";
import { handleTourneysJob } from "./register.js";
import { onTourneyOpen } from "./jobs.js";

/** The tournaments the stub was asked to open. */
const opened = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock("./views/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./views/lifecycle.js")>();
  const service = await import("./service.js");

  return {
    ...actual,
    openTourneyInGuild: async (_guild: unknown, tourneyId: string) => {
      opened.ids.push(tourneyId);

      return service.openTourney(tourneyId);
    },
  };
});

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `tourney-jobs-test-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2)}`;

/** The tournaments this test file created. */
const createdTourneyIds: string[] = [];

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
 * The kind of constraint a violation was.
 *
 * Postgres names it with a SQLSTATE (`23514` for a check violation);
 * SQLite names it with an extended result code. This reads whichever the
 * running engine produced, so the assertion says what was violated
 * rather than which engine said it.
 */
function constraintKind(error: unknown): "unique" | "check" | "other" {
  const candidate = error as
    | {
        code?: string;
        extendedCode?: string;
        cause?: { code?: string; extendedCode?: string };
      }
    | undefined;

  const code =
    candidate?.cause?.extendedCode ??
    candidate?.cause?.code ??
    candidate?.extendedCode ??
    candidate?.code;

  if (
    code === "23505" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  ) {
    return "unique";
  }

  if (code === "23514" || code === "SQLITE_CONSTRAINT_CHECK") {
    return "check";
  }

  return "other";
}

/** Creates a tournament with a unique registration channel. */
async function makeTourney(suffix: string): Promise<string> {
  const [tourney] = await db
    .insert(tourneys)
    .values({
      guildId: GUILD_ID,
      name: `Test ${suffix}`,
      registrationChannelId: `${GUILD_ID}-${suffix}-registration`,
      confirmChannelId: `${GUILD_ID}-${suffix}-confirm`,
      roleId: `${GUILD_ID}-${suffix}-role`,
      hostId: "1",
      totalSlots: 16,
    })
    .returning({ id: tourneys.id });

  if (!tourney) throw new Error(`could not create the ${suffix} tournament`);

  createdTourneyIds.push(tourney.id);

  return tourney.id;
}

/** A client that knows about exactly one guild. */
function fakeClient(): Client {
  const guild = { id: GUILD_ID } as unknown as Guild;

  return {
    guilds: {
      cache: {
        get: (id: string) => (id === GUILD_ID ? guild : undefined),
      },
    },
  } as unknown as Client;
}

/** The wall-clock parts of an instant, in the server's zone. */
function istParts(date: Date): {
  readonly weekday: string;
  readonly hour: number;
  readonly minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    weekday: read("weekday").toLowerCase(),
    hour: Number(read("hour")) % 24,
    minute: Number(read("minute")),
  };
}

beforeEach(() => {
  opened.ids.length = 0;
});

afterAll(async () => {
  for (const tourneyId of createdTourneyIds) {
    await db
      .delete(jobs)
      .where(sql`${jobs.payload} ->> 'tourneyId' = ${tourneyId}`);
  }

  if (createdTourneyIds.length > 0) {
    await db.delete(tourneys).where(inArray(tourneys.id, createdTourneyIds));
  }

  await closeDatabase();
});

describe.skipIf(!reachable)("the tourney_open job", () => {
  it("is an event the database accepts", async () => {
    const accepted = await db
      .insert(jobs)
      .values({
        event: "tourney_open",
        expiresAt: new Date(Date.now() + 60_000),
        payload: { tourneyId: "not-a-real-tournament" },
      })
      .then(
        () => true,
        () => false,
      );

    expect(accepted).toBe(true);

    // The control: an event that is not on the list is still refused, so
    // the test would notice if the constraint had gone away.
    const refused = await db
      .insert(jobs)
      .values({
        event: "tourney_openp",
        expiresAt: new Date(Date.now() + 60_000),
        payload: { tourneyId: "not-a-real-tournament" },
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(constraintKind(refused)).toBe("check");

    await db
      .delete(jobs)
      .where(sql`${jobs.payload} ->> 'tourneyId' = 'not-a-real-tournament'`);
  });

  it("is armed for the next occurrence of the schedule", async () => {
    const tourneyId = await makeTourney("armed");

    const at = await service.armOpenJob(tourneyId, {
      openDays: [],
      openTime: "18:00",
    });

    expect(at).not.toBeNull();

    const rows = await repo.listTourneyJobs(repo.TOURNEY_JOB_EVENT, tourneyId);

    expect(rows).toHaveLength(1);

    // 18:00 in the server's zone, whatever the wall clock says now.
    const parts = istParts(rows[0]!.expiresAt);

    expect(parts.hour).toBe(18);
    expect(parts.minute).toBe(0);
  });

  it("reaches the handler and opens the tournament", async () => {
    const tourneyId = await makeTourney("fire");

    await service.armOpenJob(tourneyId, { openDays: [], openTime: "18:00" });

    const armed = await repo.listTourneyJobs(repo.TOURNEY_JOB_EVENT, tourneyId);

    expect(armed).toHaveLength(1);

    const row = armed[0]!;

    // The dispatcher claims a due job by deleting it — a compare-and-delete
    // on `(id, expires_at)`. This is that claim, for this row only.
    const deleted = await db
      .delete(jobs)
      .where(and(eq(jobs.id, row.id), eq(jobs.expiresAt, row.expiresAt)))
      .returning({ id: jobs.id });

    expect(deleted).toHaveLength(1);

    // The dispatcher hands the payload to the handler the manager
    // registered for this area.
    registerJobHandler("tourney_open", handleTourneysJob);

    await dispatchJob(fakeClient(), "tourney_open", row.payload);

    // The handler ran.
    expect(opened.ids).toContain(tourneyId);

    // And the tournament is open, in the database.
    const tourney = await repo.getTourney(tourneyId);

    expect(tourney?.status).toBe("open");

    // The job re-armed itself.
    const rearmed = await repo.listTourneyJobs(repo.TOURNEY_JOB_EVENT, tourneyId);

    expect(rearmed).toHaveLength(1);
  });

  it("re-arms for the schedule, not for 24 hours after the fire", async () => {
    const tourneyId = await makeTourney("down");

    const schedule = { openDays: ["monday"], openTime: "18:00" };

    await service.armOpenJob(tourneyId, schedule);

    const armed = await repo.listTourneyJobs(repo.TOURNEY_JOB_EVENT, tourneyId);

    expect(armed).toHaveLength(1);

    const row = armed[0]!;

    await db
      .delete(jobs)
      .where(and(eq(jobs.id, row.id), eq(jobs.expiresAt, row.expiresAt)));

    // The bot was down for three days: the job fires on a Thursday, long
    // after the Monday it was armed for. 2024-03-14 is a Thursday.
    const fired = new Date("2024-03-14T12:00:00.000Z");

    await onTourneyOpen(row.payload, fakeClient(), fired);

    const rearmed = await repo.listTourneyJobs(repo.TOURNEY_JOB_EVENT, tourneyId);

    expect(rearmed).toHaveLength(1);

    const at = rearmed[0]!.expiresAt;

    // The next Monday, at 18:00 — the next occurrence of the schedule.
    const parts = istParts(at);

    expect(parts.weekday).toBe("monday");
    expect(parts.hour).toBe(18);
    expect(parts.minute).toBe(0);

    // Not "24 hours after the job fired", which is what the source did
    // and what drifted by the length of every outage.
    expect(at.getTime()).not.toBe(fired.getTime() + 86_400_000);
  });

  it("opens on a late fire, and heals the schedule afterwards", async () => {
    const tourneyId = await makeTourney("late");

    const schedule = { openDays: ["monday"], openTime: "18:00" };

    await service.armOpenJob(tourneyId, schedule);

    const armed = await repo.listTourneyJobs(repo.TOURNEY_JOB_EVENT, tourneyId);

    const row = armed[0]!;

    await db
      .delete(jobs)
      .where(and(eq(jobs.id, row.id), eq(jobs.expiresAt, row.expiresAt)));

    // The bot was down for three hours: the job fires at 21:00 on the
    // Monday it was armed for. 2024-03-11 is a Monday.
    const fired = new Date("2024-03-11T15:30:00.000Z");

    await onTourneyOpen(row.payload, fakeClient(), fired);

    // The tournament opens, late, on the day it was scheduled.
    expect(opened.ids).toContain(tourneyId);

    const tourney = await repo.getTourney(tourneyId);

    expect(tourney?.status).toBe("open");

    // And the schedule is back where it belongs: the next Monday at 18:00.
    const rearmed = await repo.listTourneyJobs(repo.TOURNEY_JOB_EVENT, tourneyId);

    expect(rearmed).toHaveLength(1);

    const parts = istParts(rearmed[0]!.expiresAt);

    expect(parts.weekday).toBe("monday");
    expect(parts.hour).toBe(18);
    expect(parts.minute).toBe(0);
  });

  it("stops the schedule when the tournament is gone", async () => {
    const tourneyId = await makeTourney("deleted");

    await service.armOpenJob(tourneyId, { openDays: [], openTime: "18:00" });

    const armed = await repo.listTourneyJobs(repo.TOURNEY_JOB_EVENT, tourneyId);

    const row = armed[0]!;

    await db.delete(tourneys).where(eq(tourneys.id, tourneyId));

    await onTourneyOpen(row.payload, fakeClient(), new Date());

    expect(opened.ids).toHaveLength(0);

    const left = await repo.listTourneyJobs(repo.TOURNEY_JOB_EVENT, tourneyId);

    expect(left).toHaveLength(0);
  });
});
