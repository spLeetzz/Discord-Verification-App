/**
 * The ban log.
 *
 * A guild's ban log channel is configured with `/scrims banlog` and
 * stored in `ban_logs` — one row per guild, holding the channel that
 * receives the ban and unban entries. This file is this area's half of
 * that table: it reads the row and writes the entry.
 *
 * **Why this area has its own writer.** The slot area owns the published
 * slot list, and with it the **Punish** button — the flow a moderator
 * actually uses to ban a team. A ban made through that button has to
 * leave the same trail a ban made anywhere else leaves, or the log stops
 * being an audit trail of anything.
 *
 * The scrims area has a writer for the bans it makes. This is a second
 * implementation of the same content, not an import of theirs: the
 * dependency runs the other way — the scrims area imports this area for
 * the published slot list — so importing back would be a cycle.
 *
 * **The write never fails the ban.** The ban is already in the database
 * by the time the log is written, and a ban a moderator asked for has to
 * happen. A log that cannot be written is a nuisance; a ban that does
 * not happen is a hole. Every failure here is swallowed and logged as a
 * warning, and the caller gets a promise that resolves either way.
 */

import { ChannelType, EmbedBuilder } from "discord.js";
import type { Guild } from "discord.js";
import { EMBED_COLOR, ERROR_COLOR } from "../../core/constants.js";
import { discordTimestamp } from "../../core/time.js";
import { logger } from "../../utils/logger.js";
import * as repo from "./repo.js";

/** What the entry says happened. */
export type BanLogAction = "banned" | "unbanned";

/** One entry of the ban log. */
export interface BanLogEntry {
  readonly action: BanLogAction;
  /** Who was banned, or unbanned. */
  readonly userId: string;
  /** Which scrim it happened in. */
  readonly scrimName: string;
  /** Why, when there was a reason. */
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
 * The embed one entry is written as.
 *
 * Exported on its own so the content can be checked without a Discord
 * channel: the title, the colour and the fields are the promise the
 * ban log makes to the moderator who reads it.
 */
export function buildBanLogEmbed(entry: BanLogEntry): EmbedBuilder {
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

  return embed;
}

/**
 * Writes one entry to the guild's ban log.
 *
 * Does nothing when the guild has no ban log channel, or when the
 * channel has been deleted since it was set. **It never throws**: the
 * ban that caused the entry has already happened, and a moderator's ban
 * must not be refused because the audit trail could not be written.
 */
export async function writeBanLog(
  guild: Guild,
  entry: BanLogEntry,
): Promise<void> {
  await writeBanLogs(guild, [entry]);
}

/**
 * Writes several entries to the guild's ban log.
 *
 * The channel is looked up **once** for the whole batch: a punish that
 * bans a team from every scrim of a server writes one entry per ban,
 * and looking the channel up per entry would be a query per entry for
 * no reason.
 *
 * **It never throws.** Every failure is logged as a warning and the
 * entries that could not be written are lost — a hole in the log, never
 * a refused ban.
 */
export async function writeBanLogs(
  guild: Guild,
  entries: readonly BanLogEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  try {
    const channelId = await repo.getBanLogChannel(guild.id);

    // No channel is configured for this guild. That is a setup matter,
    // not a failure: there is nowhere to write and nothing to warn
    // about.
    if (!channelId) return;

    const channel = guild.channels.cache.get(channelId);

    if (!channel || channel.type !== ChannelType.GuildText) return;

    for (const entry of entries) {
      await channel.send({ embeds: [buildBanLogEmbed(entry)] });
    }
  } catch (error: unknown) {
    logger.warn(
      "[Slots] Could not write the ban log entry; the ban itself stands:",
      error,
    );
  }
}
