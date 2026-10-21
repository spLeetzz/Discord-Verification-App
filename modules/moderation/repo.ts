/**
 * The SQL of the moderation area.
 *
 * Every statement the moderation module runs lives here, and nothing else
 * runs any. The tables are imported from `db/schema.ts`; this file never
 * spells out DDL and never names a column that the schema does not have.
 *
 * The one interesting query is the job lookup: a lockdown's job row is
 * found by the lockdown id inside its JSON payload, because the `jobs`
 * table has no column for it.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  BLOCK_ID_TYPES,
  LOCKDOWN_TYPES,
  blocklist,
  jobs,
  lockdowns,
} from "../../db/schema.js";
import type {
  BlockIdType,
  LockdownPriorState,
  LockdownType,
} from "../../db/schema.js";
import type {
  BlocklistEntry,
  LockdownJobPayload,
  LockRecord,
} from "./types.js";

/* ------------------------------------------------------------------ *
 * Parsing the database's closed columns
 * ------------------------------------------------------------------ */

/**
 * Narrows a `lockdowns.type` column to its union.
 *
 * The column is `text` with a `CHECK`, so the value is one of four — but
 * TypeScript does not know that, and a row written by hand outside the
 * constraint would be a surprise. A value that is not in the set is
 * rejected rather than passed on.
 */
export function asLockdownType(value: string): LockdownType | null {
  return (LOCKDOWN_TYPES as readonly string[]).includes(value)
    ? (value as LockdownType)
    : null;
}

/**
 * Narrows a `blocklist.block_id_type` column to its union.
 *
 * `"1"` is a user, `"2"` is a guild.
 */
export function asBlockIdType(value: string): BlockIdType | null {
  return (BLOCK_ID_TYPES as readonly string[]).includes(value)
    ? (value as BlockIdType)
    : null;
}

/* ------------------------------------------------------------------ *
 * Lockdowns
 * ------------------------------------------------------------------ */

/** The columns a lockdown row is read with. */
function toLockRecord(
  row: typeof lockdowns.$inferSelect,
): LockRecord | null {
  const type = asLockdownType(row.type);
  if (!type) return null;

  return {
    id: row.id,
    guildId: row.guildId,
    type,
    roleId: row.roleId,
    channelId: row.channelId,
    channelIds: row.channelIds,
    expireTime: row.expireTime,
    priorState: row.priorState,
    authorId: row.authorId,
    // A category lockdown records the *category* in `channel_id`, and a
    // category is not a channel anybody can be told about in a message.
    sourceChannelId: type === "category" ? null : row.channelId,
    // The maintenance channels only mean something for a maintenance
    // lockdown. Every other type reads as an empty list, whatever the
    // column happens to say.
    maintenanceChannelIds:
      type === "maintenance" ? row.maintenanceChannelIds : [],
  };
}

/**
 * Every lockdown the guild has.
 *
 * The state machine needs all of them: a channel unlock has to know
 * whether the channel is covered by a server lockdown, and a lock has to
 * know whether the same subject is already locked.
 */
export async function listLockdowns(guildId: string): Promise<LockRecord[]> {
  const rows = await db
    .select()
    .from(lockdowns)
    .where(eq(lockdowns.guildId, guildId));

  return rows
    .map(toLockRecord)
    .filter((record): record is LockRecord => record !== null);
}

/**
 * One lockdown, found by its key.
 *
 * @param type    the kind of lockdown.
 * @param channelId the channel (a channel or category lockdown) or `null`.
 * @param roleId  the role (a maintenance lockdown) or `null`.
 */
