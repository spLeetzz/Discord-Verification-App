/**
 * All the SQL the identity area owns, and nothing else.
 *
 * Five tables are touched here:
 *
 *  - `tagcheck_channels`  — the channels where a captain registers a team;
 *  - `easytag_channels`   — the channels where raw ids become mentions;
 *  - `ss_configs`         — the screenshot-verification setups;
 *  - `ss_config_keywords` — the words a setup's custom filter matches on;
 *  - `ss_submissions`     — the screenshots that were submitted.
 *
 * Three rules the shape of this file follows:
 *
 *  - **Roles and channels are ids.** Nothing here looks a role or a
 *    channel up by name (D16). The one exception is documented below.
 *  - **A submission belongs to exactly one configuration** (D13), so the
 *    join table is gone and the foreign key does the work.
 *  - **A setup is looked up by its guild *and* its row id.** The row id
 *    travels in a custom id, so the guild is part of the key: a setup of
 *    another server is not found and cannot be written.
 */

import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { SelectedFields, SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { db, withTransaction } from "../../db/client.js";
import type { DbExecutor } from "../../db/client.js";
import {
  easytagChannels,
  ssConfigKeywords,
  ssConfigs,
  ssSubmissions,
  tagcheckChannels,
} from "../../db/schema.js";
import type { ScreenshotType } from "../../db/schema.js";
import type {
  EasyTagConfig,
  SsConfig,
  SsSubmission,
  TagCheckConfig,
} from "./types.js";

/* ------------------------------------------------------------------ *
 * Tag check
 * ------------------------------------------------------------------ */

const tagCheckColumns = {
  id: tagcheckChannels.id,
  guildId: tagcheckChannels.guildId,
  channelId: tagcheckChannels.channelId,
  requiredMentions: tagcheckChannels.requiredMentions,
  deleteAfter: tagcheckChannels.deleteAfter,
} as const;

/** Every tag-check channel of a guild, oldest first. */
export async function listTagCheckChannels(
  guildId: string,
): Promise<TagCheckConfig[]> {
  const rows = await db
    .select(tagCheckColumns)
    .from(tagcheckChannels)
    .where(eq(tagcheckChannels.guildId, guildId))
    .orderBy(asc(tagcheckChannels.createdAt));

  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      ignoreRoleId: await readTagCheckIgnoreRole(row.id),
    })),
  );
}

/** One tag-check channel, by its channel id. */
export async function findTagCheckByChannel(
  channelId: string,
): Promise<TagCheckConfig | null> {
  const [row] = await db
    .select(tagCheckColumns)
    .from(tagcheckChannels)
    .where(eq(tagcheckChannels.channelId, channelId))
    .limit(1);

  if (!row) return null;

  return { ...row, ignoreRoleId: await readTagCheckIgnoreRole(row.id) };
}

/** One tag-check channel, by its row id. */
export async function findTagCheckById(
  id: string,
): Promise<TagCheckConfig | null> {
  const [row] = await db
    .select(tagCheckColumns)
    .from(tagcheckChannels)
    .where(eq(tagcheckChannels.id, id))
    .limit(1);

  if (!row) return null;

  return { ...row, ignoreRoleId: await readTagCheckIgnoreRole(row.id) };
}

/** How many tag-check channels a guild has. */
export async function countTagCheckChannels(guildId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tagcheckChannels)
    .where(eq(tagcheckChannels.guildId, guildId));

  return row?.count ?? 0;
}

/**
 * The channel id of every tag-check channel.
 *
 * The cache's loader: it wants the ids and nothing else, and it does not
 * want the ignore role of every row (D21).
 */
export async function listTagCheckChannelIds(): Promise<string[]> {
  const rows = await db
    .select({ channelId: tagcheckChannels.channelId })
    .from(tagcheckChannels);

  return rows.map((row) => row.channelId);
}

/** Creates a tag-check channel. */
export async function insertTagCheckChannel(input: {
  guildId: string;
  channelId: string;
  requiredMentions: number;
}): Promise<string> {
  const [row] = await db
    .insert(tagcheckChannels)
    .values({
      guildId: input.guildId,
      channelId: input.channelId,
      requiredMentions: input.requiredMentions,
    })
    .returning({ id: tagcheckChannels.id });

  if (!row) {
    throw new Error("could not create the tag-check channel");
  }

  return row.id;
}

