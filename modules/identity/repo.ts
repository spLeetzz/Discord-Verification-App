/**
 * All the SQL the identity area owns, and nothing else.
 *
 * Four tables are touched here:
 *
 *  - `tagcheck_channels`  — the channels where a captain registers a team;
 *  - `easytag_channels`   — the channels where raw ids become mentions;
 *  - `ss_configs`         — the screenshot-verification setups;
 *  - `ss_submissions`     — the screenshots that were submitted.
 *
 * Plus two read-only tables for the group management:
 *
 *  - `tourneys`, `tourney_slots` — the tournament and its registered teams;
 *  - `tourney_group_lists` — the published group lists.
 *
 * Two rules the shape of this file follows:
 *
 *  - **Roles and channels are ids.** Nothing here looks a role or a
 *    channel up by name (D16). The one exception is documented below.
 *  - **A submission belongs to exactly one configuration** (D13), so the
 *    join table is gone and the foreign key does the work.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  easytagChannels,
  ssConfigs,
  ssSubmissions,
  tagcheckChannels,
  tourneyGroupLists,
  tourneySlots,
  tourneys,
} from "../../db/schema.js";
import type { ScreenshotType } from "../../db/schema.js";
import type {
  EasyTagConfig,
  GroupListEntry,
  GroupSlot,
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
  keywords: ssConfigs.keywords,
  allowSame: ssConfigs.allowSame,
  ssType: ssConfigs.ssType,
  successMessage: ssConfigs.successMessage,
} as const;

/**
 * The `ss_type` column is a `text` with a `CHECK` constraint, so the
 * database guarantees the value is one of the allowed ones. Drizzle types
 * it as `string`; this is where it becomes the union.
 */
const asScreenshotType = (value: string): ScreenshotType =>
  value as ScreenshotType;

/** Every setup of a guild, oldest first. */
export async function listSsConfigs(guildId: string): Promise<SsConfig[]> {
  const rows = await db
    .select(ssConfigColumns)
    .from(ssConfigs)
    .where(eq(ssConfigs.guildId, guildId))
    .orderBy(asc(ssConfigs.createdAt));

  return rows.map((row) => ({ ...row, ssType: asScreenshotType(row.ssType) }));
}

/** One setup, by its row id. */
export async function findSsConfigById(id: string): Promise<SsConfig | null> {
  const [row] = await db
    .select(ssConfigColumns)
    .from(ssConfigs)
    .where(eq(ssConfigs.id, id))
    .limit(1);

  return row ? { ...row, ssType: asScreenshotType(row.ssType) } : null;
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

  return row ? { ...row, ssType: asScreenshotType(row.ssType) } : null;
}

/** How many setups a guild has. */
export async function countSsConfigs(guildId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ssConfigs)
    .where(eq(ssConfigs.guildId, guildId));

  return row?.count ?? 0;
}

/** Creates a setup. */
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
  const [row] = await db
    .insert(ssConfigs)
    .values({
      guildId: input.guildId,
      channelId: input.channelId,
      roleId: input.roleId,
      requiredSs: input.requiredSs,
      channelName: input.channelName,
      channelLink: input.channelLink,
      keywords: [...input.keywords],
      allowSame: input.allowSame,
      ssType: input.ssType,
      successMessage: input.successMessage,
    })
    .returning({ id: ssConfigs.id });

  if (!row) {
    throw new Error("could not create the screenshot-verification setup");
  }

  return row.id;
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

/** Writes the given fields of a setup. */
export async function updateSsConfig(
  id: string,
  patch: SsConfigPatch,
): Promise<void> {
  const values: Record<string, unknown> = {};

  if (patch.channelId !== undefined) values["channelId"] = patch.channelId;
  if (patch.roleId !== undefined) values["roleId"] = patch.roleId;
  if (patch.requiredSs !== undefined) values["requiredSs"] = patch.requiredSs;
  if (patch.channelName !== undefined) values["channelName"] = patch.channelName;
  if (patch.channelLink !== undefined) values["channelLink"] = patch.channelLink;
  if (patch.keywords !== undefined) values["keywords"] = [...patch.keywords];
  if (patch.allowSame !== undefined) values["allowSame"] = patch.allowSame;
  if (patch.ssType !== undefined) values["ssType"] = patch.ssType;
  if (patch.successMessage !== undefined) {
    values["successMessage"] = patch.successMessage;
  }

  if (Object.keys(values).length === 0) return;

  values["updatedAt"] = new Date();

  await db
    .update(ssConfigs)
    .set(values)
    .where(eq(ssConfigs.id, id));
}

