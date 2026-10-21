/**
 * The group panels.
 *
 * Two things live here:
 *
 *  - the **group manager**, the panel a moderator uses to draw the
 *    groups, create the group channels and roles, and publish the
 *    group lists;
 *  - the **published group list**, the message that goes into a group
 *    channel with a persistent **Refresh** button on it.
 *
 * The published list is keyed by its message id in
 * `tourney_group_lists`, and the **channel is stored on the row**
 * (D16 / B15). The source re-discovered the channel by a substring match
 * on the channel name, so "Group 1" also matched "Group 10" — the list
 * was posted into the wrong channel half the time.
 *
 * The Refresh button's two-minute cooldown reads a plain timestamp that
 * **only the refresh path writes** (B16). The source read an `auto_now`
 * column, so the cooldown depended on the last write of any kind.
 */

import { ButtonStyle, EmbedBuilder } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import { renderGroupList } from "../groups.js";
import type { TourneyRecord, TourneySlotRecord } from "../types.js";
import type { Group } from "../groups.js";
import {
  assertComponentBudget,
  button,
  buttonRow,
} from "./components.js";
import { tourneysId } from "./ids.js";
import type { Panel, PanelComponents } from "./handlers.js";

/** The group manager panel. */
export function buildGroupManagerPanel(options: {
  readonly tourney: TourneyRecord;
  readonly groups: readonly Group<TourneySlotRecord>[];
  /** The group the panel is showing. Counting from 1. */
  readonly current: number;
  /** The category the group channels live in, when one was made. */
  readonly categoryId: string | null;
}): Panel {
  const { tourney, groups, current, categoryId } = options;

  const group = groups[current - 1] ?? null;

  const embed = new EmbedBuilder()
    .setTitle(`Group Management — ${tourney.name}`)
    .setColor(EMBED_COLOR)
    .setDescription(
      group === null
        ? "Nobody has registered yet, so there are no groups to draw."
        : `**Group ${current} of ${groups.length}**\n\n${renderGroupList(group, tourney.startFrom)}`,
    );

  embed.addFields(
    {
      name: "Teams per group",
      value: `\`${tourney.groupSize ?? "not set"}\``,
      inline: true,
    },
    {
      name: "Slotlist start from",
      value: `\`${tourney.startFrom}\``,
      inline: true,
    },
    {
      name: "Category",
      value: categoryId ? `<#${categoryId}>` : "`Not created`",
      inline: true,
    },
  );

  const rows: PanelComponents = [
    buttonRow(
      button({
        customId: tourneysId("groups", tourney.id, current - 1),
        label: "Previous",
        style: ButtonStyle.Secondary,
        disabled: current <= 1,
      }),
      button({
        customId: tourneysId("groups", tourney.id, current + 1),
        label: "Next",
        style: ButtonStyle.Secondary,
        disabled: current >= groups.length,
      }),
      button({
        customId: tourneysId("group_publish", tourney.id, current),
        label: "Publish Group List",
        style: ButtonStyle.Success,
        disabled: group === null,
      }),
      button({
        customId: tourneysId("modal", "group_format", tourney.id),
        label: "Create Channels & Roles",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: tourneysId("groups", tourney.id, current, "role"),
        label: "Give Group Role",
        style: ButtonStyle.Primary,
        disabled: group === null,
      }),
    ),
    buttonRow(
      button({
        customId: tourneysId("modal", "set_start_from", tourney.id),
        label: "Slotlist Start",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: tourneysId("groups", tourney.id, current, "refresh"),
        label: "Refresh",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: tourneysId("manager", tourney.id),
        label: "Main Menu",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/**
 * The published group list.
 *
 * The message a group channel gets. It carries a **persistent Refresh
 * button** whose custom id names the tournament and the group, so it
 * survives a restart (D18).
 */
export function buildPublishedGroupList(options: {
  readonly tourney: TourneyRecord;
  readonly group: Group<TourneySlotRecord>;
  readonly guildName: string;
}): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const { tourney, group, guildName } = options;

  const embed = new EmbedBuilder()
    .setTitle(`${tourney.name} — Group ${group.number}`)
    .setColor(EMBED_COLOR)
    .setDescription(renderGroupList(group, tourney.startFrom))
    .setFooter({ text: guildName });

  const rows: PanelComponents = [
    buttonRow(
      button({
        customId: tourneysId("group_refresh", tourney.id, group.number),
        label: "Refresh",
        style: ButtonStyle.Success,
      }),
      button({
        customId: tourneysId("group_refresh", tourney.id, group.number, "info"),
        label: "Info",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
