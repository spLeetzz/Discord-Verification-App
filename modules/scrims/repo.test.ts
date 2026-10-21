/**
 * The scrims area against the live database.
 *
 * These are not unit tests with a mocked database. They write to the
 * database the bot talks to and assert the things the port actually
 * promises:
 *
 *  - **the claim is one conditional `UPDATE`** — two claims for one
 *    slot, one winner, one loser that updates nothing. This is the
 *    single highest-value behaviour in the port: it replaces a
 *    process-global lock that died with the process, and it is what
 *    makes two users owning one slot impossible;
 *  - **the team of a slot is a join table** — the claim writes the
 *    claimer and the teammates, and the list is replaced, not merged,
 *    when the team changes;
 *  - **the fake-tag check is a join** — it finds a player who is
 *    already on another slot of the scrim, it does not fire for a
 *    player who is not, and a slot is never a fake tag of itself;
 *  - **the open days and the autoclean kinds round-trip** — they are
 *    join tables now, and the domain type still says "a list of days"
 *    and "a list of kinds".
 *
 * The fixtures use ids no real row can have, and they are deleted
 * afterwards.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, db } from "../../db/client.js";
import {
  scrimAutoclean,
  scrimOpenDays,
  scrims,
  slotMembers,
  slots,
} from "../../db/schema.js";
import {
  changeSlotTeam,
  claimSlot,
  createScrim,
  deleteScrimJobs,
  findFakeTagMatches,
  getScrim,
  getSlot,
  listReservedSlots,
  listScrimJobs,
  releaseSlot,
  replaceScrimJob,
  reserveSlot,
  scheduleJob,
  setSlotState,
  updateScrim,
} from "./repo.js";

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `scrims-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const OWNER = "111111111111111111";
const TEAMMATE = "222222222222222222";
const OTHER = "333333333333333333";
const STRANGER = "444444444444444444";

/** The scrim the fixtures live on. */
let scrimId = "";

/** Creates the fixture scrim and its slots. */
async function seed(): Promise<void> {
  const rows = await db
    .insert(scrims)
    .values({
      guildId: GUILD_ID,
      name: "Scrims test scrim",
      status: "open",
      registrationChannelId: `${GUILD_ID}-registration`,
      slotlistChannelId: `${GUILD_ID}-slotlist`,
      roleId: `${GUILD_ID}-role`,
      openTime: new Date(),
      totalSlots: 3,
      startFrom: 1,
      hostId: `${GUILD_ID}-host`,
    })
    .returning({ id: scrims.id });

  scrimId = rows[0]?.id ?? "";

  await db.insert(slots).values([
    { scrimId, num: 1 },
    { scrimId, num: 2 },
    { scrimId, num: 3 },
  ]);
}

/** Removes every fixture. */
async function clean(): Promise<void> {
  if (!scrimId) return;

  // The slots and their members cascade with the scrim, but the delete
  // is explicit so the test does not depend on the cascade.
  await db.delete(slots).where(eq(slots.scrimId, scrimId));
  await db.delete(scrims).where(eq(scrims.id, scrimId));
}

beforeEach(async () => {
  await clean();
  await seed();
});

afterAll(async () => {
  await clean();
  await db.delete(scrims).where(eq(scrims.guildId, GUILD_ID));

  await closeDatabase();
});

