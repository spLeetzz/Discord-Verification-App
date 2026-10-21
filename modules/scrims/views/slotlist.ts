/**
 * The scrims area's slotlist view.
 *
 * The **published** slot list belongs to the slot area: it owns the
 * panel, the buttons (`slots:slotlist_*`) and the operations behind
 * them. This area keeps the lifecycle — open, close, the daily
 * `scrim_open` job, the autoclean — and publishes the list *through*
 * the slot area's API (`modules/slots/index.js`), so there is one
 * implementation of what a published slot list looks like and one
 * namespace for its buttons.
 *
 * The import direction is one-way (scrims → slots), so there is no
 * cycle.
 *
 * What is left here is the **manager's view** of a scrim's slotlist:
 * the preview a moderator sees on the manager panel. Its body is this
 * area's own, and its buttons are the slot area's.
 */

import { ButtonStyle, EmbedBuilder } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import { buildSlotListPanel as slotAreaRows } from "../../slots/index.js";
import { slotListLines } from "../render.js";
import type { ScrimRecord, SlotRecord } from "../types.js";
import { assertComponentBudget, button, buttonRow } from "./components.js";
import { scrimsId } from "./ids.js";
import type { PanelComponents } from "./manager.js";

/**
 * The panel that manages the slotlist.
 *
 * The body is this area's own: a plain list of the claimed slots. The
 * `slotlist_format` template (D32) does **not** govern it — it
 * governs the `/scrims slotlist` post, and the published list is the
 * slot area's. One renderer for the preview and the published list is
 * the next step, and it is not this area's to write.
 *
 * The buttons are the **slot area's** — `slots:slotlist_edit`,
 * `slots:slotlist_punish` and `slots:slotlist_info` — so the manager
 * reaches the same operations the published message carries, and there
 * is one namespace for them across the bot. This area renders no
 * `scrims:slotlist:*` button of its own any more.
 *
 * The second row is the way back to the manager panel. Every other
 * panel in this area has one, and this preview is rendered *on* the
 * manager's message, so without it there would be no way back.
 */
export function buildSlotlistPanel(
  scrim: ScrimRecord,
  slots: readonly SlotRecord[],
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const claimed = slots.filter((slot) => slot.state === "claimed");

  const embed = new EmbedBuilder()
    .setTitle(`Slotlist — ${scrim.name}`)
    .setColor(EMBED_COLOR)
    .setDescription(
      claimed.length === 0
        ? "No team has registered yet."
        : `\`\`\`\n${slotListLines(claimed)}\n\`\`\``,
    );

  const rows: PanelComponents = [
    ...slotAreaRows(scrim.id),
    buttonRow(
      button({
        customId: scrimsId("manager", scrim.id),
        label: "Main Menu",
        style: ButtonStyle.Secondary,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
