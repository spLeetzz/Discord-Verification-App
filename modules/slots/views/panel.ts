/**
 * The public panel: its body, its buttons and its refresh.
 *
 * The panel is a message in a read-only channel. It has to survive a
 * restart, so every button's custom id carries the **slot manager's id**
 * (D18) — the manager row knows the channel, the message and the scrims.
 *
 * The builders live here and the handlers live in `public.ts`, so the
 * slot list can refresh the panel without importing the handlers.
 */

import { ButtonStyle, EmbedBuilder } from "discord.js";
import type { Client } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";
import { plural } from "../../../core/text.js";
import { logger } from "../../../utils/logger.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { slotsId } from "../ids.js";
import type { ClaimableScrim } from "../service.js";
import type { SlotManagerRecord } from "../types.js";
import { assertComponentBudget, button, buttonRow } from "./components.js";

/**
 * The message shown when the slot manager is switched off.
 *
 * The source disabled every button and said nothing. The buttons are
 * still disabled; this is the extra sentence that says why.
 */
export const SLOT_MANAGER_DISABLED_MESSAGE =
  "The slot manager is currently disabled. A moderator has to switch it on before slots can be claimed or cancelled.";

/**
 * The panel's embed.
 *
 * The source's wording, with the button names it actually has.
 */
export function buildPublicEmbed(
  claimable: readonly ClaimableScrim[],
): EmbedBuilder {
  const lines = claimable.map((entry, index) => {
    const channel = entry.scrim.registrationChannelId;

    return `${index + 1}. Slot ${entry.lowestFreeNum} — <#${channel}> ─ ${plural(entry.freeCount, "Slot")}`;
  });

  const body =
    lines.length > 0
      ? lines.join("\n")
      : "```No Slots Available at the time.\nPress 🔔 to set a reminder.```";

  return new EmbedBuilder()
    .setTitle("Scrims Slot Management")
    .setColor(EMBED_COLOR)
    .setDescription(
      [
        "● Press `Cancel Slot` to cancel your slot.",
        "● Note that the ID/Pass role can only be transferred to your teammates.",
        "",
        `● Available Slots:\n${body}`,
      ].join("\n"),
    );
}

/**
 * The panel's buttons.
 *
 * The claim button is disabled when there is nothing to claim, and the
 * reminder button is disabled when the manager does not allow reminders.
 * When the manager itself is switched off, every button is disabled.
 */
export function buildPublicRows(
  manager: SlotManagerRecord,
  claimable: readonly ClaimableScrim[],
): ReturnType<typeof buttonRow>[] {
  const disabled = !manager.toggle;

  const rows = [
    buttonRow(
      button({
        customId: slotsId("cancel", manager.id),
        label: "Cancel Slot",
        style: ButtonStyle.Danger,
        disabled,
      }),
      button({
        customId: slotsId("claim", manager.id),
        label: "Claim Slot",
        style: ButtonStyle.Success,
        disabled: disabled || claimable.length === 0,
      }),
      button({
        customId: slotsId("remind", manager.id),
        label: "Remind Me",
        emoji: "🔔",
        style: ButtonStyle.Secondary,
        disabled: disabled || !manager.allowReminders,
      }),
      button({
        customId: slotsId("idp", manager.id),
        label: "Transfer IDP Role",
        style: ButtonStyle.Success,
        disabled,
      }),
    ),
  ];

  assertComponentBudget(rows);

  return rows;
}

/**
 * Re-renders the public panel.
 *
 * The panel is a message in a channel; the manager row knows both, so
 * the panel is found again after a restart without anybody rediscovering
 * it by name.
 */
export async function refreshPublicMessage(
  client: Client,
  managerId: string,
): Promise<void> {
  const manager = await repo.getSlotManager(managerId);

  if (!manager) return;

  const claimable = await service.listClaimableScrims(
    repo.slotStore,
    manager.id,
  );

  const embed = buildPublicEmbed(claimable);
  const rows = buildPublicRows(manager, claimable);

  const guild = client.guilds.cache.get(manager.guildId);

  if (!guild) return;

  const channel = guild.channels.cache.get(manager.mainChannelId);

  if (!channel || !("messages" in channel)) return;

  const message = await channel.messages
    .fetch(manager.messageId)
    .catch(() => null);

  if (!message) return;

  await message
    .edit({ embeds: [embed], components: rows })
    .catch(() => undefined);
}

/**
 * Re-renders every public panel of a guild.
 *
 * A claim in one scrim changes what the panel shows, so every manager of
 * the guild is refreshed.
 */
export async function refreshGuildPanels(
  client: Client,
  guildId: string,
): Promise<void> {
  const managers = await repo.listSlotManagers(guildId);

  for (const manager of managers) {
    await refreshPublicMessage(client, manager.id).catch((error: unknown) => {
      logger.error("[Slots] Could not refresh the public panel:", error);
    });
  }
}
