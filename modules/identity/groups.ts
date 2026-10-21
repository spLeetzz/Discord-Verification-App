/**
 * Group management — the service.
 *
 * Quotient's tourney group manager did three things:
 *
 *  1. **Create Channels & Roles** — one category, one role and one
 *     channel per group, named from a format string with a `{0}` in it.
 *  2. **Publish a group list** — post the group's teams in a channel.
 *  3. **Refresh** — a persistent button on the published list that redraws
 *     it with the current teams.
 *
 * Two of the three had bugs, and both are fixed here:
 *
 *  - **No rollback (B17).** Quotient created the roles and the channels
 *    in a loop and returned on the first failure, so a failure on the
 *    fourth of five groups left the first three behind. Everything that is
 *    created is collected and removed again when something goes wrong.
 *  - **The channel was found by a name substring (B15).** "Group 1" also
 *    matched "Group 10", so a group list could be published into another
 *    group's channel. The channel is chosen by the operator and stored on
 *    the row (D16).
 *
 * The cooldown of the refresh button is the third fix: Quotient read an
 * `auto_now` column, so the two-minute cooldown depended on the last write
 * of any kind. The row's `updated_at` is written **only** by the refresh
 * path, so it *is* the last refresh time.
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { CategoryChannel, Guild, OverwriteData, Role, TextChannel } from "discord.js";
import { logger } from "../../utils/logger.js";
import { errorMessage } from "../../utils/errors.js";
import * as repo from "./repo.js";
import type { GroupListEntry, GroupSlot } from "./types.js";

/* ------------------------------------------------------------------ *
 * Creating the channels and the roles
 * ------------------------------------------------------------------ */

/** How a group is named. */
export interface GroupFormat {
  /** The format string, with a `{0}` where the group number goes. */
  readonly format: string;
  /** The first group. */
  readonly from: number;
  /** The last group. */
  readonly to: number;
}

/** What was created. */
export interface GroupChannelPlan {
  readonly categoryId: string;
  readonly channelIds: string[];
  readonly roleIds: string[];
}

/** The longest a format string may be. */
export const MAX_GROUP_FORMAT_LENGTH = 35;

/**
 * Checks a format string.
 *
 * @returns `null` when the format is usable, or the reason it is not.
 */
export function validateGroupFormat(
  format: string,
  from: number,
  to: number,
): string | null {
  if (format.length === 0) return "The name format must not be empty.";

  if (format.length > MAX_GROUP_FORMAT_LENGTH) {
    return `Name too long. Max ${MAX_GROUP_FORMAT_LENGTH} characters.`;
  }

  if (!format.includes("{0}")) return "No `{0}` found in the input.";

  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return "Invalid format provided.";
  }

  if (from === to) return "Invalid range provided.";

  if (from < 1 || to < 1) return "Invalid range provided.";

  if (to - from > 99) {
    return "That is too many groups at once. Please pick a smaller range.";
  }

  return null;
}

/**
 * The name of a group.
 */
export function groupName(format: string, number: number): string {
  return format.replaceAll("{0}", String(number));
}

/**
 * The name of the category.
 */
export function categoryName(format: string, from: number, to: number): string {
  return `${format.replaceAll("{0}", "")} ${from}-${to}`;
}

/**
 * Creates the category, the roles and the channels of a range of groups.
 *
 * Everything that is created is remembered, and everything is removed again
 * when something fails — so a failure on the fourth group does not leave
 * the first three behind (B17).
 *
 * @param guild     the guild.
 * @param input     the format and the range.
 * @param modRoleId the role that moderates the groups, when there is one.
 * @throws when the guild has too many channels, or when a creation fails.
 *         The rollback happens first, so nothing is left behind.
 */
export async function createGroupChannels(
  guild: Guild,
  input: GroupFormat,
  modRoleId: string | null,
): Promise<GroupChannelPlan> {
  // Discord's hard limit is 500 channels per guild.
  if (guild.channels.cache.size >= 490) {
    throw new Error(
      "Too many channels in server. Please delete some first.",
    );
  }

  const createdChannels: string[] = [];
  const createdRoles: string[] = [];

  let category: CategoryChannel | null = null;

  try {
    const overwrites = buildOverwrites(guild, modRoleId);

    category = (await guild.channels.create({
      name: categoryName(input.format, input.from, input.to),
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites,
      reason: `Group management by ${guild.client.user.username}`,
    })) as CategoryChannel;

    for (let number = input.from; number <= input.to; number += 1) {
      const name = groupName(input.format, number);

      const { role, created } = await getOrCreateRole(guild, name);

      if (created) createdRoles.push(role.id);

      const channel = (await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: buildChannelOverwrites(overwrites, role),
        reason: `Group management by ${guild.client.user.username}`,
      })) as TextChannel;

      createdChannels.push(channel.id);
    }

    return {
      categoryId: category.id,
      channelIds: createdChannels,
      roleIds: createdRoles,
    };
  } catch (error) {
    await rollbackGroupChannels(guild, category, createdChannels, createdRoles);

    throw error;
  }
}

/**
 * The overwrites of the category.
 *
 * The @everyone role may not read the category; the tournament's own role
 * may do everything in it.
 */