export async function findLockdown(
  guildId: string,
  type: LockdownType,
  channelId: string | null = null,
  roleId: string | null = null,
): Promise<LockRecord | null> {
  const conditions = [
    eq(lockdowns.guildId, guildId),
    eq(lockdowns.type, type),
  ];

  if (type === "channel" || type === "category") {
    conditions.push(eq(lockdowns.channelId, channelId ?? ""));
  }

  if (type === "maintenance") {
    conditions.push(eq(lockdowns.roleId, roleId ?? ""));
  }

  const rows = await db
    .select()
    .from(lockdowns)
    .where(and(...conditions))
    .limit(1);

  const row = rows[0];
  return row ? toLockRecord(row) : null;
}

/** What a new lockdown row holds. */
export interface NewLockdown {
  readonly guildId: string;
  readonly type: LockdownType;
  readonly roleId: string | null;
  readonly channelId: string | null;
  readonly channelIds: readonly string[];
  readonly expireTime: Date | null;
  readonly authorId: string;
  /**
   * What each channel's permission looked like before the lock.
   *
   * It is written with the row, in the same statement, so the undo data is
   * as durable as the lock itself: a lockdown with no duration still
   * restores exactly after a restart.
   */
  readonly priorState: LockdownPriorState | null;
  /** Where the lockdown was started from — the closing message goes there. */
  readonly sourceChannelId: string | null;
  /**
   * The maintenance channels the bot created for this lockdown.
   *
   * They are written with the row, in the same statement, so the record of
   * which channels the bot owns survives a restart. A maintenance lockdown
   * has no duration, so it has no job row, and the job row was never a
   * place this could live.
   */
  readonly maintenanceChannelIds: readonly string[];
}

/**
 * Writes a lockdown row, and the timer that lifts it.
 *
 * Both go in one transaction. A lockdown whose timer row was lost between
 * the two writes would stay locked forever, and only a moderator could
 * undo it.
 *
 * **A lockdown with no duration gets no timer.** There is nothing to
 * schedule, and the row itself is the state — the double-lock guard reads
 * it, and the unlock finds the permission state through it. A job row that
 * never fires, used as a data store, would read as a design nobody meant.
 */
export async function createLockdown(input: NewLockdown): Promise<LockRecord> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(lockdowns)
      .values({
        guildId: input.guildId,
        type: input.type,
        roleId: input.roleId,
        channelId: input.channelId,
        channelIds: [...input.channelIds],
        expireTime: input.expireTime,
        priorState: input.priorState,
        // The maintenance channels go in with the row, in the same
        // statement: one write, one row, and the ids of the channels the
        // bot created are as durable as the lock itself. Only a
        // maintenance lockdown has any.
        maintenanceChannelIds:
          input.type === "maintenance" ? [...input.maintenanceChannelIds] : [],
        authorId: input.authorId,
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error("The lockdown row was not returned.");

    const record = toLockRecord(row);
    if (!record) throw new Error("The lockdown row has an unknown type.");

    if (input.expireTime) {
      const payload: LockdownJobPayload = {
        lockdownId: record.id,
        type: record.type,
        guildId: record.guildId,
        channelIds: [...record.channelIds],
        roleId: record.roleId,
        sourceChannelId: input.sourceChannelId,
      };

      await tx.insert(jobs).values({
        event: "lockdown",
        expiresAt: input.expireTime,
        payload,
      });
    }

    return record;
  });
}

/**
 * Removes a lockdown row and the timer that lifts it.
 *
 * Both go in one transaction: a lockdown row left behind without its timer
 * would never lift itself.
 */
export async function removeLockdown(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(jobs)
      .where(
        and(
          eq(jobs.event, "lockdown"),
          sql`${jobs.payload}->>'lockdownId' = ${id}`,
        ),
      );

    await tx.delete(lockdowns).where(eq(lockdowns.id, id));
  });
}

/* ------------------------------------------------------------------ *
 * The durable job
 * ------------------------------------------------------------------ */

/**
 * Checks a `jobs.payload` value against the lockdown payload shape.
 *
 * The payload is `jsonb`, so it is `unknown` on the way out of the
 * database. It is parsed at the boundary rather than cast.
 */
