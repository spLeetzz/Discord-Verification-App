/**
 * The tournament slot manager.
 *
 * The public panel a team uses to manage its own registration:
 * **Cancel my slot**, **My groups**, **Change team name** and **Swap
 * groups**.
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
 * somebody else typing in the channel, and it cannot be swallowed by
 * the bot's own message handler.
 */

import {
  actionRow,
  assertComponentBudget,
  dangerButton,
  panelEmbed,
  primaryButton,
  secondaryButton,
} from "../../../core/ui.js";
import type { TourneyRecord } from "../types.js";
import { tourneysId } from "./ids.js";
import type { Panel, PanelComponents } from "./handlers.js";

/**
 * The slot-manager panel.
 */
export function buildSlotManagerPanel(tourney: TourneyRecord): Panel {
  const embed = panelEmbed({
    title: "Tournament slot manager",
    description: `Your slot in **${tourney.name}**.`,
    fields: [
      { name: "Tournament", value: `\`${tourney.name}\``, inline: true },
      { name: "Slots", value: `\`${tourney.totalSlots}\``, inline: true },
      {
        name: "Registration",
        value: tourney.status === "open" ? "`Open`" : "`Closed`",
        inline: true,
      },
    ],
    footer: "Cancelling a slot cannot be undone.",
  });

  const rows: PanelComponents = [];

  // The first row holds the one thing to do next.
  rows.push(
    actionRow(
      primaryButton({
        customId: tourneysId("slotm_rename", tourney.id),
        label: "Change team name",
      }),
    ),
  );

  rows.push(
    actionRow(
      secondaryButton({
        customId: tourneysId("slotm", tourney.id, "info"),
        label: "My groups",
      }),
      secondaryButton({
        customId: tourneysId("slotm_swap", tourney.id),
        label: "Swap groups",
      }),
    ),
  );

  // Cancelling a slot destroys it, and it cannot be undone.
  rows.push(
    actionRow(
      dangerButton({
        customId: tourneysId("slotm_cancel", tourney.id),
        label: "Cancel my slot",
      }),
    ),
  );

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
