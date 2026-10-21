/**
 * The maintenance channels.
 *
 * `maintenance on` can create a text channel and a voice channel that the
 * role under maintenance still has access to, so that people can talk to
 * each other while the rest of the server is hidden. `maintenance off`
 * deletes them again.
 *
 * Quotient's `maintenance off` looked the channels up with
 * `discord.utils.get(ctx.guild.channels, name="maintenance-chat")`, which
 * asks a *list* for an attribute called `name` — every channel has a
 * `name`, so the lookup never matched and the channels were never deleted
 * (D44). The fix is a name predicate over the channel cache, and the ids
 * the bot recorded when it created them.
 */

import { ChannelType, OverwriteType, PermissionFlagsBits } from "discord.js";
import type { Guild, Role } from "discord.js";

/** The names of the channels maintenance mode creates. */
export const MAINTENANCE_CHANNEL_NAMES = {
  text: "maintenance-chat",
  voice: "maintenance-vc",
} as const;

/** Every name maintenance mode claims. */
export const MAINTENANCE_CHANNEL_NAME_LIST: readonly string[] = [
  MAINTENANCE_CHANNEL_NAMES.text,
  MAINTENANCE_CHANNEL_NAMES.voice,
];

/**
 * The channels of a guild with a given name.
 *
 * The name predicate that replaces `discord.utils.get`.
 */
export function findChannelsByName(guild: Guild, name: string): string[] {
  const ids: string[] = [];

  for (const channel of guild.channels.cache.values()) {
    if (channel.name === name) ids.push(channel.id);
  }

  return ids;
}

/**
 * Creates the maintenance channels.
 *
 * @returns the ids of the channels that were created.
 */
export async function createMaintenanceChannels(
  guild: Guild,
  role: Role,
  reason: string,
): Promise<string[]> {
  const ids: string[] = [];

  const allow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  const overwrites = [
    { id: role.id, allow, type: OverwriteType.Role },
  ];

  const botMember = guild.members.me;

  if (botMember) {
    overwrites.push({
      id: botMember.id,
      allow,
      type: OverwriteType.Role,
    });
  }

  const text = await guild.channels.create({
    name: MAINTENANCE_CHANNEL_NAMES.text,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
    reason,
  });

  ids.push(text.id);

  const voice = await guild.channels.create({
    name: MAINTENANCE_CHANNEL_NAMES.voice,
    type: ChannelType.GuildVoice,
    permissionOverwrites: overwrites,
    reason,
  });

  ids.push(voice.id);

  return ids;
}

/**
 * Deletes the maintenance channels.
 *
 * The recorded ids are used when there are any — those are exactly the
 * channels the bot created. When there is no record, the names are used
 * instead, which is the name predicate that fixes Quotient's bug.
 *
 * @returns how many channels were deleted.
 */
export async function deleteMaintenanceChannels(
  guild: Guild,
  recordedIds: readonly string[],
  reason: string,
): Promise<number> {
  const deleted = new Set<string>();
  let count = 0;

  const remove = async (id: string): Promise<void> => {
    if (deleted.has(id)) return;

    const channel = guild.channels.cache.get(id);
    if (!channel) return;

    try {
      await channel.delete(reason);
      deleted.add(id);
      count += 1;
    } catch {
      // The channel could not be deleted. It is left alone.
    }
  };

  if (recordedIds.length > 0) {
    for (const id of recordedIds) await remove(id);

    return count;
  }

  for (const name of MAINTENANCE_CHANNEL_NAME_LIST) {
    for (const id of findChannelsByName(guild, name)) await remove(id);
  }

  return count;
}
