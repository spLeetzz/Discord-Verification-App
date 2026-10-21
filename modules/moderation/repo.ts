/**
 * The SQL of the moderation area.
 *
 * Every statement the moderation module runs lives here, and nothing else
 * runs any. The tables are imported from `db/schema.js`; this file never
 * spells out DDL and never names a column that the schema does not have.
 *
 * **The channels a lockdown covers are rows, not a list.** The source kept
 * them in a `text[]` column and rewrote the whole array on every lock and
 * unlock. SQLite has no arrays, so the schema holds them in a join table
 * — `lockdown_channels`, one row per (lockdown, channel) — and the
 * maintenance channels the bot created in `lockdown_maintenance_channels`.
 * The rows are written and read inside the same statements as the lockdown
 * itself, so the list of covered channels is as durable as the lock.
 *
 * **The one interesting query is the job lookup**: a lockdown's job row is
 * found by the lockdown id inside its JSON payload, because the `jobs`
 * table has no column for it.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, withTransaction } from "../../db/client.js";
import {
  BLOCK_ID_TYPES,
  LOCKDOWN_TYPES,
  blocklist,
  jobs,
  lockdownChannels,
  lockdownMaintenanceChannels,
  lockdowns,
} from "../../db/schema.js";
import type {
  BlockIdType,
  LockdownPriorState,
  LockdownType,
} from "../../db/schema.js";
import { lockKey } from "./lock-state.js";
import type {
  BlocklistEntry,
  LockdownJobPayload,
  LockRecord,
} from "./types.js";

/* ------------------------------------------------------------------ *
 * One statement at a time
 * ------------------------------------------------------------------ */

/**
 * The queue of this module's database work.
 *
 * **Why it exists.** SQLite has one writer, and the driver gives a
 * transaction a connection of its own: two transactions that overlap in
 * this process do not queue, they collide — the second one fails with
 * `SQLITE_BUSY` instead of waiting its turn. The gate turns the collision
 * into a queue.
 *
 * **What it does not do.** It does not decide who wins a race. The winner
 * is still the database: the insert of a second lockdown of the same
 * subject is refused by the unique constraint on `lockdowns.lock_key`, and
 * that refusal is what the moderator is told. The gate only makes sure
 * the two statements reach the database one after the other, so the
 * refusal is the constraint's and not the driver's.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs `operation` once every operation queued before it has finished.
 *
 * The queue never rejects: a failed operation must not block the next one.
 */
function serialise<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);

  queue = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

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

/** A lockdown row, as the database has it. */
type LockdownRow = typeof lockdowns.$inferSelect;

/**
 * The columns a lockdown row is read with.
 *
 * The channel ids are not columns of the row: they are rows of
 * `lockdown_channels` and `lockdown_maintenance_channels`, and they are
 * passed in.
 */
function toLockRecord(
  row: LockdownRow,
  channelIds: readonly string[],
  maintenanceChannelIds: readonly string[],
): LockRecord | null {
  const type = asLockdownType(row.type);
  if (!type) return null;

  return {
    id: row.id,
    guildId: row.guildId,
    type,
    roleId: row.roleId,
    channelId: row.channelId,
    channelIds,
    expireTime: row.expireTime,
    priorState: row.priorState,
    authorId: row.authorId,
    // A category lockdown records the *category* in `channel_id`, and a
    // category is not a channel anybody can be told about in a message.
    sourceChannelId: type === "category" ? null : row.channelId,
    // The maintenance channels only mean something for a maintenance
    // lockdown. Every other type reads as an empty list, whatever the
    // join table holds.
    maintenanceChannelIds: type === "maintenance" ? maintenanceChannelIds : [],
  };
}

/**
 * The channels a set of lockdowns covers.
 *
 * Two maps, one per join table: the lockdown id to its channel ids.
 *
 * **The order is the channel id's.** The join table has no column for
 * the order the channels were locked in, so the rows come back sorted by
 * channel id — a fixed order, the same on every read, which is all the
 * callers need. Nothing in the module depends on the order the channels
 * were locked in.
 */
interface LockdownChannels {
  readonly covered: Map<string, readonly string[]>;
  readonly maintenance: Map<string, readonly string[]>;
}

/**
 * Reads the channel rows of a set of lockdowns.
 *
 * One query per join table, whatever the number of lockdowns: the rows
 * are found by the lockdown ids, not one lockdown at a time.
 */
