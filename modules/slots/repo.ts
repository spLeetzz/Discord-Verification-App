/**
 * All the SQL for the slot-manager area.
 *
 * The rule that matters: **no SQL outside this file.** The service layer
 * talks to these functions; the views talk to the service.
 *
 * The schema is in `db/schema/esports.ts` and it is already migrated and
 * verified, so the column names here are the real ones — `slots.state`,
 * `slots.members`, `slot_managers.toggle`, `slot_manager_scrims` and so
 * on.
 *
 * Two statements carry the whole area:
 *
 *  - {@link buildClaimStatement} — the conditional `UPDATE` from S7. The
 *    claim is a race, and the database settles it. There is no lock.
 *  - {@link buildReleaseStatement} — the conditional cancel. It only frees
 *    a slot the member actually owns.
 */

import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  bannedTeams,
  jobs,
  scrims,
  slotManagerScrims,
  slotManagers,
  slotReminders,
  slots,
} from "../../db/schema.js";
import type { JobEvent } from "../../db/schema/common.js";
import type {
  ScrimLite,
  SlotManagerRecord,
  SlotRecord,
  SlotReminderRecord,
  SlotStore,
} from "./types.js";

/* ------------------------------------------------------------------ *
 * Row mapping
 * ------------------------------------------------------------------ */

function toSlotManager(
  row: typeof slotManagers.$inferSelect,
): SlotManagerRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    mainChannelId: row.mainChannelId,
    messageId: row.messageId,
    toggle: row.toggle,
    allowReminders: row.allowReminders,
    multipleSlots: row.multipleSlots,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toScrim(row: typeof scrims.$inferSelect): ScrimLite {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    status: row.status,
    registrationChannelId: row.registrationChannelId,
    slotlistChannelId: row.slotlistChannelId,
    slotlistMessageId: row.slotlistMessageId,
    roleId: row.roleId,
    startFrom: row.startFrom,
    totalSlots: row.totalSlots,
    openTime: row.openTime,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    matchTime: row.matchTime,
    hostId: row.hostId,
  };
}

function toSlot(row: typeof slots.$inferSelect): SlotRecord {
  return {
    id: row.id,
    scrimId: row.scrimId,
    num: row.num,
    state: row.state as SlotRecord["state"],
    teamName: row.teamName,
    ownerUserId: row.ownerUserId,
    members: row.members,
    messageId: row.messageId,
    jumpUrl: row.jumpUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toReminder(
  row: typeof slotReminders.$inferSelect,
): SlotReminderRecord {
  return {
    id: row.id,
    scrimId: row.scrimId,
    userId: row.userId,
    createdAt: row.createdAt,
  };
}

/* ------------------------------------------------------------------ *
 * Slot managers
 * ------------------------------------------------------------------ */

/** One slot manager, by id. */
export async function getSlotManager(
  id: string,
): Promise<SlotManagerRecord | null> {
  const rows = await db
    .select()
    .from(slotManagers)
    .where(eq(slotManagers.id, id))
    .limit(1);

  const row = rows[0];

  return row ? toSlotManager(row) : null;
}

/** Every slot manager of a guild. */
export async function listSlotManagers(
  guildId: string,
): Promise<SlotManagerRecord[]> {
  const rows = await db
    .select()
    .from(slotManagers)
    .where(eq(slotManagers.guildId, guildId))
    .orderBy(asc(slotManagers.createdAt));

  return rows.map(toSlotManager);
}

/** How many slot managers a guild has. */
export async function countSlotManagers(guildId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(slotManagers)
    .where(eq(slotManagers.guildId, guildId));

  return rows[0]?.value ?? 0;
}

/** Creates a slot manager. */
export async function createSlotManager(values: {
  readonly guildId: string;
  readonly mainChannelId: string;
  readonly messageId: string;
}): Promise<SlotManagerRecord> {
  const rows = await db
    .insert(slotManagers)
    .values({
      guildId: values.guildId,
      mainChannelId: values.mainChannelId,
      messageId: values.messageId,
    })
    .returning();

  const row = rows[0];

  if (!row) throw new Error("the slot manager insert returned no row");

  return toSlotManager(row);
}

/** Updates a slot manager. */
export async function updateSlotManager(
  id: string,
  patch: Partial<
    Pick<
      SlotManagerRecord,
      "toggle" | "allowReminders" | "multipleSlots" | "messageId" | "mainChannelId"
    >
  >,
): Promise<SlotManagerRecord | null> {
  const rows = await db
    .update(slotManagers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(slotManagers.id, id))
    .returning();

  const row = rows[0];

  return row ? toSlotManager(row) : null;
}

/** Deletes a slot manager. The join rows cascade. */
export async function deleteSlotManager(id: string): Promise<void> {
  await db.delete(slotManagers).where(eq(slotManagers.id, id));
}

/** The scrims a slot manager shows. */
export async function listSlotManagerScrimIds(
  managerId: string,
): Promise<string[]> {
  const rows = await db
    .select({ scrimId: slotManagerScrims.scrimId })
    .from(slotManagerScrims)
    .where(eq(slotManagerScrims.slotManagerId, managerId));

  return rows.map((row) => row.scrimId);
}

/**
 * Replaces the scrims of a slot manager.
 *
 * The source kept the scrim ids in a `bigint[]` and appended to it with a
 * raw `UPDATE … SET scrim_ids = scrim_ids || $1`, which is a
 * read-modify-write and races. This is a join table (S8), so the whole set
 * is replaced in one transaction.
 *
 * The unique constraint on `scrim_id` alone means a scrim sits in at most
 * one slot manager; the insert therefore skips a scrim that is already
 * somewhere else rather than stealing it.
 */
export async function setSlotManagerScrims(
  managerId: string,
  scrimIds: readonly string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(slotManagerScrims)
      .where(eq(slotManagerScrims.slotManagerId, managerId));

    if (scrimIds.length === 0) return;

    await tx
      .insert(slotManagerScrims)
      .values(
        scrimIds.map((scrimId) => ({ slotManagerId: managerId, scrimId })),
      )
      .onConflictDoNothing();
  });
}

