/**
 * Creating the group channels and roles.
 *
 * The source's flow (`groupm/main.py:135-147`) created a role and a
 * channel for every group in a loop, with **no rollback**: if channel 4
 * of 5 failed, the first three were left behind, and the category with
 * them (B17).
 *
 * Ours collects what it creates and undoes it when something fails:
 * the channels, then the roles, then the category, in reverse order. A
 * failed creation leaves the server exactly as it was.
 *
 * The channels are created with a permission overwrite that gives the
 * group role read access and everybody else none, and the **published
 * group list is written to the channel it was created in** — so the
 * channel is *stored on the row* and never has to be rediscovered by a
 * substring match (D16 / B15).
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { Guild, Role, TextChannel } from "discord.js";
import { logger } from "../../../utils/logger.js";
import type { TourneyRecord } from "../types.js";
import type { Group } from "../groups.js";
import * as repo from "../repo.js";
import { buildPublishedGroupList } from "./groups.js";

/** The result of a creation run. */
export type GroupChannelResult =
  | { readonly ok: true; readonly created: number }
  | { readonly ok: false; readonly reason: string };

/**
 * The name of the category the group channels live in.
 *
 * It carries the tournament's id, so two tournaments never share a
 * category and the category can be found again by an **exact** name.
 */
export function groupCategoryName(tourneyId: string): string {
  return `tourney-groups-${tourneyId}`;
}

/**
 * Creates a category, a role and a channel per group.
 *
 * @param guild   the guild the channels are created in;
 * @param tourney the tournament the groups belong to;
 * @param format  the name format, with `{0}` where the group number goes;
 * @param from    the first group number;
 * @param to      the last group number;
 * @param groups  the groups that exist, so the lists can be published.
 */
export async function createGroupChannels(options: {
  readonly guild: Guild;
  readonly tourney: TourneyRecord;
  readonly format: string;
  readonly from: number;
  readonly to: number;
  readonly groups: readonly Group[];
}): Promise<GroupChannelResult> {
  const { guild, tourney, format, from, to, groups } = options;

  if (guild.channels.cache.size >= 490) {
    return {
      ok: false,
      reason: "Too many channels in this server. Please delete some first.",
    };
  }

  const me = guild.members.me;

  if (!me) {
    return { ok: false, reason: "I could not find my own member record." };
  }

  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return {
      ok: false,
      reason: "I do not have `Manage Channels` in this server.",
    };
  }

  const createdChannels: TextChannel[] = [];
  const createdRoles: Role[] = [];
  let categoryId: string | null = null;

  try {
    const category = await guild.channels.create({
      name: groupCategoryName(tourney.id),
      type: ChannelType.GuildCategory,
      reason: `Group channels for tournament ${tourney.id}`,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageRoles,
          ],
        },
      ],
    });

    categoryId = category.id;

    for (let number = from; number <= to; number += 1) {
      const name = format.replaceAll("{0}", String(number));

      const role = await guild.roles.create({
        name,
        reason: `Group role for tournament ${tourney.id}`,
        permissions: [],
      });

      createdRoles.push(role);

      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category.id,
        reason: `Group channel for tournament ${tourney.id}`,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
            ],
          },
          {
            id: role.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
          {
            id: me.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.ManageMessages,
            ],
          },
        ],
      });

      createdChannels.push(channel);
    }
  } catch (error) {
    logger.error(
      `[Tourneys] Could not create the group channels: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    await rollback(guild, createdChannels, createdRoles, categoryId);

    return {
      ok: false,
      reason:
        error instanceof Error
          ? `Could not create the group channels: ${error.message}`
          : "Could not create the group channels.",
    };
  }

  // Publish the group lists into the channels that were just created, so
  // the channel is stored on the row.
  for (const group of groups) {
    if (group.number < from || group.number > to) continue;

    const channel = createdChannels[group.number - from];

    if (!channel) continue;

    const panel = buildPublishedGroupList({
      tourney,
      group: group as Parameters<typeof buildPublishedGroupList>[0]["group"],
      guildName: guild.name,
    });

    const message = await channel
      .send({ embeds: panel.embeds, components: panel.components })
      .catch(() => null);

    if (!message) continue;

    await repo.upsertGroupList({
      tourneyId: tourney.id,
      messageId: message.id,
      channelId: channel.id,
      groupNumber: group.number,
    });
  }

  return { ok: true, created: createdChannels.length };
}

/**
 * Undoes a failed creation.
 *
 * The channels go first, then the roles, then the category — a channel
 * cannot be deleted while its category is gone, and a role cannot be
 * deleted while it is still attached to a channel.
 */
export async function rollback(
  guild: Guild,
  channels: readonly TextChannel[],
  roles: readonly Role[],
  categoryId: string | null,
): Promise<void> {
  for (const channel of [...channels].reverse()) {
    await channel.delete().catch(() => undefined);
  }

  for (const role of [...roles].reverse()) {
    await role.delete().catch(() => undefined);
  }

  if (!categoryId) return;

  const category = guild.channels.cache.get(categoryId);

  if (!category) return;

  await category.delete().catch(() => undefined);
}
