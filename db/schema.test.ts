/**
 * The schema, proved against the live database.
 *
 * These are not unit tests with a mocked database. They connect to the
 * Postgres the bot talks to and assert the things the port actually
 * promises:
 *
 *  - the table names are the ratified ones, and there are no leftovers from
 *    an earlier migration;
 *  - every primary key is a uuid, except `command_usage`, which is a
 *    `bigserial`;
 *  - the unique constraints and the enum CHECKs are real constraints in
 *    the database and not just TypeScript types;
 *  - **the conditional claim UPDATE works** — the single highest-value
 *    behaviour in the port, because it replaces Quotient's process-global
 *    lock and removes the double-claim corruption class;
 *  - a plan can be reseeded without destroying the transactions that
 *    reference it.
 *
 * The fixtures are created with ids that no real row can have, and they are
 * deleted afterwards.
 */

import { afterAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { closeDatabase, db } from "./client.js";
import { PREMIUM_PLAN_CATALOGUE, seedPremiumPlans } from "./seed.js";
import {
  commandUsage,
  premiumPlans,
  premiumTransactions,
  scrims,
  slots,
  tags,
} from "./schema.js";

/**
 * The ratified table list (`docs/porting/schema.md` §S3), plus the join and
 * utility tables it implies.
 *
 * It is written out by hand on purpose: a test that compares the database
 * against the schema would happily pass if both were wrong in the same way.
 */
const EXPECTED_TABLES = [
  "alert_prompts",
  "alert_reads",
  "alerts",
  "autopurge_configs",
  "autorole_configs",
  "ban_logs",
  "banned_teams",
  "blocklist",
  "command_usage",
  "easytag_channels",
  "guild_entitlements",
  "guild_settings",
  "jobs",
  "lockdowns",
  "media_partner_slots",
  "media_partners",
  "premium_plans",
  "premium_transactions",
  "reserved_slots",
  "scrims",
  "slot_manager_scrims",
  "slot_managers",
  "slot_reminders",
  "slots",
  "snipes",
  "ss_configs",
  "ss_submissions",
  "tagcheck_channels",
  "tags",
  "tourney_banned_users",
  "tourney_group_lists",
  "tourney_slots",
  "tourneys",
  "user_settings",
  "votes",
];

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `db-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The Postgres SQLSTATE of the error a constraint violation produced. */
function pgErrorCode(error: unknown): string | undefined {
  const candidate = error as
    | { code?: string; cause?: { code?: string } }
    | undefined;

  return candidate?.cause?.code ?? candidate?.code;
}

/** The scrims this test file created, so they can be cleaned up. */
const createdScrimIds: string[] = [];

afterAll(async () => {
  if (createdScrimIds.length > 0) {
    await db.delete(scrims).where(inArray(scrims.id, createdScrimIds));
  }

  await db.delete(tags).where(sql`${tags.guildId} = ${GUILD_ID}`);
  await db
    .delete(premiumTransactions)
    .where(sql`${premiumTransactions.txnId} like 'db-test-%'`);
  await db.delete(premiumPlans).where(sql`${premiumPlans.code} like 'db-test-%'`);

  await closeDatabase();
});

describe("db/schema", () => {
  it("creates exactly the ratified tables", async () => {
    const result = await db.execute<{ table_name: string }>(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `);

    const actual = result.rows.map((row) => row.table_name);

    expect(actual).toEqual([...EXPECTED_TABLES].sort());
  });

  it("uses a uuid primary key everywhere except command_usage", async () => {
    const result = await db.execute<{
      table_name: string;
      data_type: string;
      column_default: string;
    }>(sql`
      select table_name, data_type, column_default
      from information_schema.columns
      where table_schema = 'public'
        and column_name = 'id'
        and table_name in (select table_name from information_schema.tables
                          where table_schema = 'public' and table_type = 'BASE TABLE')
      order by table_name
    `);

    const byTable = new Map(
      result.rows.map((row) => [row.table_name, row] as const),
    );

    // The one exception: command_usage is the high-write table.
    const usage = byTable.get("command_usage");
    expect(usage?.data_type).toBe("bigint");

    for (const [table, row] of byTable) {
      if (table === "command_usage") continue;

      expect(row.data_type, `${table}.id must be a uuid`).toBe("uuid");
      expect(row.column_default, `${table}.id must default to a uuid`).toContain(
        "gen_random_uuid()",
      );
    }
  });

  it("stores Discord ids as text, never as bigint", async () => {
    const result = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from information_schema.columns
      where table_schema = 'public'
        and (column_name like '%\_user\_id'
             or column_name like '%\_guild\_id'
             or column_name like '%\_channel\_id'
             or column_name = 'block_id')
        and data_type <> 'text'
    `);

    expect(result.rows[0]?.count).toBe(0);
  });

  it("stores the premium plan duration as whole days", async () => {
    const result = await db.execute<{ data_type: string }>(sql`
      select data_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'premium_plans'
        and column_name = 'duration_days'
    `);

    expect(result.rows[0]?.data_type).toBe("integer");
  });

  it("rejects a duplicate slot number in the same scrim", async () => {
    const scrimId = await makeScrim("unique-slot");
    const [slot] = await db
      .insert(slots)
      .values({ scrimId, num: 1 })
      .returning({ id: slots.id });

    expect(slot).toBeDefined();

    const error = await db
      .insert(slots)
      .values({ scrimId, num: 1 })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(pgErrorCode(error)).toBe("23505");
  });

  it("rejects a slot state outside the closed union", async () => {
    const scrimId = await makeScrim("bad-state");

    const error = await db
      .insert(slots)
      .values({ scrimId, num: 1, state: "wat" })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(pgErrorCode(error)).toBe("23514");
  });

  it("rejects a scrim status that a tourney would accept", async () => {
    // A scrim cannot be paused; only a tourney can.
    const error = await db
      .insert(scrims)
      .values({
        guildId: GUILD_ID,
        registrationChannelId: `${GUILD_ID}-paused-scrim`,
        slotlistChannelId: `${GUILD_ID}-slotlist`,
        hostId: "1",
        totalSlots: 2,
        openTime: new Date(),
        status: "paused",
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(pgErrorCode(error)).toBe("23514");
  });

  it("rejects a duplicate tag name in the same guild", async () => {
    await db
      .insert(tags)
      .values({
        guildId: GUILD_ID,
        name: "rules",
        content: "read them",
        ownerId: "1",
      });

    const error = await db
      .insert(tags)
      .values({
        guildId: GUILD_ID,
        name: "rules",
        content: "read them again",
        ownerId: "2",
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(pgErrorCode(error)).toBe("23505");
  });

  it("claims a slot exactly once", async () => {
    const scrimId = await makeScrim("claim");
    await db.insert(slots).values([
      { scrimId, num: 1 },
      { scrimId, num: 2 },
    ]);

    // The claim, exactly as §S7 specifies it.
    const first = await db
      .update(slots)
      .set({
        state: "claimed",
        teamName: "Team A",
        ownerUserId: "42",
        members: ["42", "43"],
      })
      .where(
        sql`${slots.scrimId} = ${scrimId} and ${slots.num} = 1 and ${slots.state} = 'free'`,
      )
      .returning({ id: slots.id });

    expect(first).toHaveLength(1);

    // The second claim for the same slot: zero rows, because the row is no
    // longer free. This is the invariant Quotient's asyncio.Lock used to
    // protect.
    const second = await db
      .update(slots)
      .set({
        state: "claimed",
        teamName: "Team B",
        ownerUserId: "44",
        members: ["44"],
      })
      .where(
        sql`${slots.scrimId} = ${scrimId} and ${slots.num} = 1 and ${slots.state} = 'free'`,
      )
      .returning({ id: slots.id });

    expect(second).toHaveLength(0);

    const [row] = await db
      .select({
        state: slots.state,
        teamName: slots.teamName,
        ownerUserId: slots.ownerUserId,
        members: slots.members,
      })
      .from(slots)
      .where(sql`${slots.id} = ${first[0]?.id}`);

    expect(row?.state).toBe("claimed");
    expect(row?.teamName).toBe("Team A");
    expect(row?.ownerUserId).toBe("42");
    expect(row?.members).toEqual(["42", "43"]);

    // "How many are free" is a count, not a read-modify-write.
    const free = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(slots)
      .where(sql`${slots.scrimId} = ${scrimId} and ${slots.state} = 'free'`);

    expect(free[0]?.n).toBe(1);

    // The cancel, also from §S7.
    const cancelled = await db
      .update(slots)
      .set({ state: "free", teamName: null, ownerUserId: null, members: [] })
      .where(sql`${slots.id} = ${first[0]?.id} and ${slots.ownerUserId} = ${"42"}`)
      .returning({ id: slots.id });

    expect(cancelled).toHaveLength(1);
  });

  it("keeps a paid transaction when the plan catalogue is reseeded", async () => {
    const [plan] = await db
      .insert(premiumPlans)
      .values({
        code: "db-test-plan",
        name: `db-test-plan-${Date.now()}`,
        description: "a plan that is about to be deleted",
        price: 10,
        durationDays: 7,
      })
      .returning({ id: premiumPlans.id });

    expect(plan).toBeDefined();

    const [txn] = await db
      .insert(premiumTransactions)
      .values({
        txnId: `db-test-txn-${Date.now()}`,
        status: "paid",
        userId: "1",
        guildId: GUILD_ID,
        planId: plan?.id ?? null,
        planSnapshot: { name: "db-test-plan", price: 10, duration_days: 7 },
      })
      .returning({ id: premiumTransactions.id });

    expect(txn).toBeDefined();

    // The plan goes away (a catalogue edit, a reseed).
    await db.delete(premiumPlans).where(sql`${premiumPlans.id} = ${plan?.id}`);

    const [survivor] = await db
      .select({
        id: premiumTransactions.id,
        planId: premiumTransactions.planId,
        snapshot: premiumTransactions.planSnapshot,
      })
      .from(premiumTransactions)
      .where(sql`${premiumTransactions.id} = ${txn?.id}`);

    // The transaction survived, the dangling reference was nulled, and the
    // snapshot still renders the receipt.
    expect(survivor?.id).toBe(txn?.id);
    expect(survivor?.planId).toBeNull();
    expect(survivor?.snapshot).toEqual({
      name: "db-test-plan",
      price: 10,
      duration_days: 7,
    });
  });

  it("upserts the plan catalogue without duplicating rows", async () => {
    await seedPremiumPlans();
    await seedPremiumPlans();

    const result = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from premium_plans
      where code in (${sql.join(
        PREMIUM_PLAN_CATALOGUE.map(
          (plan) => sql`${plan.code}`,
        ),
        sql`, `,
      )})
    `);

    expect(result.rows[0]?.count).toBe(PREMIUM_PLAN_CATALOGUE.length);
  });

  it("logs command usage with a serial id", async () => {
    const [row] = await db
      .insert(commandUsage)
      .values({
        guildId: GUILD_ID,
        channelId: "1",
        userId: "2",
        cmd: "tag",
      })
      .returning({ id: commandUsage.id });

    expect(typeof row?.id).toBe("number");

    await db.delete(commandUsage).where(sql`${commandUsage.guildId} = ${GUILD_ID}`);
  });
});

/**
 * Creates a scrim with a unique registration channel and remembers its id
 * so `afterAll` can remove it. The slots cascade with it.
 */
async function makeScrim(suffix: string): Promise<string> {
  const [scrim] = await db
    .insert(scrims)
    .values({
      guildId: GUILD_ID,
      registrationChannelId: `${GUILD_ID}-${suffix}-registration`,
      slotlistChannelId: `${GUILD_ID}-${suffix}-slotlist`,
      hostId: "1",
      totalSlots: 2,
      openTime: new Date(),
    })
    .returning({ id: scrims.id });

  if (!scrim) {
    throw new Error(`could not create the ${suffix} scrim`);
  }

  createdScrimIds.push(scrim.id);

  return scrim.id;
}