/** The slot manager a scrim belongs to. */
export async function findSlotManagerForScrim(
  scrimId: string,
): Promise<SlotManagerRecord | null> {
  const rows = await db
    .select({ manager: slotManagers })
    .from(slotManagerScrims)
    .innerJoin(slotManagers, eq(slotManagers.id, slotManagerScrims.slotManagerId))
    .where(eq(slotManagerScrims.scrimId, scrimId))
    .limit(1);

  const row = rows[0];

  return row ? toSlotManager(row.manager) : null;
}

/* ------------------------------------------------------------------ *
 * Scrims
 * ------------------------------------------------------------------ */

/** One scrim, by id. */
export async function getScrim(id: string): Promise<ScrimLite | null> {
  const rows = await db.select().from(scrims).where(eq(scrims.id, id)).limit(1);

  const row = rows[0];

  return row ? toScrim(row) : null;
}

/** Every scrim of a guild. */
export async function listScrims(guildId: string): Promise<ScrimLite[]> {
  const rows = await db
    .select()
    .from(scrims)
    .where(eq(scrims.guildId, guildId))
    .orderBy(asc(scrims.openTime));

  return rows.map(toScrim);
}

/** The scrims a slot manager shows. */
export async function listScrimsForManager(
  managerId: string,
): Promise<ScrimLite[]> {
  const ids = await listSlotManagerScrimIds(managerId);

  if (ids.length === 0) return [];

  const rows = await db
    .select()
    .from(scrims)
    .where(inArray(scrims.id, [...ids]))
    .orderBy(asc(scrims.openTime));

  return rows.map(toScrim);
}

/** The ids of every scrim of a guild. */
export async function listScrimIds(guildId: string): Promise<string[]> {
  const rows = await db
    .select({ id: scrims.id })
    .from(scrims)
    .where(eq(scrims.guildId, guildId));

  return rows.map((row) => row.id);
}

/* ------------------------------------------------------------------ *
 * Slots
 * ------------------------------------------------------------------ */

/** The slots of a scrim, in number order. */
export async function listSlots(scrimId: string): Promise<SlotRecord[]> {
  const rows = await db
    .select()
    .from(slots)
    .where(eq(slots.scrimId, scrimId))
    .orderBy(asc(slots.num));

  return rows.map(toSlot);
}

/** One slot, by id. */
export async function getSlot(id: string): Promise<SlotRecord | null> {
  const rows = await db.select().from(slots).where(eq(slots.id, id)).limit(1);

  const row = rows[0];

  return row ? toSlot(row) : null;
}

/** One slot, by its number in a scrim. */
export async function getSlotByNum(
  scrimId: string,
  num: number,
): Promise<SlotRecord | null> {
  const rows = await db
    .select()
    .from(slots)
    .where(and(eq(slots.scrimId, scrimId), eq(slots.num, num)))
    .limit(1);

  const row = rows[0];

  return row ? toSlot(row) : null;
}

/** How many slots are free. A count, not a read-modify-write (D14). */
export async function countFreeSlots(scrimId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(slots)
    .where(and(eq(slots.scrimId, scrimId), eq(slots.state, "free")));

  return rows[0]?.value ?? 0;
}

/** What a claim writes. */
export interface ClaimValues {
  readonly teamName: string;
  readonly ownerUserId: string;
  /**
   * The whole team.
   *
   * The source wrote `members=[user_id]` only, so the ID-Pass transfer
   * could never find a teammate (B3). The claim modal collects the
   * mentions and they are persisted here.
   */
  readonly members: readonly string[];
}

