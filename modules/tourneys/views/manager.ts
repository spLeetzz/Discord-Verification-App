/**
 * The management panels.
 *
 * Two panels live here:
 *
 *  - the **manager panel**, which lists the guild's tournaments and lets
 *    a moderator pick one;
 *  - the **per-tournament panel**, which is the panel the source's
 *    `TourneyManager` showed once a tournament had been chosen.
 *
 * The source's manager asked the moderator to pick a tournament *every
 * time* they pressed a button (`Tourney.prompt_selector`), which meant
 * the panel could not survive a restart and two moderators could not see
 * each other's work. Ours carries the tournament's id in the custom id
 * (D18), so the panel is a render of the row and every button says which
 * tournament it acts on.
 *
 * **The panel is public** (D43): other moderators have to be able to see
 * it.
 */

import { ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import type { TourneyRecord } from "../types.js";
import {
  assertComponentBudget,
  button,
  buttonRow,
  selectRow,
} from "./components.js";
import { tourneysId } from "./ids.js";
import type { Panel, PanelComponents } from "./handlers.js";

/** How many tournaments the select menu can offer. */
const MAX_MENU_OPTIONS = 25;

/**
 * The manager panel: the guild's tournaments and a way into each.
 */
export function buildManagerPanel(
  tourneys: readonly TourneyRecord[],
): Panel {
  const embed = new EmbedBuilder()
    .setTitle("Tournament Manager")
    .setColor(EMBED_COLOR);

  if (tourneys.length === 0) {
    embed.setDescription(
      "There is no tournament in this server yet. Use **Create Tournament** to make one.",
    );
  } else {
    embed.setDescription(
      tourneys
        .map(
          (tourney, index) =>
            `\`${String(index + 1).padStart(2, "0")}.\` **${tourney.name}** — \`${tourney.status}\` — Slots: \`${tourney.totalSlots}\``,
        )
        .join("\n"),
    );
  }

  const rows: PanelComponents = [];

  if (tourneys.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(tourneysId("select", "pick"))
      .setPlaceholder("Choose a tournament to manage")
      .setMinValues(1)
      .setMaxValues(1);

    for (const tourney of tourneys.slice(0, MAX_MENU_OPTIONS)) {
      menu.addOptions({
        label: tourney.name.slice(0, 100),
        value: tourney.id,
        description: `${tourney.status} — ${tourney.totalSlots} slots`.slice(0, 100),
      });
    }

    rows.push(selectRow(menu));
  }

  rows.push(
    buttonRow(
      button({
        customId: tourneysId("wizard", "new"),
        label: "Create Tournament",
        style: ButtonStyle.Success,
      }),
      button({
        customId: tourneysId("manager", "refresh"),
        label: "Refresh",
        style: ButtonStyle.Secondary,
      }),
    ),
  );

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}

/**
 * The panel of one tournament.
 *
 * Every button carries the tournament's id, so the panel survives a
 * restart and two moderators can work on the same tournament.
 */
export function buildTourneyPanel(tourney: TourneyRecord): Panel {
  const embed = new EmbedBuilder()
    .setTitle(`Tournament — ${tourney.name}`)
    .setColor(EMBED_COLOR)
    .setDescription(
      [
        `**Status:** \`${tourney.status}\``,
        `**Slots:** \`${tourney.totalSlots}\``,
        `**Teams per group:** \`${tourney.groupSize ?? "not set"}\``,
        `**Registration channel:** <#${tourney.registrationChannelId}>`,
        `**Confirm channel:** <#${tourney.confirmChannelId}>`,
        `**Success role:** <@&${tourney.roleId}>`,
        `**Mentions required:** \`${tourney.requiredMentions}\``,
        `**Reactions:** ${tourney.emojis.tick},${tourney.emojis.cross}`,
      ].join("\n"),
    );

  const rows: PanelComponents = [
    buttonRow(
      button({
        customId: tourneysId("lifecycle", "toggle", tourney.id),
        label: tourney.status === "open" ? "Pause Reg" : "Start Reg",
        style:
          tourney.status === "open" ? ButtonStyle.Secondary : ButtonStyle.Success,
      }),
      button({
        customId: tourneysId("lifecycle", "close", tourney.id),
        label: "Close Reg",
        style: ButtonStyle.Danger,
        disabled: tourney.status === "closed",
      }),
      button({
        customId: tourneysId("editor", tourney.id),
        label: "Edit Settings",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: tourneysId("groups", tourney.id),
        label: "Manage Groups",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: tourneysId("ban", tourney.id),
        label: "Ban/Unban",
        style: ButtonStyle.Secondary,
      }),
    ),
    buttonRow(
      button({
        customId: tourneysId("slotm", tourney.id),
        label: "Slot-Manager",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: tourneysId("partner", tourney.id),
        label: "Media-Partner",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: tourneysId("modal", "add_slot", tourney.id),
        label: "Add Slot",
        style: ButtonStyle.Success,
      }),
      button({
        customId: tourneysId("modal", "remove_slot", tourney.id),
        label: "Cancel Slots",
        style: ButtonStyle.Danger,
      }),
      button({
        customId: tourneysId("modal", "export", tourney.id),
        label: "Export CSV",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
