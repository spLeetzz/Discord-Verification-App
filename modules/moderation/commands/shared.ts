/**
 * The bits every command adapter needs.
 *
 * A command file is a thin adapter (D38): it reads the options, calls one
 * module function, and renders the result. The helpers here are the
 * reading and the rendering; the decisions are in the module.
 */

import { PermissionFlagsBits } from "discord.js";
import type {
  Channel,
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  GuildTextBasedChannel,
  PermissionResolvable,
  Role,
} from "discord.js";
import { denialMessage, InputError } from "../../../core/errors.js";
import { hasGuildPermissions } from "../../../core/guards.js";
import type { Guard } from "../../../core/guards.js";
import { getGuildMember } from "../../../utils/member.js";
import { refusalPanel, replyPanel } from "../views/panels.js";
import type { LockableChannel } from "../lockdown.js";
import { isLockableChannel } from "../lockdown.js";

/**
 * A guard that refuses unless the caller holds a permission.
 *
 * The lookup is `core/guards.ts`'s `hasGuildPermissions`; this is only
 * the shape D28 wants — a predicate that answers with a refusal.
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
 * Is this channel a text channel of a guild?
 *
 * A DM channel has no `bulkDelete` and no guild, so the two checks
 * together pick the right one out of the union.
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
 * The channel a command option names, or the one it was run in.
 *
 * @param name the option's name.
 */
export async function resolveChannelOption(
  interaction: ChatInputCommandInteraction,
  name: string,
): Promise<GuildTextBasedChannel> {
  const option = interaction.options.getChannel(name);

  if (!option) return requireTextChannel(interaction);

  const guild = requireGuild(interaction);
  const channel =
    guild.channels.cache.get(option.id) ??
    (await guild.channels.fetch(option.id).catch(() => null));

  if (!channel || !isGuildTextBasedChannel(channel)) {
    throw new InputError("That channel is not a text channel in this server.");
  }

  return channel;
}

/**
 * The channel a command option names, for a command that may only touch a
 * channel the bot can lock.
 */
export async function resolveLockableChannel(
  interaction: ChatInputCommandInteraction,
  name: string,
): Promise<LockableChannel> {
  const channel = await resolveChannelOption(interaction, name);

  if (!isLockableChannel(channel)) {
    throw new InputError("That channel cannot be locked.");
  }

  return channel;
}

/**
 * The role a command option names, if the option was given.
 *
 * The option can hand back an API shape when the role is not cached, and
 * the hierarchy guard needs a real role with a position and a permission
 * set, so the role is looked up in the guild.
 */
export async function requireRoleOption(
  interaction: ChatInputCommandInteraction,
  name = "role",
): Promise<Role | null> {
  const option = interaction.options.getRole(name);

  if (!option) return null;

  const guild = requireGuild(interaction);
  const role =
    guild.roles.cache.get(option.id) ??
    (await guild.roles.fetch(option.id).catch(() => null));

  if (!role) {
    throw new InputError("That role is not in this server.");
  }

  return role;
}

/**
 * The role a command option names.
 */
export async function requireRole(
  interaction: ChatInputCommandInteraction,
  name = "role",
): Promise<Role> {
  const role = await requireRoleOption(interaction, name);

  if (!role) {
    throw new InputError("Please pick a role.");
  }

  return role;
}

/**
 * Runs the command and turns a refusal into a reply.
 *
 * A refusal is an answer, not a crash: the user is shown the message and
 * the command stops. Anything else is re-thrown, so the dispatcher reports
 * it as a crash.
 *
 * The refusal is shown in the bot's refusal panel — the red one every
 * other area uses — so a moderator sees the same thing wherever the
 * command lives.
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
      await replyPanel(
        interaction,
        refusalPanel(interaction.commandName, message),
      );
      return;
    }

    throw error;
  }
}

/** The permission bits the moderation commands care about. */
export const MODERATION_PERMISSIONS = {
  manageMessages: PermissionFlagsBits.ManageMessages,
  manageRoles: PermissionFlagsBits.ManageRoles,
  manageChannels: PermissionFlagsBits.ManageChannels,
  manageGuild: PermissionFlagsBits.ManageGuild,
  kickMembers: PermissionFlagsBits.KickMembers,
  banMembers: PermissionFlagsBits.BanMembers,
} as const;