/** Removes a tag-check channel. */
export async function deleteTagCheckChannel(channelId: string): Promise<void> {
  await db
    .delete(tagcheckChannels)
    .where(eq(tagcheckChannels.channelId, channelId));
}

/** Turns the auto-delete of a tag-check channel on or off. */
export async function toggleTagCheckAutoDelete(
  channelId: string,
): Promise<boolean | null> {
  const [row] = await db
    .update(tagcheckChannels)
    .set({
      deleteAfter: sql`not ${tagcheckChannels.deleteAfter}`,
      updatedAt: new Date(),
    })
    .where(eq(tagcheckChannels.channelId, channelId))
    .returning({ deleteAfter: tagcheckChannels.deleteAfter });

  return row?.deleteAfter ?? null;
}

/* ------------------------------------------------------------------ *
 * Easy tag
 * ------------------------------------------------------------------ */

const easyTagColumns = {
  id: easytagChannels.id,
  guildId: easytagChannels.guildId,
  channelId: easytagChannels.channelId,
  deleteAfter: easytagChannels.deleteAfter,
} as const;

/** Every easy-tag channel of a guild, oldest first. */
export async function listEasyTagChannels(
  guildId: string,
): Promise<EasyTagConfig[]> {
  const rows = await db
    .select(easyTagColumns)
    .from(easytagChannels)
    .where(eq(easytagChannels.guildId, guildId))
    .orderBy(asc(easytagChannels.createdAt));

  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      ignoreRoleId: await readEasyTagIgnoreRole(row.id),
    })),
  );
}

/** One easy-tag channel, by its channel id. */
export async function findEasyTagByChannel(
  channelId: string,
): Promise<EasyTagConfig | null> {
  const [row] = await db
    .select(easyTagColumns)
    .from(easytagChannels)
    .where(eq(easytagChannels.channelId, channelId))
    .limit(1);

  if (!row) return null;

  return { ...row, ignoreRoleId: await readEasyTagIgnoreRole(row.id) };
}

/** How many easy-tag channels a guild has. */
export async function countEasyTagChannels(guildId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(easytagChannels)
    .where(eq(easytagChannels.guildId, guildId));

  return row?.count ?? 0;
}

/**
 * The channel id of every easy-tag channel.
 *
 * The cache's loader (D21).
 */
export async function listEasyTagChannelIds(): Promise<string[]> {
  const rows = await db
    .select({ channelId: easytagChannels.channelId })
    .from(easytagChannels);

  return rows.map((row) => row.channelId);
}

/** Creates an easy-tag channel. */
export async function insertEasyTagChannel(input: {
  guildId: string;
  channelId: string;
}): Promise<string> {
  const [row] = await db
    .insert(easytagChannels)
    .values({ guildId: input.guildId, channelId: input.channelId })
    .returning({ id: easytagChannels.id });

  if (!row) {
    throw new Error("could not create the easy-tag channel");
  }

  return row.id;
}

/** Removes an easy-tag channel. */
export async function deleteEasyTagChannel(channelId: string): Promise<void> {
  await db.delete(easytagChannels).where(eq(easytagChannels.channelId, channelId));
}

/** Turns the auto-delete of an easy-tag channel on or off. */
export async function toggleEasyTagAutoDelete(
  channelId: string,
): Promise<boolean | null> {
  const [row] = await db
    .update(easytagChannels)
    .set({
      deleteAfter: sql`not ${easytagChannels.deleteAfter}`,
      updatedAt: new Date(),
    })
    .where(eq(easytagChannels.channelId, channelId))
    .returning({ deleteAfter: easytagChannels.deleteAfter });

  return row?.deleteAfter ?? null;
}

/* ------------------------------------------------------------------ *
 * The ignore role
 *
 * Quotient looked the role named `quotient-tag-ignore` up **on every
 * message** and, when the guild did not have it, never created it. The
 * port stores the role's **id** on the configuration row (D16).
 *
 * The ratified schema (`docs/porting/schema.md`, §S3/§S5, migrated and
 * verified) has no `ignore_role_id` column on `tagcheck_channels` or
 * `easytag_channels`, so the column is read and written through a raw
 * projection. When it is absent — which is the case until the schema
 * engineer adds it — the read returns `null` and the write is skipped, and
 * the module falls back to the id it resolved in this process. The failure
 * is reported once rather than on every message.
 * ------------------------------------------------------------------ */

