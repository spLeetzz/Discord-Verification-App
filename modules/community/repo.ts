/**
 * The SQL of the community area.
 *
 * Every statement the community module runs lives here, and nothing else
 * runs any. The tables are imported from `db/schema.ts`; this file never
 * spells out DDL and never names a column the schema does not have.
 *
 * Two statements are hand-written SQL, and both are for a reason:
 *
 *  - the tag usage counter is an atomic `usage = usage + 1`, which has to
 *    be one statement (S6, query 6);
 *  - the auto-role toggle is an `INSERT … ON CONFLICT DO UPDATE` that adds
 *    or removes a role id in the array **atomically**. Quotient did the
 *    same thing with `ARRAY_APPEND`/`ARRAY_REMOVE`, and a read-modify-write
 *    here would race two moderators clicking at once.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  autoroleConfigs,
  autopurgeConfigs,
  commandUsage,
  jobs,
  snipes,
  tags,
} from "../../db/schema.js";
import type { JobEvent } from "../../db/schema.js";
import type {
  AutoroleConfig,
  AutoPurgeConfig,
  AutoPurgeJobPayload,
  CommandUsageEntry,
  GuildTagStats,
  MemberTagStat,
  ReminderJobPayload,
  ReminderRecord,
  SnipeRecord,
  TagOwnerCount,
  TagRecord,
  TagUserUseCount,
} from "./types.js";

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

/** A tag row, as the area sees it. */
function toTagRecord(row: typeof tags.$inferSelect): TagRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    content: row.content,
    isEmbed: row.isEmbed,
    isNsfw: row.isNsfw,
    ownerId: row.ownerId,
    usage: row.usage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Finds a tag by its canonical name.
 *
 * The name is matched exactly, because the canonical form is what is
 * stored — see `service.ts`.
 */
export async function findTagByName(
  guildId: string,
  name: string,
): Promise<TagRecord | null> {
  const rows = await db
    .select()
    .from(tags)
    .where(and(eq(tags.guildId, guildId), eq(tags.name, name)))
    .limit(1);

  const row = rows[0];

  return row ? toTagRecord(row) : null;
}

/** Finds a tag by its id. */
export async function findTagById(
  guildId: string,
  id: string,
): Promise<TagRecord | null> {
  const rows = await db
    .select()
    .from(tags)
    .where(and(eq(tags.guildId, guildId), eq(tags.id, id)))
    .limit(1);

  const row = rows[0];

  return row ? toTagRecord(row) : null;
}

/** Every tag of a guild, oldest first. */
export async function listTags(guildId: string): Promise<TagRecord[]> {
  const rows = await db
    .select()
    .from(tags)
    .where(eq(tags.guildId, guildId))
    .orderBy(asc(tags.createdAt));

  return rows.map(toTagRecord);
}

/** Every tag a member owns in a guild. */
export async function listTagsByOwner(
  guildId: string,
  ownerId: string,
): Promise<TagRecord[]> {
  const rows = await db
    .select()
    .from(tags)
    .where(and(eq(tags.guildId, guildId), eq(tags.ownerId, ownerId)))
    .orderBy(asc(tags.createdAt));

  return rows.map(toTagRecord);
}

/**
 * The tags whose name contains the query, case-insensitively.
 *
 * The source's `name__icontains`. At most `limit` of them.
 */
export async function listTagsMatching(
  guildId: string,
  query: string,
  limit = 10,
): Promise<TagRecord[]> {
  const rows = await db
    .select()
    .from(tags)
    .where(
      and(
        eq(tags.guildId, guildId),
        sql`${tags.name} ILIKE ${`%${query}%`}`,
      ),
    )
    .orderBy(asc(tags.name))
    .limit(limit);

  return rows.map(toTagRecord);
}

/** Inserts a tag. */
export async function insertTag(tag: {
  guildId: string;
  name: string;
  content: string;
  isEmbed: boolean;
  ownerId: string;
}): Promise<TagRecord> {
  const rows = await db
    .insert(tags)
    .values({
      guildId: tag.guildId,
      name: tag.name,
      content: tag.content,
      isEmbed: tag.isEmbed,
      ownerId: tag.ownerId,
    })
    .returning();

  const row = rows[0];

  if (!row) {
    throw new Error("The tag was not written.");
  }

  return toTagRecord(row);
}