/**
 * Removes a setup.
 *
 * Its submissions go with it: `ss_submissions.ss_config_id` is a foreign
 * key with `ON DELETE CASCADE` (D13), so the source's manual
 * `SSVerify.full_delete()` dance is not needed.
 */
export async function deleteSsConfig(id: string): Promise<void> {
  await db.delete(ssConfigs).where(eq(ssConfigs.id, id));
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

/* ------------------------------------------------------------------ *
 * Group management
 * ------------------------------------------------------------------ */

/** One tournament, by its row id. */
export async function findTourney(
  id: string,
): Promise<{
  id: string;
  guildId: string;
  name: string;
  roleId: string;
  groupSize: number | null;
} | null> {
  const [row] = await db
    .select({
      id: tourneys.id,
      guildId: tourneys.guildId,
      name: tourneys.name,
      roleId: tourneys.roleId,
      groupSize: tourneys.groupSize,
    })
    .from(tourneys)
    .where(eq(tourneys.id, id))
    .limit(1);

  return row ?? null;
}

/**
 * The registered teams of a tournament, in slot order.
 *
 * Read-only: the tourney area owns the table.
 */
export async function listTourneySlots(
  tourneyId: string,
): Promise<GroupSlot[]> {
  const rows = await db
    .select({
      id: tourneySlots.id,
      num: tourneySlots.num,
      teamName: tourneySlots.teamName,
      leaderId: tourneySlots.leaderId,
    })
    .from(tourneySlots)
    .where(eq(tourneySlots.tourneyId, tourneyId))
    .orderBy(asc(tourneySlots.num));

  return rows;
}

/** Every published group list of a tournament. */
export async function listGroupLists(
  tourneyId: string,
): Promise<GroupListEntry[]> {
  const rows = await db
    .select({
      id: tourneyGroupLists.id,
      tourneyId: tourneyGroupLists.tourneyId,
      messageId: tourneyGroupLists.messageId,
      channelId: tourneyGroupLists.channelId,
      groupNumber: tourneyGroupLists.groupNumber,
      updatedAt: tourneyGroupLists.updatedAt,
    })
    .from(tourneyGroupLists)
    .where(eq(tourneyGroupLists.tourneyId, tourneyId))
    .orderBy(asc(tourneyGroupLists.groupNumber));

  return rows;
}

/** One published group list, by its row id. */
export async function findGroupListById(
  id: string,
): Promise<GroupListEntry | null> {
  const [row] = await db
    .select({
      id: tourneyGroupLists.id,
      tourneyId: tourneyGroupLists.tourneyId,
      messageId: tourneyGroupLists.messageId,
      channelId: tourneyGroupLists.channelId,
      groupNumber: tourneyGroupLists.groupNumber,
      updatedAt: tourneyGroupLists.updatedAt,
    })
    .from(tourneyGroupLists)
    .where(eq(tourneyGroupLists.id, id))
    .limit(1);

  return row ?? null;
}

/**
 * Records a published group list.
 *
 * The channel id is written on the row (D16 / B15). Quotient re-discovered
 * it by a name substring, so group 1 could publish into "Group 10"'s
 * channel.
 */
export async function insertGroupList(input: {
  tourneyId: string;
  messageId: string;
  channelId: string;
  groupNumber: number;
}): Promise<string> {
  const [row] = await db
    .insert(tourneyGroupLists)
    .values({
      tourneyId: input.tourneyId,
      messageId: input.messageId,
      channelId: input.channelId,
      groupNumber: input.groupNumber,
    })
    .returning({ id: tourneyGroupLists.id });

  if (!row) {
    throw new Error("could not record the published group list");
  }

  return row.id;
}

/**
 * Writes the last-refresh time of a published group list.
 *
 * `updated_at` is the only timestamp the row has: the schema folds the
 * source's `refresh_at` into it (S4), and the refresh path is the only
 * thing that ever updates an existing row, so it *is* the last refresh
 * time. The source read an `auto_now` column, which meant the cooldown
 * depended on the last write of any kind (B16).
 */
export async function touchGroupList(id: string): Promise<void> {
  await db
    .update(tourneyGroupLists)
    .set({ updatedAt: new Date() })
    .where(eq(tourneyGroupLists.id, id));
}

/** Removes the published group list of one group. */
export async function deleteGroupList(
  tourneyId: string,
  groupNumber: number,
): Promise<void> {
  await db
    .delete(tourneyGroupLists)
    .where(
      and(
        eq(tourneyGroupLists.tourneyId, tourneyId),
        eq(tourneyGroupLists.groupNumber, groupNumber),
      ),
    );
}