export function parseLockdownJobPayload(
  value: unknown,
): LockdownJobPayload | null {
  if (typeof value !== "object" || value === null) return null;

  const candidate = value as Partial<LockdownJobPayload>;

  if (typeof candidate.lockdownId !== "string") return null;
  if (typeof candidate.guildId !== "string") return null;
  if (!Array.isArray(candidate.channelIds)) return null;

  const type = candidate.type;
  if (!type || !asLockdownType(type)) return null;

  return {
    lockdownId: candidate.lockdownId,
    type,
    guildId: candidate.guildId,
    channelIds: candidate.channelIds.filter(
      (id): id is string => typeof id === "string",
    ),
    roleId: typeof candidate.roleId === "string" ? candidate.roleId : null,
    sourceChannelId:
      typeof candidate.sourceChannelId === "string"
        ? candidate.sourceChannelId
        : null,
  };
}

/** The job row of a lockdown, when it still has one. */
export interface LockdownJob {
  readonly id: string;
  readonly payload: LockdownJobPayload;
}

/** A job row, as the database has it. */
export interface LockdownJobRow {
  readonly id: string;
  /** The JSON payload, unparsed. */
  readonly payload: unknown;
  /** When the job comes due. */
  readonly expiresAt: Date;
}

/**
 * The job rows of a lockdown.
 *
 * A lockdown has one while it has a timer, and none once it is lifted.
 * The payload comes back **raw**, because what is *in* it matters: the
 * permission state is not supposed to be there any more, and only the raw
 * JSON can say so.
 */
export async function listLockdownJobs(
  lockdownId: string,
): Promise<LockdownJobRow[]> {
  const rows = await db
    .select({
      id: jobs.id,
      payload: jobs.payload,
      expiresAt: jobs.expiresAt,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.event, "lockdown"),
        sql`${jobs.payload}->>'lockdownId' = ${lockdownId}`,
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    payload: row.payload,
    expiresAt: row.expiresAt,
  }));
}

/**
 * Finds the job row of a lockdown.
 *
 * The `jobs` table has no column for the lockdown id, so the lookup goes
 * through the JSON payload. The table holds one row per pending job, so
 * the scan is small.
 */
export async function findLockdownJob(
  lockdownId: string,
): Promise<LockdownJob | null> {
  const rows = await listLockdownJobs(lockdownId);
  const row = rows[0];
  if (!row) return null;

  const payload = parseLockdownJobPayload(row.payload);
  if (!payload) return null;

  return { id: row.id, payload };
}

/* ------------------------------------------------------------------ *
 * The block list
 * ------------------------------------------------------------------ */

/** Every block-list entry. */
export async function loadBlocklist(): Promise<BlocklistEntry[]> {
  const rows = await db.select().from(blocklist);
  const entries: BlocklistEntry[] = [];

  for (const row of rows) {
    const blockIdType = asBlockIdType(row.blockIdType);
    if (!blockIdType) continue;

    entries.push({
      blockId: row.blockId,
      blockIdType,
      blockedBy: row.blockedBy,
      reason: row.reason,
    });
  }

  return entries;
}

/** Blocks an id. */
export async function insertBlocklistEntry(entry: {
  readonly blockId: string;
  readonly blockIdType: BlockIdType;
  readonly blockedBy: string | null;
  readonly reason: string | null;
}): Promise<void> {
  await db
    .insert(blocklist)
    .values({
      blockId: entry.blockId,
      blockIdType: entry.blockIdType,
      blockedBy: entry.blockedBy,
      reason: entry.reason,
    })
    .onConflictDoNothing();
}

/** Unblocks an id. */
export async function deleteBlocklistEntry(
  blockId: string,
  blockIdType: BlockIdType,
): Promise<void> {
  await db
    .delete(blocklist)
    .where(
      and(
        eq(blocklist.blockId, blockId),
        eq(blocklist.blockIdType, blockIdType),
      ),
    );
}