/** Replaces a tag's body. */
export async function updateTagContent(
  id: string,
  content: string,
  isEmbed: boolean,
): Promise<void> {
  await db
    .update(tags)
    .set({ content, isEmbed, updatedAt: new Date() })
    .where(eq(tags.id, id));
}

/** Changes a tag's owner. */
export async function updateTagOwner(id: string, ownerId: string): Promise<void> {
  await db
    .update(tags)
    .set({ ownerId, updatedAt: new Date() })
    .where(eq(tags.id, id));
}

/** Flips a tag's NSFW flag and returns the new value. */
export async function setTagNsfw(id: string, nsfw: boolean): Promise<void> {
  await db
    .update(tags)
    .set({ isNsfw: nsfw, updatedAt: new Date() })
    .where(eq(tags.id, id));
}

/** Deletes a tag. */
export async function deleteTag(id: string): Promise<void> {
  await db.delete(tags).where(eq(tags.id, id));
}

/** Deletes every tag a member owns in a guild. */
export async function deleteTagsByOwner(
  guildId: string,
  ownerId: string,
): Promise<number> {
  const deleted = await db
    .delete(tags)
    .where(and(eq(tags.guildId, guildId), eq(tags.ownerId, ownerId)))
    .returning({ id: tags.id });

  return deleted.length;
}

/**
 * Counts one use of a tag.
 *
 * Atomic on purpose: `usage = usage + 1` has to be one statement, or two
 * people using the tag at the same time lose a count (S6, query 6).
 */
export async function incrementTagUsage(
  guildId: string,
  name: string,
): Promise<void> {
  await db.execute(
    sql`UPDATE tags SET usage = usage + 1, updated_at = now() WHERE guild_id = ${guildId} AND name = ${name}`,
  );
}

/* ------------------------------------------------------------------ *
 * The tag statistics
 * ------------------------------------------------------------------ */

/**
 * How many times each member used the tag command in a guild.
 *
 * The source's raw SQL:
 *
 * ```sql
 * SELECT COUNT(*) AS tag_uses, user_id FROM commands
 *  WHERE guild_id=$1 AND cmd='tag'
 *  GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 3;
 * ```
 *
 * The `count(*)` is cast to `int`: `pg` returns a `bigint` as a string,
 * and a count that comes back as `"3"` is a bug waiting to happen.
 */
export async function countTagUsesByUser(
  guildId: string,
  limit = 3,
): Promise<TagUserUseCount[]> {
  const rows = await db
    .select({
      userId: commandUsage.userId,
      uses: sql<number>`count(*)::int`,
    })
    .from(commandUsage)
    .where(
      and(
        eq(commandUsage.guildId, guildId),
        eq(commandUsage.cmd, "tag"),
      ),
    )
    .groupBy(commandUsage.userId)
    .orderBy(sql`count(*) DESC`)
    .limit(limit);

  return rows.map((row) => ({ userId: row.userId, uses: row.uses }));
}

/**
 * How many times one member used the tag command in a guild.
 *
 * The source's raw SQL:
 *
 * ```sql
 * SELECT COUNT(*) FROM commands
 *  WHERE guild_id=$1 AND cmd='tag' AND user_id=$2;
 * ```
 */
export async function countTagCommandUses(
  guildId: string,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ uses: sql<number>`count(*)::int` })
    .from(commandUsage)
    .where(
      and(
        eq(commandUsage.guildId, guildId),
        eq(commandUsage.cmd, "tag"),
        eq(commandUsage.userId, userId),
      ),
    );

  return rows[0]?.uses ?? 0;
}

/**
 * How many tags each member owns in a guild.
 *
 * The source's raw SQL:
 *
 * ```sql
 * SELECT COUNT(*) AS "Tags", owner_id FROM tags
 *  WHERE guild_id=$1 GROUP BY owner_id ORDER BY COUNT(*) DESC LIMIT 3;
 * ```
 */
export async function countTagsByOwner(
  guildId: string,
  limit = 3,
): Promise<TagOwnerCount[]> {
  const rows = await db
    .select({
      ownerId: tags.ownerId,
      count: sql<number>`count(*)::int`,
    })
    .from(tags)
    .where(eq(tags.guildId, guildId))
    .groupBy(tags.ownerId)
    .orderBy(sql`count(*) DESC`)
    .limit(limit);

  return rows.map((row) => ({ ownerId: row.ownerId, count: row.count }));
}

