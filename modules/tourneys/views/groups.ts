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

import type { EmbedBuilder } from "discord.js";
import {
  actionRow,
  assertComponentBudget,
  navigationRow,
  panelEmbed,
  primaryButton,
  secondaryButton,
  successButton,
} from "../../../core/ui.js";
import { renderGroupList } from "../groups.js";
import type { TourneyRecord, TourneySlotRecord } from "../types.js";
import type { Group } from "../groups.js";
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

  const embed = panelEmbed({
    title: `Group management — ${tourney.name}`,
    description:
      group === null
        ? "Nobody has registered yet, so there are no groups to draw."
        : "The teams of each group, and what to do with them.",
    fields: [
      {
        name: "Group",
        value: group === null ? "`None`" : `**${current}** of ${groups.length}`,
        inline: true,
      },
      {
        name: "Teams per group",
        value: `\`${tourney.groupSize ?? "not set"}\``,
        inline: true,
      },
      {
        name: "Slotlist start",
        value: `\`${tourney.startFrom}\``,
        inline: true,
      },
      {
        name: "Category",
        value: categoryId ? `<#${categoryId}>` : "`Not created`",
        inline: true,
      },
      ...(group === null
        ? []
        : [
            {
              name: `Group ${current}`,
              value: renderGroupList(group, tourney.startFrom),
              inline: false,
            },
          ]),
    ],
    footer:
      "Publish the list to put it in a channel. Set the number of teams per group in the editor.",
  });

  const rows: PanelComponents = [];

  // The first row holds the one thing to do next.
  rows.push(
    actionRow(
      primaryButton({
        customId: tourneysId("group_publish", tourney.id, current),
        label: "Publish group list",
        disabled: group === null,
      }),
    ),
  );

  // Creating the channels and the roles is green: it creates them.
  rows.push(
    actionRow(
      successButton({
        customId: tourneysId("modal", "group_format", tourney.id),
        label: "Create channels and roles",
      }),
      secondaryButton({
        customId: tourneysId("groups", tourney.id, current, "role"),
        label: "Give group role",
        disabled: group === null,
      }),
      secondaryButton({
        customId: tourneysId("modal", "set_start_from", tourney.id),
        label: "Set slotlist start",
      }),
    ),
  );

  // The navigation is grey and last.
  rows.push(
    navigationRow(
      secondaryButton({
        customId: tourneysId("groups", tourney.id, current - 1),
        label: "Previous",
        disabled: current <= 1,
      }),
      secondaryButton({
        customId: tourneysId("groups", tourney.id, current + 1),
        label: "Next",
        disabled: current >= groups.length,
      }),
      secondaryButton({
        customId: tourneysId("groups", tourney.id, current, "refresh"),
        label: "Refresh",
      }),
      secondaryButton({
        customId: tourneysId("manager", tourney.id),
        label: "Back",
      }),
    ),
  );

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

  const embed = panelEmbed({
    title: `${tourney.name} — Group ${group.number}`,
    description: renderGroupList(group, tourney.startFrom),
    footer: `${guildName} — press Info to see a slot's details.`,
  });

  const rows: PanelComponents = [
    // The one thing a reader of the board can do.
    actionRow(
      primaryButton({
        customId: tourneysId("group_refresh", tourney.id, group.number, "info"),
        label: "Info",
      }),
    ),

    // The navigation is grey and last.
    navigationRow(
      secondaryButton({
        customId: tourneysId("group_refresh", tourney.id, group.number),
        label: "Refresh",
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