function buildOverwrites(
  guild: Guild,
  modRoleId: string | null,
): OverwriteData[] {
  const overwrites: OverwriteData[] = [
    {
      id: guild.roles.everyone.id,
      deny: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  if (modRoleId) {
    const modRole = guild.roles.cache.get(modRoleId);

    if (modRole) {
      overwrites.push({
        id: modRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.MentionEveryone,
        ],
      });
    }
  }

  return overwrites;
}

/**
 * The overwrites of a group channel.
 *
 * The group's own role may read the channel but not write in it — the
 * captain who holds it posts the team's slot number.
 */
function buildChannelOverwrites(
  categoryOverwrites: readonly OverwriteData[],
  groupRole: Role,
): OverwriteData[] {
  return [
    {
      id: groupRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      deny: [PermissionFlagsBits.SendMessages],
    },
    ...categoryOverwrites,
  ];
}

/**
 * Finds a role by name, or creates it.
 *
 * @returns the role and whether it was created — a role that already
 *          existed is **not** removed when the creation is rolled back.
 */
async function getOrCreateRole(
  guild: Guild,
  name: string,
): Promise<{ role: Role; created: boolean }> {
  const existing = guild.roles.cache.find(
    (role) => role.name.toLowerCase() === name.toLowerCase(),
  );

  if (existing) return { role: existing, created: false };

  const role = await guild.roles.create({
    name,
    reason: `Group management by ${guild.client.user.username}`,
  });

  return { role, created: true };
}

/**
 * Removes everything a failed creation left behind.
 *
 * The channels go first (they reference the roles), then the category,
 * then the roles.
 */
async function rollbackGroupChannels(
  guild: Guild,
  category: CategoryChannel | null,
  channelIds: readonly string[],
  roleIds: readonly string[],
): Promise<void> {
  for (const id of [...channelIds].reverse()) {
    try {
      await guild.channels.delete(id);
    } catch (error) {
      logger.warn(
        `[Identity] Could not remove the channel ${id} while rolling back: ${errorMessage(error)}`,
      );
    }
  }

  if (category) {
    try {
      await guild.channels.delete(category.id);
    } catch (error) {
      logger.warn(
        `[Identity] Could not remove the category ${category.id} while rolling back: ${errorMessage(error)}`,
      );
    }
  }

  for (const id of [...roleIds].reverse()) {
    try {
      await guild.roles.delete(id);
    } catch (error) {
      logger.warn(
        `[Identity] Could not remove the role ${id} while rolling back: ${errorMessage(error)}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Publishing a group list
 * ------------------------------------------------------------------ */

/** How long a published list may not be refreshed. */
export const GROUP_LIST_REFRESH_COOLDOWN_MS = 120_000;

/**
 * May the published list be refreshed right now?
 *
 * The row's `updated_at` is written **only** by the refresh path, so it is
 * the time of the last refresh and nothing else (B16).
 */
export function canRefreshGroupList(
  entry: GroupListEntry,
  now: Date = new Date(),
): boolean {
  const elapsed = now.getTime() - entry.updatedAt.getTime();

  return elapsed >= GROUP_LIST_REFRESH_COOLDOWN_MS;
}

/**
 * How long the caller has to wait.
 *
 * @returns the milliseconds left, or `0` when the list may be refreshed.
 */
export function groupListRefreshWait(
  entry: GroupListEntry,
  now: Date = new Date(),
): number {
  const elapsed = now.getTime() - entry.updatedAt.getTime();

  return Math.max(0, GROUP_LIST_REFRESH_COOLDOWN_MS - elapsed);
}

/**
 * Records a published group list.
 *
 * The channel id is written on the row (D16 / B15).
 */
export async function recordGroupList(input: {
  tourneyId: string;
  messageId: string;
  channelId: string;
  groupNumber: number;
}): Promise<string> {
  // A group is published once: the old row goes, so the unique
  // constraint on (tourney, group number) holds.
  await repo.deleteGroupList(input.tourneyId, input.groupNumber);

  return repo.insertGroupList(input);
}

/**
 * Writes the last-refresh time of a published group list.
 */
export async function touchGroupList(id: string): Promise<void> {
  await repo.touchGroupList(id);
}

/**
 * One published group list, by its row id.
 */
export async function findGroupList(id: string): Promise<GroupListEntry | null> {
  return repo.findGroupListById(id);
}

/**
 * The teams of one group.
 *
 * The groups are a flat chunk of the ordered slot list, cut into pieces of
 * `group_size` (D25). The tourney area owns the slots; this module only
 * reads them.
 */
export async function getGroup(
  tourneyId: string,
  groupSize: number,
  groupNumber: number,
): Promise<GroupSlot[]> {
  const slots = await repo.listTourneySlots(tourneyId);

  const start = (groupNumber - 1) * groupSize;

  return slots.slice(start, start + groupSize);
}

/**
 * How many groups there are.
 */
export async function countGroups(
  tourneyId: string,
  groupSize: number,
): Promise<number> {
  const slots = await repo.listTourneySlots(tourneyId);

  if (groupSize <= 0) return 0;

  return Math.ceil(slots.length / groupSize);
}

/**
 * The tournament a published list belongs to.
 */
export async function findTourney(
  id: string,
): Promise<{
  id: string;
  guildId: string;
  name: string;
  roleId: string;
  groupSize: number | null;
} | null> {
  return repo.findTourney(id);
}
