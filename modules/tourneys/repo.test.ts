/**
 * The tournaments repository, proved against the live database.
 *
 * The properties that matter:
 *
 *  - **one registration channel, one tournament.** The source enforced
 *    this in application code by reading and then writing, which races;
 *    the schema has a unique constraint on
 *    `tourneys.registration_channel_id` and this test proves the
 *    database really refuses the second one;
 *  - the friendly check that runs before the write agrees with the
 *    constraint;
 *  - the published group list keeps the **channel on the row**, so it
 *    never has to be rediscovered by a name substring (D16 / B15);
 *  - the fake-tag check is a typed query, not the source's broken raw
 *    SQL (S6, row 14).
 */

import { afterAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { closeDatabase, db } from "../../db/client.js";
import { tourneyGroupLists, tourneySlots, tourneys } from "../../db/schema.js";
import * as repo from "./repo.js";

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `tourney-repo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The tournaments this test file created. */
const createdTourneyIds: string[] = [];

/** The PostgreSQL SQLSTATE of the error a constraint violation produced. */
function pgErrorCode(error: unknown): string | undefined {
  const candidate = error as
    | { code?: string; cause?: { code?: string } }
    | undefined;

  return candidate?.cause?.code ?? candidate?.code;
}

afterAll(async () => {
  if (createdTourneyIds.length > 0) {
    await db.delete(tourneys).where(inArray(tourneys.id, createdTourneyIds));
  }

  await db
    .delete(tourneyGroupLists)
    .where(sql`${tourneyGroupLists.channelId} like ${`${GUILD_ID}%`}`);

  await closeDatabase();
});

/** Creates a tournament with a unique registration channel. */
async function makeTourney(
  suffix: string,
  registrationChannelId?: string,
): Promise<string> {
  const [tourney] = await db
    .insert(tourneys)
    .values({
      guildId: GUILD_ID,
      name: `Test ${suffix}`,
      registrationChannelId:
        registrationChannelId ?? `${GUILD_ID}-${suffix}-registration`,
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

describe("modules/tourneys/repo — the registration channel", () => {
  it("refuses a second tournament in the same registration channel", async () => {
    const channel = `${GUILD_ID}-shared-registration`;

    await makeTourney("shared-one", channel);

    const error = await db
      .insert(tourneys)
      .values({
        guildId: GUILD_ID,
        name: "Test shared-two",
        registrationChannelId: channel,
        confirmChannelId: `${GUILD_ID}-shared-two-confirm`,
        roleId: `${GUILD_ID}-shared-two-role`,
        hostId: "1",
        totalSlots: 16,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(pgErrorCode(error)).toBe("23505");
  });

  it("says so before the write", async () => {
    const channel = `${GUILD_ID}-checked-registration`;

    const tourneyId = await makeTourney("checked", channel);

    await expect(repo.isRegistrationChannelTaken(channel)).resolves.toBe(true);

    // The tournament that owns the channel may keep it.
    await expect(
      repo.isRegistrationChannelTaken(channel, tourneyId),
    ).resolves.toBe(false);

    await expect(
      repo.isRegistrationChannelTaken(`${GUILD_ID}-never-used`),
    ).resolves.toBe(false);
  });
});

describe("modules/tourneys/repo — the published group list", () => {
  it("keeps the channel on the row", async () => {
    const tourneyId = await makeTourney("group-list");

    const record = await repo.upsertGroupList({
      tourneyId,
      messageId: `${GUILD_ID}-message-1`,
      channelId: `${GUILD_ID}-channel-1`,
      groupNumber: 1,
    });

    expect(record.channelId).toBe(`${GUILD_ID}-channel-1`);

    const found = await repo.getGroupListByMessage(record.messageId);

    expect(found?.channelId).toBe(`${GUILD_ID}-channel-1`);
    expect(found?.groupNumber).toBe(1);
  });

  it("replaces the row when a group is published again", async () => {
    const tourneyId = await makeTourney("group-republish");

    await repo.upsertGroupList({
      tourneyId,
      messageId: `${GUILD_ID}-message-old`,
      channelId: `${GUILD_ID}-channel-old`,
      groupNumber: 2,
    });

    const updated = await repo.upsertGroupList({
      tourneyId,
      messageId: `${GUILD_ID}-message-new`,
      channelId: `${GUILD_ID}-channel-new`,
      groupNumber: 2,
    });

    expect(updated.messageId).toBe(`${GUILD_ID}-message-new`);
    expect(updated.channelId).toBe(`${GUILD_ID}-channel-new`);

    // The old message no longer resolves.
    const old = await repo.getGroupListByMessage(`${GUILD_ID}-message-old`);

    expect(old).toBeNull();
  });

  it("writes the refresh timestamp only when the refresh path runs", async () => {
    const tourneyId = await makeTourney("group-refresh");

    const record = await repo.upsertGroupList({
      tourneyId,
      messageId: `${GUILD_ID}-message-refresh`,
      channelId: `${GUILD_ID}-channel-refresh`,
      groupNumber: 1,
    });

    const before = record.updatedAt.getTime();

    await repo.touchGroupList(record.id, new Date(before + 120_000));

    const after = await repo.getGroupListByMessage(record.messageId);

    expect(after?.updatedAt.getTime()).toBe(before + 120_000);
  });
});

describe("modules/tourneys/repo — the fake-tag check", () => {
  it("finds the slots that already hold a member", async () => {
    const tourneyId = await makeTourney("fake-tag");

    await repo.insertSlot({
      tourneyId,
      teamName: "Team A",
      leaderId: "leader-a",
      members: ["leader-a", "member-a"],
      messageId: null,
      jumpUrl: null,
      confirmJumpUrl: null,
    });

    await repo.insertSlot({
      tourneyId,
      teamName: "Team B",
      leaderId: "leader-b",
      members: ["leader-b"],
      messageId: null,
      jumpUrl: null,
      confirmJumpUrl: null,
    });

    const matches = await repo.findFakeTagMatches(tourneyId, ["member-a"]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.teamName).toBe("Team A");

    const none = await repo.findFakeTagMatches(tourneyId, ["nobody"]);

    expect(none).toHaveLength(0);
  });

  it("does not reach across tournaments", async () => {
    const first = await makeTourney("fake-tag-a");
    const second = await makeTourney("fake-tag-b");

    await repo.insertSlot({
      tourneyId: first,
      teamName: "Team A",
      leaderId: "leader-a",
      members: ["leader-a"],
      messageId: null,
      jumpUrl: null,
      confirmJumpUrl: null,
    });

    const matches = await repo.findFakeTagMatches(second, ["leader-a"]);

    expect(matches).toHaveLength(0);
  });
});

describe("modules/tourneys/repo — the slots", () => {
  it("finds a slot by the message that produced it", async () => {
    const tourneyId = await makeTourney("slot-by-message");

    const slot = await repo.insertSlot({
      tourneyId,
      teamName: "Team A",
      leaderId: "leader-a",
      members: ["leader-a"],
      messageId: `${GUILD_ID}-registration-message`,
      jumpUrl: null,
      confirmJumpUrl: null,
    });

    const found = await repo.getSlotByMessage(
      tourneyId,
      `${GUILD_ID}-registration-message`,
    );

    expect(found?.id).toBe(slot.id);
  });

  it("finds the slots of a user, by leadership or membership", async () => {
    const tourneyId = await makeTourney("slot-of-user");

    await repo.insertSlot({
      tourneyId,
      teamName: "Team A",
      leaderId: "leader-a",
      members: ["leader-a", "member-a"],
      messageId: null,
      jumpUrl: null,
      confirmJumpUrl: null,
    });

    await repo.insertSlot({
      tourneyId,
      teamName: "Team B",
      leaderId: "leader-b",
      members: ["leader-b"],
      messageId: null,
      jumpUrl: null,
      confirmJumpUrl: null,
    });

    const asLeader = await repo.listSlotsOfUser(tourneyId, "leader-a");
    const asMember = await repo.listSlotsOfUser(tourneyId, "member-a");
    const nobody = await repo.listSlotsOfUser(tourneyId, "nobody");

    expect(asLeader).toHaveLength(1);
    expect(asMember).toHaveLength(1);
    expect(nobody).toHaveLength(0);
  });

  it("deletes a slot", async () => {
    const tourneyId = await makeTourney("slot-delete");

    const slot = await repo.insertSlot({
      tourneyId,
      teamName: "Team A",
      leaderId: "leader-a",
      members: ["leader-a"],
      messageId: null,
      jumpUrl: null,
      confirmJumpUrl: null,
    });

    await repo.deleteSlot(slot.id);

    const found = await repo.getSlot(slot.id);

    expect(found).toBeNull();
  });
});

describe("modules/tourneys/repo — the bans", () => {
  it("bans idempotently", async () => {
    const tourneyId = await makeTourney("ban");

    await repo.banUser(tourneyId, "user-1");
    await repo.banUser(tourneyId, "user-1");

    const banned = await repo.listBannedUserIds(tourneyId);

    expect(banned).toEqual(["user-1"]);

    await repo.unbanUser(tourneyId, "user-1");

    expect(await repo.listBannedUserIds(tourneyId)).toEqual([]);
  });
});

describe("modules/tourneys/repo — the tourney lifecycle", () => {
  it("starts as a draft", async () => {
    const tourneyId = await makeTourney("lifecycle");

    const tourney = await repo.getTourney(tourneyId);

    expect(tourney?.status).toBe("draft");
    expect(tourney?.startedAt).toBeNull();
    expect(tourney?.closedAt).toBeNull();
  });

  it("writes only the field it was given", async () => {
    const tourneyId = await makeTourney("one-field");

    const before = await repo.getTourney(tourneyId);

    await repo.updateTourney(tourneyId, { name: "Renamed" });

    const after = await repo.getTourney(tourneyId);

    expect(after?.name).toBe("Renamed");
    // The source's editor rebuilt the whole model on every interaction;
    // this one left everything else alone.
    expect(after?.totalSlots).toBe(before?.totalSlots);
    expect(after?.requiredMentions).toBe(before?.requiredMentions);
    expect(after?.emojis).toEqual(before?.emojis);
  });

  it("refuses a status outside the closed union", async () => {
    const tourneyId = await makeTourney("bad-status");

    const error = await db
      .update(tourneys)
      .set({ status: "wat" })
      .where(sql`${tourneys.id} = ${tourneyId}`)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(pgErrorCode(error)).toBe("23514");
  });
});

describe("modules/tourneys/repo — the slots table", () => {
  it("refuses two slots on the same number in one tournament", async () => {
    const tourneyId = await makeTourney("unique-num");

    await db
      .insert(tourneySlots)
      .values({ tourneyId, num: 1, teamName: "Team A", leaderId: "1" });

    const error = await db
      .insert(tourneySlots)
      .values({ tourneyId, num: 1, teamName: "Team B", leaderId: "2" })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(pgErrorCode(error)).toBe("23505");
  });

  it("allows the same number in two tournaments", async () => {
    const first = await makeTourney("num-a");
    const second = await makeTourney("num-b");

    await db
      .insert(tourneySlots)
      .values({ tourneyId: first, num: 1, teamName: "Team A", leaderId: "1" });

    await db
      .insert(tourneySlots)
      .values({ tourneyId: second, num: 1, teamName: "Team B", leaderId: "2" });

    const rows = await db
      .select()
      .from(tourneySlots)
      .where(sql`${tourneySlots.tourneyId} in (${first}, ${second})`);

    expect(rows).toHaveLength(2);
  });
});
