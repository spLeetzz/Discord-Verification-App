/**
 * The tournament slot manager.
 *
 * The public panel a team uses to manage its own registration:
 * **Cancel My Slot**, **My Groups**, **Change Team Name** and **Swap
 * Groups**.
 *
 * The panel is **persistent**: it lives in its own channel and the
 * tournament's row carries the channel and the message id, so the panel
 * is still there after the bot restarts. Every button's custom id names
 * the tournament, so a press can be understood without anybody's memory
 * (D18).
 *
 * **The change-team-name flow is a modal.** The source granted the user
 * temporary `send_messages` in the channel and waited for their next
 * chat message (`slotm.py:169-193`) — a chat-message collector, which is
 * the class of flow D17 bans. A modal is a native Discord primitive: it
 * is addressed to the person who opened it, it cannot be hijacked by
 * somebody else typing in the channel, and it cannot be swallowed by the
 * bot's own message handler.
 */

import { ButtonStyle, EmbedBuilder } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import type { TourneyRecord } from "../types.js";
import {
  assertComponentBudget,
  button,
  buttonRow,
} from "./components.js";
import { tourneysId } from "./ids.js";
import type { Panel, PanelComponents } from "./handlers.js";

/**
 * The slot-manager panel.
 */
export function buildSlotManagerPanel(tourney: TourneyRecord): Panel {
  const embed = new EmbedBuilder()
    .setTitle("Tournament Slot Manager")
    .setColor(EMBED_COLOR)
    .setDescription(
      [
        `**${tourney.name}**`,
        "",
        "• Click **Cancel My Slot** below to cancel your slot.",
        "• Click **My Groups** to see the slots you hold.",
        "• Click **Change Team Name** to rename your team.",
        "",
        "*Note that cancelling a slot is irreversible.*",
      ].join("\n"),
    );

  const rows: PanelComponents = [
    buttonRow(
      button({
        customId: tourneysId("slotm_cancel", tourney.id),
        label: "Cancel My Slot",
        style: ButtonStyle.Danger,
      }),
      button({
        customId: tourneysId("slotm", tourney.id, "info"),
        label: "My Groups",
        style: ButtonStyle.Success,
      }),
      button({
        customId: tourneysId("slotm_rename", tourney.id),
        label: "Change Team Name",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: tourneysId("slotm_swap", tourney.id),
        label: "Swap Groups",
        style: ButtonStyle.Primary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