describe("the claim", () => {
  it("gives the slot to one claimant and to nobody else", async () => {
    const first = await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER, TEAMMATE],
      messageId: null,
      jumpUrl: null,
    });

    expect(first).not.toBeNull();
    expect(first?.state).toBe("claimed");
    expect(first?.ownerUserId).toBe(OWNER);

    // The second claim for the same slot: the conditional `UPDATE`
    // matches no row, because the row is no longer free. This is the
    // invariant Quotient's asyncio.Lock used to protect — and the lock
    // did not survive a restart.
    const second = await claimSlot(scrimId, 1, {
      teamName: "Team Bravo",
      ownerUserId: OTHER,
      members: [OTHER],
      messageId: null,
      jumpUrl: null,
    });

    expect(second).toBeNull();

    // The slot still belongs to the first claimant.
    const stored = await getSlot(first?.id ?? "");

    expect(stored?.state).toBe("claimed");
    expect(stored?.teamName).toBe("Team Alpha");
    expect(stored?.ownerUserId).toBe(OWNER);
    expect(stored?.members).toEqual([OWNER, TEAMMATE]);
  });

  it("lets exactly one of two simultaneous claims win", async () => {
    const [alpha, bravo] = await Promise.all([
      claimSlot(scrimId, 1, {
        teamName: "Team Alpha",
        ownerUserId: OWNER,
        members: [OWNER],
        messageId: null,
        jumpUrl: null,
      }),
      claimSlot(scrimId, 1, {
        teamName: "Team Bravo",
        ownerUserId: OTHER,
        members: [OTHER],
        messageId: null,
        jumpUrl: null,
      }),
    ]);

    const winners = [alpha, bravo].filter((slot) => slot !== null);

    expect(winners).toHaveLength(1);
  });

  it("records every mentioned teammate", async () => {
    const claimed = await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER, TEAMMATE, OTHER],
      messageId: null,
      jumpUrl: null,
    });

    // The team is a join table now: one row per member.
    const rows = await db
      .select({ userId: slotMembers.userId })
      .from(slotMembers)
      .where(eq(slotMembers.slotId, claimed?.id ?? ""));

    expect(rows.map((row) => row.userId).sort()).toEqual(
      [OWNER, TEAMMATE, OTHER].sort(),
    );

    const stored = await getSlot(claimed?.id ?? "");

    expect([...(stored?.members ?? [])].sort()).toEqual(
      [OWNER, TEAMMATE, OTHER].sort(),
    );
  });

  it("writes the members only after the slot is won", async () => {
    // A claim that loses the race writes nothing at all — not even a
    // member row for a slot somebody else owns.
    await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER],
      messageId: null,
      jumpUrl: null,
    });

    const loser = await claimSlot(scrimId, 1, {
      teamName: "Team Bravo",
      ownerUserId: OTHER,
      members: [OTHER, STRANGER],
      messageId: null,
      jumpUrl: null,
    });

    expect(loser).toBeNull();

    const rows = await db
      .select({ userId: slotMembers.userId })
      .from(slotMembers)
      .where(eq(slotMembers.slotId, (await getSlotByNum(1)) ?? ""));

    expect(rows.map((row) => row.userId)).toEqual([OWNER]);
  });

  it("replaces the team when the team changes", async () => {
    const claimed = await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER, TEAMMATE],
      messageId: null,
      jumpUrl: null,
    });

    const changed = await changeSlotTeam(claimed?.id ?? "", {
      teamName: "Team Bravo",
      ownerUserId: OTHER,
      members: [OTHER],
    });

    expect(changed?.teamName).toBe("Team Bravo");
    expect(changed?.ownerUserId).toBe(OTHER);
    expect(changed?.members).toEqual([OTHER]);

    const stored = await getSlot(claimed?.id ?? "");

    // The old team is gone: the list is replaced, not merged.
    expect(stored?.members).toEqual([OTHER]);
  });

  it("empties the team when the slot is released", async () => {
    const claimed = await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER, TEAMMATE],
      messageId: null,
      jumpUrl: null,
    });

    const released = await releaseSlot(claimed?.id ?? "", OWNER);

    expect(released?.state).toBe("free");
    expect(released?.members).toEqual([]);

    const rows = await db
      .select({ userId: slotMembers.userId })
      .from(slotMembers)
      .where(eq(slotMembers.slotId, claimed?.id ?? ""));

    expect(rows).toHaveLength(0);
  });

  it("lets a moderator move a slot to another state", async () => {
    const claimed = await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER, TEAMMATE],
      messageId: null,
      jumpUrl: null,
    });

    const locked = await setSlotState(claimed?.id ?? "", "locked");

    expect(locked?.state).toBe("locked");
    expect(locked?.members).toEqual([OWNER, TEAMMATE]);
  });
});

