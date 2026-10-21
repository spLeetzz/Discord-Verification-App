/**
 * The community area's embeds.
 *
 * Every embed the area posts is built here, and every builder is a pure
 * function: it takes data and returns an `EmbedBuilder`. Nothing in this
 * file talks to Discord or to the database, so the wording of a message
 * can be checked without a gateway.
 *
 * The emoji are Unicode (D36) — Quotient's snowflake ids point at its
 * own emote server and would render as literal text here.
 */

import { EmbedBuilder } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import { formatTimestamp } from "../../../core/time.js";
import type {
  AutoPurgeConfig,
  GuildTagStats,
  MemberTagStat,
  SnipeRecord,
  TagRecord,
} from "../types.js";

/** The emoji the source's `emojize` helper produced, in order. */
const RANK_EMOJI = ["🥱", "🥲", "🥳"];

/**
 * The emoji for a rank, cycling when there are more than three.
 */
function rankEmoji(index: number): string {
  return RANK_EMOJI[index % RANK_EMOJI.length] ?? "•";
}

/**
 * The embed `/snipe` posts.
 *
 * @param authorName the deleted message's author, as a plain name. The
 *                   source named the author rather than mentioning them,
 *                   and a mention here would ping somebody for a message
 *                   they deleted.
 */
export function buildSnipeEmbed(
  snipe: SnipeRecord,
  authorName: string,
  channelName: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setDescription(
      [
        `Message sent by **${authorName}** was deleted in **${channelName}**.`,
        formatTimestamp(snipe.createdAt),
        "",
        "**__Message Content__**",
        snipe.content,
      ].join("\n"),
    )
    .setFooter({ text: "Deleted" })
    .setTimestamp(snipe.createdAt)
    .setColor(EMBED_COLOR);
}

/**
 * The embed `/tag info` posts.
 */
export function buildTagInfoEmbed(
  tag: TagRecord,
  ownerName: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Stats for tag ${tag.name}`)
    .setAuthor({ name: ownerName })
    .addFields(
      { name: "Owner", value: ownerName, inline: true },
      { name: "ID", value: tag.id, inline: true },
      { name: "Uses", value: String(tag.usage), inline: true },
      { name: "NSFW", value: tag.isNsfw ? "Yes" : "No", inline: true },
      { name: "Embed", value: tag.isEmbed ? "Yes" : "No", inline: true },
    )
    .setFooter({ text: `Created At: ${formatTimestamp(tag.createdAt)}` })
    .setColor(EMBED_COLOR);
}

/**
 * The embed `/autorole config` posts.
 *
 * @param humans one line per configured human role.
 * @param bots   one line per configured bot role.
 */
export function buildAutoroleConfigEmbed(
  humans: readonly string[],
  bots: readonly string[],
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Autorole Config")
    .addFields(
      {
        name: "Humans",
        value: humans.length > 0 ? humans.join("\n") : "Not Set!",
        inline: false,
      },
      {
        name: "Bots",
        value: bots.length > 0 ? bots.join("\n") : "Not Set!",
        inline: false,
      },
    )
    .setColor(EMBED_COLOR);
}

/**
 * The embed `/autopurge list` posts.
 *
 * @param channels the channel name of every configured channel. A channel
 *                 that no longer exists is shown as "Deleted Channel".
 */
export function buildAutoPurgeListEmbed(
  configs: readonly AutoPurgeConfig[],
  channels: ReadonlyMap<string, string>,
): EmbedBuilder {
  const lines = configs.map((config, index) => {
    const name = channels.get(config.channelId) ?? "Deleted Channel";
    const minutes = Math.floor(config.deleteAfter / 60);
    const seconds = config.deleteAfter % 60;

    const delay =
      minutes > 0
        ? `${minutes} minute${minutes === 1 ? "" : "s"}${
            seconds > 0 ? ` ${seconds}s` : ""
          }`
        : `${seconds} second${seconds === 1 ? "" : "s"}`;

    return `\`${String(index + 1).padStart(2, "0")}\` | ${name} (${delay})`;
  });

  return new EmbedBuilder()
    .setTitle("AutoPurge List")
    .setDescription(lines.join("\n") || "This server has no auto-purge channels.")
    .setColor(EMBED_COLOR);
}

/**
 * The embed `/tag stats` posts for a whole guild.
 */
export function buildGuildTagStatsEmbed(stats: GuildTagStats): EmbedBuilder {
  const topTags =
    stats.topTags.length > 0
      ? stats.topTags
          .map(
            (tag, index) =>
              `${rankEmoji(index)}: ${tag.name} (${tag.usage} uses)`,
          )
          .join("\n")
      : "No tag statistics here.";

  const topUsers = Array.from({ length: 3 }, (_, index) => {
    const entry = stats.topUsers[index];

    if (!entry) return `${rankEmoji(index)}: No one!`;

    return `${rankEmoji(index)}: <@${entry.userId}> (${entry.uses} times)`;
  }).join("\n");

  const topCreators =
    stats.topCreators.length > 0
      ? stats.topCreators
          .map(
            (entry, index) =>
              `${rankEmoji(index)}: <@${entry.ownerId}> (${entry.count} tags)`,
          )
          .join("\n")
      : "No statistics to show here.";

  return new EmbedBuilder()
    .setTitle("Tag Stats")
    .setDescription(
      `${stats.totalTags} tags, ${stats.totalUses} tag uses`,
    )
    .addFields(
      { name: "Top Tags", value: topTags, inline: false },
      { name: "Top Tag Users", value: topUsers, inline: false },
      { name: "Top Tag Creators", value: topCreators, inline: false },
    )
    .setFooter({ text: "These statistics are server-specific." })
    .setColor(EMBED_COLOR);
}

/**
 * The embed `/tag stats` posts for one member.
 *
 * @param stats the member's own tags.
 */
export function buildMemberTagStatsEmbed(
  memberName: string,
  stats: {
    ownedTags: number;
    ownedUses: number;
    commandUses: number;
    tags: readonly MemberTagStat[];
  },
): EmbedBuilder {
  const owned = stats.tags[0];

  const tagLines = Array.from({ length: 3 }, (_, index) => {
    const entry = stats.tags[index];

    if (!entry) return `${rankEmoji(index)} Owned Tag: Nothing!`;

    return `${rankEmoji(index)} Owned Tag: ${entry.name} (${entry.usage} uses)`;
  }).join("\n");

  return new EmbedBuilder()
    .setAuthor({ name: memberName })
    .addFields(
      {
        name: "Owned Tags",
        value: owned ? String(owned.totalTags) : "None",
        inline: true,
      },
      {
        name: "Owned Tag Uses",
        value: owned ? String(owned.totalUses) : "0",
        inline: true,
      },
      {
        name: "Tag Command Uses",
        value: String(stats.commandUses),
        inline: true,
      },
      { name: "Top Tags", value: tagLines, inline: false },
    )
    .setFooter({ text: "These statistics are server-specific." })
    .setColor(EMBED_COLOR);
}
