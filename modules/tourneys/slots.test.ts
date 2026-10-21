/**
 * The tourney slots, proved against the live database.
 *
 * Two properties matter (D25):
 *
 *  - **the slot number comes from a per-tourney sequence, not
 *    `max(num) + 1`**, so two registrations can never be handed the same
 *    number;
 *  - **the swap is one transaction**, so the intermediate state never
 *    has two rows on the same number — which the source's two
 *    independent `UPDATE`s did, and which `UNIQUE (tourney_id, num)`
 *    forbids.
 *
 * The fixtures use ids that no real row can have, and they are deleted
 * afterwards.
 */

import { afterAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { closeDatabase, db } from "../../db/client.js";
import { tourneys } from "../../db/schema.js";
import * as repo from "./repo.js";

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `tourney-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The tournaments this test file created. */
const createdTourneyIds: string[] = [];

afterAll(async () => {
  if (createdTourneyIds.length > 0) {
    await db.delete(tourneys).where(inArray(tourneys.id, createdTourneyIds));
  }

  await closeDatabase();
});

/**
 * Creates a tournament with a unique registration channel.
 */
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

/** Adds a slot with the given name. */
async function addSlot(tourneyId: string, teamName: string) {
  const slot = await repo.insertSlot({
    tourneyId,
    teamName,
    leaderId: "1",
    members: ["1"],
    messageId: null,
    jumpUrl: null,
    confirmJumpUrl: null,
  });

  return slot;
}

describe("modules/tourneys/slots — the per-tourney sequence", () => {
  it("hands out the numbers in order", async () => {
    const tourneyId = await makeTourney("sequence");

    const first = await addSlot(tourneyId, "Team A");
    const second = await addSlot(tourneyId, "Team B");
    const third = await addSlot(tourneyId, "Team C");

    expect(first.num).toBe(1);
    expect(second.num).toBe(2);
    expect(third.num).toBe(3);
  });

  it("gives every tournament its own sequence", async () => {
    const first = await makeTourney("seq-a");
    const second = await makeTourney("seq-b");

    await addSlot(first, "Team A");
    await addSlot(first, "Team B");
    await addSlot(second, "Team C");

    const slots = await repo.listSlots(second);

    expect(slots).toHaveLength(1);
    expect(slots[0]?.num).toBe(1);
  });

  it("never hands out the same number twice", async () => {
    const tourneyId = await makeTourney("race");

    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        addSlot(tourneyId, `Team ${index}`),
      ),
    );

    const numbers = results.map((slot) => slot.num).sort((a, b) => a - b);

    expect(new Set(numbers).size).toBe(8);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("modules/tourneys/slots — the swap", () => {
  it("swaps two numbers", async () => {
    const tourneyId = await makeTourney("swap");

    const first = await addSlot(tourneyId, "Team A");
    const second = await addSlot(tourneyId, "Team B");
    const third = await addSlot(tourneyId, "Team C");

    const swapped = await repo.swapSlotNumbers(tourneyId, first.id, second.id);

    expect(swapped).toBe(true);

    const after = await repo.listSlots(tourneyId);

    const byId = new Map(after.map((slot) => [slot.id, slot]));

    expect(byId.get(first.id)?.num).toBe(2);
    expect(byId.get(second.id)?.num).toBe(1);
    expect(byId.get(third.id)?.num).toBe(3);
  });

  it("never leaves two rows on the same number", async () => {
    const tourneyId = await makeTourney("swap-unique");

    const first = await addSlot(tourneyId, "Team A");
    const second = await addSlot(tourneyId, "Team B");

    await repo.swapSlotNumbers(tourneyId, first.id, second.id);

    // The database refuses a duplicate number, so the fact that the
    // swap succeeded at all is the proof. This is the assertion that
    // would have failed with the source's two independent updates.
    const duplicates = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from (
        select num from tourney_slots
        where tourney_id = ${tourneyId}
        group by num having count(*) > 1
      ) as doubled
    `);

    expect(duplicates.rows[0]?.count).toBe(0);
  });

  it("refuses to swap a slot with itself", async () => {
    const tourneyId = await makeTourney("swap-self");

    const first = await addSlot(tourneyId, "Team A");

    await expect(
      repo.swapSlotNumbers(tourneyId, first.id, first.id),
    ).resolves.toBe(false);
  });

  it("refuses to swap a slot that is not in the tournament", async () => {
    const tourneyId = await makeTourney("swap-other");
    const other = await makeTourney("swap-other-two");

    const first = await addSlot(tourneyId, "Team A");
    const second = await addSlot(other, "Team B");

    await expect(
      repo.swapSlotNumbers(tourneyId, first.id, second.id),
    ).resolves.toBe(false);
  });
});