describe("the fake-tag check", () => {
  it("finds a player who is already on another slot of the scrim", async () => {
    await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER, TEAMMATE],
      messageId: null,
      jumpUrl: null,
    });

    const matches = await findFakeTagMatches(scrimId, [TEAMMATE]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.num).toBe(1);
  });

  it("does not fire for a player who is on no slot", async () => {
    await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER, TEAMMATE],
      messageId: null,
      jumpUrl: null,
    });

    const matches = await findFakeTagMatches(scrimId, [STRANGER]);

    expect(matches).toHaveLength(0);
  });

  it("does not fire for a player who is only on a slot that is not claimed", async () => {
    // The members of a free slot are nobody's team yet: the slot is not
    // claimed, so it does not count as a registration.
    const free = await getSlotByNum(2);

    await setSlotState(free, "free", { members: [STRANGER] });

    const matches = await findFakeTagMatches(scrimId, [STRANGER]);

    expect(matches).toHaveLength(0);
  });

  it("excludes the slot being checked", async () => {
    const claimed = await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER, TEAMMATE],
      messageId: null,
      jumpUrl: null,
    });

    const matches = await findFakeTagMatches(scrimId, [TEAMMATE], claimed?.id ?? "");

    expect(matches).toHaveLength(0);
  });

  it("finds a player on a slot of another scrim only when it is the same scrim", async () => {
    const other = await db
      .insert(scrims)
      .values({
        guildId: GUILD_ID,
        registrationChannelId: `${GUILD_ID}-other-registration`,
        slotlistChannelId: `${GUILD_ID}-other-slotlist`,
        hostId: `${GUILD_ID}-host`,
        openTime: new Date(),
        totalSlots: 1,
        startFrom: 1,
      })
      .returning({ id: scrims.id });

    const otherScrimId = other[0]?.id ?? "";

    await db.insert(slots).values({ scrimId: otherScrimId, num: 1 });

    await claimSlot(otherScrimId, 1, {
      teamName: "Team Charlie",
      ownerUserId: STRANGER,
      members: [STRANGER],
      messageId: null,
      jumpUrl: null,
    });

    // The player is on a slot of another scrim: not a fake tag here.
    expect(await findFakeTagMatches(scrimId, [STRANGER])).toHaveLength(0);

    // The same player on this scrim: a fake tag.
    expect(await findFakeTagMatches(otherScrimId, [STRANGER])).toHaveLength(1);

    await db.delete(slots).where(eq(slots.scrimId, otherScrimId));
    await db.delete(scrims).where(eq(scrims.id, otherScrimId));
  });
});