/** Set once the column has been found to be missing. */
let ignoreRoleColumnMissing = false;

/**
 * Reads the ignore-role id of a tag-check row.
 *
 * @returns the id, or `null` when it has not been set (or when the column
 *          does not exist yet).
 */
export async function readTagCheckIgnoreRole(
  configId: string,
): Promise<string | null> {
  if (ignoreRoleColumnMissing) return null;

  try {
    const [row] = await db
      .select({ ignoreRoleId: sql<string | null>`"ignore_role_id"` })
      .from(tagcheckChannels)
      .where(eq(tagcheckChannels.id, configId))
      .limit(1);

    return row?.ignoreRoleId ?? null;
  } catch (error) {
    reportMissingIgnoreRoleColumn(error);

    return null;
  }
}

/**
 * Reads the ignore-role id of an easy-tag row.
 */
export async function readEasyTagIgnoreRole(
  configId: string,
): Promise<string | null> {
  if (ignoreRoleColumnMissing) return null;

  try {
    const [row] = await db
      .select({ ignoreRoleId: sql<string | null>`"ignore_role_id"` })
      .from(easytagChannels)
      .where(eq(easytagChannels.id, configId))
      .limit(1);

    return row?.ignoreRoleId ?? null;
  } catch (error) {
    reportMissingIgnoreRoleColumn(error);

    return null;
  }
}

/**
 * Stores the ignore-role id on a tag-check row.
 *
 * @returns whether the id was written.
 */
export async function writeTagCheckIgnoreRole(
  configId: string,
  roleId: string,
): Promise<boolean> {
  if (ignoreRoleColumnMissing) return false;

  try {
    await db.execute(
      sql`update "tagcheck_channels" set "ignore_role_id" = ${roleId} where "id" = ${configId}`,
    );

    return true;
  } catch (error) {
    reportMissingIgnoreRoleColumn(error);

    return false;
  }
}

/**
 * Stores the ignore-role id on an easy-tag row.
 */
export async function writeEasyTagIgnoreRole(
  configId: string,
  roleId: string,
): Promise<boolean> {
  if (ignoreRoleColumnMissing) return false;

  try {
    await db.execute(
      sql`update "easytag_channels" set "ignore_role_id" = ${roleId} where "id" = ${configId}`,
    );

    return true;
  } catch (error) {
    reportMissingIgnoreRoleColumn(error);

    return false;
  }
}

/**
 * Reports the missing column once.
 *
 * A missing column is a queue item for the schema engineer, not a crash:
 * the feature still works with the id this process resolved.
 */
function reportMissingIgnoreRoleColumn(error: unknown): void {
  if (ignoreRoleColumnMissing) return;

  ignoreRoleColumnMissing = true;

  console.warn(
    "[identity] The configuration rows have no `ignore_role_id` column yet, " +
      "so the ignore-role id cannot be persisted. The role is still honoured " +
      "for as long as this process runs. Please add the column to " +
      "`tagcheck_channels` and `easytag_channels`.",
    error instanceof Error ? error.message : String(error),
  );
}

/* ------------------------------------------------------------------ *
 * Screenshot verification — the setups
 * ------------------------------------------------------------------ */

const ssConfigColumns = {
  id: ssConfigs.id,
  guildId: ssConfigs.guildId,
  channelId: ssConfigs.channelId,
  roleId: ssConfigs.roleId,
  requiredSs: ssConfigs.requiredSs,
  channelName: ssConfigs.channelName,
  channelLink: ssConfigs.channelLink,
  allowSame: ssConfigs.allowSame,
  duplicateThreshold: ssConfigs.duplicateThreshold,
  ssType: ssConfigs.ssType,
  successMessage: ssConfigs.successMessage,
} as const;

/**
 * The row the setups table hands back.
 *
 * The keywords are not on it: they live in `ss_config_keywords`.
 */
type SsConfigRow = SelectedFields<typeof ssConfigColumns>;

