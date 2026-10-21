/**
 * The community area's service layer.
 *
 * The rules live here; the SQL lives in `repo.ts` and the Discord calls
 * live in `views/`. A function in this file decides *what* should happen
 * and says so; it does not talk to Postgres and it does not talk to
 * Discord.
 *
 * The refusals are raised as `core/errors.ts` classes. A refusal is an
 * answer to show a person, not a crash, and the command layer turns one
 * into a reply.
 */

import { PremiumRequiredError } from "../../core/errors.js";
import { InputError, LimitExceededError, OwnershipError } from "../../core/errors.js";
import { randomUUID } from "node:crypto";
import { assertEntitled } from "../premium/entitlements.js";
import { FREE_TIER } from "../premium/limits.js";
import { PremiumFeature } from "../../core/constants.js";
import { logger } from "../../utils/logger.js";
import * as repo from "./repo.js";
import {
  MAX_REMINDERS_PER_MEMBER,
  MAX_TAGS_PER_MEMBER,
  buildTagBody,
  checkAutoPurgeAdmission,
  checkMemberQuota,
  normaliseTagName,
  validateTagName,
} from "./rules.js";
import type {
  AutoPurgeConfig,
  AutoroleConfig,
  AutoroleKind,
  ReminderRecord,
  SnipeRecord,
  TagRecord,
} from "./types.js";

/**
 * The entitlement that lifts the auto-purge channel limit.
 *
 * The auto-purge allowance is a **count** limit (D45), not a boolean
 * feature: the free tier allows one auto-purge channel and premium lifts
 * the limit. `extra_channels` is the "more channels" entitlement.
 */
export const AUTOPURGE_LIMIT_FEATURE = PremiumFeature.extraChannels;

/**
 * The free-tier allowance of auto-purge channels.
 *
 * Read from the limits configuration, never hard-coded (D45).
 */
export const AUTOPURGE_FREE_TIER_LIMIT = FREE_TIER.autopurgeChannels;

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

/**
 * Creates a tag.
 *
 * The name is validated and canonicalised first, so the name that is
 * stored is the name that is looked up. The uniqueness check is the
 * database's: `UNIQUE (guild_id, name)` refuses a second tag with the
 * same canonical name.
 *
 * The member's allowance is checked before the row is written: a tag is
 * a row nobody ever removes, so the number of them a member may leave
 * behind has to be bounded. The "name is taken" answer comes first —
 * it is the more specific one.
 */
export async function createTag(input: {
  guildId: string;
  name: string;
  content: string;
  isEmbed: boolean;
  ownerId: string;
}): Promise<TagRecord> {
  const validation = validateTagName(input.name);

  if (!validation.ok) {
    throw new InputError(validation.message);
  }

  const body = buildTagBody(input.content, input.isEmbed);

  const existing = await repo.findTagByName(input.guildId, validation.name);

  if (existing) {
    throw new InputError("That tag name is already taken.");
  }

  const owned = await repo.countOwnerTags(input.guildId, input.ownerId);

  const admission = checkMemberQuota({
    subject: "tag",
    currentCount: owned,
    limit: MAX_TAGS_PER_MEMBER,
  });

  if (!admission.allowed) {
    throw new LimitExceededError(
      owned,
      MAX_TAGS_PER_MEMBER,
      admission.message,
    );
  }

  try {
    return await repo.insertTag({
      guildId: input.guildId,
      name: validation.name,
      content: body.body,
      isEmbed: body.isEmbed,
      ownerId: input.ownerId,
    });
  } catch (error) {
    // Two members creating the same tag at the same moment: the
    // database refused the second one, and the refusal is the same
    // answer the read above would have given.
    if (repo.isUniqueViolation(error)) {
      throw new InputError("That tag name is already taken.");
    }

    throw error;
  }
}

/**
 * The shape of a uuid.
 *
 * The source let a tag be called by its id as well as by its name
 * (`TagConverter` tried `int(argument)` first). Our ids are uuids, so
 * this is what "by its id" looks like now.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Finds a tag by name, whatever case the user typed it in.
 *
 * A uuid is looked up by its id, as the source's converter did.
 */
export async function findTag(
  guildId: string,
  name: string,
): Promise<TagRecord | null> {
  const canonical = normaliseTagName(name);

  const byName = await repo.findTagByName(guildId, canonical);

  if (byName) return byName;

  if (UUID_PATTERN.test(canonical)) {
    return repo.findTagById(guildId, canonical);
  }

  return null;
}

