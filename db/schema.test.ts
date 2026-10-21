/**
 * The schema, proved against a real SQLite database.
 *
 * These are not unit tests with a mocked database. They open a temporary
 * file database, apply the migration to it, and assert the things the port
 * actually promises:
 *
 *  - every ratified table is created, and there are no leftovers from an
 *    earlier migration;
 *  - the primary keys, the unique constraints and the enum CHECKs are
 *    real constraints in the database and not just TypeScript types;
 *  - **the conditional claim UPDATE works** — the single highest-value
 *    behaviour in the port, because it replaces Quotient's process-global
 *    lock and removes the double-claim corruption class;
 *  - `ON DELETE CASCADE` really cascades, and the partial unique index on
 *    `alerts` really is partial;
 *  - applying the migration twice is safe.
 *
 * **No server is involved.** The database is a file in the system
 * temporary directory, created and dropped with the test run.
 *
 * The client reads `DB_FILE` when it is imported and applies the
 * migrations as it goes, so the variable is set before the import — which
 * is why the imports below are dynamic.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray, sql } from "drizzle-orm";

/** The database this run uses. Dropped when the run ends. */
const directory = mkdtempSync(join(tmpdir(), "quotient-db-test-"));

process.env.DB_FILE = join(directory, "schema-test.db");

const { closeDatabase, db, withTransaction } = await import("./client.js");
const { applyMigrations } = await import("./migrate.js");
const {
  alerts,
  commandUsage,
  premiumPlans,
  premiumTransactions,
  scrims,
  slotMembers,
  slots,
  tags,
} = await import("./schema.js");
const { PREMIUM_PLAN_CATALOGUE, seedPremiumPlans } = await import("./seed.js");

/**
 * The ratified table list (`docs/porting/schema.md` §S3), plus the join
 * tables the SQLite port adds in place of Postgres arrays.
 *
 * It is written out by hand on purpose: a test that compares the database
 * against the schema would happily pass if both were wrong in the same
 * way.
 */