/**
 * The claim, as one statement.
 *
 * ```sql
 * UPDATE slots
 *    SET state = 'claimed', team_name = $3, owner_user_id = $4, members = $5
 *  WHERE scrim_id = $1 AND num = $2 AND state = 'free'
 *  RETURNING id;
 * ```
 *
 * Zero rows returned means somebody else got it. **There is no lock** —
 * the source protected this with a module-global `asyncio.Lock` that
 * died with the process, so two users could own one slot.
 *
 * Exported separately from the execution so a test can read the statement
 * the database actually receives.
 */
export function buildClaimStatement(
  scrimId: string,
  num: number,
  values: ClaimValues,
) {
  return db
    .update(slots)
    .set({
      state: "claimed",
      teamName: values.teamName,
      ownerUserId: values.ownerUserId,
      members: [...values.members],
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(slots.scrimId, scrimId),
        eq(slots.num, num),
        eq(slots.state, "free"),
      ),
    )
    .returning();
}

/**
 * Claims a slot.
 *
 * @returns the claimed slot, or `null` when somebody else won the race.
 */
export async function claimSlot(
  scrimId: string,
  num: number,
  values: ClaimValues,
): Promise<SlotRecord | null> {
  const rows = await buildClaimStatement(scrimId, num, values);

  const row = rows[0];

  return row ? toSlot(row) : null;
}

/**
 * The cancel, as one statement.
 *
 * ```sql
 * UPDATE slots
 *    SET state = 'free', team_name = null, owner_user_id = null, members = '{}'
 *  WHERE id = $1 AND owner_user_id = $2;
 * ```
 *
 * The `owner_user_id` predicate is what stops one member from cancelling
 * another member's slot.
 */
export function buildReleaseStatement(slotId: string, ownerUserId: string) {
  return db
    .update(slots)
    .set({
      state: "free",
      teamName: null,
      ownerUserId: null,
      members: [],
      updatedAt: new Date(),
    })
    .where(and(eq(slots.id, slotId), eq(slots.ownerUserId, ownerUserId)))
    .returning();
}

/**
 * Releases a slot.
 *
 * @returns the freed slot, or `null` when the member does not own it.
 */
export async function releaseSlot(
  slotId: string,
  ownerUserId: string,
): Promise<SlotRecord | null> {
  const rows = await buildReleaseStatement(slotId, ownerUserId);

  const row = rows[0];

  return row ? toSlot(row) : null;
}

/**
 * How many other claimed slots a member holds in a scrim.
 *
 * This is the load-bearing rule of the cancel: the scrim's role is only
 * removed when the answer is zero. The slot being cancelled is excluded,
 * because it is still claimed at the moment the question is asked.
 */
export async function countUserSlotsInScrim(
  scrimId: string,
  userId: string,
  exceptSlotId?: string,
): Promise<number> {
  const conditions = [
    eq(slots.scrimId, scrimId),
    eq(slots.ownerUserId, userId),
    eq(slots.state, "claimed"),
  ];

  if (exceptSlotId) conditions.push(ne(slots.id, exceptSlotId));

  const rows = await db
    .select({ value: count() })
    .from(slots)
    .where(and(...conditions));

  return rows[0]?.value ?? 0;
}

/**
 * Moves a slot to a new owner and writes the member list back.
 *
 * The source mutated `slot.members` **in memory only** and never wrote it
 * back, so the database kept listing the old captain (B9). This writes
 * both the owner and the members.
 */
export async function transferSlot(
  slotId: string,
  newOwnerId: string,
  members: readonly string[],
): Promise<SlotRecord | null> {
  const rows = await db
    .update(slots)
    .set({
      ownerUserId: newOwnerId,
      members: [...members],
      updatedAt: new Date(),
    })
    .where(eq(slots.id, slotId))
    .returning();

  const row = rows[0];

  return row ? toSlot(row) : null;
}

/** The claimed slots a member holds in a set of scrims. */
export async function listUserSlots(
  scrimIds: readonly string[],
  userId: string,
): Promise<SlotRecord[]> {
  if (scrimIds.length === 0) return [];

  const rows = await db
    .select()
    .from(slots)
    .where(
      and(
        inArray(slots.scrimId, [...scrimIds]),
        eq(slots.ownerUserId, userId),
        eq(slots.state, "claimed"),
      ),
    )
    .orderBy(asc(slots.num));

  return rows.map(toSlot);
}

/* ------------------------------------------------------------------ *
 * Reminders
 * ------------------------------------------------------------------ */