/** Finds a tag by its id. */
export async function findTagById(
  guildId: string,
  id: string,
): Promise<TagRecord | null> {
  return repo.findTagById(guildId, id);
}

/**
 * Replaces a tag's body.
 *
 * `isEmbed` is `null` when the caller did not say: the tag keeps the
 * kind it had, so editing an embed tag's JSON does not quietly turn it
 * into a text tag.
 *
 * @param canManage whether the caller may edit a tag they do not own.
 */
export async function editTag(input: {
  guildId: string;
  name: string;
  content: string;
  isEmbed: boolean | null;
  callerId: string;
  canManage: boolean;
}): Promise<TagRecord> {
  const tag = await findTag(input.guildId, input.name);

  if (!tag) {
    throw new InputError("There is no tag with that name.");
  }

  if (tag.ownerId !== input.callerId && !input.canManage) {
    throw new OwnershipError("That tag does not belong to you.");
  }

  const isEmbed = input.isEmbed ?? tag.isEmbed;

  const body = buildTagBody(input.content, isEmbed);

  await repo.updateTagContent(tag.id, body.body, body.isEmbed);

  return { ...tag, content: body.body, isEmbed: body.isEmbed };
}

/**
 * Deletes a tag.
 *
 * @param canManage whether the caller may delete a tag they do not own.
 */
export async function deleteTag(input: {
  guildId: string;
  name: string;
  callerId: string;
  canManage: boolean;
}): Promise<TagRecord> {
  const tag = await findTag(input.guildId, input.name);

  if (!tag) {
    throw new InputError("There is no tag with that name.");
  }

  if (tag.ownerId !== input.callerId && !input.canManage) {
    throw new OwnershipError("That tag does not belong to you.");
  }

  await repo.deleteTag(tag.id);

  return tag;
}

/** Hands a tag to another member. */
export async function transferTag(input: {
  guildId: string;
  name: string;
  callerId: string;
  toUserId: string;
}): Promise<TagRecord> {
  const tag = await findTag(input.guildId, input.name);

  if (!tag) {
    throw new InputError("There is no tag with that name.");
  }

  if (tag.ownerId !== input.callerId) {
    throw new OwnershipError("That tag does not belong to you.");
  }

  await repo.updateTagOwner(tag.id, input.toUserId);

  return { ...tag, ownerId: input.toUserId };
}

/**
 * Claims a tag whose owner has left the guild.
 *
 * @param ownerIsStillInGuild whether the owner is still a member. The
 *        claim is refused when they are.
 */
export async function claimTag(input: {
  guildId: string;
  name: string;
  callerId: string;
  ownerIsStillInGuild: boolean;
}): Promise<TagRecord> {
  const tag = await findTag(input.guildId, input.name);

  if (!tag) {
    throw new InputError("There is no tag with that name.");
  }

  if (input.ownerIsStillInGuild) {
    throw new InputError("The owner of that tag is still in the server.");
  }

  await repo.updateTagOwner(tag.id, input.callerId);

  return { ...tag, ownerId: input.callerId };
}

/** Flips a tag's NSFW flag. */
export async function toggleTagNsfw(input: {
  guildId: string;
  name: string;
  callerId: string;
  canManage: boolean;
}): Promise<{ tag: TagRecord; nsfw: boolean }> {
  const tag = await findTag(input.guildId, input.name);

  if (!tag) {
    throw new InputError("There is no tag with that name.");
  }

  if (tag.ownerId !== input.callerId && !input.canManage) {
    throw new OwnershipError("That tag does not belong to you.");
  }

  const nsfw = !tag.isNsfw;

  await repo.setTagNsfw(tag.id, nsfw);

  return { tag: { ...tag, isNsfw: nsfw }, nsfw };
}

/** Deletes every tag a member owns. */
export async function purgeTagsOfOwner(
  guildId: string,
  ownerId: string,
): Promise<number> {
  return repo.deleteTagsByOwner(guildId, ownerId);
}

/**
 * Counts one use of a tag.
 *
 * The counter is atomic, so two people using the tag at the same moment
 * do not lose a count.
 */
export async function countTagUse(guildId: string, name: string): Promise<void> {
  await repo.incrementTagUsage(guildId, normaliseTagName(name));
}

