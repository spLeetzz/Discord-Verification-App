/**
 * All the SQL for the scrims area.
 *
 * The rule that matters: **no SQL outside this file.** The service layer
 * talks to these functions; the views talk to the service.
 *
 * **Every list of ids is a join table.** Postgres had arrays and SQLite
 * does not, so a column that holds a list cannot be written in a dialect
 * both engines understand. The lists are normalised:
 *
 * | What | Where it lives |
 * |---|---|
 * | the team of a slot | `slot_members` |
 * | the team of a reservation | `reserved_slot_members` |
 * | the team of a ban | `banned_team_members` |
 * | the days a scrim opens on | `scrim_open_days` |
 * | what the autoclean pass removes | `scrim_autoclean` |
 *
 * The **domain types still hold arrays** — `SlotRecord.members` is
 * `string[]`, `ScrimRecord.openDays` is `Weekday[]` — because the array
 * is the shape the application sees. The join table is only how it is
 * stored. This file is the seam between the two.
 *
 * The one statement that matters most is {@link claimSlot}: the
 * conditional `UPDATE` from S7. It is the whole reason D14 exists.
 */

import { and, asc, count, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { db, withTransaction } from "../../db/client.js";
import type { DbExecutor, Transaction } from "../../db/client.js";
import { withLock } from "../../utils/lock.js";
import {
  banLogs,
  bannedTeamMembers,
  bannedTeams,
  jobs,
  reservedSlotMembers,
  reservedSlots,
  scrimAutoclean,
  scrimOpenDays,
  scrims,
  slotMembers,
  slots,
} from "../../db/schema.js";
import type {
  AutocleanKind,
  JobEvent,
  ScrimStatus,
  SlotState,
  Weekday,
} from "../../db/schema/common.js";
import { parseTemplate } from "./template.js";
import type { EmbedTemplate } from "./template.js";
import type {
  BannedTeamRecord,
  ReservedSlotRecord,
  ScrimCountdown,
  ScrimEmojis,
  ScrimRecord,
  SlotRecord,
} from "./types.js";

/* ------------------------------------------------------------------ *
 * The executor
 * ------------------------------------------------------------------ */

/**
 * Anything that can run a query.
 *
 * The database itself and a transaction handle both qualify. Every write
 * that has to be atomic runs inside `withTransaction`, and the helpers
 * below take whichever executor they are handed — so a helper used from
 * both paths does the same thing in both.
 */
type Executor = Pick<DbExecutor, "select" | "insert" | "update" | "delete">;

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/** The key this area's writes are serialised under. */
const WRITE_LOCK = "scrims:write";

/**
 * Runs a write of this area.
 *
 * **SQLite has one writer.** Two transactions that overlap cannot both
 * hold the write lock, and the second one fails with `SQLITE_BUSY`
 * rather than waiting — a claim and a job firing at the same moment
 * would make one of them fail. The mutex makes the second one wait.
 *
 * **The mutex is not what makes the claim exclusive.** The conditional
 * `UPDATE` is: two claims of one slot still race inside the mutex, and
 * the loser still updates zero rows. Take the mutex away and the claim
 * is still correct — it just loses with a busy error instead of losing
 * cleanly.
 */
function writeLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(WRITE_LOCK, fn);
}

/**
 * Runs a write of this area that is more than one statement.
 *
 * The statements share a transaction, so they commit together or not at
 * all, and the mutex keeps them from overlapping another write.
 */
function writeTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return writeLock(() => withTransaction(fn));
}

/* ------------------------------------------------------------------ *
 * Row mapping
 * ------------------------------------------------------------------ */

/**
 * The `emojis` column, with the defaults the source had.
 *
 * The column's default is `{}`, not `{"tick": "✅"}`, so a scrim that was
 * never edited has no emoji of its own and falls back to the Unicode
 * ones (D36).
 */
function readEmojis(value: unknown): ScrimEmojis {
  const source = (typeof value === "object" && value !== null
    ? value
    : {}) as Record<string, unknown>;

  return {
    tick: typeof source.tick === "string" ? source.tick : "✅",
    cross: typeof source.cross === "string" ? source.cross : "❌",
  };
}

/** The countdown column, with the defaults the source had. */
function readCountdown(value: unknown): ScrimCountdown {
  const source = (typeof value === "object" && value !== null
    ? value
    : {}) as Record<string, unknown>;

  return {
    status: source.status === true,
    countdown: typeof source.countdown === "number" ? source.countdown : 3,
    msg: parseTemplate(source.msg),
  };
}

/**
 * The two lists a scrim row no longer carries.
 *
 * They live in `scrim_open_days` and `scrim_autoclean`, so a scrim row
 * on its own is not a scrim.
 */
interface ScrimExtras {
  openDays: Weekday[];
  autoclean: AutocleanKind[];
}

/** The extras of a scrim that has neither. */
const NO_EXTRAS: ScrimExtras = { openDays: [], autoclean: [] };