/**
 * Anything that can run a query.
 *
 * The database itself and a transaction handle both qualify, so a helper
 * used from both paths does the same thing in both.
 */
type Executor = Pick<DbExecutor, "select" | "insert" | "update" | "delete">;

/**
 * The `ss_type` column is a `text` with a `CHECK` constraint, so the
 * database guarantees the value is one of the allowed ones. Drizzle types
 * it as `string`; this is where it becomes the union.
 */
const asScreenshotType = (value: string): ScreenshotType =>
  value as ScreenshotType;

/**
 * A setup, with the keywords that belong to it.
 *
 * The keywords are read from their own table, so they are handed in.
 */
function toSsConfig(row: SsConfigRow, keywords: readonly string[]): SsConfig {
  return {
    ...row,
    keywords: [...keywords],
    ssType: asScreenshotType(row.ssType),
  };
}

/* ------------------------------------------------------------------ *
 * The keywords of a setup
 *
 * The keywords used to be a `text[]` column on `ss_configs`. They are
 * rows in `ss_config_keywords` now, one row per keyword, with a unique
 * index on `(ss_config_id, keyword)`.
 * ------------------------------------------------------------------ */

/**
 * The keywords of several setups, keyed by the setup's id.
 *
 * One query for the whole list: a panel that shows ten setups must not
 * make ten round trips.
 *
 * **The order.** The join table has no ordinal, so the order is the
 * order the rows were written in — `created_at` first, and the keyword
 * itself for the rows written in the same millisecond. The *set* is what
 * the rules use; the order only decides which keyword a refusal names.
 */
async function readKeywords(
  executor: Executor,
  ssConfigIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byConfig = new Map<string, string[]>();

  if (ssConfigIds.length === 0) return byConfig;

  const rows = await executor
    .select({
      ssConfigId: ssConfigKeywords.ssConfigId,
      keyword: ssConfigKeywords.keyword,
    })
    .from(ssConfigKeywords)
    .where(inArray(ssConfigKeywords.ssConfigId, [...ssConfigIds]))
    .orderBy(asc(ssConfigKeywords.createdAt), asc(ssConfigKeywords.keyword));

  for (const row of rows) {
    const list = byConfig.get(row.ssConfigId) ?? [];

    list.push(row.keyword);

    byConfig.set(row.ssConfigId, list);
  }

  return byConfig;
}

/**
 * Writes a setup's keyword set.
 *
 * **Two statements, both about the whole set.** The keywords that are
 * wanted go in with a conflict clause — the unique index on
 * `(ss_config_id, keyword)` makes the insert idempotent, so a keyword
 * that is already there is stored once and the write cannot fail on it —
 * and the ones that are gone are deleted. Neither statement reads the
 * table first: this is a write, not a read followed by a write.
 *
 * The two statements have to run together, so the caller puts them in one
 * transaction: a reader must never see the union of the old set and the
 * new one.
 *
 * **The keywords are stored as they were given.** The comparison
 * normalises them — case-insensitively, with the spaces stripped — when
 * it looks at them, so normalising here would change what the operator
 * typed and lose the raw value.
 */
async function writeKeywords(
  executor: Executor,
  ssConfigId: string,
  keywords: readonly string[],
): Promise<void> {
  const wanted = [...new Set(keywords)];

  if (wanted.length > 0) {
    await executor
      .insert(ssConfigKeywords)
      .values(wanted.map((keyword) => ({ ssConfigId, keyword })))
      .onConflictDoNothing();
  }

  // An empty set is "no keyword at all", which is not the same as "keep
  // the ones that are there" — so the whole set goes.
  if (wanted.length === 0) {
    await executor
      .delete(ssConfigKeywords)
      .where(eq(ssConfigKeywords.ssConfigId, ssConfigId));

    return;
  }

  await executor
    .delete(ssConfigKeywords)
    .where(
      and(
        eq(ssConfigKeywords.ssConfigId, ssConfigId),
        notInArray(ssConfigKeywords.keyword, wanted),
      ),
    );
}