/** The most used tags of a guild. */
export async function listTopTags(
  guildId: string,
  limit = 3,
): Promise<{ name: string; usage: number }[]> {
  const rows = await db
    .select({ name: tags.name, usage: tags.usage })
    .from(tags)
    .where(eq(tags.guildId, guildId))
    .orderBy(desc(tags.usage))
    .limit(limit);

  return rows.map((row) => ({ name: row.name, usage: row.usage }));
}

/** How many tags a guild has, and how many times they have been used. */
export async function countGuildTagTotals(
  guildId: string,
): Promise<{ totalTags: number; totalUses: number }> {
  const rows = await db
    .select({
      totalTags: sql<number>`count(*)::int`,
      totalUses: sql<number>`coalesce(sum(${tags.usage}), 0)::int`,
    })
    .from(tags)
    .where(eq(tags.guildId, guildId));

  const row = rows[0];

  return {
    totalTags: row?.totalTags ?? 0,
    totalUses: row?.totalUses ?? 0,
  };
}

/**
 * A member's own tag statistics.
 *
 * The source's raw SQL:
 *
 * ```sql
 * SELECT name, usage, COUNT(*) OVER() AS "Count", SUM(usage) OVER () AS "Uses"
 *   FROM tags WHERE guild_id=$1 AND owner_id=$2
 *  ORDER BY usage DESC LIMIT 3;
 * ```
 *
 * The window functions are computed over the whole set before the limit
 * takes effect, so `totalTags` is the member's real total and not the
 * number of rows that survived the limit.
 */
export async function listMemberTagStats(
  guildId: string,
  ownerId: string,
  limit = 3,
): Promise<MemberTagStat[]> {
  const rows = await db
    .select({
      name: tags.name,
      usage: tags.usage,
      totalTags: sql<number>`count(*) OVER ()::int`,
      totalUses: sql<number>`sum(${tags.usage}) OVER ()::int`,
    })
    .from(tags)
    .where(and(eq(tags.guildId, guildId), eq(tags.ownerId, ownerId)))
    .orderBy(desc(tags.usage))
    .limit(limit);

  return rows.map((row) => ({
    name: row.name,
    usage: row.usage,
    totalTags: row.totalTags,
    totalUses: row.totalUses,
  }));
}

/** The whole guild-wide statistics, in one call. */
export async function getGuildTagStats(guildId: string): Promise<GuildTagStats> {
  const [totals, topTags, topUsers, topCreators] = await Promise.all([
    countGuildTagTotals(guildId),
    listTopTags(guildId),
    countTagUsesByUser(guildId),
    countTagsByOwner(guildId),
  ]);

  return {
    totalTags: totals.totalTags,
    totalUses: totals.totalUses,
    topTags,
    topUsers,
    topCreators,
  };
}

/* ------------------------------------------------------------------ *
 * Snipes
 * ------------------------------------------------------------------ */

/** A snipe row, as the area sees it. */
function toSnipeRecord(row: typeof snipes.$inferSelect): SnipeRecord {
  return {
    id: row.id,
    channelId: row.channelId,
    authorId: row.authorId,
    content: row.content,
    nsfw: row.nsfw,
    createdAt: row.createdAt,
  };
}

/** Stores the last deleted message of a channel, replacing the old one. */
export async function upsertSnipe(snipe: {
  channelId: string;
  authorId: string;
  content: string;
  nsfw: boolean;
}): Promise<void> {
  await db
    .insert(snipes)
    .values({
      channelId: snipe.channelId,
      authorId: snipe.authorId,
      content: snipe.content,
      nsfw: snipe.nsfw,
    })
    .onConflictDoUpdate({
      target: snipes.channelId,
      set: {
        authorId: snipe.authorId,
        content: snipe.content,
        nsfw: snipe.nsfw,
        updatedAt: new Date(),
      },
    });
}

/** The last deleted message of a channel. */
export async function findSnipe(
  channelId: string,
): Promise<SnipeRecord | null> {
  const rows = await db
    .select()
    .from(snipes)
    .where(eq(snipes.channelId, channelId))
    .limit(1);

  const row = rows[0];

  return row ? toSnipeRecord(row) : null;
}

