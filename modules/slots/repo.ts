/**
 * All the SQL for the slot-manager area.
 *
 * The rule that matters: **no SQL outside this file.** The service layer
 * talks to these functions; the views talk to the service.
 *
 * The schema is in `db/schema/esports.ts` and it is already migrated and
 * verified, so the column names here are the real ones — `slots.state`,
 * `slot_members.user_id`, `slot_managers.toggle`, `slot_manager_scrims`
 * and so on.
 *
 * Two statements carry the whole area:
 *
 *  - {@link buildClaimStatement} — the conditional `UPDATE` from S7. The
 *    claim is a race, and the database settles it. There is no lock.
 *  - {@link buildReleaseStatement} — the conditional cancel. It only frees
 *    a slot the member actually owns.
 *
 * **The member list is a join table.** `slots.members` was a `text[]`,
 * and SQLite has no arrays, so the members of a slot live in
 * `slot_members`: one row per (slot, member). The three things that
 * used the array now use the table:
 *
 *  - the claim writes the claimer and the mentioned teammates;
 *  - the ID-Pass transfer replaces the list;
 *  - the fake-tag check — "does any other claimed slot in this scrim
 *    already hold one of these players?" — is a join.
 *
 * The list is never assembled in JavaScript and written back: a claim
 * that read the slot, appended a member and wrote the list back is a
 * race two moderators can lose. Every write of the list is a set of
 * rows, inside the same transaction as the statement that changed the
 * slot.
 */

import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db, withTransaction } from "../../db/client.js";
import type { DbExecutor, Transaction } from "../../db/client.js";
import {
  banLogs,
  bannedTeams,
  jobs,
  scrims,
  slotManagerScrims,
  slotManagers,
  slotMembers,
  slotReminders,
  slots,
} from "../../db/schema.js";
import type { JobEvent } from "../../db/schema/common.js";
import type {
  BanRecord,
  ScrimLite,
  SlotManagerRecord,
  SlotRecord,
  SlotReminderRecord,
  SlotStore,
} from "./types.js";

/* ------------------------------------------------------------------ *
 * The write transaction
 * ------------------------------------------------------------------ */

/**
 * How many times a write is tried again when SQLite says the database
 * is locked.
 *
 * SQLite has one writer. Two writes that overlap make the second one
 * fail with `SQLITE_BUSY`, and the client sets no busy timeout, so the
 * failure is immediate rather than a wait. The other writer is a
 * statement away from finishing, so the write is tried again.
 *
 * The central fix belongs in `db/client.ts` — a busy timeout on every
 * connection the client opens. This is the belt to that pair of braces.
 */
const BUSY_RETRIES = 6;

/** The pause before each retry, in milliseconds. */
const BUSY_BACKOFF_MS = [2, 5, 10, 20, 40, 80] as const;

/**
 * Is this the "the database is locked" error?
 *
 * SQLite has one writer, and the error says so in two different ways
 * depending on where it was raised.
 */
function isDatabaseLocked(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const message = (error as { readonly message?: unknown }).message;

  if (typeof message !== "string") return false;

  return (
    message.includes("SQLITE_BUSY") || message.includes("database is locked")
  );
}

/**
 * Runs a write in a transaction, waiting out a locked database.
 *
 * The claim, the release and the transfer all write more than one
 * table, and the rows of one table are worthless without the rows of
 * the other: a claimed slot with no team, or a free slot that still
 * holds one. One transaction is what makes them one fact.
 *
 * The transaction is *not* a lock on the slot. The slot is settled by
 * the conditional `UPDATE` inside it, and that statement is what makes
 * two users owning one slot impossible. This only keeps the write from
 * failing when SQLite says the file is busy.
 */
