/**
 * The SQL of the community area.
 *
 * Every statement the community module runs lives here, and nothing else
 * runs any. The tables are imported from `db/schema.ts`; this file never
 * spells out DDL and never names a column the schema does not have.
 *
 * **Nothing here is written for one engine.** The schema is a dialect
 * neutral subset of SQL and the differences are confined to `db/dialect.ts`,
 * so this file never says `ILIKE`, never says `now()`, and never casts
 * with `::`. The two rules that used to need hand-written SQL are now
 * ordinary builder statements:
 *
 *  - the tag usage counter is an atomic `usage = usage + 1`, which has to
 *    be one statement (S6, query 6);
 *  - the auto-role toggle adds or removes a role **atomically**. The
 *    roles live in a join table now, and the toggle is an insert that
 *    conflicts — the database's own answer to "is it there already?" —
 *    followed, when it did conflict, by a delete. A read-modify-write here
 *    would race two moderators clicking at once, which is exactly what
 *    Quotient's `ARRAY_APPEND` did.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  autoroleConfigs,
  autoroleRoles,
  autopurgeConfigs,
  commandUsage,
  jobs,
  snipes,
  tags,
} from "../../db/schema.js";
import type { AutoroleKind as SchemaAutoroleKind } from "../../db/schema.js";
import type { JobEvent } from "../../db/schema.js";
import type {
  AutoroleConfig,
  AutoroleKind,  AutoPurgeConfig,
  CommandUsageEntry,
  GuildTagStats,
  JobRecord,
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

/**
 * Is this error a unique-constraint violation?
 *
 * Postgres reports it as SQLSTATE `23505`, and `pg` puts the error in the
 * `cause` of the one it throws. SQLite reports it as the extended code
 * `SQLITE_CONSTRAINT_UNIQUE`, which the driver puts on the error itself.
 *
 * Both are answered here, because "that name is taken" is the same
 * answer whichever engine the bot is running on.
 */
export function isUniqueViolation(error: unknown): boolean {
  const candidate = error as
    | { code?: string; cause?: { code?: string } }
    | undefined;

  const code = candidate?.cause?.code ?? candidate?.code;

  return code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE";
}

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
 *
 * **`lower(col) LIKE lower(?)`, not `ILIKE`.** `ILIKE` is Postgres-only.
 * SQLite's `LIKE` is already case-insensitive for ASCII, and the
 * `lower()` on *both* sides is what makes the two engines behave the
 * same: the column is folded and the pattern is folded, so the
 * comparison is an exact one between two folded strings.
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
        sql`lower(${tags.name}) LIKE lower(${`%${query}%`})`,
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

/**
 * How many tags a member owns in a guild.
 *
 * The count is what the member's allowance is checked against, so it
 * runs on every `/tag create`. The table is small — every member is
 * capped — so the count is cheap even without a dedicated index.
 */
export async function countOwnerTags(
  guildId: string,
  ownerId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`cast(count(*) as integer)` })
    .from(tags)
    .where(and(eq(tags.guildId, guildId), eq(tags.ownerId, ownerId)));

  return rows[0]?.count ?? 0;
}

/**
 * Deletes the tags that have never been used and have not been touched
 * for a while.
 *
 * A tag that has been used is never pruned: `incrementTagUsage` bumps
 * `updated_at`, so a tag in daily use keeps its row. What goes is the
 * tag somebody made once and forgot about.
 *
 * @param cutoff the tags older than this are removed.
 * @returns how many rows were removed.
 */