const EXPECTED_TABLES = [
  "alert_prompts",
  "alert_reads",
  "alerts",
  "autopurge_configs",
  "autorole_configs",
  "autorole_roles",
  "ban_logs",
  "banned_team_members",
  "banned_teams",
  "blocklist",
  "command_usage",
  "easytag_channels",
  "guild_entitlements",
  "guild_settings",
  "jobs",
  "lockdown_channels",
  "lockdown_maintenance_channels",
  "lockdowns",
  "media_partner_slot_members",
  "media_partner_slots",
  "media_partners",
  "premium_plans",
  "premium_transactions",
  "reserved_slot_members",
  "reserved_slots",
  "scrim_autoclean",
  "scrim_open_days",
  "scrims",
  "slot_manager_scrims",
  "slot_managers",
  "slot_members",
  "slot_reminders",
  "slots",
  "snipes",
  "ss_config_keywords",
  "ss_configs",
  "ss_submissions",
  "tagcheck_channels",
  "tags",
  "tourney_banned_users",
  "tourney_group_lists",
  "tourney_slot_members",
  "tourney_slots",
  "tourneys",
  "user_settings",
  "votes",
];

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `db-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * The extended SQLite error code of a constraint violation.
 *
 * `SQLITE_CONSTRAINT_UNIQUE` for a unique index, `..._PRIMARYKEY` for a
 * primary key and `..._CHECK` for a CHECK constraint. The Postgres test
 * asserted the SQLSTATE; this is the same idea, one engine down.
 *
 * Drizzle wraps the driver's error, so the code is on the `cause`.
 */
function sqliteErrorCode(error: unknown): string | undefined {
  const candidate = error as
    | { extendedCode?: string; code?: string; cause?: unknown }
    | undefined;

  if (candidate?.extendedCode) return candidate.extendedCode;
  if (candidate?.code) return candidate.code;

  return sqliteErrorCode(candidate?.cause);
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
  rmSync(directory, { recursive: true, force: true });
});

describe("db/schema", () => {
  it("creates exactly the ratified tables", async () => {
    const result = await db.execute<{ name: string }>(sql`
      select name
      from sqlite_master
      where type = 'table' and name not like 'sqlite_%'
        and name not like '__drizzle_%'
      order by name
    `);

    const actual = result.rows.map((row) => row.name);

    expect(actual).toEqual([...EXPECTED_TABLES].sort());
  });

  it("gives every table a text primary key, except command_usage", async () => {
    const result = await db.execute<{
      name: string;
      type: string;
      pk: number;
      dflt_value: string | null;
    }>(sql`
      select m.name as name, p.type as type, p.pk as pk, p.dflt_value as dflt_value
      from sqlite_master m
      join pragma_table_info(m.name) p
      where m.type = 'table' and m.name not like 'sqlite_%'
        and m.name not like '__drizzle_%'
        and p.pk > 0
      order by m.name, p.pk
    `);

    const byTable = new Map<string, typeof result.rows>();

    for (const row of result.rows) {
      const list = byTable.get(row.name) ?? [];

      list.push(row);
      byTable.set(row.name, list);
    }

    // The one exception: command_usage is the high-write table.
    const usage = byTable.get("command_usage");
    expect(usage?.[0]?.type.toLowerCase()).toBe("integer");

    for (const [table, columns] of byTable) {
      if (table === "command_usage") continue;

      for (const column of columns) {
        expect(column.type.toLowerCase(), `${table}.${column.name}`).toBe(
          "text",
        );
      }
    }
  });

  it("stores Discord ids as text, never as a number", async () => {
    const result = await db.execute<{ count: number }>(sql`
      select count(*) as count
      from sqlite_master m
      join pragma_table_info(m.name) p
      where m.type = 'table' and m.name not like 'sqlite_%'
        and m.name not like '__drizzle_%'
        and (p.name glob '*_user_id'
             or p.name glob '*_guild_id'
             or p.name glob '*_channel_id'
             or p.name = 'block_id')
        and lower(p.type) <> 'text'
    `);

    expect(result.rows[0]?.count).toBe(0);
  });

  it("stores timestamps as epoch milliseconds", async () => {
    const result = await db.execute<{ count: number }>(sql`
      select count(*) as count
      from sqlite_master m
      join pragma_table_info(m.name) p
      where m.type = 'table' and m.name not like 'sqlite_%'
        and m.name not like '__drizzle_%'
        and p.name in ('created_at', 'updated_at')
        and lower(p.type) <> 'integer'
    `);

    expect(result.rows[0]?.count).toBe(0);
  });

  it("stores the premium plan duration as whole days", async () => {
    const result = await db.execute<{ type: string }>(sql`
      select type
      from pragma_table_info('premium_plans')
      where name = 'duration_days'
    `);

    expect(result.rows[0]?.type.toLowerCase()).toBe("integer");
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

    expect(sqliteErrorCode(error)).toBe("SQLITE_CONSTRAINT_UNIQUE");
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

    expect(sqliteErrorCode(error)).toBe("SQLITE_CONSTRAINT_CHECK");
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

    expect(sqliteErrorCode(error)).toBe("SQLITE_CONSTRAINT_CHECK");
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

    expect(sqliteErrorCode(error)).toBe("SQLITE_CONSTRAINT_UNIQUE");
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
      })
      .from(slots)
      .where(sql`${slots.id} = ${first[0]?.id}`);

    expect(row?.state).toBe("claimed");
    expect(row?.teamName).toBe("Team A");
    expect(row?.ownerUserId).toBe("42");

    // The team members live in the join table now.
    await db.insert(slotMembers).values([
      { slotId: first[0]?.id ?? "", userId: "42" },
      { slotId: first[0]?.id ?? "", userId: "43" },
    ]);

    const members = await db
      .select({ userId: slotMembers.userId })
      .from(slotMembers)
      .where(sql`${slotMembers.slotId} = ${first[0]?.id}`);

    expect(members.map((member) => member.userId).sort()).toEqual(["42", "43"]);

    // "How many are free" is a count, not a read-modify-write.
    const free = await db
      .select({ n: sql<number>`count(*)` })
      .from(slots)
      .where(sql`${slots.scrimId} = ${scrimId} and ${slots.state} = 'free'`);

    expect(free[0]?.n).toBe(1);

    // The cancel, also from §S7.
    const cancelled = await db
      .update(slots)
      .set({ state: "free", teamName: null, ownerUserId: null })
      .where(sql`${slots.id} = ${first[0]?.id} and ${slots.ownerUserId} = ${"42"}`)
      .returning({ id: slots.id });

    expect(cancelled).toHaveLength(1);
  });

  it("cascades a delete to the children a row owns", async () => {
    const scrimId = await makeScrim("cascade");

    const [slot] = await db
      .insert(slots)
      .values({ scrimId, num: 1 })
      .returning({ id: slots.id });

    await db
      .insert(slotMembers)
      .values({ slotId: slot?.id ?? "", userId: "99" });

    await db.delete(scrims).where(sql`${scrims.id} = ${scrimId}`);

    const slotsLeft = await db
      .select({ n: sql<number>`count(*)` })
      .from(slots)
      .where(sql`${slots.scrimId} = ${scrimId}`);

    const membersLeft = await db
      .select({ n: sql<number>`count(*)` })
      .from(slotMembers)
      .where(sql`${slotMembers.slotId} = ${slot?.id}`);

    expect(slotsLeft[0]?.n).toBe(0);
    expect(membersLeft[0]?.n).toBe(0);
  });

  it("keeps only one alert live at a time", async () => {
    await db.insert(alerts).values({ authorId: "1", active: true });

    const error = await db
      .insert(alerts)
      .values({ authorId: "2", active: true })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(sqliteErrorCode(error)).toBe("SQLITE_CONSTRAINT_UNIQUE");

    // The index is *partial*: an inactive alert does not collide.
    await db.insert(alerts).values({ authorId: "3", active: false });

    await db.delete(alerts).where(sql`${alerts.authorId} != ${"1"}`);
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
      select count(*) as count
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

  it("applies the migration twice without changing anything", async () => {
    const before = await db.execute<{ count: number }>(sql`
      select count(*) as count from sqlite_master where type = 'table'
    `);

    await applyMigrations(db);

    const after = await db.execute<{ count: number }>(sql`
      select count(*) as count from sqlite_master where type = 'table'
    `);

    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("runs a raw statement and hands back the rows", async () => {
    // The feature modules were written against the Postgres driver, whose
    // `execute` returns `{ rows }`. The SQLite driver returns the rows
    // directly, so `db/client.ts` gives it the same shape.
    const result = await db.execute<{ count: number }>(sql`
      select count(*) as count from slots
    `);

    expect(result.rows[0]?.count).toBeGreaterThanOrEqual(0);
  });

  it("rolls a transaction back when the body throws", async () => {
    const scrimId = await makeScrim("rollback");

    await expect(
      (async () => {
        await withTransaction(async (tx) => {
          await tx.insert(slots).values({ scrimId, num: 7 });

          throw new Error("the body failed");
        });
      })(),
    ).rejects.toThrow("the body failed");

    const left = await db
      .select({ n: sql<number>`count(*)` })
      .from(slots)
      .where(sql`${slots.scrimId} = ${scrimId}`);

    expect(left[0]?.n).toBe(0);
  });

  it("bumps updated_at on every write", async () => {
    const scrimId = await makeScrim("updated-at");

    const [before] = await db
      .select({ updatedAt: scrims.updatedAt })
      .from(scrims)
      .where(sql`${scrims.id} = ${scrimId}`);

    await new Promise((resolve) => setTimeout(resolve, 5));

    await db
      .update(scrims)
      .set({ name: "renamed" })
      .where(sql`${scrims.id} = ${scrimId}`);

    const [after] = await db
      .select({ updatedAt: scrims.updatedAt })
      .from(scrims)
      .where(sql`${scrims.id} = ${scrimId}`);

    expect(after?.updatedAt.getTime()).toBeGreaterThan(
      before?.updatedAt.getTime() ?? 0,
    );
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