/** Turns a database row into the domain type. */
function toScrim(
  row: typeof scrims.$inferSelect,
  extras: ScrimExtras,
): ScrimRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    status: row.status as ScrimStatus,
    registrationChannelId: row.registrationChannelId,
    slotlistChannelId: row.slotlistChannelId,
    slotlistMessageId: row.slotlistMessageId,
    roleId: row.roleId,
    openRoleId: row.openRoleId,
    pingRoleId: row.pingRoleId,
    hostId: row.hostId,
    requiredMentions: row.requiredMentions,
    requiredLines: row.requiredLines,
    startFrom: row.startFrom,
    totalSlots: row.totalSlots,
    openTime: row.openTime,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    matchTime: row.matchTime,
    autoclean: [...extras.autoclean],
    autocleanTime: row.autocleanTime,
    autoslotlist: row.autoslotlist,
    multiregister: row.multiregister,
    enabled: row.enabled,
    autodeleteRejects: row.autodeleteRejects,
    autodeleteExtras: row.autodeleteExtras,
    teamnameCompulsion: row.teamnameCompulsion,
    noDuplicateName: row.noDuplicateName,
    allowDuplicateTags: row.allowDuplicateTags,
    timeElapsedSeconds: row.timeElapsedSeconds,
    openDays: [...extras.openDays],
    slotlistFormat: parseTemplate(row.slotlistFormat),
    openMessage: parseTemplate(row.openMessage),
    closeMessage: parseTemplate(row.closeMessage),
    emojis: readEmojis(row.emojis),
    cdn: readCountdown(row.cdn),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The captain first.
 *
 * The member rows have no order column, so the order they come back in
 * is the order they were written in — except when two of them share a
 * timestamp, which they do when they are written in one statement. The
 * captain is put first explicitly, because that is the order the
 * source's array had and the order the slot list shows.
 */
function orderMembers(
  ownerUserId: string | null,
  members: readonly string[],
): string[] {
  const ordered = [...members];

  if (!ownerUserId) return ordered;

  const index = ordered.indexOf(ownerUserId);

  if (index <= 0) return ordered;

  const [captain] = ordered.splice(index, 1);

  ordered.unshift(captain ?? ownerUserId);

  return ordered;
}