async function loadLockdownChannels(
  lockdownIds: readonly string[],
): Promise<LockdownChannels> {
  const covered = new Map<string, string[]>();
  const maintenance = new Map<string, string[]>();

  if (lockdownIds.length === 0) return { covered, maintenance };

  const channelRows = await db
    .select({
      lockdownId: lockdownChannels.lockdownId,
      channelId: lockdownChannels.channelId,
    })
    .from(lockdownChannels)
    .where(inArray(lockdownChannels.lockdownId, [...lockdownIds]))
    .orderBy(asc(lockdownChannels.channelId));

  for (const row of channelRows) {
    const list = covered.get(row.lockdownId);

    if (list) {
      list.push(row.channelId);
    } else {
      covered.set(row.lockdownId, [row.channelId]);
    }
  }

  const maintenanceRows = await db
    .select({
      lockdownId: lockdownMaintenanceChannels.lockdownId,
      channelId: lockdownMaintenanceChannels.channelId,
    })
    .from(lockdownMaintenanceChannels)
    .where(inArray(lockdownMaintenanceChannels.lockdownId, [...lockdownIds]))
    .orderBy(asc(lockdownMaintenanceChannels.channelId));

  for (const row of maintenanceRows) {
    const list = maintenance.get(row.lockdownId);

    if (list) {
      list.push(row.channelId);
    } else {
      maintenance.set(row.lockdownId, [row.channelId]);
    }
  }

  return { covered, maintenance };
}

/**
 * Turns lockdown rows into records, with the channels they cover.
 */
async function toLockRecords(
  rows: readonly LockdownRow[],
): Promise<LockRecord[]> {
  const channels = await loadLockdownChannels(rows.map((row) => row.id));

  const records: LockRecord[] = [];

  for (const row of rows) {
    const record = toLockRecord(
      row,
      channels.covered.get(row.id) ?? [],
      channels.maintenance.get(row.id) ?? [],
    );

    if (record) records.push(record);
  }

  return records;
}

/**
 * Every lockdown the guild has.
 *
 * The state machine needs all of them: a channel unlock has to know
 * whether the channel is covered by a server lockdown, and a lock has to
 * know whether the same subject is already locked.
 *
 * **The order is fixed.** The rows come back oldest first, with the id as
 * the tiebreaker, so that two reads of the same guild give the same list
 * in the same order — and so that the row an unlock lifts is always the
 * same row.
 */
export async function listLockdowns(guildId: string): Promise<LockRecord[]> {
  return serialise(async () => {
    const rows = await db
      .select()
      .from(lockdowns)
      .where(eq(lockdowns.guildId, guildId))
      .orderBy(asc(lockdowns.createdAt), asc(lockdowns.id));

    return toLockRecords(rows);
  });
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
  return serialise(async () => {
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
      .orderBy(asc(lockdowns.createdAt), asc(lockdowns.id))
      .limit(1);

    const records = await toLockRecords(rows);

    return records[0] ?? null;
  });
}

/**
 * What a new lockdown row holds.
 *
 * The key of the row is derived from the guild, the type and the subject
 * — it is not passed in, so it cannot be the key of something else. See
 * {@link lockKey}.
 */
export interface NewLockdown {
  readonly guildId: string;
  readonly type: LockdownType;
  readonly roleId: string | null;
  readonly channelId: string | null;
  /**
   * Every channel the lockdown touches.
   *
   * They become rows of the `lockdown_channels` join table, in the same
   * transaction as the row that says what the lockdown covers.
   */
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
   * They are written with the row, in the same transaction, so the record
   * of which channels the bot owns survives a restart. A maintenance
   * lockdown has no duration, so it has no job row, and the job row was
   * never a place this could live.
   */
  readonly maintenanceChannelIds: readonly string[];
}

/**
 * Writes a lockdown row, the channels it covers, and the timer that lifts
 * it.
 *
 * **All of it goes in one transaction.** The row, the rows of the channels
 * it covers and the job row are written together or not at all: a
 * lockdown whose channel rows were lost would unlock the wrong channels,
 * and a lockdown whose timer row was lost would stay locked forever, and
 * only a moderator could undo it.
 *
 * **A lockdown with no duration gets no timer.** There is nothing to
 * schedule, and the row itself is the state — the double-lock guard reads
 * it, and the unlock finds the permission state through it. A job row that
 * never fires, used as a data store, would read as a design nobody meant.
 *
 * **The insert is refused by the database when the subject is already
 * locked.** The row carries the key of its subject — `channel:<id>`,
 * `category:<id>`, `maintenance:<roleId>` or `guild:<guildId>` — and the
 * unique constraint on that column is what says "one lockdown per
 * subject". The insert does `ON CONFLICT (lock_key) DO NOTHING`, so the
 * second lockdown of a subject does not get a row: it is refused by the
 * database, not by a read-then-write check, and two moderators who lock
 * the same thing at the same time cannot both get their way.
 *
 * @returns the row that was written, or `null` when the subject is
 *          already locked and the insert was refused.
 */
