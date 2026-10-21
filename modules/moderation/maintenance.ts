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
 * (D44).
 *
 * The fix is **not** a name predicate. A name predicate would delete every
 * channel called `maintenance-chat`, and a moderator's own channel may
 * well be called that. The bot deletes the channels it created, and it
 * knows which ones those are: the ids it recorded on the lockdown row when
 * it made them.
 */

import { ChannelType, OverwriteType, PermissionFlagsBits } from "discord.js";
import type { Guild, Role } from "discord.js";

/** The names of the channels maintenance mode creates. */
export const MAINTENANCE_CHANNEL_NAMES = {
  text: "maintenance-chat",
  voice: "maintenance-vc",
} as const;

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
 * What happened to the maintenance channels.
 */
export interface MaintenanceChannelDeletion {
  /** How many channels the lockdown recorded. */
  readonly recorded: number;
  /** How many were deleted. */
  readonly deleted: number;
  /** How many could not be deleted. */
  readonly failed: number;
  /** How many were already gone. */
  readonly missing: number;
}

/**
 * Deletes the maintenance channels.
 *
 * **Only the recorded ids are deleted.** They are the ids of the channels
 * the bot itself created, and nothing else is touched: a channel that
 * merely shares the name `maintenance-chat` belongs to whoever made it,
 * and the bot has no business deleting it.
 *
 * An empty list deletes nothing. The lockdown recorded no maintenance
 * channels, so there is nothing of the bot's to remove.
 *
 * @returns how many channels were deleted, and what happened to the rest.
 */
export async function deleteMaintenanceChannels(
  guild: Guild,
  recordedIds: readonly string[],
  reason: string,
): Promise<MaintenanceChannelDeletion> {
  let deleted = 0;
  let failed = 0;
  let missing = 0;

  const done = new Set<string>();

  for (const id of recordedIds) {
    if (done.has(id)) continue;
    done.add(id);

    const channel = guild.channels.cache.get(id);

    if (!channel) {
      // The channel was already deleted, by hand or otherwise.
      missing += 1;
      continue;
    }

    try {
      await channel.delete(reason);
      deleted += 1;
    } catch {
      // The channel could not be deleted. It is left alone.
      failed += 1;
    }
  }

  return { recorded: recordedIds.length, deleted, failed, missing };
}

/**
 * The line the command says about the maintenance channels.
 *
 * When the lockdown recorded no channels the moderator is told so, rather
 * than being left to wonder whether anything was deleted.
 */
export function describeMaintenanceChannels(
  deletion: MaintenanceChannelDeletion,
): string {
  if (deletion.recorded === 0) {
    return "No maintenance channels were recorded for this lockdown, so none were deleted.";
  }

  let text = `Deleted ${deletion.deleted} of ${deletion.recorded} maintenance channels.`;

  if (deletion.failed > 0) {
    text += ` (${deletion.failed} could not be deleted.)`;
  }

  if (deletion.missing > 0) {
    text += ` (${deletion.missing} were already gone.)`;
  }

  return text;
}