/* ------------------------------------------------------------------ *
 * Snipes
 * ------------------------------------------------------------------ */

/** Stores the last deleted message of a channel. */
export async function recordSnipe(snipe: {
  channelId: string;
  authorId: string;
  content: string;
  nsfw: boolean;
}): Promise<void> {
  await repo.upsertSnipe(snipe);
}

/** The last deleted message of a channel. */
export async function getSnipe(channelId: string): Promise<SnipeRecord | null> {
  return repo.findSnipe(channelId);
}

/**
 * Deletes the snipes that are older than the retention window.
 *
 * @param days how long a snipe is kept. Ten days, as in the source.
 */
export async function pruneSnipes(days = 10): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return repo.deleteSnipesOlderThan(cutoff);
}

/* ------------------------------------------------------------------ *
 * Auto-roles
 * ------------------------------------------------------------------ */

/**
 * Adds a role to an auto-role list, or removes it when it is already
 * there.
 *
 * The whole change is one statement, so two moderators clicking at the
 * same moment cannot lose a role.
 */
export async function toggleAutoroleRole(input: {
  guildId: string;
  kind: AutoroleKind;
  roleId: string;
}): Promise<{ roles: string[]; added: boolean }> {
  const before = await repo.findAutoroleConfig(input.guildId);

  const wasThere = (before?.[input.kind] ?? []).includes(input.roleId);

  const roles = await repo.toggleAutoroleRole(
    input.guildId,
    input.kind,
    input.roleId,
  );

  return { roles, added: !wasThere };
}

/** The auto-role config of a guild. */
export async function getAutoroleConfig(
  guildId: string,
): Promise<AutoroleConfig | null> {
  return repo.findAutoroleConfig(guildId);
}

/** Empties both auto-role lists. */
export async function clearAutoroleRoles(guildId: string): Promise<void> {
  await repo.clearAutoroleRoles(guildId);
}

/**
 * Drops a role id from an auto-role list.
 *
 * The self-healing path: a role that no longer exists is removed from
 * the list rather than failing every join.
 */
export async function forgetAutoroleRole(input: {
  guildId: string;
  kind: AutoroleKind;
  roleId: string;
}): Promise<void> {
  await repo.removeAutoroleRole(input.guildId, input.kind, input.roleId);
}

/* ------------------------------------------------------------------ *
 * Auto-purge
 * ------------------------------------------------------------------ */

/**
 * Is the guild past the free-tier auto-purge allowance?
 *
 * The entitlement is read through the premium module's one gate. The
 * gate is a *count* limit, so the question is "is the limit lifted?"
 * rather than "is the feature allowed?" — a guild that is entitled may
 * configure as many channels as it likes.
 */
export async function isAutoPurgeUnlimited(guildId: string): Promise<boolean> {
  try {
    await assertEntitled(guildId, AUTOPURGE_LIMIT_FEATURE);
    return true;
  } catch (error) {
    // `assertEntitled` refuses with a `PremiumRequiredError`; anything
    // else is a real failure and is not swallowed.
    if (error instanceof PremiumRequiredError) return false;

    throw error;
  }
}

/**
 * Configures a channel for auto-purge.
 *
 * The admission check happens **before** anything is written, and inside
 * it the "already configured" answer comes before the free-tier answer
 * (see `rules.ts`).
 */
export async function configureAutoPurge(input: {
  guildId: string;
  channelId: string;
  channelName: string;
  deleteAfter: number;
}): Promise<AutoPurgeConfig> {
  const existing = await repo.findAutoPurgeConfig(input.channelId);

  const count = await repo.countAutoPurgeConfigs(input.guildId);

  const entitled = await isAutoPurgeUnlimited(input.guildId);

  const admission = checkAutoPurgeAdmission({
    alreadyConfigured: existing !== null,
    currentCount: count,
    limit: AUTOPURGE_FREE_TIER_LIMIT,
    entitled,
    channelName: input.channelName,
  });

  if (!admission.allowed) {
    throw new InputError(admission.message);
  }

  await repo.insertAutoPurgeConfig({
    guildId: input.guildId,
    channelId: input.channelId,
    deleteAfter: input.deleteAfter,
  });

  const created = await repo.findAutoPurgeConfig(input.channelId);

  if (!created) {
    throw new Error("The auto-purge config was not written.");
  }

  return created;
}