/**
 * Deletes the snipes that are older than the cutoff.
 *
 * @returns how many were removed.
 */
export async function deleteSnipesOlderThan(cutoff: Date): Promise<number> {
  const deleted = await db
    .delete(snipes)
    .where(sql`${snipes.createdAt} < ${cutoff}`)
    .returning({ id: snipes.id });

  return deleted.length;
}

/* ------------------------------------------------------------------ *
 * Auto-purge
 * ------------------------------------------------------------------ */

/** An auto-purge row, as the area sees it. */
function toAutoPurgeConfig(
  row: typeof autopurgeConfigs.$inferSelect,
): AutoPurgeConfig {
  return {
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    deleteAfter: row.deleteAfter,
    createdAt: row.createdAt,
  };
}

/** The auto-purge config of a channel. */
export async function findAutoPurgeConfig(
  channelId: string,
): Promise<AutoPurgeConfig | null> {
  const rows = await db
    .select()
    .from(autopurgeConfigs)
    .where(eq(autopurgeConfigs.channelId, channelId))
    .limit(1);

  const row = rows[0];

  return row ? toAutoPurgeConfig(row) : null;
}

/** Every auto-purge channel of a guild. */
export async function listAutoPurgeConfigs(
  guildId: string,
): Promise<AutoPurgeConfig[]> {
  const rows = await db
    .select()
    .from(autopurgeConfigs)
    .where(eq(autopurgeConfigs.guildId, guildId))
    .orderBy(asc(autopurgeConfigs.createdAt));

  return rows.map(toAutoPurgeConfig);
}

/** How many auto-purge channels a guild has. */
export async function countAutoPurgeConfigs(guildId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(autopurgeConfigs)
    .where(eq(autopurgeConfigs.guildId, guildId));

  return rows[0]?.count ?? 0;
}

/**
 * The id of every auto-purge channel, in every guild.
 *
 * The cache is built from this at startup.
 */
export async function listAutoPurgeChannelIds(): Promise<string[]> {
  const rows = await db
    .select({ channelId: autopurgeConfigs.channelId })
    .from(autopurgeConfigs);

  return rows.map((row) => row.channelId);
}

/** Creates an auto-purge config. */
export async function insertAutoPurgeConfig(config: {
  guildId: string;
  channelId: string;
  deleteAfter: number;
}): Promise<void> {
  await db.insert(autopurgeConfigs).values({
    guildId: config.guildId,
    channelId: config.channelId,
    deleteAfter: config.deleteAfter,
  });
}

/** Removes an auto-purge config. */
export async function deleteAutoPurgeConfig(channelId: string): Promise<void> {
  await db.delete(autopurgeConfigs).where(eq(autopurgeConfigs.channelId, channelId));
}

/* ------------------------------------------------------------------ *
 * Auto-roles
 * ------------------------------------------------------------------ */

/** An auto-role row, as the area sees it. */
function toAutoroleConfig(
  row: typeof autoroleConfigs.$inferSelect,
): AutoroleConfig {
  return {
    id: row.id,
    guildId: row.guildId,
    humans: row.humans,
    bots: row.bots,
  };
}

/** The auto-role config of a guild. */
export async function findAutoroleConfig(
  guildId: string,
): Promise<AutoroleConfig | null> {
  const rows = await db
    .select()
    .from(autoroleConfigs)
    .where(eq(autoroleConfigs.guildId, guildId))
    .limit(1);

  const row = rows[0];

  return row ? toAutoroleConfig(row) : null;
}

/**
 * Adds a role to an auto-role list, or removes it when it is already there.
 *
 * The whole thing is one statement, so two moderators clicking at the same
 * moment cannot lose a role. The source did the same with
 * `ARRAY_APPEND`/`ARRAY_REMOVE`, but read the row first and wrote it back
 * afterwards.
 *
 * @returns the list after the change.
 */
