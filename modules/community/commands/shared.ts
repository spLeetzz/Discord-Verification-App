/**
 * The bits every community command needs.
 *
 * A command file is a thin adapter (D38): it reads the options, calls one
 * service function and renders the result. The helpers here are the
 * reading and the rendering; the decisions are in `service.ts`.
 */

import { PermissionFlagsBits } from "discord.js";
import type {
  Channel,
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  GuildTextBasedChannel,
  PermissionResolvable,
} from "discord.js";
import { denialMessage, InputError } from "../../../core/errors.js";
import { replyError } from "../../../core/context.js";
import { hasGuildPermissions } from "../../../core/guards.js";
import type { Guard } from "../../../core/guards.js";
import { getGuildMember } from "../../../utils/member.js";
import type { Command } from "../../../types/command.js";

/**
 * A community command.
 *
 * The `guards` field is the D28 list: each guard answers "may this
 * caller do this?" with `null` or with a refusal.
 */
export interface CommunityCommand extends Command {
  guards?: Guard[];
  guildOnly?: boolean;
}

/**
 * A guard that refuses unless the caller holds a permission.
 */
export function permissionGuard(
  permission: PermissionResolvable,
  refusal: string,
): Guard {
  return async (interaction) =>
    (await hasGuildPermissions(interaction, permission)) ? null : refusal;
}

/** The refusal when the caller lacks a permission. */
export function missingPermission(permission: string): string {
  return `You need the \`${permission}\` permission to use this command.`;
}

/**
 * Refuses unless the caller holds a permission.
 *
 * The guard list (D28) is where the dispatcher will enforce this, but the
 * check is made here as well: the dispatcher does not run the guards yet,
 * and a command that quietly let anybody through in the meantime would be
 * a hole.
 */
export async function requirePermission(
  interaction: ChatInputCommandInteraction,
  permission: PermissionResolvable,
  name: string,
): Promise<void> {
  if (await hasGuildPermissions(interaction, permission)) return;

  throw new InputError(missingPermission(name));
}

/** The guild the command was run in. */
export function requireGuild(interaction: ChatInputCommandInteraction): Guild {
  const guild = interaction.guild;

  if (!guild) {
    throw new InputError("This command only works in a server.");
  }

  return guild;
}

/** The member who ran the command. */
export async function requireMember(
  interaction: ChatInputCommandInteraction,
): Promise<GuildMember> {
  const member = await getGuildMember(interaction);

  if (!member) {
    throw new InputError(
      "I could not work out who you are. Please try again in a moment.",
    );
  }

  return member;
}

/**
 * Is the channel a text channel of a guild?
 *
 * A DM channel has no guild, so the two checks together pick the right
 * one out of the union.
 */
function isGuildTextBasedChannel(
  channel: Channel,
): channel is GuildTextBasedChannel {
  return "bulkDelete" in channel && "guild" in channel;
}

/** The text channel the command was run in. */
export function requireTextChannel(
  interaction: ChatInputCommandInteraction,
): GuildTextBasedChannel {
  const channel = interaction.channel;

  if (!channel || !isGuildTextBasedChannel(channel)) {
    throw new InputError("This command only works in a text channel.");
  }

  return channel;
}

/**
 * May the caller manage the server?
 *
 * The tag `purge` command needs it: it deletes somebody else's tags.
 */
export async function canManageGuild(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  return hasGuildPermissions(interaction, PermissionFlagsBits.ManageGuild);
}

/**
 * Runs the command and turns a refusal into a reply.
 *
 * A refusal is an answer, not a crash: the user is shown the message and
 * the command stops. Anything else is re-thrown, so the dispatcher reports
 * it as a crash.
 */
export async function runCommand(
  interaction: ChatInputCommandInteraction,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = denialMessage(error);

    if (message !== null) {
      await replyError(interaction, message);
      return;
    }

    throw error;
  }
}

/**
 * The name a member is shown under.
 *
 * The source used `str(user)`, which is the display name. A member who
 * has left the server has no display name, so their id is shown.
 */
export function displayName(
  guild: Guild,
  userId: string,
): string {
  const member = guild.members.cache.get(userId);

  if (member) return member.displayName;

  const user = guild.client.users.cache.get(userId);

  if (user) return user.username;

  return "Unknown user";
}