/** Every setup of a guild, oldest first. */
export async function listSsConfigs(guildId: string): Promise<SsConfig[]> {
  const rows = await db
    .select(ssConfigColumns)
    .from(ssConfigs)
    .where(eq(ssConfigs.guildId, guildId))
    .orderBy(asc(ssConfigs.createdAt));

  const keywords = await readKeywords(
    db,
    rows.map((row) => row.id),
  );

  return rows.map((row) => toSsConfig(row, keywords.get(row.id) ?? []));
}

/**
 * One setup, by its row id **and** its guild.
 *
 * The guild is part of the key on purpose. The row id travels in a custom
 * id, so a lookup by id alone would answer a question about a setup of
 * another server — and the panel's buttons would then edit it. A uuid
 * makes that guess unguessable, not impossible, so the guild is checked as
 * well: a setup of another guild is simply not found.
 */
export async function findSsConfigById(
  guildId: string,
  id: string,
): Promise<SsConfig | null> {
  const [row] = await db
    .select(ssConfigColumns)
    .from(ssConfigs)
    .where(and(eq(ssConfigs.guildId, guildId), eq(ssConfigs.id, id)))
    .limit(1);

  if (!row) return null;

  const keywords = await readKeywords(db, [row.id]);

  return toSsConfig(row, keywords.get(row.id) ?? []);
}

/** One setup, by its channel id. */
export async function findSsConfigByChannel(
  channelId: string,
): Promise<SsConfig | null> {
  const [row] = await db
    .select(ssConfigColumns)
    .from(ssConfigs)
    .where(eq(ssConfigs.channelId, channelId))
    .limit(1);

  if (!row) return null;

  const keywords = await readKeywords(db, [row.id]);

  return toSsConfig(row, keywords.get(row.id) ?? []);
}

/** How many setups a guild has. */
export async function countSsConfigs(guildId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ssConfigs)
    .where(eq(ssConfigs.guildId, guildId));

  return row?.count ?? 0;
}

/**
 * The channel id of every screenshot-verification setup.
 *
 * The cache's loader (D21).
 */
export async function listSsConfigChannelIds(): Promise<string[]> {
  const rows = await db
    .select({ channelId: ssConfigs.channelId })
    .from(ssConfigs);

  return rows.map((row) => row.channelId);
}

/**
 * Is there at least one screenshot-verification setup?
 *
 * The whole table, not one guild's: the question is whether **this
 * deployment** uses screenshot verification at all, and that is what the
 * automatic half of the OCR decision asks (see `ocr.ts`).
 *
 * One row is enough, so the query stops at the first one.
 */
export async function hasSsConfig(): Promise<boolean> {
  const [row] = await db
    .select({ id: ssConfigs.id })
    .from(ssConfigs)
    .limit(1);

  return row !== undefined;
}

/**
 * Creates a setup.
 *
 * The row and its keywords go in together: a setup whose keywords could
 * not be written is not a setup, and a keyword row without a setup is
 * nothing at all. The transaction is what makes the two one write.
 */
export async function insertSsConfig(input: {
  guildId: string;
  channelId: string;
  roleId: string;
  requiredSs: number;
  channelName: string;
  channelLink: string;
  keywords: readonly string[];
  allowSame: boolean;
  ssType: ScreenshotType;
  successMessage: string | null;
}): Promise<string> {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .insert(ssConfigs)
      .values({
        guildId: input.guildId,
        channelId: input.channelId,
        roleId: input.roleId,
        requiredSs: input.requiredSs,
        channelName: input.channelName,
        channelLink: input.channelLink,
        allowSame: input.allowSame,
        ssType: input.ssType,
        successMessage: input.successMessage,
      })
      .returning({ id: ssConfigs.id });

    if (!row) {
      throw new Error("could not create the screenshot-verification setup");
    }

    await writeKeywords(tx, row.id, input.keywords);

    return row.id;
  });
}

/**
 * The fields of a setup that the editor may write.
 *
 * An explicit list, not `dict(self.record)` (B18): the source's update
 * payload relied on Tortoise internals and wrote columns it had no
 * business writing.
 */
export interface SsConfigPatch {
  readonly channelId?: string;
  readonly roleId?: string;
  readonly requiredSs?: number;
  readonly channelName?: string;
  readonly channelLink?: string;
  readonly keywords?: readonly string[];
  readonly allowSame?: boolean;
  readonly ssType?: ScreenshotType;
  readonly successMessage?: string | null;
}

