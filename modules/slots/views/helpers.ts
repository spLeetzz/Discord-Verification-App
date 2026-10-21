/**
 * The small things every slot panel needs.
 *
 * Channel names, member resolution and the scrim's role. They live here
 * so the public panel, the slot list and the manager editor can all use
 * them without importing each other.
 */

import type { Guild, GuildMember } from "discord.js";
import { logger } from "../../../utils/logger.js";
import * as repo from "../repo.js";

/** The name of a channel, or a placeholder when it is gone. */
export function channelName(guild: Guild | null, channelId: string): string {
  if (!guild) return "deleted-channel";

  const channel = guild.channels.cache.get(channelId);

  return channel && "name" in channel ? channel.name : "deleted-channel";
}

/**
 * Resolves member ids to the members that still exist.
 *
 * A member may have left the server, and the source assumed they had
 * not: `guild.get_member()` returned `None` and the detached task died on
 * it (B10). Here the ones that cannot be found are simply dropped, and
 * the caller decides what an empty list means.
 */
export async function resolveMembers(
  guild: Guild,
  ids: readonly string[],
): Promise<GuildMember[]> {
  const members: GuildMember[] = [];

  for (const id of ids) {
    const member = await guild.members.fetch(id).catch(() => null);

    if (member) members.push(member);
  }

  return members;
}

/** The role a scrim gives to the members who hold a slot. */
export async function scrimRoleId(scrimId: string): Promise<string | null> {
  const scrim = await repo.getScrim(scrimId);

  return scrim?.roleId ?? null;
}

/** Takes a scrim's role away from a member. */
export async function removeScrimRole(
  guild: Guild | null,
  scrimId: string,
  userId: string,
): Promise<void> {
  if (!guild) return;

  const roleId = await scrimRoleId(scrimId);

  if (!roleId) return;

  const member = await guild.members.fetch(userId).catch(() => null);

  if (!member) return;

  await member.roles.remove(roleId).catch(() => undefined);
}

/** Gives a scrim's role to a member. */
export async function addScrimRole(
  guild: Guild | null,
  scrimId: string,
  userId: string,
): Promise<void> {
  if (!guild) return;

  const roleId = await scrimRoleId(scrimId);

  if (!roleId) return;

  const member = await guild.members.fetch(userId).catch(() => null);

  if (!member) return;

  await member.roles.add(roleId).catch((error: unknown) => {
    logger.warn(`[Slots] Could not give the scrim role to ${userId}:`, error);
  });
}
