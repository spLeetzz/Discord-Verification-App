/**
 * The claim, proved against the live database.
 *
 * The claim is the highest-value change in the whole port: it replaces
 * a process-global lock that died with the process — and did not survive
 * a second bot process — with one conditional `UPDATE` the database
 * enforces.
 *
 * These tests are not unit tests with a mocked database. They connect to
 * the Postgres the bot talks to and assert the things the port
 * actually promises:
 *
 *  - the statement the database receives is the conditional `UPDATE`
 *    from S7, and not a read-then-write;
 *  - a free slot can be claimed;
 *  - **a slot that is already taken cannot be claimed again** — the
 *    second claim updates nothing;
 *  - the member list is persisted, so the ID-Pass transfer has a
 *    teammate to find;
 *  - only the owner may release a slot.
 *
 * The fixtures use ids no real row can have, and they are deleted
 * afterwards.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDatabase, db } from "../../db/client.js";
import { scrims, slots } from "../../db/schema.js";
import {
  buildClaimStatement,
  buildReleaseStatement,
  claimSlot,
  countUserSlotsInScrim,
  getSlot,
  releaseSlot,
  setScrimSlotlistMessage,
} from "./repo.js";

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `slots-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const OWNER = "111111111111111111";
const TEAMMATE = "222222222222222222";
const OTHER = "333333333333333333";

/** The scrim the fixtures live on. */
let scrimId = "";

/** Creates the fixture scrim and its three slots. */
async function seed(): Promise<void> {
  const rows = await db
    .insert(scrims)
    .values({
      guildId: GUILD_ID,
      name: "Slots test scrim",
      status: "closed",
      registrationChannelId: "900000000000000001",
      slotlistChannelId: "900000000000000002",
      roleId: "900000000000000003",
      openTime: new Date(),
      totalSlots: 3,
      startFrom: 1,
      hostId: "900000000000000004",
      closedAt: new Date(),
      matchTime: new Date(Date.now() + 3_600_000),
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

  // The slots cascade with the scrim, but the delete is explicit so the
  // test does not depend on the cascade.
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

describe("the claim statement", () => {
  it("is one conditional UPDATE, not a read-then-write", () => {
    const statement = buildClaimStatement(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER, TEAMMATE],
    });

    const { sql: text, params } = statement.toSQL();

    // The statement the database receives.
    expect(text).toContain('update "slots"');
    expect(text).toContain('"state" = $');
    expect(text).toContain('"team_name" = $');
    expect(text).toContain('"owner_user_id" = $');
    expect(text).toContain('"members" = $');

    // The three predicates that make it a race the database settles.
    expect(text).toContain('"scrim_id" = $');
    expect(text).toContain('"num" = $');
    expect(text).toContain('"state" = $');
    expect(text).toContain("returning");

    // The values.
    expect(params).toContain("claimed");
    expect(params).toContain("Team Alpha");
    expect(params).toContain(OWNER);
    expect(params).toContain(scrimId);
    expect(params).toContain(1);
    expect(params).toContain("free");

    // There is no SELECT anywhere in the statement.
    expect(text).not.toContain("select");
  });
});

describe("the claim", () => {
  it("claims a free slot", async () => {
    const slot = await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER, TEAMMATE],
    });

    expect(slot).not.toBeNull();
    expect(slot?.state).toBe("claimed");
    expect(slot?.ownerUserId).toBe(OWNER);
    expect(slot?.teamName).toBe("Team Alpha");
  });

  it("persists the member list, so the ID-Pass transfer has a teammate", async () => {
    // BUG-1 / BUG-3: the source wrote only the claimer, so the transfer
    // could never find a teammate and the feature had never worked.
    const slot = await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER, TEAMMATE],
    });

    const stored = await getSlot(slot?.id ?? "");

    expect(stored?.members).toEqual([OWNER, TEAMMATE]);
  });

  it("refuses a slot somebody else already took", async () => {
    const first = await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER],
    });

    expect(first).not.toBeNull();

    // The second claim matches no row: the race is lost.
    const second = await claimSlot(scrimId, 1, {
      teamName: "Team Bravo",
      ownerUserId: OTHER,
      members: [OTHER],
    });

    expect(second).toBeNull();

    // ...and the first owner is still the owner.
    const stored = await getSlot(first?.id ?? "");

    expect(stored?.ownerUserId).toBe(OWNER);
    expect(stored?.teamName).toBe("Team Alpha");
  });

  it("leaves the other slots alone", async () => {
    await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER],
    });

    const free = await db
      .select({ num: slots.num, state: slots.state })
      .from(slots)
      .where(eq(slots.scrimId, scrimId))
      .orderBy(slots.num);

    expect(free).toEqual([
      { num: 1, state: "claimed" },
      { num: 2, state: "free" },
      { num: 3, state: "free" },
    ]);
  });
});