export async function deleteUnusedTags(cutoff: Date): Promise<number> {
  const deleted = await db
    .delete(tags)
    .where(and(eq(tags.usage, 0), sql`${tags.updatedAt} < ${cutoff}`))
    .returning({ id: tags.id });

  return deleted.length;
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
 *
 * The statement is a builder statement rather than hand-written SQL, and
 * that is what makes the timestamp portable: `updated_at` is epoch
 * milliseconds on SQLite and a `timestamptz` on Postgres, and the driver
 * encodes the `Date` the way the column stores it. A raw `now()` would
 * only ever mean one engine's clock.
 */
export async function incrementTagUsage(
  guildId: string,
  name: string,
): Promise<void> {
  await db
    .update(tags)
    .set({ usage: sql`${tags.usage} + 1`, updatedAt: new Date() })
    .where(and(eq(tags.guildId, guildId), eq(tags.name, name)));
}

/* ------------------------------------------------------------------ *
 * The tag statistics
 * ------------------------------------------------------------------ */

/**
 * The command names the tag statistics count.
 *
 * The source filtered on `cmd='tag'`, and its `tag` group was invoked
 * without a subcommand, so that was every *use* of a tag.
 *
 * The port's `/tag` is a group with fourteen subcommands, so the row may
 * hold either the top-level name (`tag`) or the qualified one
 * (`tag show`), depending on what the dispatcher writes. Both are
 * counted, and nothing else is: `like 'tag %'` needs the space, so
 * `tagcheck` is not a tag command.
 */
const TAG_COMMAND_FILTER = sql`(${commandUsage.cmd} = 'tag' or ${commandUsage.cmd} like 'tag %')`;

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
      uses: sql<number>`cast(count(*) as integer)`,
    })
    .from(commandUsage)
    .where(and(eq(commandUsage.guildId, guildId), TAG_COMMAND_FILTER))
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
    .select({ uses: sql<number>`cast(count(*) as integer)` })
    .from(commandUsage)
    .where(
      and(
        eq(commandUsage.guildId, guildId),
        eq(commandUsage.userId, userId),
        TAG_COMMAND_FILTER,
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
      count: sql<number>`cast(count(*) as integer)`,
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
      totalTags: sql<number>`cast(count(*) as integer)`,
      totalUses: sql<number>`cast(coalesce(sum(${tags.usage}), 0) as integer)`,
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
      totalTags: sql<number>`cast(count(*) OVER () as integer)`,
      totalUses: sql<number>`cast(sum(${tags.usage}) OVER () as integer)`,
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
    .select({ count: sql<number>`cast(count(*) as integer)` })
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

/**
 * The two auto-role lists, in the schema's vocabulary.
 *
 * The command surface says "humans" and "bots" — those are the
 * subcommand names — and the join table says "human" and "bot". The
 * mapping is here so the two vocabularies meet in exactly one place.
 *
 * `satisfies` is what keeps the two in step: a kind the schema does not
 * have, or a list with no kind, is a compile error rather than a row
 * nobody can read back.
 */
const AUTOROLE_LIST_KIND = {
  humans: "human",
  bots: "bot",
} as const satisfies Record<AutoroleKind, SchemaAutoroleKind>;

/**
 * Makes sure the guild has an auto-role config row.
 *
 * The config row is the parent of every role row, so it has to exist
 * before one can be written. The insert is a statement of its own and it
 * is atomic: two moderators toggling roles at the same moment both run
 * it, and the unique constraint on `guild_id` means exactly one of them
 * writes the row.
 */
async function ensureAutoroleConfig(guildId: string): Promise<void> {
  await db
    .insert(autoroleConfigs)
    .values({ guildId })
    .onConflictDoNothing({ target: autoroleConfigs.guildId });
}

/**
 * The role ids of one auto-role list, oldest first.
 */
async function listAutoroleRoles(
  guildId: string,
  kind: SchemaAutoroleKind,
): Promise<string[]> {
  const rows = await db
    .select({ roleId: autoroleRoles.roleId })
    .from(autoroleRoles)
    .where(
      and(
        eq(autoroleRoles.guildId, guildId),
        eq(autoroleRoles.kind, kind),
      ),
    )
    .orderBy(asc(autoroleRoles.createdAt), asc(autoroleRoles.roleId));

  return rows.map((row) => row.roleId);
}

/**
 * The auto-role config of a guild.
 *
 * The roles live in a join table now, so the config is the config row
 * plus the rows that belong to it. The two lists are folded back into
 * the shape the area has always spoken in, so nothing above this file
 * knows that the storage changed.
 */
export async function findAutoroleConfig(
  guildId: string,
): Promise<AutoroleConfig | null> {
  const [configRows, roleRows] = await Promise.all([
    db
      .select()
      .from(autoroleConfigs)
      .where(eq(autoroleConfigs.guildId, guildId))
      .limit(1),
    db
      .select({ kind: autoroleRoles.kind, roleId: autoroleRoles.roleId })
      .from(autoroleRoles)
      .where(eq(autoroleRoles.guildId, guildId)),
  ]);

  const config = configRows[0];

  if (!config) return null;

  const humans: string[] = [];
  const bots: string[] = [];

  for (const row of roleRows) {
    if (row.kind === "human") humans.push(row.roleId);
    else if (row.kind === "bot") bots.push(row.roleId);
  }

  return { id: config.id, guildId: config.guildId, humans, bots };
}

/**
 * Adds a role to an auto-role list, or removes it when it is already there.
 *
 * **The toggle is decided by the database, not by a read.** The insert
 * carries the unique constraint on `(guild_id, kind, role_id)`, so:
 *
 *  - the role is not there yet, the insert succeeds and returns the row:
 *    the role has been added;
 *  - the role is there already, the insert conflicts and returns nothing:
 *    the role has to come out, and the delete removes it.
 *
 * There is no read of the list anywhere in that decision, so there is no
 * window in which two moderators clicking at once can lose a role. The
 * source did the same thing with `ARRAY_APPEND`/`ARRAY_REMOVE`, but read
 * the row first and wrote it back afterwards, and the read-then-write is
 * exactly the race.
 *
 * @returns the list after the change, and whether the role was added.
 */
export async function toggleAutoroleRole(
  guildId: string,
  kind: AutoroleKind,
  roleId: string,
): Promise<{ roles: string[]; added: boolean }> {
  const schemaKind = AUTOROLE_LIST_KIND[kind];

  await ensureAutoroleConfig(guildId);

  const inserted = await db
    .insert(autoroleRoles)
    .values({ guildId, kind: schemaKind, roleId })
    .onConflictDoNothing()
    .returning({ id: autoroleRoles.id });

  const added = inserted.length > 0;

  if (!added) {
    await db
      .delete(autoroleRoles)
      .where(
        and(
          eq(autoroleRoles.guildId, guildId),
          eq(autoroleRoles.kind, schemaKind),
          eq(autoroleRoles.roleId, roleId),
        ),
      );
  }

  return { roles: await listAutoroleRoles(guildId, schemaKind), added };
}

/**
 * Removes a role id from an auto-role list.
 *
 * Used by the self-healing path: a role that no longer exists is dropped
 * from the list rather than failing every join.
 */
export async function removeAutoroleRole(
  guildId: string,
  kind: AutoroleKind,
  roleId: string,
): Promise<void> {
  await db
    .delete(autoroleRoles)
    .where(
      and(
        eq(autoroleRoles.guildId, guildId),
        eq(autoroleRoles.kind, AUTOROLE_LIST_KIND[kind]),
        eq(autoroleRoles.roleId, roleId),
      ),
    );
}

/**
 * Empties both auto-role lists.
 *
 * The config row stays: it says the guild has auto-roles, not that it
 * has any at the moment. That is the shape the command has always
 * spoken in, and `/autorole config` still answers.
 */
export async function clearAutoroleRoles(guildId: string): Promise<void> {
  await db.delete(autoroleRoles).where(eq(autoroleRoles.guildId, guildId));
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

/**
 * The job row with this id, if it is there.
 *
 * The id is the row's identity, so this is how the area finds the one
 * daily housekeeping row it owns.
 */
export async function findJob(id: string): Promise<JobRecord | null> {
  const rows = await db
    .select({
      id: jobs.id,
      event: jobs.event,
      expiresAt: jobs.expiresAt,
      createdAt: jobs.createdAt,
      payload: jobs.payload,
    })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1);

  const row = rows[0];

  return row
    ? {
        id: row.id,
        event: row.event,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        payload: row.payload,
      }
    : null;
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

/** How many reminders a user has running. */
export async function countUserReminders(userId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`cast(count(*) as integer)` })
    .from(jobs)
    .where(and(eq(jobs.event, "reminder"), eq(jobs.userId, userId)));

  return rows[0]?.count ?? 0;
}

/**
 * Deletes one of a member's running reminders.
 *
 * The delete is conditional on the row being **the member's** reminder,
 * so a member cannot delete somebody else's by guessing an id.
 *
 * @returns whether a row was removed.
 */
export async function deleteUserReminder(
  id: string,
  userId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(jobs)
    .where(
      and(
        eq(jobs.id, id),
        eq(jobs.event, "reminder"),
        eq(jobs.userId, userId),
      ),
    )
    .returning({ id: jobs.id });

  return deleted.length > 0;
}

/**
 * Deletes every running reminder of a member.
 *
 * @returns how many rows were removed.
 */
export async function deleteUserReminders(userId: string): Promise<number> {
  const deleted = await db
    .delete(jobs)
    .where(and(eq(jobs.event, "reminder"), eq(jobs.userId, userId)))
    .returning({ id: jobs.id });

  return deleted.length;
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