/**
 * Writes the given fields of a setup.
 *
 * The write is scoped to the guild as well, so a row of another server is
 * never touched — the guard and the lookup both say which guild the
 * caller is acting in, and this is the last line of defence.
 *
 * The keywords are not a column, so they are a second statement — and it
 * shares the transaction with the columns, so a reader never sees half of
 * the edit.
 */
export async function updateSsConfig(
  guildId: string,
  id: string,
  patch: SsConfigPatch,
): Promise<void> {
  const values: SQLiteUpdateSetSource<typeof ssConfigs> = {};

  if (patch.channelId !== undefined) values.channelId = patch.channelId;
  if (patch.roleId !== undefined) values.roleId = patch.roleId;
  if (patch.requiredSs !== undefined) values.requiredSs = patch.requiredSs;
  if (patch.channelName !== undefined) values.channelName = patch.channelName;
  if (patch.channelLink !== undefined) values.channelLink = patch.channelLink;
  if (patch.allowSame !== undefined) values.allowSame = patch.allowSame;
  if (patch.ssType !== undefined) values.ssType = patch.ssType;
  if (patch.successMessage !== undefined) {
    values.successMessage = patch.successMessage;
  }

  const hasColumns = Object.keys(values).length > 0;
  const keywords = patch.keywords;

  if (!hasColumns && keywords === undefined) return;

  await withTransaction(async (tx) => {
    if (hasColumns) {
      values.updatedAt = new Date();

      await tx
        .update(ssConfigs)
        .set(values)
        .where(and(eq(ssConfigs.guildId, guildId), eq(ssConfigs.id, id)));
    }

    if (keywords !== undefined) {
      await writeKeywords(tx, id, keywords);
    }
  });
}

/**
 * Removes a setup.
 *
 * Its submissions go with it: `ss_submissions.ss_config_id` is a foreign
 * key with `ON DELETE CASCADE` (D13), so the source's manual
 * `SSVerify.full_delete()` dance is not needed.
 *
 * The delete is scoped to the guild, like the lookup and the update.
 */
export async function deleteSsConfig(
  guildId: string,
  id: string,
): Promise<void> {
  await db
    .delete(ssConfigs)
    .where(and(eq(ssConfigs.guildId, guildId), eq(ssConfigs.id, id)));
}

/* ------------------------------------------------------------------ *
 * Screenshot verification — the submissions
 * ------------------------------------------------------------------ */

/** Records a submission. */
export async function insertSsSubmission(input: {
  ssConfigId: string;
  authorId: string;
  channelId: string;
  messageId: string;
  dhash: string | null;
  phash: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(ssSubmissions)
    .values({
      ssConfigId: input.ssConfigId,
      authorId: input.authorId,
      channelId: input.channelId,
      messageId: input.messageId,
      dhash: input.dhash,
      phash: input.phash,
    })
    .returning({ id: ssSubmissions.id });

  if (!row) {
    throw new Error("could not record the screenshot submission");
  }

  return row.id;
}

/**
 * Every submission of a setup, oldest first.
 *
 * The order matters: the duplicate check compares against the member's own
 * submissions in the order they were made.
 */
export async function listSsSubmissions(
  ssConfigId: string,
): Promise<SsSubmission[]> {
  const rows = await db
    .select({
      id: ssSubmissions.id,
      ssConfigId: ssSubmissions.ssConfigId,
      authorId: ssSubmissions.authorId,
      channelId: ssSubmissions.channelId,
      messageId: ssSubmissions.messageId,
      dhash: ssSubmissions.dhash,
      phash: ssSubmissions.phash,
      createdAt: ssSubmissions.createdAt,
    })
    .from(ssSubmissions)
    .where(eq(ssSubmissions.ssConfigId, ssConfigId))
    .orderBy(asc(ssSubmissions.createdAt));

  return rows;
}

/** How many screenshots a member has submitted to a setup. */
export async function countSsSubmissions(
  ssConfigId: string,
  authorId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ssSubmissions)
    .where(
      and(
        eq(ssSubmissions.ssConfigId, ssConfigId),
        eq(ssSubmissions.authorId, authorId),
      ),
    );

  return row?.count ?? 0;
}