export async function toggleAutoroleRole(
  guildId: string,
  kind: "humans" | "bots",
  roleId: string,
): Promise<string[]> {
  const column = kind === "humans" ? "humans" : "bots";

  const rows = await db.execute<{ humans: string[]; bots: string[] }>(sql`
    INSERT INTO ${autoroleConfigs} (guild_id, ${sql.raw(column)}, created_at, updated_at)
    VALUES (${guildId}, ARRAY[${roleId}]::text[], now(), now())
    ON CONFLICT (guild_id) DO UPDATE SET
      ${sql.raw(column)} = CASE
        WHEN ${roleId} = ANY(${sql.raw(column)}) THEN array_remove(${sql.raw(column)}, ${roleId}::text)
        ELSE array_append(${sql.raw(column)}, ${roleId}::text)
      END,
      updated_at = now()
    RETURNING humans, bots
  `);

  const row = rows.rows[0];

  if (!row) return [];

  return kind === "humans" ? row.humans : row.bots;
}

/**
 * Removes a role id from an auto-role list.
 *
 * Used by the self-healing path: a role that no longer exists is dropped
 * from the list rather than failing every join.
 */
export async function removeAutoroleRole(
  guildId: string,
  kind: "humans" | "bots",
  roleId: string,
): Promise<void> {
  const column = kind === "humans" ? "humans" : "bots";

  await db.execute(sql`
    UPDATE ${autoroleConfigs}
       SET ${sql.raw(column)} = array_remove(${sql.raw(column)}, ${roleId}::text),
           updated_at = now()
     WHERE guild_id = ${guildId}
  `);
}

/** Empties both auto-role lists. */
export async function clearAutoroleRoles(guildId: string): Promise<void> {
  await db
    .update(autoroleConfigs)
    .set({ humans: [], bots: [], updatedAt: new Date() })
    .where(eq(autoroleConfigs.guildId, guildId));
}

/* ------------------------------------------------------------------ *
 * The durable scheduler
 * ------------------------------------------------------------------ */

/** Writes a job row. */
export async function insertJob(job: {
  id?: string;
  expiresAt: Date;
  event: JobEvent;
  payload: Record<string, unknown>;
  userId?: string | null;
}): Promise<string> {
  const rows = await db
    .insert(jobs)
    .values({
      ...(job.id ? { id: job.id } : {}),
      expiresAt: job.expiresAt,
      event: job.event,
      payload: job.payload,
      userId: job.userId ?? null,
    })
    .returning({ id: jobs.id });

  return rows[0]?.id ?? "";
}

/** Deletes a job row. */
export async function deleteJob(id: string): Promise<void> {
  await db.delete(jobs).where(eq(jobs.id, id));
}

/** Deletes every job row of an event. */
export async function deleteJobsByEvent(event: JobEvent): Promise<number> {
  const deleted = await db
    .delete(jobs)
    .where(eq(jobs.event, event))
    .returning({ id: jobs.id });

  return deleted.length;
}

/** How many job rows of an event exist. */
export async function countJobs(event: JobEvent): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.event, event));

  return rows[0]?.count ?? 0;
}

/**
 * A user's running reminders, the latest first.
 *
 * The source scanned the whole table with
 * `extra #>> '{args,0}' = $1`; the schema gives `jobs` a `user_id` column
 * and an index on it (S6, query 4), so this is an index lookup.
 */
export async function listUserReminders(
  userId: string,
  limit = 10,
): Promise<ReminderRecord[]> {
  const rows = await db
    .select({
      id: jobs.id,
      expiresAt: jobs.expiresAt,
      payload: jobs.payload,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .where(and(eq(jobs.event, "reminder"), eq(jobs.userId, userId)))
    .orderBy(desc(jobs.expiresAt))
    .limit(limit);

  return rows.map((row) => {
    const payload = row.payload as Partial<ReminderJobPayload> | null;

    return {
      id: row.id,
      expiresAt: row.expiresAt,
      message:
        typeof payload?.message === "string" ? payload.message : "(no text)",
      channelId:
        typeof payload?.channelId === "string" ? payload.channelId : "",
      userId,
      createdAt: row.createdAt,
    };
  });
}

/* ------------------------------------------------------------------ *
 * The command-usage log
 * ------------------------------------------------------------------ */

/**
 * Writes one row of the command-usage log.
 *
 * The dispatcher calls this once per command invocation.
 */
export async function recordCommandUsage(entry: CommandUsageEntry): Promise<void> {
  await db.insert(commandUsage).values({
    guildId: entry.guildId,
    channelId: entry.channelId,
    userId: entry.userId,
    cmd: entry.cmd,
    prefix: entry.prefix,
    failed: entry.failed,
  });
}