describe("the open days and the autoclean kinds", () => {
  it("round-trips through the join tables", async () => {
    const created = await createScrim({
      guildId: GUILD_ID,
      hostId: `${GUILD_ID}-host`,
      name: "Scrim with lists",
      registrationChannelId: `${GUILD_ID}-lists-registration`,
      slotlistChannelId: `${GUILD_ID}-lists-slotlist`,
      roleId: null,
      requiredMentions: 4,
      totalSlots: 2,
      openTime: new Date(),
      startFrom: 1,
      openDays: ["monday", "friday"],
      autoclean: ["channel", "role"],
      autocleanTime: null,
      emojis: { tick: "✅", cross: "❌" },
      openMessage: {},
      closeMessage: {},
      slotlistFormat: {},
    });

    const scrim = await getScrim(created);

    expect(scrim?.openDays.sort()).toEqual(["friday", "monday"]);
    expect(scrim?.autoclean.sort()).toEqual(["channel", "role"]);

    // They are rows, not columns.
    const days = await db
      .select({ day: scrimOpenDays.day })
      .from(scrimOpenDays)
      .where(eq(scrimOpenDays.scrimId, created));

    expect(days.map((row) => row.day).sort()).toEqual(["friday", "monday"]);

    const kinds = await db
      .select({ kind: scrimAutoclean.kind })
      .from(scrimAutoclean)
      .where(eq(scrimAutoclean.scrimId, created));

    expect(kinds.map((row) => row.kind).sort()).toEqual(["channel", "role"]);

    await db.delete(slots).where(eq(slots.scrimId, created));
    await db.delete(scrims).where(eq(scrims.id, created));
  });

  it("is replaced when the scrim is edited", async () => {
    const updated = await updateScrim(scrimId, {
      openDays: ["saturday", "sunday"],
      autoclean: ["role"],
    });

    expect(updated?.openDays.sort()).toEqual(["saturday", "sunday"]);
    expect(updated?.autoclean).toEqual(["role"]);

    // The old rows are gone: the list is replaced, not merged.
    const days = await db
      .select({ day: scrimOpenDays.day })
      .from(scrimOpenDays)
      .where(eq(scrimOpenDays.scrimId, scrimId));

    expect(days.map((row) => row.day).sort()).toEqual(["saturday", "sunday"]);

    const kinds = await db
      .select({ kind: scrimAutoclean.kind })
      .from(scrimAutoclean)
      .where(eq(scrimAutoclean.scrimId, scrimId));

    expect(kinds.map((row) => row.kind)).toEqual(["role"]);
  });

  it("is empty when the scrim has no restriction", async () => {
    const updated = await updateScrim(scrimId, { openDays: [], autoclean: [] });

    expect(updated?.openDays).toEqual([]);
    expect(updated?.autoclean).toEqual([]);
  });
});

describe("the reserved slots", () => {
  it("keeps the team of a reservation", async () => {
    const reserved = await reserveSlot({
      scrimId,
      num: 1,
      userId: OWNER,
      teamName: "Team Alpha",
      members: [OWNER, TEAMMATE],
      expires: null,
    });

    expect(reserved?.members).toEqual([OWNER, TEAMMATE]);

    const stored = await listReservedSlots(scrimId);

    expect(stored[0]?.members).toEqual([OWNER, TEAMMATE]);
  });
});

describe("the durable jobs", () => {
  it("finds the job of one scrim and no other", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);

    const id = await scheduleJob("scrim_open", expiresAt, { scrimId });

    const found = await listScrimJobs("scrim_open", scrimId);

    expect(found.map((job) => job.id)).toEqual([id]);

    // A job about another scrim is not found.
    const other = await listScrimJobs("scrim_open", `${GUILD_ID}-other`);

    expect(other).toHaveLength(0);

    await deleteScrimJobs("scrim_open", scrimId);

    expect(await listScrimJobs("scrim_open", scrimId)).toHaveLength(0);
  });

  it("leaves one job behind when the schedule is replaced", async () => {
    const first = new Date(Date.now() + 3_600_000);
    const second = new Date(Date.now() + 7_200_000);

    await replaceScrimJob("scrim_open", scrimId, first);
    await replaceScrimJob("scrim_open", scrimId, second);

    const found = await listScrimJobs("scrim_open", scrimId);

    expect(found).toHaveLength(1);
    expect(found[0]?.expiresAt.getTime()).toBe(second.getTime());

    await deleteScrimJobs("scrim_open", scrimId);
  });
});

/** The id of the slot with a given number, or an empty string. */
async function getSlotByNum(num: number): Promise<string> {
  const rows = await db
    .select({ id: slots.id })
    .from(slots)
    .where(and(eq(slots.scrimId, scrimId), eq(slots.num, num)))
    .limit(1);

  return rows[0]?.id ?? "";
}