describe("the release statement", () => {
  it("is one conditional UPDATE that names the owner", () => {
    const statement = buildReleaseStatement("00000000-0000-0000-0000-000000000000", OWNER);

    const { sql: text, params } = statement.toSQL();

    expect(text).toContain('update "slots"');
    expect(text).toContain('"state" = $');
    expect(text).toContain('"owner_user_id" = $');
    expect(text).toContain('"id" = $');
    expect(params).toContain(OWNER);
    expect(text).not.toContain("select");
  });

  it("frees the slot for its owner", async () => {
    const slot = await claimSlot(scrimId, 2, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER],
    });

    const released = await releaseSlot(slot?.id ?? "", OWNER);

    expect(released).not.toBeNull();
    expect(released?.state).toBe("free");
    expect(released?.ownerUserId).toBeNull();
    expect(released?.members).toEqual([]);
  });

  it("refuses to free somebody else's slot", async () => {
    const slot = await claimSlot(scrimId, 2, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER],
    });

    const released = await releaseSlot(slot?.id ?? "", OTHER);

    expect(released).toBeNull();

    const stored = await getSlot(slot?.id ?? "");

    expect(stored?.state).toBe("claimed");
    expect(stored?.ownerUserId).toBe(OWNER);
  });
});

describe("the last-slot rule", () => {
  it("counts the other slots the member holds in that scrim", async () => {
    const first = await claimSlot(scrimId, 1, {
      teamName: "Team Alpha",
      ownerUserId: OWNER,
      members: [OWNER],
    });

    const second = await claimSlot(scrimId, 2, {
      teamName: "Team Bravo",
      ownerUserId: OWNER,
      members: [OWNER],
    });

    // Two slots: the role stays.
    expect(
      await countUserSlotsInScrim(scrimId, OWNER, first?.id ?? ""),
    ).toBe(1);

    // Excluding nothing, both count.
    expect(await countUserSlotsInScrim(scrimId, OWNER)).toBe(2);

    // The other member holds none.
    expect(await countUserSlotsInScrim(scrimId, OTHER)).toBe(0);

    // One slot left after the second is cancelled.
    await releaseSlot(second?.id ?? "", OWNER);

    expect(
      await countUserSlotsInScrim(scrimId, OWNER, first?.id ?? ""),
    ).toBe(0);
  });
});

describe("the scrim's slot list message", () => {
  it("is recorded by id, not found by name", async () => {
    // D16 / B15: the message is stored on the row.
    await setScrimSlotlistMessage(scrimId, "900000000000000009");

    const rows = await db
      .select({ id: scrims.slotlistMessageId })
      .from(scrims)
      .where(eq(scrims.id, scrimId));

    expect(rows[0]?.id).toBe("900000000000000009");
  });
});

describe("the schema's own rule", () => {
  it("refuses a claimed slot without an owner", async () => {
    // The schema carries a constraint the source did not have: a
    // claimed slot must have an owner.
    await expect(
      db.execute(sql`
        update slots
           set state = 'claimed', team_name = 'Team Alpha', owner_user_id = null
         where scrim_id = ${scrimId} and num = 3
      `),
    ).rejects.toThrow();
  });
});