export async function createLockdown(
  input: NewLockdown,
): Promise<LockRecord | null> {
  return serialise(() =>
    withTransaction(async (tx) => {
      const rows = await tx
        .insert(lockdowns)
        .values({
          guildId: input.guildId,
          type: input.type,
          roleId: input.roleId,
          channelId: input.channelId,
          expireTime: input.expireTime,
          priorState: input.priorState,
          authorId: input.authorId,
          // The key of the subject, written with the row. The unique
          // constraint on it is what refuses a second lockdown of the same
          // subject.
          lockKey: lockKey(input),
        })
        .onConflictDoNothing({ target: lockdowns.lockKey })
        .returning();

      const row = rows[0];

      // No row came back: the unique constraint on `lock_key` refused the
      // insert, so the subject is already locked.
      if (!row) return null;

      // The channels the lockdown covers, in the same transaction as the
      // row that says what it covers. A read-modify-write of a channel
      // list in JavaScript would reintroduce the race the join table is
      // there to remove.
      const covered = [...input.channelIds];

      if (covered.length > 0) {
        await tx.insert(lockdownChannels).values(
          covered.map((channelId) => ({ lockdownId: row.id, channelId })),
        );
      }

      // The maintenance channels the bot created, in the same transaction.
      // Only a maintenance lockdown has any.
      const maintenance =
        input.type === "maintenance" ? [...input.maintenanceChannelIds] : [];

      if (maintenance.length > 0) {
        await tx.insert(lockdownMaintenanceChannels).values(
          maintenance.map((channelId) => ({ lockdownId: row.id, channelId })),
        );
      }

      const record = toLockRecord(row, covered, maintenance);
      if (!record) throw new Error("The lockdown row has an unknown type.");

      if (input.expireTime) {
        const payload: LockdownJobPayload = {
          lockdownId: record.id,
          type: record.type,
          guildId: record.guildId,
          channelIds: covered,
          roleId: record.roleId,
          sourceChannelId: input.sourceChannelId,
        };

        await tx.insert(jobs).values({
          event: "lockdown",
          // The same instant as the lockdown's `expire_time`, and computed
          // by the application rather than by the database: the scheduler
          // fires the row when `expires_at` has passed, so the timer and
          // the expiry have to be the same moment down to the
          // millisecond.
          expiresAt: input.expireTime,
          payload,
        });
      }

      return record;
    }),
  );
}

/**
 * Removes a lockdown row, the channels it covered, and the timer that
 * lifts it.
 *
 * All of it goes in one transaction: a lockdown row left behind without
 * its timer would never lift itself, and channel rows left behind would
 * outlive the lock they belong to.
 */
export async function removeLockdown(id: string): Promise<void> {
  await serialise(() =>
    withTransaction(async (tx) => {
      await tx
        .delete(jobs)
        .where(
          and(
            eq(jobs.event, "lockdown"),
            sql`${jobs.payload}->>'lockdownId' = ${id}`,
          ),
        );

      await tx
        .delete(lockdownChannels)
        .where(eq(lockdownChannels.lockdownId, id));

      await tx
        .delete(lockdownMaintenanceChannels)
        .where(eq(lockdownMaintenanceChannels.lockdownId, id));

      await tx.delete(lockdowns).where(eq(lockdowns.id, id));
    }),
  );
}

/* ------------------------------------------------------------------ *
 * The durable job
 * ------------------------------------------------------------------ */

/**
 * Checks a `jobs.payload` value against the lockdown payload shape.
 *
 * The payload is JSON, so it is `unknown` on the way out of the
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
  return serialise(async () => {
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
  });
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
  return serialise(async () => {
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
  });
}

/**
 * Blocks an id.
 *
 * **The key is the id and the kind.** The unique constraint is on
 * `(block_id, block_id_type)`, so a user and a guild that share an id are
 * two entries and not one: blocking the guild does not block the user,
 * and unblocking one does not unblock the other.
 */
export async function insertBlocklistEntry(entry: {
  readonly blockId: string;
  readonly blockIdType: BlockIdType;
  readonly blockedBy: string | null;
  readonly reason: string | null;
}): Promise<void> {
  await serialise(async () => {
    await db
      .insert(blocklist)
      .values({
        blockId: entry.blockId,
        blockIdType: entry.blockIdType,
        blockedBy: entry.blockedBy,
        reason: entry.reason,
      })
      .onConflictDoNothing({
        target: [blocklist.blockId, blocklist.blockIdType],
      });
  });
}

/** Unblocks an id — the id *and* the kind, never the id alone. */
export async function deleteBlocklistEntry(
  blockId: string,
  blockIdType: BlockIdType,
): Promise<void> {
  await serialise(async () => {
    await db
      .delete(blocklist)
      .where(
        and(
          eq(blocklist.blockId, blockId),
          eq(blocklist.blockIdType, blockIdType),
        ),
      );
  });
}