/** Turns a database row into the domain type. */
function toSlot(
  row: typeof slots.$inferSelect,
  members: readonly string[],
): SlotRecord {
  return {
    id: row.id,
    scrimId: row.scrimId,
    num: row.num,
    state: row.state as SlotState,
    teamName: row.teamName,
    ownerUserId: row.ownerUserId,
    members: orderMembers(row.ownerUserId, members),
    messageId: row.messageId,
    jumpUrl: row.jumpUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Turns a database row into the domain type. */
function toReservedSlot(
  row: typeof reservedSlots.$inferSelect,
  members: readonly string[],
): ReservedSlotRecord {
  return {
    id: row.id,
    scrimId: row.scrimId,
    num: row.num,
    userId: row.userId,
    teamName: row.teamName,
    members: [...members],
    expires: row.expires,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Turns a database row into the domain type. */
function toBannedTeam(
  row: typeof bannedTeams.$inferSelect,
  members: readonly string[],
): BannedTeamRecord {
  return {
    id: row.id,
    scrimId: row.scrimId,
    num: row.num,
    userId: row.userId,
    teamName: row.teamName,
    members: [...members],
    reason: row.reason,
    expires: row.expires,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------------------------------------------ *
 * The join tables
 * ------------------------------------------------------------------ */

/**
 * The open days and the autoclean kinds of a set of scrims.
 *
 * One query per list, for every scrim at once — the panel that lists a
 * guild's scrims reads them all, and a query per scrim would be a
 * query per scrim.
 */
async function loadScrimExtras(
  executor: Executor,
  scrimIds: readonly string[],
): Promise<Map<string, ScrimExtras>> {
  const byScrim = new Map<string, ScrimExtras>();

  if (scrimIds.length === 0) return byScrim;

  for (const id of scrimIds) byScrim.set(id, { openDays: [], autoclean: [] });

  const days = await executor
    .select({ scrimId: scrimOpenDays.scrimId, day: scrimOpenDays.day })
    .from(scrimOpenDays)
    .where(inArray(scrimOpenDays.scrimId, [...scrimIds]));

  for (const row of days) {
    byScrim.get(row.scrimId)?.openDays.push(row.day as Weekday);
  }

  const kinds = await executor
    .select({ scrimId: scrimAutoclean.scrimId, kind: scrimAutoclean.kind })
    .from(scrimAutoclean)
    .where(inArray(scrimAutoclean.scrimId, [...scrimIds]));

  for (const row of kinds) {
    byScrim.get(row.scrimId)?.autoclean.push(row.kind as AutocleanKind);
  }

  return byScrim;
}

/** The members of a set of slots, keyed by slot id. */
async function loadSlotMembers(
  executor: Executor,
  slotIds: readonly string[],
): Promise<Map<string, string[]>> {
  return loadMembers(
    executor,
    slotMembers,
    slotMembers.slotId,
    slotMembers.userId,
    slotIds,
  );
}

/** The members of a set of reservations, keyed by reservation id. */
async function loadReservedMembers(
  executor: Executor,
  reservedSlotIds: readonly string[],
): Promise<Map<string, string[]>> {
  return loadMembers(
    executor,
    reservedSlotMembers,
    reservedSlotMembers.reservedSlotId,
    reservedSlotMembers.userId,
    reservedSlotIds,
  );
}

/** The members of a set of bans, keyed by ban id. */
async function loadBannedMembers(
  executor: Executor,
  bannedTeamIds: readonly string[],
): Promise<Map<string, string[]>> {
  return loadMembers(
    executor,
    bannedTeamMembers,
    bannedTeamMembers.bannedTeamId,
    bannedTeamMembers.userId,
    bannedTeamIds,
  );
}

/**
 * Reads a member list out of a join table.
 *
 * The three member tables have the same shape, so they share one
 * reader. `parentId` is the column the child points at and `userId` the
 * column the member id is in.
 */
async function loadMembers(
  executor: Executor,
  table: typeof slotMembers | typeof reservedSlotMembers | typeof bannedTeamMembers,
  parentId: typeof slotMembers.slotId | typeof reservedSlotMembers.reservedSlotId | typeof bannedTeamMembers.bannedTeamId,
  userId:
    | typeof slotMembers.userId
    | typeof reservedSlotMembers.userId
    | typeof bannedTeamMembers.userId,
  parentIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byParent = new Map<string, string[]>();

  if (parentIds.length === 0) return byParent;

  const rows = await executor
    .select({ parent: parentId, user: userId })
    .from(table)
    .where(inArray(parentId, [...parentIds]));

  for (const row of rows) {
    const list = byParent.get(row.parent);

    if (list) list.push(row.user);
    else byParent.set(row.parent, [row.user]);
  }

  return byParent;
}

/**
 * Replaces the open days of a scrim.
 *
 * The containment check — "every day is a real weekday" — is a `CHECK`
 * constraint on `scrim_open_days.day`, so the database refuses a day
 * that is not one. The write path does not have to police it.
 */
async function replaceOpenDays(
  executor: Executor,
  scrimId: string,
  days: readonly Weekday[],
): Promise<void> {
  await executor.delete(scrimOpenDays).where(eq(scrimOpenDays.scrimId, scrimId));

  const unique = [...new Set(days)];

  if (unique.length === 0) return;

  await executor
    .insert(scrimOpenDays)
    .values(unique.map((day) => ({ scrimId, day })));
}

/**
 * Replaces the autoclean kinds of a scrim.
 *
 * The kinds are `channel` and `role` — a `CHECK` constraint on
 * `scrim_autoclean.kind` says so, and the unique constraint on
 * `(scrim_id, kind)` makes a duplicate a no-op instead of an error.
 */
async function replaceAutoclean(
  executor: Executor,
  scrimId: string,
  kinds: readonly AutocleanKind[],
): Promise<void> {
  await executor.delete(scrimAutoclean).where(eq(scrimAutoclean.scrimId, scrimId));

  const unique = [...new Set(kinds)];

  if (unique.length === 0) return;

  await executor
    .insert(scrimAutoclean)
    .values(unique.map((kind) => ({ scrimId, kind })));
}

/** Replaces the members of a slot. */
async function replaceSlotMembers(
  executor: Executor,
  slotId: string,
  memberIds: readonly string[],
): Promise<string[]> {
  await executor.delete(slotMembers).where(eq(slotMembers.slotId, slotId));

  const unique = [...new Set(memberIds)];

  if (unique.length === 0) return [];

  await executor
    .insert(slotMembers)
    .values(unique.map((userId) => ({ slotId, userId })));

  return unique;
}

/** Replaces the members of a reservation. */
async function replaceReservedMembers(
  executor: Executor,
  reservedSlotId: string,
  memberIds: readonly string[],
): Promise<string[]> {
  await executor
    .delete(reservedSlotMembers)
    .where(eq(reservedSlotMembers.reservedSlotId, reservedSlotId));

  const unique = [...new Set(memberIds)];

  if (unique.length === 0) return [];

  await executor
    .insert(reservedSlotMembers)
    .values(unique.map((userId) => ({ reservedSlotId, userId })));

  return unique;
}

/** Replaces the members of a ban. */
async function replaceBannedMembers(
  executor: Executor,
  bannedTeamId: string,
  memberIds: readonly string[],
): Promise<string[]> {
  await executor
    .delete(bannedTeamMembers)
    .where(eq(bannedTeamMembers.bannedTeamId, bannedTeamId));

  const unique = [...new Set(memberIds)];

  if (unique.length === 0) return [];

  await executor
    .insert(bannedTeamMembers)
    .values(unique.map((userId) => ({ bannedTeamId, userId })));

  return unique;
}

/* ------------------------------------------------------------------ *
 * Scrims
 * ------------------------------------------------------------------ */

/** One scrim, by id. */
export async function getScrim(id: string): Promise<ScrimRecord | null> {
  const rows = await db.select().from(scrims).where(eq(scrims.id, id)).limit(1);

  const row = rows[0];

  if (!row) return null;

  const extras = await loadScrimExtras(db, [id]);

  return toScrim(row, extras.get(id) ?? NO_EXTRAS);
}

/** Every scrim in a guild, oldest open time first. */
export async function listScrims(guildId: string): Promise<ScrimRecord[]> {
  const rows = await db
    .select()
    .from(scrims)
    .where(eq(scrims.guildId, guildId))
    .orderBy(asc(scrims.openTime));

  const extras = await loadScrimExtras(
    db,
    rows.map((row) => row.id),
  );

  return rows.map((row) => toScrim(row, extras.get(row.id) ?? NO_EXTRAS));
}

/** The scrim that lives in a registration channel. */
export async function getScrimByRegistrationChannel(
  channelId: string,
): Promise<ScrimRecord | null> {
  const rows = await db
    .select()
    .from(scrims)
    .where(eq(scrims.registrationChannelId, channelId))
    .limit(1);

  const row = rows[0];

  if (!row) return null;

  const extras = await loadScrimExtras(db, [row.id]);

  return toScrim(row, extras.get(row.id) ?? NO_EXTRAS);
}

/** Every scrim whose registration is open, across every guild. */
export async function listOpenScrims(): Promise<ScrimRecord[]> {
  const rows = await db
    .select()
    .from(scrims)
    .where(eq(scrims.status, "open"))
    .orderBy(asc(scrims.openTime));

  const extras = await loadScrimExtras(
    db,
    rows.map((row) => row.id),
  );

  return rows.map((row) => toScrim(row, extras.get(row.id) ?? NO_EXTRAS));
}

/** How many scrims a guild has. */
export async function countScrims(guildId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(scrims)
    .where(eq(scrims.guildId, guildId));

  return rows[0]?.value ?? 0;
}

/** The values a new scrim is created with. */
export interface CreateScrimValues {
  readonly guildId: string;
  readonly hostId: string;
  readonly name: string;
  readonly registrationChannelId: string;
  readonly slotlistChannelId: string;
  readonly roleId: string | null;
  readonly requiredMentions: number;
  readonly totalSlots: number;
  readonly openTime: Date;
  readonly startFrom: number;
  readonly openDays: readonly Weekday[];
  readonly autoclean: readonly AutocleanKind[];
  readonly autocleanTime: Date | null;
  readonly emojis: ScrimEmojis;
  readonly openMessage: EmbedTemplate;
  readonly closeMessage: EmbedTemplate;
  readonly slotlistFormat: EmbedTemplate;
}

/**
 * Creates a scrim. It starts as a `draft` (D26).
 *
 * The scrim row and its two lists are one transaction: a scrim with no
 * open days and no autoclean kinds is a different scrim from one with
 * them, and a half-written scrim is neither.
 */
export async function createScrim(values: CreateScrimValues): Promise<string> {
  return writeTransaction(async (tx) => {
    const rows = await tx
      .insert(scrims)
      .values({
        guildId: values.guildId,
        hostId: values.hostId,
        name: values.name,
        status: "draft",
        registrationChannelId: values.registrationChannelId,
        slotlistChannelId: values.slotlistChannelId,
        roleId: values.roleId,
        requiredMentions: values.requiredMentions,
        totalSlots: values.totalSlots,
        openTime: values.openTime,
        startFrom: values.startFrom,
        autocleanTime: values.autocleanTime,
        emojis: values.emojis,
        openMessage: values.openMessage,
        closeMessage: values.closeMessage,
        slotlistFormat: values.slotlistFormat,
      })
      .returning({ id: scrims.id });

    const id = rows[0]?.id;

    if (!id) throw new Error("the scrim insert returned no id");

    await replaceOpenDays(tx, id, values.openDays);
    await replaceAutoclean(tx, id, values.autoclean);

    return id;
  });
}

/**
 * The fields the editor may write.
 *
 * `slotlistMessageId` is **not** in the list: the slot area owns the
 * published slot list, and it is the only writer of the column that
 * remembers the message. Two writers means whichever re-renders last
 * wins.
 */
export type ScrimColumnUpdate = Partial<
  Pick<
    typeof scrims.$inferInsert,
    | "name"
    | "registrationChannelId"
    | "slotlistChannelId"
    | "roleId"
    | "openRoleId"
    | "pingRoleId"
    | "requiredMentions"
    | "requiredLines"
    | "startFrom"
    | "totalSlots"
    | "openTime"
    | "openedAt"
    | "closedAt"
    | "matchTime"
    | "status"
    | "autocleanTime"
    | "autoslotlist"
    | "multiregister"
    | "enabled"
    | "autodeleteRejects"
    | "autodeleteExtras"
    | "teamnameCompulsion"
    | "noDuplicateName"
    | "allowDuplicateTags"
    | "timeElapsedSeconds"
    | "slotlistFormat"
    | "openMessage"
    | "closeMessage"
    | "emojis"
    | "cdn"
  >
>;

/**
 * One edit to a scrim.
 *
 * The columns and the two lists are edited together, so a caller never
 * has to remember that `openDays` and `autoclean` are not columns any
 * more: they are written to their join tables in the same transaction
 * as the columns.
 */
export interface ScrimUpdate extends ScrimColumnUpdate {
  /** The days registration may open on. Written to `scrim_open_days`. */
  readonly openDays?: readonly Weekday[];
  /** What the autoclean pass removes. Written to `scrim_autoclean`. */
  readonly autoclean?: readonly AutocleanKind[];
}

/**
 * Writes **one** field of a scrim.
 *
 * The source's editor rebuilt the whole model from `dict(self.record)` on
 * every interaction, which wrote columns another writer may have changed
 * in the meantime. The port writes only what the button touched.
 */
export async function updateScrim(
  id: string,
  values: ScrimUpdate,
): Promise<ScrimRecord | null> {
  const { openDays, autoclean, ...columns } = values;

  return writeTransaction(async (tx) => {
    const rows = await tx
      .update(scrims)
      .set({ ...columns, updatedAt: new Date() })
      .where(eq(scrims.id, id))
      .returning();

    const row = rows[0];

    if (!row) return null;

    if (openDays) await replaceOpenDays(tx, id, openDays);
    if (autoclean) await replaceAutoclean(tx, id, autoclean);

    const extras = await loadScrimExtras(tx, [id]);

    return toScrim(row, extras.get(id) ?? NO_EXTRAS);
  });
}

/**
 * Writes one field on **every** scrim of a guild.
 *
 * This is the "apply to all scrims" prompt. It is a separate function on
 * purpose: the source ran it *after* the panel had already re-rendered,
 * so the user saw the new value on the edited scrim and then had to
 * confirm a change to every other scrim. The port asks first.
 */
export async function updateAllScrims(
  guildId: string,
  values: ScrimUpdate,
): Promise<number> {
  const { openDays, autoclean, ...columns } = values;

  return writeTransaction(async (tx) => {
    const rows = await tx
      .update(scrims)
      .set({ ...columns, updatedAt: new Date() })
      .where(eq(scrims.guildId, guildId))
      .returning({ id: scrims.id });

    if (openDays) {
      for (const row of rows) await replaceOpenDays(tx, row.id, openDays);
    }

    if (autoclean) {
      for (const row of rows) await replaceAutoclean(tx, row.id, autoclean);
    }

    return rows.length;
  });
}

/**
 * Deletes a scrim. The slots, their members, the reservations and the
 * two lists cascade with it.
 */
export async function deleteScrim(id: string): Promise<void> {
  await writeLock(() => db.delete(scrims).where(eq(scrims.id, id)));
}

/* ------------------------------------------------------------------ *
 * Slots
 * ------------------------------------------------------------------ */

/** Every slot of a scrim, in slot-number order. */
export async function listSlots(scrimId: string): Promise<SlotRecord[]> {
  const rows = await db
    .select()
    .from(slots)
    .where(eq(slots.scrimId, scrimId))
    .orderBy(asc(slots.num));

  const members = await loadSlotMembers(
    db,
    rows.map((row) => row.id),
  );

  return rows.map((row) => toSlot(row, members.get(row.id) ?? []));
}

/** One slot of a scrim, by its number. */
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

  if (!row) return null;

  const members = await loadSlotMembers(db, [row.id]);

  return toSlot(row, members.get(row.id) ?? []);
}

/** One slot, by its row id. */
export async function getSlot(slotId: string): Promise<SlotRecord | null> {
  const rows = await db.select().from(slots).where(eq(slots.id, slotId)).limit(1);

  const row = rows[0];

  if (!row) return null;

  const members = await loadSlotMembers(db, [row.id]);

  return toSlot(row, members.get(row.id) ?? []);
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
  readonly members: readonly string[];
  readonly messageId: string | null;
  readonly jumpUrl: string | null;
}

/**
 * Claims a slot.
 *
 * ```sql
 * UPDATE slots
 *    SET state = 'claimed', team_name = $3, owner_user_id = $4
 *  WHERE scrim_id = $1 AND num = $2 AND state = 'free'
 * RETURNING id;
 * ```
 *
 * Zero rows returned means somebody else got it. **The claim is not
 * protected by a lock** — the source protected it with a module-global
 * `asyncio.Lock` that died with the process, so two users could own one
 * slot. The database enforces the invariant here. (There *is* an
 * in-process mutex around the transaction, because SQLite has one
 * writer; it is not what makes the claim exclusive.)
 *
 * The team goes into `slot_members`, in the **same transaction** as the
 * claim: the claim wins the slot, and only then are the members
 * written. There is no read-modify-write of the member list anywhere —
 * a claim that read the slot, appended a member and wrote it back is a
 * race two moderators can lose.
 *
 * @returns the claimed slot, or `null` when somebody else won.
 */
export async function claimSlot(
  scrimId: string,
  num: number,
  values: ClaimValues,
): Promise<SlotRecord | null> {
  return writeTransaction(async (tx) => {
    const rows = await tx
      .update(slots)
      .set({
        state: "claimed",
        teamName: values.teamName,
        ownerUserId: values.ownerUserId,
        messageId: values.messageId,
        jumpUrl: values.jumpUrl,
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

    const row = rows[0];

    if (!row) return null;

    const members = await replaceSlotMembers(tx, row.id, values.members);

    return toSlot(row, members);
  });
}

/**
 * Releases a slot.
 *
 * Only the owner may release their own slot; a moderator releasing
 * somebody else's slot goes through {@link setSlotState} instead.
 */
export async function releaseSlot(
  slotId: string,
  ownerUserId: string,
): Promise<SlotRecord | null> {
  return writeTransaction(async (tx) => {
    const rows = await tx
      .update(slots)
      .set({
        state: "free",
        teamName: null,
        ownerUserId: null,
        messageId: null,
        jumpUrl: null,
        updatedAt: new Date(),
      })
      .where(and(eq(slots.id, slotId), eq(slots.ownerUserId, ownerUserId)))
      .returning();

    const row = rows[0];

    if (!row) return null;

    await tx.delete(slotMembers).where(eq(slotMembers.slotId, slotId));

    return toSlot(row, []);
  });
}

/**
 * Moves a slot to a state.
 *
 * The moderator path: "Add Team", "Remove Team", "Change Team". The
 * source did this with array surgery on `available_slots` plus a row
 * insert or delete; here it is a state change on one row.
 */
export async function setSlotState(
  slotId: string,
  state: SlotState,
  values: {
    readonly teamName?: string | null;
    readonly ownerUserId?: string | null;
    readonly members?: readonly string[];
  } = {},
): Promise<SlotRecord | null> {
  return writeTransaction(async (tx) => {
    const patch: Partial<typeof slots.$inferInsert> = {
      state,
      updatedAt: new Date(),
    };

    if (values.teamName !== undefined) patch.teamName = values.teamName;
    if (values.ownerUserId !== undefined) patch.ownerUserId = values.ownerUserId;

    const rows = await tx
      .update(slots)
      .set(patch)
      .where(eq(slots.id, slotId))
      .returning();

    const row = rows[0];

    if (!row) return null;

    if (values.members !== undefined) {
      const members = await replaceSlotMembers(tx, slotId, values.members);

      return toSlot(row, members);
    }

    const members = await loadSlotMembers(tx, [slotId]);

    return toSlot(row, members.get(slotId) ?? []);
  });
}

/**
 * Replaces a slot's team, in one statement.
 *
 * The "Change Team" button. The source wrote the team name and the
 * owner in two separate statements, which could leave a half-changed
 * slot behind.
 *
 * The member list is replaced, not merged: the team that was on the
 * slot is the team that is off it.
 */
export async function changeSlotTeam(
  slotId: string,
  values: {
    readonly teamName: string;
    readonly ownerUserId: string | null;
    readonly members: readonly string[];
  },
): Promise<SlotRecord | null> {
  return writeTransaction(async (tx) => {
    const rows = await tx
      .update(slots)
      .set({
        state: "claimed",
        teamName: values.teamName,
        ownerUserId: values.ownerUserId,
        updatedAt: new Date(),
      })
      .where(eq(slots.id, slotId))
      .returning();

    const row = rows[0];

    if (!row) return null;

    const members = await replaceSlotMembers(tx, slotId, values.members);

    return toSlot(row, members);
  });
}

/**
 * Creates the free slots of a scrim.
 *
 * Called when registration opens. A free slot is a **row**, so the
 * whole range is materialised up front rather than being discovered one
 * at a time.
 */
export async function createFreeSlots(
  scrimId: string,
  numbers: readonly number[],
): Promise<void> {
  if (numbers.length === 0) return;

  await writeLock(() =>
    db
      .insert(slots)
      .values(
        numbers.map((num) => ({
          scrimId,
          num,
          state: "free" as const,
        })),
      )
      .onConflictDoNothing(),
  );
}

/**
 * Deletes every slot of a scrim.
 *
 * Opening a scrim resets its slots, so this runs first. The members of
 * the slots go with them.
 */
export async function deleteSlots(scrimId: string): Promise<void> {
  await writeLock(() => db.delete(slots).where(eq(slots.scrimId, scrimId)));
}

/** The owners of the claimed slots of a scrim. */
export async function listClaimedOwnerIds(scrimId: string): Promise<string[]> {
  const rows = await db
    .select({ ownerUserId: slots.ownerUserId })
    .from(slots)
    .where(and(eq(slots.scrimId, scrimId), eq(slots.state, "claimed")));

  return rows
    .map((row) => row.ownerUserId)
    .filter((id): id is string => id !== null);
}

/** The team names of the claimed slots of a scrim. */
export async function listClaimedTeamNames(
  scrimId: string,
): Promise<string[]> {
  const rows = await db
    .select({ teamName: slots.teamName })
    .from(slots)
    .where(and(eq(slots.scrimId, scrimId), eq(slots.state, "claimed")));

  return rows
    .map((row) => row.teamName)
    .filter((name): name is string => name !== null);
}

/**
 * The claimed slots of a scrim that already hold one of these members.
 *
 * The source asked this as raw SQL with an array-overlap operator
 * (`$2 && SLOTS.MEMBERS`) against a schema-qualified join table. Ours
 * is a **join** against `slot_members`: the same question, asked of a
 * table that exists on both engines.
 *
 * The join is also faster than the operator was — the index on
 * `slot_members.user_id` does the work — and it says what it means: a
 * slot matches when one of its member rows names one of these users.
 *
 * @param excludeSlotId the slot being checked, when there is one. A
 *        slot never counts as a duplicate of itself.
 */
export async function findFakeTagMatches(
  scrimId: string,
  memberIds: readonly string[],
  excludeSlotId: string | null = null,
): Promise<SlotRecord[]> {
  if (memberIds.length === 0) return [];

  const rows = await db
    .selectDistinct({ slot: slots })
    .from(slots)
    .innerJoin(slotMembers, eq(slotMembers.slotId, slots.id))
    .where(
      and(
        eq(slots.scrimId, scrimId),
        eq(slots.state, "claimed"),
        inArray(slotMembers.userId, [...memberIds]),
        excludeSlotId ? ne(slots.id, excludeSlotId) : undefined,
      ),
    );

  const matched = rows.map((row) => row.slot);

  const members = await loadSlotMembers(
    db,
    matched.map((slot) => slot.id),
  );

  return matched.map((slot) => toSlot(slot, members.get(slot.id) ?? []));
}

/* ------------------------------------------------------------------ *
 * Reserved slots
 * ------------------------------------------------------------------ */

/** Every reserved slot of a scrim, in slot-number order. */
export async function listReservedSlots(
  scrimId: string,
): Promise<ReservedSlotRecord[]> {
  const rows = await db
    .select()
    .from(reservedSlots)
    .where(eq(reservedSlots.scrimId, scrimId))
    .orderBy(asc(reservedSlots.num));

  const members = await loadReservedMembers(
    db,
    rows.map((row) => row.id),
  );

  return rows.map((row) => toReservedSlot(row, members.get(row.id) ?? []));
}

/**
 * Reserves a slot.
 *
 * The reservation replaces any earlier one for the same number, which is
 * what the source did by deleting the old row first.
 */
export async function reserveSlot(
  values: {
    readonly scrimId: string;
    readonly num: number;
    readonly userId: string | null;
    readonly teamName: string;
    readonly members: readonly string[];
    readonly expires: Date | null;
  },
): Promise<ReservedSlotRecord | null> {
  return writeTransaction(async (tx) => {
    await tx
      .delete(reservedSlots)
      .where(
        and(
          eq(reservedSlots.scrimId, values.scrimId),
          eq(reservedSlots.num, values.num),
        ),
      );

    const rows = await tx
      .insert(reservedSlots)
      .values({
        scrimId: values.scrimId,
        num: values.num,
        userId: values.userId,
        teamName: values.teamName,
        expires: values.expires,
      })
      .returning();

    const row = rows[0];

    if (!row) return null;

    const members = await replaceReservedMembers(tx, row.id, values.members);

    return toReservedSlot(row, members);
  });
}

/** Removes a reservation. */
export async function deleteReservedSlot(slotId: string): Promise<void> {
  await writeLock(() =>
    db.delete(reservedSlots).where(eq(reservedSlots.id, slotId)),
  );
}

/** Removes every reservation of a scrim. */
export async function deleteReservedSlots(scrimId: string): Promise<void> {
  await writeLock(() =>
    db.delete(reservedSlots).where(eq(reservedSlots.scrimId, scrimId)),
  );
}

/* ------------------------------------------------------------------ *
 * Bans
 * ------------------------------------------------------------------ */

/** Every ban of a scrim. */
export async function listBans(scrimId: string): Promise<BannedTeamRecord[]> {
  const rows = await db
    .select()
    .from(bannedTeams)
    .where(eq(bannedTeams.scrimId, scrimId))
    .orderBy(asc(bannedTeams.createdAt));

  const members = await loadBannedMembers(
    db,
    rows.map((row) => row.id),
  );

  return rows.map((row) => toBannedTeam(row, members.get(row.id) ?? []));
}

/** The users banned from a scrim. */
export async function listBannedUserIds(scrimId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: bannedTeams.userId })
    .from(bannedTeams)
    .where(eq(bannedTeams.scrimId, scrimId));

  return rows.map((row) => row.userId);
}

/** Is this user banned from this scrim? */
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

/**
 * Bans a user from a scrim.
 *
 * The unique constraint on `(scrim_id, user_id)` makes this idempotent:
 * banning twice updates the row instead of stacking a second one.
 */
export async function banUser(
  values: {
    readonly scrimId: string;
    readonly userId: string;
    readonly teamName: string | null;
    readonly members: readonly string[];
    readonly reason: string | null;
    readonly expires: Date | null;
  },
): Promise<BannedTeamRecord | null> {
  return writeTransaction(async (tx) => {
    const rows = await tx
      .insert(bannedTeams)
      .values({
        scrimId: values.scrimId,
        userId: values.userId,
        teamName: values.teamName,
        reason: values.reason,
        expires: values.expires,
      })
      .onConflictDoUpdate({
        target: [bannedTeams.scrimId, bannedTeams.userId],
        set: {
          teamName: values.teamName,
          reason: values.reason,
          expires: values.expires,
          updatedAt: new Date(),
        },
      })
      .returning();

    const row = rows[0];

    if (!row) return null;

    const members = await replaceBannedMembers(tx, row.id, values.members);

    return toBannedTeam(row, members);
  });
}

/** Lifts a ban. */
export async function unbanUser(scrimId: string, userId: string): Promise<void> {
  await writeLock(() =>
    db
      .delete(bannedTeams)
      .where(
        and(eq(bannedTeams.scrimId, scrimId), eq(bannedTeams.userId, userId)),
      ),
  );
}

/** The scrims a user is banned from, in one guild. */
export async function listScrimsBanning(
  guildId: string,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ scrimId: bannedTeams.scrimId })
    .from(bannedTeams)
    .innerJoin(scrims, eq(bannedTeams.scrimId, scrims.id))
    .where(and(eq(scrims.guildId, guildId), eq(bannedTeams.userId, userId)));

  return rows.map((row) => row.scrimId);
}

/** The channel a guild writes its ban log to. */
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

/** Sets the channel a guild writes its ban log to. */
export async function setBanLogChannel(
  guildId: string,
  channelId: string,
): Promise<void> {
  await writeLock(() =>
    db
      .insert(banLogs)
      .values({ guildId, channelId })
      .onConflictDoUpdate({
        target: banLogs.guildId,
        set: { channelId, updatedAt: new Date() },
      }),
  );
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

/** The payload of a scrim job. */
export interface ScrimJobPayload {
  readonly scrimId: string;
  readonly [key: string]: unknown;
}

/**
 * Arms a job for a scrim.
 *
 * The scheduler is the durable `jobs` table, never a `setTimeout`: a
 * timer that dies with the process means the scrim never opens again.
 */
export async function scheduleJob(
  event: JobEvent,
  expiresAt: Date,
  payload: ScrimJobPayload,
  userId: string | null = null,
): Promise<string> {
  return writeLock(() => scheduleJobUnlocked(event, expiresAt, payload, userId));
}

/** The write behind {@link scheduleJob}, without the lock. */
async function scheduleJobUnlocked(
  event: JobEvent,
  expiresAt: Date,
  payload: ScrimJobPayload,
  userId: string | null = null,
): Promise<string> {
  const rows = await db
    .insert(jobs)
    .values({ event, expiresAt, payload, userId })
    .returning({ id: jobs.id });

  const id = rows[0]?.id;

  if (!id) throw new Error("the job insert returned no id");

  return id;
}

/**
 * Replaces the job of one kind for one scrim.
 *
 * The source deleted the old timer and created a new one whenever the
 * schedule changed. Same here, so there is never two timers for one
 * scrim.
 */
export async function replaceScrimJob(
  event: JobEvent,
  scrimId: string,
  expiresAt: Date,
  payload: ScrimJobPayload = { scrimId },
  userId: string | null = null,
): Promise<string> {
  return writeLock(async () => {
    await db
      .delete(jobs)
      .where(
        and(
          eq(jobs.event, event),
          sql`${jobs.payload} ->> 'scrimId' = ${scrimId}`,
        ),
      );

    return scheduleJobUnlocked(event, expiresAt, payload, userId);
  });
}

/**
 * Deletes every job of one kind for one scrim.
 *
 * The payload is JSON, and `->>` reads one key out of it on both
 * engines — Postgres on a `jsonb`, SQLite (3.38 and later) on the JSON
 * text the column holds. Every id is still a bind parameter.
 */
export async function deleteScrimJobs(
  event: JobEvent,
  scrimId: string,
): Promise<void> {
  await writeLock(() =>
    db
      .delete(jobs)
      .where(
        and(
          eq(jobs.event, event),
          sql`${jobs.payload} ->> 'scrimId' = ${scrimId}`,
        ),
      ),
  );
}

/** The jobs of one kind for one scrim. */
export async function listScrimJobs(
  event: JobEvent,
  scrimId: string,
): Promise<{ id: string; expiresAt: Date }[]> {
  const rows = await db
    .select({ id: jobs.id, expiresAt: jobs.expiresAt })
    .from(jobs)
    .where(
      and(
        eq(jobs.event, event),
        sql`${jobs.payload} ->> 'scrimId' = ${scrimId}`,
      ),
    );

  return rows;
}

/** The jobs of one kind that are due at a given instant. */
export async function listDueJobs(
  event: JobEvent,
  now: Date,
): Promise<{ id: string; payload: unknown; expiresAt: Date }[]> {
  const rows = await db
    .select({ id: jobs.id, payload: jobs.payload, expiresAt: jobs.expiresAt })
    .from(jobs)
    .where(and(eq(jobs.event, event), lte(jobs.expiresAt, now)));

  return rows;
}

/** Deletes a job by id. The dispatcher deletes before it dispatches. */
export async function deleteJob(id: string): Promise<void> {
  await writeLock(() => db.delete(jobs).where(eq(jobs.id, id)));
}

/** The scrim ids a job is about. */
export function scrimIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;

  const scrimId = (payload as Record<string, unknown>).scrimId;

  return typeof scrimId === "string" ? scrimId : null;
}

/** The user ids a job is about. */
export function userIdsOf(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];

  const raw = (payload as Record<string, unknown>).userIds;

  if (!Array.isArray(raw)) return [];

  return raw.filter((id): id is string => typeof id === "string");
}

/** The scrim ids a job is about, as a list. */
export function scrimIdsOf(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];

  const raw = (payload as Record<string, unknown>).scrimIds;

  if (!Array.isArray(raw)) return [];

  return raw.filter((id): id is string => typeof id === "string");
}

/** Every scrim id a job is about, whichever key it used. */
export function allScrimIdsOf(payload: unknown): string[] {
  const single = scrimIdOf(payload);
  const many = scrimIdsOf(payload);

  if (single) return [single, ...many];

  return many;
}

/** The ids of the slots a job is about. */
export function slotIdsOf(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];

  const raw = (payload as Record<string, unknown>).slotIds;

  if (!Array.isArray(raw)) return [];

  return raw.filter((id): id is string => typeof id === "string");
}

/** The ids of the scrims a set of slots belong to. */
export async function listScrimIdsForSlots(
  slotIds: readonly string[],
): Promise<string[]> {
  if (slotIds.length === 0) return [];

  const rows = await db
    .selectDistinct({ scrimId: slots.scrimId })
    .from(slots)
    .where(inArray(slots.id, [...slotIds]));

  return rows.map((row) => row.scrimId);
}
