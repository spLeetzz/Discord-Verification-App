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

import type { EmbedBuilder } from "discord.js";
import { navigationRow, panelEmbed, secondaryButton } from "../../../core/ui.js";
import { buildSlotListPanel as slotAreaRows } from "../../slots/index.js";
import type { ScrimRecord, SlotRecord } from "../types.js";
import { assertComponentBudget } from "./components.js";
import { scrimsId } from "./ids.js";
import type { PanelComponents } from "./manager.js";

/**
 * The dot that says what state a slot is in.
 *
 * The dot is the state: a slot that is free, one that is taken, one
 * that is locked and one that is banned look different at a glance,
 * without the eye having to read the word next to them.
 */
const SLOT_MARKS: Record<SlotRecord["state"], string> = {
  free: "⚪",
  claimed: "🟢",
  locked: "🔒",
  banned: "🚫",
};

/** The word that goes with the dot. */
const SLOT_WORDS: Record<SlotRecord["state"], string> = {
  free: "free",
  claimed: "claimed",
  locked: "locked",
  banned: "banned",
};

/**
 * One line of the list.
 *
 * A free slot is the dot and the number alone; a slot that carries a
 * team carries its name; a slot that is locked or banned says so, so
 * the reason it cannot be taken is never a mystery.
 */
function slotLine(slot: SlotRecord): string {
  const parts = [`${SLOT_MARKS[slot.state]} ${String(slot.num).padStart(2, "0")}`];

  if (slot.teamName) parts.push(slot.teamName);

  if (slot.state === "locked" || slot.state === "banned") {
    parts.push(`(${SLOT_WORDS[slot.state]})`);
  }

  return parts.join("  ");
}

/**
 * The panel that manages the slotlist.
 *
 * The body is this area's own: every slot of the scrim, in slot order,
 * with a dot that says what state it is in. The `slotlist_format`
 * template (D32) does **not** govern it — it governs the
 * `/scrims slotlist` post, and the published list is the slot area's.
 * One renderer for the preview and the published list is the next step,
 * and it is not this area's to write.
 *
 * The buttons are the **slot area's** — `slots:slotlist_edit`,
 * `slots:slotlist_punish` and `slots:slotlist_info` — so the manager
 * reaches the same operations the published message carries, and there
 * is one namespace for them across the bot. This area renders no
 * `scrims:slotlist:*` button of its own any more.
 *
 * The last row is the way back to the manager panel. Every other
 * panel in this area has one, and this preview is rendered *on* the
 * manager's message, so without it there would be no way back.
 */
export function buildSlotlistPanel(
  scrim: ScrimRecord,
  slots: readonly SlotRecord[],
): { embeds: EmbedBuilder[]; components: PanelComponents } {
  const ordered = [...slots].sort((a, b) => a.num - b.num);

  const embed = panelEmbed({
    title: `Slotlist — ${scrim.name}`,
    description:
      ordered.length === 0
        ? `No team has registered yet. They show up here as they register in <#${scrim.registrationChannelId}>.`
        : ordered.map((slot) => slotLine(slot)).join("\n"),
    footer: "⚪ free · 🟢 claimed · 🔒 locked · 🚫 banned",
  });

  const rows: PanelComponents = [
    ...slotAreaRows(scrim.id),
    navigationRow(
      secondaryButton({
        customId: scrimsId("manager", scrim.id),
        label: "Back",
      }),
    ),
  ];

  assertComponentBudget(rows);

  return { embeds: [embed], components: rows };
}
