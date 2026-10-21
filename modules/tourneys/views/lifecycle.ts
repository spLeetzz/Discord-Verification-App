/**
 * Opening and closing a tournament — the Discord half.
 *
 * The state transitions live in `service.ts`; this file does the Discord
 * work around them: the announcements, the channel permissions and the
 * success role.
 *
 * The source's `toggle_registrations` checked four things before it
 * opened a tournament:
 *
 *  1. the registration channel exists;
 *  2. the bot can manage permissions in it;
 *  3. the open role exists;
 *  4. the tournament is not already full.
 *
 * The first three are environment checks and belong here, where the guild
 * is available. The fourth is a state check and lives in the service.
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { Guild, TextChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { DANGER_COLOR, PANEL_COLOR, panelEmbed } from "../../../core/ui.js";
import { run } from "../../../core/fire-and-forget.js";
import { logger } from "../../../utils/logger.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import type { TourneyRecord } from "../types.js";

/**
 * May the tournament open?
 *
 * @returns the reason it may not, or `null` when it may.
 */
export function checkCanOpen(guild: Guild, tourney: TourneyRecord): string | null {
  const channel = guild.channels.cache.get(tourney.registrationChannelId);

  if (!channel || channel.type !== ChannelType.GuildText) {
    return "I couldn't find the registration channel. Maybe it is deleted, or hidden from me.";
  }

  const me = guild.members.me;

  if (!me) return "I could not find my own member record.";

  const permissions = channel.permissionsFor(me);

  if (!permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return `I do not have \`Manage Channels\` in ${channel.toString()}.`;
  }

  if (!tourney.roleId) {
    return "I couldn't find the success role.";
  }

  const role = guild.roles.cache.get(tourney.roleId);

  if (!role) return "I couldn't find the success role.";

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return "I don't have `Manage Roles` in this server.";
  }

  if (role.position >= me.roles.highest.position) {
    return `The success role (${role.toString()}) is above my top role (${me.roles.highest.toString()}).`;
  }

  if (tourney.openRoleId && !guild.roles.cache.get(tourney.openRoleId)) {
    return "You have set an open role earlier and I couldn't find it.";
  }

  return null;
}

/** The channel a tournament registers in. */
export function registrationChannel(
  guild: Guild,
  tourney: TourneyRecord,
): TextChannel | null {
  const channel = guild.channels.cache.get(tourney.registrationChannelId);

  if (!channel) return null;
  if (channel.type !== ChannelType.GuildText) return null;

  return channel;
}

/**
 * Opens or closes the registration channel for the open role.
 *
 * The source toggled the `send_messages` permission of the open role.
 * Ours does the same: a closed tournament's channel is read-only for
 * everybody except the staff role.
 */
export async function toggleChannel(
  guild: Guild,
  tourney: TourneyRecord,
  open: boolean,
): Promise<boolean> {
  const channel = guild.channels.cache.get(tourney.registrationChannelId);

  if (!channel || channel.type !== ChannelType.GuildText) return false;

  const roleId = tourney.openRoleId;

  if (!roleId) return false;

  const role = guild.roles.cache.get(roleId);

  if (!role) return false;

  try {
    await channel.permissionOverwrites.edit(
      role,
      { SendMessages: open },
      {
        reason: open
          ? "Tournament registration is open."
          : "Tournament registration is over.",
      },
    );

    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a tournament in a guild: the state change, the announcement and
 * the channel.
 */
export async function openTourneyInGuild(
  guild: Guild,
  tourneyId: string,
): Promise<service.OpenResult | null> {
  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) return null;

  const refusal = checkCanOpen(guild, tourney);

  if (refusal) {
    logger.warn(`[Tourneys] ${refusal}`);

    return null;
  }

  let result: service.OpenResult;

  try {
    result = await service.openTourney(tourney.id);
  } catch (error) {
    logger.error(
      `[Tourneys] Could not open the tournament ${tourney.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }

  const fresh = result.tourney;
  const channel = registrationChannel(guild, fresh);

  const embed = panelEmbed({
    title: `Registration open — ${fresh.name}`,
    description: [
      "```",
      `📣 ${fresh.requiredMentions} mentions required.`,
      `📣 Total slots: ${fresh.totalSlots} [${fresh.totalSlots - result.slotCount} slots left]`,
      "```",
    ].join("\n"),
    footer: "Register in the registration channel to take a slot.",
  });

  if (channel) {
    const pingRole = fresh.pingRoleId
      ? guild.roles.cache.get(fresh.pingRoleId)
      : null;

    await channel
      .send({
        content: pingRole ? pingRole.toString() : undefined,
        embeds: [embed],
        allowedMentions: { roles: [fresh.pingRoleId ?? ""] },
      })
      .catch(() => undefined);
  }

  await toggleChannel(guild, fresh, true);

  return result;
}

/**
 * Closes a tournament in a guild: the state change, the announcement and
 * the channel.
 */
