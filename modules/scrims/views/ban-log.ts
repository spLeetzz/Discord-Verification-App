/**
 * The ban log.
 *
 * A guild's ban log channel is configured with `/scrims banlog` and
 * stored in `ban_logs` — one row per guild. This file is the half that
 * **writes** to it.
 *
 * The source's `q banlog` existed so that bans and unbans left a trace
 * in a channel the moderators could read; the command alone would have
 * configured a channel that never received anything.
 *
 * **The write never fails the ban.** A log that cannot be written is a
 * nuisance; a ban that does not happen is a hole. Every failure here is
 * swallowed, and the ban itself has already been written to the
 * database by the time this runs.
 */

import { ChannelType, EmbedBuilder } from "discord.js";
import type { Guild } from "discord.js";
import { EMBED_COLOR, ERROR_COLOR } from "../../../core/constants.js";
import { discordTimestamp } from "../../../core/time.js";
import * as repo from "../repo.js";

/** What the entry says happened. */
export type BanLogAction = "banned" | "unbanned";

/** One entry of the ban log. */
export interface BanLogEntry {
  readonly action: BanLogAction;
  /** Who was banned, or unbanned. */
  readonly userId: string;
  /** Which scrim it happened in. */
  readonly scrimName: string;
  /** Why, when the moderator gave a reason. */
  readonly reason: string | null;
  /** When the ban runs out, when it has a duration. */
  readonly expires: Date | null;
  /**
   * Who did it.
   *
   * `null` when the bot did it — a ban whose time was up.
   */
  readonly moderatorId: string | null;
}

/**
 * Writes one entry to the guild's ban log.
 *
 * Does nothing when the guild has no ban log channel, or when the
 * channel has been deleted since it was set.
 */
export async function writeBanLog(
  guild: Guild,
  entry: BanLogEntry,
): Promise<void> {
  const channelId = await repo.getBanLogChannel(guild.id).catch(() => null);

  if (!channelId) return;

  const channel = guild.channels.cache.get(channelId);

  if (!channel || channel.type !== ChannelType.GuildText) return;

  const embed = new EmbedBuilder()
    .setTitle(entry.action === "banned" ? "🔨 Banned" : "🔓 Unbanned")
    .setColor(entry.action === "banned" ? ERROR_COLOR : EMBED_COLOR)
    .addFields(
      { name: "User", value: `<@${entry.userId}>`, inline: true },
      { name: "Scrim", value: entry.scrimName, inline: true },
      {
        name: "Until",
        value: entry.expires
          ? discordTimestamp(entry.expires, "f")
          : "Never expires",
        inline: true,
      },
    );

  if (entry.reason) {
    embed.addFields({ name: "Reason", value: entry.reason });
  }

  if (entry.moderatorId) {
    embed.addFields({
      name: "Moderator",
      value: `<@${entry.moderatorId}>`,
      inline: true,
    });
  }

  await channel.send({ embeds: [embed] }).catch(() => undefined);
}
