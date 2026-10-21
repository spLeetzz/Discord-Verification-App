/**
 * The community area's panels.
 *
 * Every panel the area shows is built here, and every builder is a pure
 * function: it takes data and returns an `EmbedBuilder`. Nothing in this
 * file talks to Discord or to the database, so the wording of a message
 * can be checked without a gateway.
 *
 * The panels are built with `core/ui.ts` — the bot's design language. A
 * panel has a title, a *short* description, the data in the fields, and
 * a footer that says what to do next, so the description does not have
 * to shout it.
 *
 * The area has no buttons of its own: every action here is a slash
 * command, so the footer is where the action is named. The one button
 * the area does show is a link, and it lives in `views/buttons.ts`.
 */

import type { EmbedBuilder } from "discord.js";
import { escapeMarkdown } from "../../../core/escape.js";
import { formatTimestamp } from "../../../core/time.js";
import { panelEmbed } from "../../../core/ui.js";
import type {
  AutoPurgeConfig,
  GuildTagStats,
  MemberTagStat,
  SnipeRecord,
  TagRecord,
} from "../types.js";

/**
 * The panel `/snipe` posts.
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
  return panelEmbed({
    title: "Deleted message",
    description: [
      `**${authorName}** deleted this in **${channelName}**.`,
      "",
      snipe.content,
    ].join("\n"),
    fields: [
      {
        name: "Deleted",
        value: formatTimestamp(snipe.createdAt),
        inline: true,
      },
    ],
    footer: "Sniped messages are kept for ten days.",
  });
}

/**
 * The panel `/tag info` posts.
 */
export function buildTagInfoEmbed(
  tag: TagRecord,
  ownerName: string,
): EmbedBuilder {
  return panelEmbed({
    // The name is the member's own text, so it is escaped: a tag called
    // `*rules*` must not turn the title into italics.
    title: `Tag: ${escapeMarkdown(tag.name)}`,
    fields: [
      { name: "Owner", value: ownerName, inline: true },
      { name: "ID", value: `\`${tag.id}\``, inline: true },
      { name: "Uses", value: String(tag.usage), inline: true },
      { name: "NSFW", value: tag.isNsfw ? "Yes" : "No", inline: true },
      { name: "Embed", value: tag.isEmbed ? "Yes" : "No", inline: true },
    ],
    footer: "Post it with `/tag show <name>`.",
  });
}

/**
 * The panel `/autorole config` posts.
 *
 * @param humans one line per configured human role.
 * @param bots   one line per configured bot role.
 */
export function buildAutoroleConfigEmbed(
  humans: readonly string[],
  bots: readonly string[],
): EmbedBuilder {
  return panelEmbed({
    title: "Auto-roles",
    description: "The roles a new member is given when they join.",
    fields: [
      {
        name: "Humans",
        value: humans.length > 0 ? humans.join("\n") : "Not set",
        inline: false,
      },
      {
        name: "Bots",
        value: bots.length > 0 ? bots.join("\n") : "Not set",
        inline: false,
      },
    ],
    footer: "Add a role with `/autorole humans` or `/autorole bots`.",
  });
}

/**
 * The panel `/autopurge list` posts.
 *
 * The empty case is the command's empty panel, so this is only called
 * with at least one channel.
 *
 * @param channels the channel name of every configured channel. A channel
 *                 that no longer exists is shown as "Deleted channel".
 */
export function buildAutoPurgeListEmbed(
  configs: readonly AutoPurgeConfig[],
  channels: ReadonlyMap<string, string>,
): EmbedBuilder {
  const lines = configs.map((config, index) => {
    const name = channels.get(config.channelId) ?? "Deleted channel";

    return `\`${String(index + 1).padStart(2, "0")}\` ${name} — ${formatDelay(config.deleteAfter)}`;
  });

  return panelEmbed({
    title: "Auto-purge channels",
    description: lines.join("\n"),
    footer: "Set a channel up with `/autopurge set`.",
  });
}

/**
 * The panel `/tag stats` posts for a whole guild.
 */
export function buildGuildTagStatsEmbed(stats: GuildTagStats): EmbedBuilder {
  const topTags =
    stats.topTags.length > 0
      ? stats.topTags
          .map(
            (tag, index) =>
              `${rank(index)} **${escapeMarkdown(tag.name)}** (${tag.usage} uses)`,
          )
          .join("\n")
      : "No tags yet.";

  const topUsers =
    stats.topUsers.length > 0
      ? stats.topUsers
          .map(
            (entry, index) =>
              `${rank(index)} <@${entry.userId}> (${entry.uses} uses)`,
          )
          .join("\n")
      : "Nobody has used a tag yet.";

  const topCreators =
    stats.topCreators.length > 0
      ? stats.topCreators
          .map(
            (entry, index) =>
              `${rank(index)} <@${entry.ownerId}> (${entry.count} tags)`,
          )
          .join("\n")
      : "Nobody has created a tag yet.";

  return panelEmbed({
    title: "Tag stats",
    description: `${stats.totalTags} tags, ${stats.totalUses} tag uses`,
    fields: [
      { name: "Top tags", value: topTags, inline: false },
      { name: "Top tag users", value: topUsers, inline: false },
      { name: "Top tag creators", value: topCreators, inline: false },
    ],
    footer: "These statistics are for this server only.",
  });
}

/**
 * The panel `/tag stats` posts for one member.
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
  const tagLines =
    stats.tags.length > 0
      ? stats.tags
          .map(
            (entry, index) =>
              `${rank(index)} **${escapeMarkdown(entry.name)}** (${entry.usage} uses)`,
          )
          .join("\n")
      : "No tags yet.";

  return panelEmbed({
    title: `Tag stats for ${escapeMarkdown(memberName)}`,
    fields: [
      { name: "Owned tags", value: String(stats.ownedTags), inline: true },
      { name: "Owned tag uses", value: String(stats.ownedUses), inline: true },
      {
        name: "Tag command uses",
        value: String(stats.commandUses),
        inline: true,
      },
      { name: "Top tags", value: tagLines, inline: false },
    ],
    footer: "These statistics are for this server only.",
  });
}

/**
 * The number of a place in a list.
 *
 * A number says the order, which is all a rank is: the source drew the
 * top three with a rank emoji, and a list of emoji is a list of things
 * to decode rather than a list to read.
 */
function rank(index: number): string {
  return `${index + 1}.`;
}

/**
 * A delay in seconds, as a human reads it.
 */
function formatDelay(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  if (minutes === 0) {
    return `${rest} second${rest === 1 ? "" : "s"}`;
  }

  if (rest === 0) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  return `${minutes} minute${minutes === 1 ? "" : "s"} ${rest}s`;
}