async function withWriteTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withTransaction(fn);
    } catch (error) {
      if (!isDatabaseLocked(error)) throw error;
      if (attempt >= BUSY_RETRIES) throw error;

      const wait = BUSY_BACKOFF_MS[attempt] ?? 80;

      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

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

function toSlot(
  row: typeof slots.$inferSelect,
  members: readonly string[],
): SlotRecord {
  return {
    id: row.id,
    scrimId: row.scrimId,
    num: row.num,
    state: row.state as SlotRecord["state"],
    teamName: row.teamName,
    ownerUserId: row.ownerUserId,
    members: orderMembers(row.ownerUserId, members),
    messageId: row.messageId,
    jumpUrl: row.jumpUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The member list of a slot, the captain first.
 *
 * The claim writes the claimer first and the teammates after, so the
 * captain is the head of the team. The rows come back from the database
 * in the order they were written, but the captain is put back at the
 * front anyway: a join table has no order of its own, and the captain
 * first is what the rest of the area promises.
 */
function orderMembers(
  ownerUserId: string | null,
  members: readonly string[],
): string[] {
  const ordered = [...members];

  if (ownerUserId === null) return ordered;

  const index = ordered.indexOf(ownerUserId);

  if (index <= 0) return ordered;

  const [owner] = ordered.splice(index, 1);

  return owner === undefined ? ordered : [owner, ...ordered];
}

/** A slot row together with the member that came with it. */
interface SlotMemberRow {
  readonly slot: typeof slots.$inferSelect;
  readonly userId: string | null;
}

/**
 * The slots a join found, with their member lists.
 *
 * The rows are grouped here because a slot has one row per member. The
 * grouping is in memory and writes nothing: the rows are read once and
 * assembled, which is not a read-modify-write.
 */
function groupSlots(rows: readonly SlotMemberRow[]): SlotRecord[] {
  const slotRows = new Map<string, typeof slots.$inferSelect>();
  const memberRows = new Map<string, string[]>();

  for (const row of rows) {
    if (!slotRows.has(row.slot.id)) {
      slotRows.set(row.slot.id, row.slot);
      memberRows.set(row.slot.id, []);
    }

    if (row.userId !== null) {
      memberRows.get(row.slot.id)?.push(row.userId);
    }
  }

  return [...slotRows.values()].map((row) =>
    toSlot(row, memberRows.get(row.id) ?? []),
  );
}

/**
 * The slots a condition finds, with their member lists.
 *
 * One query: the slots are joined to their members and the rows are
 * grouped in memory. A slot list and a member list are two halves of
 * one thing, and a second query per slot would be a query per slot.
 */
async function selectSlots(condition: SQL | undefined): Promise<SlotRecord[]> {
  const rows = await db
    .select({ slot: slots, userId: slotMembers.userId })
    .from(slots)
    .leftJoin(slotMembers, eq(slotMembers.slotId, slots.id))
    .where(condition)
    .orderBy(asc(slots.num), asc(slotMembers.createdAt), asc(slotMembers.id));

  return groupSlots(rows);
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

/**
 * One scrim, by the id of the slot list message it published.
 *
 * The message id is on the scrim row, so the row is what finds the
 * message again after a restart — a Discord message id carries no
 * channel, so there is nowhere else to look.
 */
export async function getScrimBySlotlistMessageId(
  messageId: string,
): Promise<ScrimLite | null> {
  const rows = await db
    .select()
    .from(scrims)
    .where(eq(scrims.slotlistMessageId, messageId))
    .limit(1);

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

/**
 * Records the message the slot list was published as.
 *
 * **This area owns the column.** The slot area publishes the slot list
 * and records the message here, and the scrims area — which owns the
 * scrim lifecycle and asks for the list to be published — does not
 * write it. One writer, one column: two writers means whichever
 * re-renders last wins, and a message id that points at a message
 * nobody can edit.
 */
export async function setScrimSlotlistMessage(
  scrimId: string,
  messageId: string,
): Promise<void> {
  await db
    .update(scrims)
    .set({ slotlistMessageId: messageId, updatedAt: new Date() })
    .where(eq(scrims.id, scrimId));
}

/* ------------------------------------------------------------------ *
 * Slots
 * ------------------------------------------------------------------ */

/** The slots of a scrim, in number order. */
export async function listSlots(scrimId: string): Promise<SlotRecord[]> {
  return selectSlots(eq(slots.scrimId, scrimId));
}

/** One slot, by id. */
export async function getSlot(id: string): Promise<SlotRecord | null> {
  const found = await selectSlots(eq(slots.id, id));

  return found[0] ?? null;
}

/** One slot, by its number in a scrim. */
export async function getSlotByNum(
  scrimId: string,
  num: number,
): Promise<SlotRecord | null> {
  const found = await selectSlots(
    and(eq(slots.scrimId, scrimId), eq(slots.num, num)),
  );

  return found[0] ?? null;
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
   * mentions and they are persisted here — as rows in `slot_members`.
   */
  readonly members: readonly string[];
}

/**
 * The claim, as one statement.
 *
 * ```sql
 * UPDATE slots
 *    SET state = 'claimed', team_name = $3, owner_user_id = $4
 *  WHERE scrim_id = $1 AND num = $2 AND state = 'free'
 *  RETURNING id;
 * ```
 *
 * Zero rows returned means somebody else got it. **There is no lock** —
 * the source protected this with a module-global `asyncio.Lock` that
 * died with the process, so two users could own one slot.
 *
 * The team is not part of the statement: the members are rows in
 * `slot_members`, and they are written in the same transaction as the
 * claim (see {@link claimSlot}).
 *
 * Exported separately from the execution so a test can read the statement
 * the database actually receives.
 */
export function buildClaimStatement(
  executor: DbExecutor,
  scrimId: string,
  num: number,
  values: ClaimValues,
) {
  return executor
    .update(slots)
    .set({
      state: "claimed",
      teamName: values.teamName,
      ownerUserId: values.ownerUserId,
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
 * Writes the members of a slot.
 *
 * One row per member, and the unique constraint on
 * `(slot_id, user_id)` makes the write idempotent: nobody is in a team
 * twice, and a mention of the captain does not stack a second row.
 */
async function insertSlotMembers(
  tx: Transaction,
  slotId: string,
  userIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(userIds)];

  if (unique.length === 0) return;

  await tx
    .insert(slotMembers)
    .values(unique.map((userId) => ({ slotId, userId })))
    .onConflictDoNothing();
}

/**
 * Claims a slot.
 *
 * **The claim is one conditional `UPDATE`, and the team goes in with
 * it.** The statement above decides the race — the database, not a
 * lock, and not a read-then-write — and the members are written as
 * rows in the same transaction. A claim that read the slot, appended a
 * member and wrote the list back is a race two moderators can lose, so
 * the list is never assembled in JavaScript.
 *
 * @returns the claimed slot, or `null` when somebody else won the race.
 */
export async function claimSlot(
  scrimId: string,
  num: number,
  values: ClaimValues,
): Promise<SlotRecord | null> {
  return withWriteTransaction(async (tx) => {
    const rows = await buildClaimStatement(tx, scrimId, num, values);

    const row = rows[0];

    // Zero rows updated: somebody else took the slot first. The
    // database decided, and there is no lock to get wrong. Nothing is
    // written either — the transaction ends with the slot untouched.
    if (!row) return null;

    await insertSlotMembers(tx, row.id, values.members);

    return toSlot(row, values.members);
  });
}

/**
 * The cancel, as one statement.
 *
 * ```sql
 * UPDATE slots
 *    SET state = 'free', team_name = null, owner_user_id = null
 *  WHERE id = $1 AND owner_user_id = $2;
 * ```
 *
 * The `owner_user_id` predicate is what stops one member from cancelling
 * another member's slot.
 */
export function buildReleaseStatement(
  executor: DbExecutor,
  slotId: string,
  ownerUserId: string,
) {
  return executor
    .update(slots)
    .set({
      state: "free",
      teamName: null,
      ownerUserId: null,
      updatedAt: new Date(),
    })
    .where(and(eq(slots.id, slotId), eq(slots.ownerUserId, ownerUserId)))
    .returning();
}

/**
 * Releases a slot.
 *
 * The team goes with it: a free slot has no members, and the rows are
 * deleted in the same transaction as the release.
 *
 * @returns the freed slot, or `null` when the member does not own it.
 */
export async function releaseSlot(
  slotId: string,
  ownerUserId: string,
): Promise<SlotRecord | null> {
  return withWriteTransaction(async (tx) => {
    const rows = await buildReleaseStatement(tx, slotId, ownerUserId);

    const row = rows[0];

    // Somebody else owns it: the slot is not touched, and neither are
    // its members.
    if (!row) return null;

    await tx.delete(slotMembers).where(eq(slotMembers.slotId, slotId));

    return toSlot(row, []);
  });
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
 *
 * **The list is replaced, not merged.** The captain who left the team is
 * gone and the new owner is in, so the rows of the old team are deleted
 * and the rows of the new one are written — in the same transaction as
 * the ownership, so the slot is never owned by somebody who is not in
 * it.
 */
export async function transferSlot(
  slotId: string,
  newOwnerId: string,
  members: readonly string[],
): Promise<SlotRecord | null> {
  return withWriteTransaction(async (tx) => {
    const rows = await tx
      .update(slots)
      .set({
        ownerUserId: newOwnerId,
        updatedAt: new Date(),
      })
      .where(eq(slots.id, slotId))
      .returning();

    const row = rows[0];

    if (!row) return null;

    await tx.delete(slotMembers).where(eq(slotMembers.slotId, slotId));

    await insertSlotMembers(tx, slotId, members);

    return toSlot(row, members);
  });
}

/** The claimed slots a member holds in a set of scrims. */
export async function listUserSlots(
  scrimIds: readonly string[],
  userId: string,
): Promise<SlotRecord[]> {
  if (scrimIds.length === 0) return [];

  return selectSlots(
    and(
      inArray(slots.scrimId, [...scrimIds]),
      eq(slots.ownerUserId, userId),
      eq(slots.state, "claimed"),
    ),
  );
}

/**
 * The claimed slots of a scrim that already hold one of these members.
 *
 * The fake-tag check: "does any other claimed slot in this scrim
 * already hold one of these players?"
 *
 * The source ran this as raw SQL with an array-overlap operator
 * (`$2 && SLOTS.MEMBERS`). A join table has no overlap operator, and
 * it does not need one: the check is a join against `slot_members` and
 * an `IN` over the ids, which is a plain index lookup on both engines
 * and faster than the operator was.
 *
 * **The slot being checked is excluded**, so a slot is never a fake tag
 * of itself: the check is about *other* slots.
 *
 * @param scrimId       the scrim the slots belong to;
 * @param memberIds     the players to look for;
 * @param exceptSlotId  the slot being checked, when there is one.
 */
export async function findFakeTagMatches(
  scrimId: string,
  memberIds: readonly string[],
  exceptSlotId?: string,
): Promise<SlotRecord[]> {
  const ids = [...new Set(memberIds)];

  if (ids.length === 0) return [];

  const conditions = [
    eq(slots.scrimId, scrimId),
    eq(slots.state, "claimed"),
    inArray(slotMembers.userId, ids),
  ];

  if (exceptSlotId) conditions.push(ne(slots.id, exceptSlotId));

  // The slots that hold one of the players.
  const matched = await db
    .selectDistinct({ id: slots.id })
    .from(slots)
    .innerJoin(slotMembers, eq(slotMembers.slotId, slots.id))
    .where(and(...conditions));

  if (matched.length === 0) return [];

  // ...and the whole team of each of them, so the answer is a slot and
  // not a row of a slot.
  return selectSlots(
    inArray(
      slots.id,
      matched.map((row) => row.id),
    ),
  );
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

/**
 * Lifts a ban.
 *
 * The ban row is the whole truth about a ban: it is what
 * `isBanned` reads and what the claim path refuses on. Deleting it is
 * the unban.
 */
export async function unbanUser(
  scrimId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(bannedTeams)
    .where(and(eq(bannedTeams.scrimId, scrimId), eq(bannedTeams.userId, userId)));
}

/**
 * The bans of a scrim.
 *
 * The reason and the expiry come with the row because the ban log entry
 * of an unban says what the ban was — "who was banned, from what, and
 * why" — and the row is the only place that is written down.
 */
export async function listBans(scrimId: string): Promise<BanRecord[]> {
  const rows = await db
    .select({
      userId: bannedTeams.userId,
      teamName: bannedTeams.teamName,
      reason: bannedTeams.reason,
      expires: bannedTeams.expires,
    })
    .from(bannedTeams)
    .where(eq(bannedTeams.scrimId, scrimId))
    .orderBy(asc(bannedTeams.createdAt));

  return rows.map((row) => ({
    userId: row.userId,
    teamName: row.teamName,
    reason: row.reason,
    expires: row.expires,
  }));
}

/**
 * The channel a guild writes its ban log to.
 *
 * The `ban_logs` table is shared with the scrims area — one row per
 * guild — and the row is written by `/scrims banlog`. This area only
 * reads it: the ban log is one channel, and two writers of that column
 * would be two answers to "where does the log go".
 */
export async function getBanLogChannel(
  guildId: string,
): Promise<string | null> {
  const rows = await db
    .select({ channelId: banLogs.channelId })
    .from(banLogs)
    .where(eq(banLogs.guildId, guildId))
    .limit(1);

  return rows[0]?.channelId ?? null;
}

/* ------------------------------------------------------------------ *
 * Job payloads
 * ------------------------------------------------------------------ */

/**
 * The user ids a `scrim_ban` job is about.
 *
 * The payload shape is `{ scrimIds, userIds }` — what
 * {@link scheduleBanExpiry} writes. The scrims area's own ban flow
 * writes a superset of it, and this reader takes the same two keys, so
 * the two agree.
 */
export function userIdsOf(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];

  const raw = (payload as Record<string, unknown>).userIds;

  if (!Array.isArray(raw)) return [];

  return raw.filter((id): id is string => typeof id === "string");
}

/**
 * The scrim ids a `scrim_ban` job is about.
 *
 * A payload that names one scrim as well as a list of them — the
 * scrims area's shape — counts that scrim once. The list is
 * deduplicated, so a scrim that is in both is unbanned once and leaves
 * one entry in the log, not two.
 */
export function scrimIdsOf(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];

  const raw = (payload as Record<string, unknown>).scrimIds;

  const many = Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === "string")
    : [];

  const single = (payload as Record<string, unknown>).scrimId;

  const all = [
    ...many,
    ...(typeof single === "string" ? [single] : []),
  ];

  return [...new Set(all)];
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
  listBans,
  unbanUser,
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