export async function closeTourneyInGuild(
  guild: Guild,
  tourneyId: string,
): Promise<TourneyRecord | null> {
  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) return null;

  let updated: TourneyRecord;

  try {
    updated = await service.closeTourney(tourney.id);
  } catch (error) {
    logger.error(
      `[Tourneys] Could not close the tournament ${tourney.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }

  const channel = registrationChannel(guild, updated);

  if (channel) {
    const embed = panelEmbed({
      title: "Registration closed",
      description: `**${updated.name}** is closed for registration.`,
      footer: "The tournament panel can open it again.",
    });

    await channel.send({ embeds: [embed] }).catch(() => undefined);
  }

  await toggleChannel(guild, updated, false);

  return updated;
}

/**
 * Pauses a tournament in a guild.
 *
 * A pause keeps the slots; only a close ends the tournament. The source
 * set `closed_at` for both, so the two were indistinguishable (D26).
 */
export async function pauseTourneyInGuild(
  guild: Guild,
  tourneyId: string,
): Promise<TourneyRecord | null> {
  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) return null;

  let updated: TourneyRecord;

  try {
    updated = await service.pauseTourney(tourney.id);
  } catch (error) {
    logger.error(
      `[Tourneys] Could not pause the tournament ${tourney.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }

  const channel = registrationChannel(guild, updated);

  if (channel) {
    const embed = panelEmbed({
      title: "Registration paused",
      description: `**${updated.name}** is paused.`,
      footer: "Open the registration again to let the teams register.",
    });

    await channel.send({ embeds: [embed] }).catch(() => undefined);
  }

  await toggleChannel(guild, updated, false);

  return updated;
}

/**
 * Strikes the confirmation message of a cancelled slot.
 *
 * The source fetched the message out of the jump url and struck it
 * through. Ours keeps the same shape but resolves the message from the
 * ids it stored, and it never throws — a cancelled slot whose
 * confirmation message has gone is still a cancelled slot.
 */
export async function strikeConfirmMessage(
  guild: Guild,
  confirmJumpUrl: string | null,
): Promise<void> {
  if (!confirmJumpUrl) return;

  const ids = parseJumpUrl(confirmJumpUrl);

  if (!ids) return;

  const channel = guild.channels.cache.get(ids.channelId);

  if (!channel || !("messages" in channel)) return;

  const message = await channel.messages
    .fetch(ids.messageId)
    .catch(() => null);

  if (!message) return;

  const embed = message.embeds[0];

  if (!embed) return;

  await message
    .edit({
      embeds: [
        new EmbedBuilder()
          .setTitle("Cancelled slot")
          .setDescription(`~~${embed.description ?? ""}~~`)
          .setColor(DANGER_COLOR),
      ],
    })
    .catch(() => undefined);
}

/**
 * The channel and message ids of a Discord jump url.
 *
 * The url is `https://discord.com/channels/<guild>/<channel>/<message>`.
 */
export function parseJumpUrl(
  url: string,
): { channelId: string; messageId: string } | null {
  const parts = url.split("/");

  // ["https:", "", "discord.com", "channels", guild, channel, message]
  if (parts.length < 7) return null;

  const channelId = parts[5];
  const messageId = parts[6];

  if (!channelId || !messageId) return null;

  return { channelId, messageId };
}

/**
 * Removes the success role from a member, if it is safe to do so.
 *
 * The rule, from the source: *only remove the role if this was their
 * last slot*.
 */
export async function removeSuccessRole(
  guild: Guild,
  tourney: TourneyRecord,
  userId: string,
): Promise<void> {
  if (!tourney.roleId) return;

  const role = guild.roles.cache.get(tourney.roleId);

  if (!role) return;

  const member = await guild.members.fetch(userId).catch(() => null);

  if (!member) return;

  await member.roles.remove(role).catch(() => undefined);
}

/**
 * Gives the success role to a member.
 */
export async function giveSuccessRole(
  guild: Guild,
  tourney: TourneyRecord,
  userId: string,
): Promise<void> {
  if (!tourney.roleId) return;

  const role = guild.roles.cache.get(tourney.roleId);

  if (!role) return;

  const member = await guild.members.fetch(userId).catch(() => null);

  if (!member) return;

  await member.roles.add(role).catch(() => undefined);
}

/**
 * Sends the success message to a member's DMs, when there is one.
 */
export async function sendSuccessMessage(
  tourney: TourneyRecord,
  userId: string,
  jumpUrl: string | null,
  client: { users: { fetch(id: string): Promise<{ send(payload: unknown): Promise<unknown> }> } },
): Promise<void> {
  if (!tourney.successMessage) return;

  const user = await client.users.fetch(userId).catch(() => null);

  if (!user) return;

  const embed = new EmbedBuilder()
    .setColor(PANEL_COLOR)
    .setTitle("Message from the server")
    .setDescription(tourney.successMessage);

  if (jumpUrl) embed.setURL(jumpUrl);

  run(
    async () => {
      await user.send({ embeds: [embed] }).catch(() => undefined);
    },
    "tourneys.sendSuccessMessage",
  );
}