/** The reminders of a scrim, oldest first. */
export async function listReminders(
  scrimId: string,
): Promise<SlotReminderRecord[]> {
  const rows = await db
    .select()
    .from(slotReminders)
    .where(eq(slotReminders.scrimId, scrimId))
    .orderBy(asc(slotReminders.createdAt));

  return rows.map(toReminder);
}

/**
 * Adds a reminder.
 *
 * The unique constraint on `(scrim_id, user_id)` makes this idempotent:
 * asking twice does not stack two rows.
 */
export async function addReminder(
  scrimId: string,
  userId: string,
): Promise<void> {
  await db
    .insert(slotReminders)
    .values({ scrimId, userId })
    .onConflictDoNothing();
}

/**
 * Deletes every reminder of a scrim.
 *
 * A reminder is one-shot: the row goes when it fires, so nobody is
 * reminded about the same scrim twice.
 */
export async function deleteReminders(scrimId: string): Promise<void> {
  await db.delete(slotReminders).where(eq(slotReminders.scrimId, scrimId));
}

/** The scrims a member has a reminder for. */
export async function listReminderScrimIds(
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ scrimId: slotReminders.scrimId })
    .from(slotReminders)
    .where(eq(slotReminders.userId, userId));

  return rows.map((row) => row.scrimId);
}

/* ------------------------------------------------------------------ *
 * Bans
 * ------------------------------------------------------------------ */

/** Is this member banned from this scrim? */
export async function isBanned(
  scrimId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: bannedTeams.id })
    .from(bannedTeams)
    .where(and(eq(bannedTeams.scrimId, scrimId), eq(bannedTeams.userId, userId)))
    .limit(1);

  return rows.length > 0;
}

/** The members banned from a scrim. */
export async function listBannedUserIds(
  scrimId: string,
): Promise<string[]> {
  const rows = await db
    .select({ userId: bannedTeams.userId })
    .from(bannedTeams)
    .where(eq(bannedTeams.scrimId, scrimId));

  return rows.map((row) => row.userId);
}

/**
 * Bans a set of members.
 *
 * The unique constraint on `(scrim_id, user_id)` makes this idempotent:
 * banning the same member twice updates the row instead of stacking a
 * second one.
 */
export async function banUsers(
  entries: readonly { readonly scrimId: string; readonly userId: string }[],
  reason: string | null,
  expires: Date | null,
): Promise<void> {
  if (entries.length === 0) return;

  await db
    .insert(bannedTeams)
    .values(
      entries.map((entry) => ({
        scrimId: entry.scrimId,
        userId: entry.userId,
        reason,
        expires,
      })),
    )
    .onConflictDoUpdate({
      target: [bannedTeams.scrimId, bannedTeams.userId],
      set: { reason, expires, updatedAt: new Date() },
    });
}

/**
 * Arms the job that lifts a ban whose time is up.
 *
 * The ban itself is durable — it is a row with an `expires` column — but
 * something has to lift it. The scheduler is the `jobs` table, never a
 * `setTimeout`: a timer that dies with the process means the ban lasts
 * forever.
 *
 * The payload shape is the one the scrims area's `scrim_ban` handler
 * reads: `{ scrimIds, userIds }`.
 */
export async function scheduleBanExpiry(
  scrimIds: readonly string[],
  userIds: readonly string[],
  expiresAt: Date,
): Promise<void> {
  if (scrimIds.length === 0 || userIds.length === 0) return;

  const event: JobEvent = "scrim_ban";

  await db.insert(jobs).values({
    event,
    expiresAt,
    payload: { scrimIds: [...scrimIds], userIds: [...userIds] },
  });
}

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

/**
 * The store the service layer talks to.
 *
 * Every function of {@link SlotStore} is implemented here; the service
 * never sees drizzle.
 */
export const slotStore: SlotStore = {
  getSlotManager,
  listSlotManagers,
  countSlotManagers,
  createSlotManager,
  updateSlotManager,
  deleteSlotManager,
  listSlotManagerScrimIds,
  setSlotManagerScrims,
  findSlotManagerForScrim,

  getScrim,
  listScrims,
  listScrimsForManager,
  listScrimIds,

  listSlots,
  getSlot,
  getSlotByNum,
  countFreeSlots,
  claimSlot,
  releaseSlot,
  countUserSlotsInScrim,
  transferSlot,
  listUserSlots,

  listReminders,
  addReminder,
  deleteReminders,
  listReminderScrimIds,

  isBanned,
  listBannedUserIds,
  banUsers,
};

/** A convenience for the views: the free slots of a scrim, by number. */
export async function listFreeSlotNumbers(
  scrimId: string,
): Promise<number[]> {
  const rows = await db
    .select({ num: slots.num })
    .from(slots)
    .where(and(eq(slots.scrimId, scrimId), eq(slots.state, "free")))
    .orderBy(asc(slots.num));

  return rows.map((row) => row.num);
}