/** Every auto-purge channel of a guild. */
export async function listAutoPurgeConfigs(
  guildId: string,
): Promise<AutoPurgeConfig[]> {
  return repo.listAutoPurgeConfigs(guildId);
}

/** Removes a channel from the auto-purge list. */
export async function removeAutoPurge(channelId: string): Promise<boolean> {
  const existing = await repo.findAutoPurgeConfig(channelId);

  if (!existing) return false;

  await repo.deleteAutoPurgeConfig(channelId);

  return true;
}

/** The auto-purge config of a channel. */
export async function getAutoPurgeConfig(
  channelId: string,
): Promise<AutoPurgeConfig | null> {
  return repo.findAutoPurgeConfig(channelId);
}

/* ------------------------------------------------------------------ *
 * Reminders
 * ------------------------------------------------------------------ */

/**
 * Arms a reminder.
 *
 * The reminder is a row in the durable `jobs` table, never a `setTimeout`:
 * a timer dies with the process and the reminder never fires.
 *
 * The member's allowance is checked before the row is written. A reminder
 * is a row in the table the dispatcher polls every fifteen seconds, and
 * nothing removed one by itself, so the number a member may leave
 * running has to be bounded.
 */
export async function createReminder(input: {
  guildId: string;
  channelId: string;
  userId: string;
  message: string;
  dueAt: Date;
  sourceMessageId?: string;
}): Promise<string> {
  const running = await repo.countUserReminders(input.userId);

  const admission = checkMemberQuota({
    subject: "reminder",
    currentCount: running,
    limit: MAX_REMINDERS_PER_MEMBER,
  });

  if (!admission.allowed) {
    throw new LimitExceededError(
      running,
      MAX_REMINDERS_PER_MEMBER,
      admission.message,
    );
  }

  // The id is generated here rather than by the database, because the
  // dispatcher hands the handler the payload and nothing else: the id
  // travels with the payload so the embed and `/reminder list` agree.
  const id = randomUUID();

  await repo.insertJob({
    id,
    expiresAt: input.dueAt,
    event: "reminder",
    payload: {
      channelId: input.channelId,
      userId: input.userId,
      message: input.message,
      reminderId: id,
      createdAt: new Date().toISOString(),
      ...(input.sourceMessageId
        ? { sourceMessageId: input.sourceMessageId }
        : {}),
    },
    userId: input.userId,
  });

  return id;
}

/** A user's running reminders, the latest first. */
export async function listReminders(
  userId: string,
  limit = 10,
): Promise<ReminderRecord[]> {
  return repo.listUserReminders(userId, limit);
}

/** How many reminders a user has running. */
export async function countReminders(userId: string): Promise<number> {
  return repo.countUserReminders(userId);
}

/**
 * Deletes one of a member's running reminders.
 *
 * The delete is the member's own row, so a member at their allowance can
 * always make room for another one — the allowance must never be a trap.
 *
 * @returns whether the reminder was there and was deleted.
 */
export async function deleteReminder(input: {
  id: string;
  userId: string;
}): Promise<boolean> {
  return repo.deleteUserReminder(input.id, input.userId);
}

/**
 * Deletes every running reminder of a member.
 *
 * @returns how many reminders were removed.
 */
export async function deleteReminders(userId: string): Promise<number> {
  return repo.deleteUserReminders(userId);
}

/**
 * Deletes the tags that have never been used and have not been touched
 * for a while.
 *
 * The allowance bounds how many tags a member may have *at once*; this
 * is what bounds how many the table keeps over the months. A tag that
 * has been used is never touched: the usage counter bumps `updated_at`,
 * so a tag in use keeps its row.
 *
 * @param days how long an unused tag is kept.
 */
export async function pruneUnusedTags(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return repo.deleteUnusedTags(cutoff);
}

/* ------------------------------------------------------------------ *
 * The command-usage log
 * ------------------------------------------------------------------ */

/**
 * Writes one row of the command-usage log.
 *
 * The dispatcher calls this once per command invocation — the log is a
 * property of the dispatcher, not of any one command.
 */
export async function recordCommandUsage(entry: {
  guildId: string;
  channelId: string;
  userId: string;
  cmd: string;
  prefix: string;
  failed: boolean;
}): Promise<void> {
  try {
    await repo.recordCommandUsage(entry);
  } catch (error) {
    // The usage log is telemetry. It must never take a command down.
    logger.warn(
      `[Community] Could not write the command-usage row: ${String(error)}`,
    );
  }
}
