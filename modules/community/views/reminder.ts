/**
 * The reminder delivery.
 *
 * A reminder is posted in the channel it was created in — not by DM. The
 * source did the same, and it is the right behaviour: a DM is a private
 * inbox the user may not be looking at, and a channel is where the
 * conversation the reminder belongs to is.
 *
 * If the channel is gone, the reminder is dropped and the drop is
 * logged. Nothing else can be done with it.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import type { Client } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import { discordTimestamp, formatTimestamp } from "../../../core/time.js";
import { logger } from "../../../utils/logger.js";
import type { ReminderJobPayload } from "../types.js";

/**
 * The result of a delivery attempt.
 */
export type ReminderDelivery =
  /** The reminder was posted. */
  | "delivered"
  /** The channel no longer exists. */
  | "channel_gone"
  /** The channel could not be posted in. */
  | "not_postable";

/**
 * The embed a reminder is posted with.
 *
 * @param reminderId the job's id, so a member can tell two reminders
 *                   apart.
 * @param createdAt  when the reminder was set.
 */
export function buildReminderEmbed(
  reminderId: string,
  message: string,
  createdAt: Date,
  jumpUrl: string | null,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Reminder #${reminderId}`)
    .setDescription(`${discordTimestamp(createdAt)}: ${message}`)
    .setTimestamp(Date.now())
    .setColor(EMBED_COLOR);

  if (jumpUrl) embed.setURL(jumpUrl);

  return embed;
}

/**
 * The "jump to the original message" button.
 */
function buildJumpRow(jumpUrl: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Jump to Original Message")
      .setURL(jumpUrl)
      .setStyle(ButtonStyle.Link),
  );
}

/**
 * Posts a reminder in the channel it was created in.
 *
 * @param client  the bot client.
 * @param payload the job's payload.
 * @param options the job's id and creation time, for the embed.
 */
export async function deliverReminder(
  client: Client,
  payload: ReminderJobPayload,
  options: { reminderId: string; createdAt: Date },
): Promise<ReminderDelivery> {
  // The cache first: fetching a channel is an API call, and a reminder
  // is delivered the moment it comes due.
  const channel =
    client.channels.cache.get(payload.channelId) ??
    (await client.channels.fetch(payload.channelId).catch(() => null));

  if (!channel) {
    logger.warn(
      `[Community] The channel ${payload.channelId} is gone, so reminder ${options.reminderId} was dropped.`,
    );

    return "channel_gone";
  }

  if (!channel.isTextBased() || channel.isDMBased()) {
    logger.warn(
      `[Community] The channel ${payload.channelId} cannot hold messages, so reminder ${options.reminderId} was dropped.`,
    );

    return "not_postable";
  }

  if (!channel.isSendable()) {
    logger.warn(
      `[Community] The channel ${payload.channelId} cannot be posted in, so reminder ${options.reminderId} was dropped.`,
    );

    return "not_postable";
  }

  const jumpUrl = buildJumpUrl(
    channel,
    payload.sourceMessageId ?? null,
  );

  const embed = buildReminderEmbed(
    options.reminderId,
    payload.message,
    options.createdAt,
    jumpUrl,
  );

  try {
    await channel.send({
      content: `<@${payload.userId}>`,
      embeds: [embed],
      ...(jumpUrl ? { components: [buildJumpRow(jumpUrl)] } : {}),
    });
  } catch (error) {
    logger.warn(
      `[Community] Could not post reminder ${options.reminderId}: ${String(error)}`,
    );

    return "not_postable";
  }

  return "delivered";
}

/**
 * The link to the message the reminder was set from.
 *
 * @returns `null` when there is no message to jump to.
 */
function buildJumpUrl(
  channel: { id: string; guildId: string | null },
  sourceMessageId: string | null,
): string | null {
  if (!sourceMessageId) return null;

  const guildId = channel.guildId;

  if (!guildId) return null;

  return `https://discord.com/channels/${guildId}/${channel.id}/${sourceMessageId}`;
}

/**
 * A one-line description of when a reminder is due, for a log line.
 */
export function describeDueAt(dueAt: Date): string {
  return formatTimestamp(dueAt);
}
