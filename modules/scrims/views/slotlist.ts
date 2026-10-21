/**
 * The published slotlist.
 *
 * The slotlist is a message in the slotlist channel with three buttons:
 * **Edit**, **Punish** and **Info**. It has to survive a restart, so the
 * custom id carries the scrim id (D18) and the message id is stored on
 * the scrim row.
 *
 * The Edit panel's "Add Team", "Remove Team" and "Change Team" buttons
 * are state transitions on the `slots` table. The source's "Add Team"
 * offered `range(start_from, 30)` — twenty slot numbers that did not
 * exist for a scrim with fewer slots (B4). Ours offers the scrim's own
 * numbers.
 */

import { ButtonStyle, EmbedBuilder } from "discord.js";
import type { Message, TextChannel } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import { discordTimestamp } from "../../../core/time.js";
import { renderSlotlist, slotListLines } from "../render.js";
import type { ScrimRecord, SlotRecord } from "../types.js";
import { assertComponentBudget, button, buttonRow } from "./components.js";
import { scrimsId } from "./ids.js";
import type { PanelComponents } from "./manager.js";

/** The panel that manages the slotlist. */
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
    buttonRow(
      button({
        customId: scrimsId("slotlist", scrim.id, "repost"),
        label: "Repost Slotlist",
        style: ButtonStyle.Primary,
      }),
      button({
        customId: scrimsId("slotlist", scrim.id, "edit"),
        label: "Edit Slotlist",
        style: ButtonStyle.Secondary,
      }),
      button({
        customId: scrimsId("slotlist", scrim.id, "punish"),
        label: "Punish",
        style: ButtonStyle.Danger,
        disabled: claimed.length === 0,
      }),
      button({
        customId: scrimsId("slotlist", scrim.id, "info"),
        label: "Info",
        style: ButtonStyle.Secondary,
        disabled: claimed.length === 0,
      }),
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

/**
 * Publishes the slotlist.
 *
 * The message carries the Edit / Punish / Info panel, so it keeps
 * working after a restart: the custom id names the scrim, and the scrim
 * row names the message.
 */
export async function publishSlotlist(
  channel: TextChannel,
  scrim: ScrimRecord,
  slots: readonly SlotRecord[],
): Promise<Message> {
  const embed = renderSlotlist(scrim, {
    name: scrim.name,
    elapsedSeconds: scrim.timeElapsedSeconds,
    openTime: scrim.openTime,
    slots: slotListLines(slots),
  });

  const rows: PanelComponents = [
    buttonRow(
      button({
        customId: scrimsId("slotlist", scrim.id, "edit"),
        label: "Edit",
        emoji: "📝",
        style: ButtonStyle.Success,
      }),
      button({
        customId: scrimsId("slotlist", scrim.id, "punish"),
        label: "Punish",
        emoji: "🛠️",
        style: ButtonStyle.Danger,
      }),
      button({
        customId: scrimsId("slotlist", scrim.id, "info"),
        label: "Info",
        emoji: "🔍",
        style: ButtonStyle.Success,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return channel.send({ embeds: [embed], components: rows });
}

/**
 * Refreshes the published slotlist message.
 *
 * The message id is on the scrim row, so the message is found again
 * after a restart without anybody rediscovering it by name.
 */
export async function refreshSlotlistMessage(
  channel: TextChannel,
  scrim: ScrimRecord,
  slots: readonly SlotRecord[],
): Promise<void> {
  if (!scrim.slotlistMessageId) return;

  const embed = renderSlotlist(scrim, {
    name: scrim.name,
    elapsedSeconds: scrim.timeElapsedSeconds,
    openTime: scrim.openTime,
    slots: slotListLines(slots),
  });

  const message = await channel.messages
    .fetch(scrim.slotlistMessageId)
    .catch(() => null);

  if (!message) return;

  await message.edit({ embeds: [embed] }).catch(() => undefined);
}

/** The moment a slotlist was published, for the footer. */
export function publishedAt(slots: readonly SlotRecord[]): Date | null {
  const first = slots[0];

  return first ? first.createdAt : null;
}

/** The relative time of the last update, for the panel. */
export function updatedAgo(slots: readonly SlotRecord[]): string {
  const published = publishedAt(slots);

  if (!published) return "never";

  return discordTimestamp(published, "R");
}
