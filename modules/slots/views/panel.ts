/**
 * The public panel: its body, its buttons and its refresh.
 *
 * The panel is a message in a read-only channel. It has to survive a
 * restart, so every button's custom id carries the **slot manager's id**
 * (D18) — the manager row knows the channel, the message and the scrims.
 *
 * The builders live here and the handlers live in `public.ts`, so the
 * slot list can refresh the panel without importing the handlers.
 *
 * **The look.** The panel exists so that a member can take a slot, so
 * "Claim slot" is the one blue button and it stands alone on the first
 * row. "Cancel slot" takes the slot away, so it is red. Everything else
 * is grey. The footer carries the hint, so the body does not have to
 * shout it.
 */

import type {
  ActionRowBuilder,
  ButtonBuilder,
  Client,
  EmbedBuilder,
} from "discord.js";
import { plural } from "../../../core/text.js";
import {
  actionRow,
  dangerButton,
  panelEmbed,
  primaryButton,
  secondaryButton,
} from "../../../core/ui.js";
import { logger } from "../../../utils/logger.js";
import * as repo from "../repo.js";
import * as service from "../service.js";
import { slotsId } from "../ids.js";
import type { ClaimableScrim } from "../service.js";
import type { SlotManagerRecord } from "../types.js";
import { assertComponentBudget } from "./components.js";

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
 * The body is the data — the slots that can be taken right now — and
 * the footer is the hint about what to do next.
 */
export function buildPublicEmbed(
  manager: SlotManagerRecord,
  claimable: readonly ClaimableScrim[],
): EmbedBuilder {
  const lines = claimable.map((entry, index) => {
    const channel = entry.scrim.registrationChannelId;

    return `${index + 1}. Slot ${entry.lowestFreeNum} — <#${channel}> ─ ${plural(entry.freeCount, "Slot")}`;
  });

  const body =
    lines.length > 0
      ? lines.join("\n")
      : "No slots are available right now.";

  return panelEmbed({
    title: "Scrims slot management",
    description: body,
    footer: publicFooter(manager, claimable.length),
  });
}

/**
 * The panel's hint.
 *
 * It says the one thing the body does not: what to press, or why
 * nothing can be pressed.
 */
function publicFooter(
  manager: SlotManagerRecord,
  available: number,
): string {
  if (!manager.toggle) {
    return "This panel is switched off. A moderator has to switch it on before a slot can be claimed.";
  }

  if (available === 0) {
    return "No slot is free right now. Set a reminder and the bot will tell you when one opens up.";
  }

  return "Claim a slot with the button below. The ID/Pass role only moves to a teammate you mention when you claim.";
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
): ActionRowBuilder<ButtonBuilder>[] {
  const disabled = !manager.toggle;

  const rows = [
    actionRow(
      primaryButton({
        customId: slotsId("claim", manager.id),
        label: "Claim slot",
        disabled: disabled || claimable.length === 0,
      }),
    ),
    actionRow(
      secondaryButton({
        customId: slotsId("remind", manager.id),
        label: "Remind me",
        disabled: disabled || !manager.allowReminders,
      }),
      secondaryButton({
        customId: slotsId("idp", manager.id),
        label: "Transfer ID/Pass role",
        disabled,
      }),
      dangerButton({
        customId: slotsId("cancel", manager.id),
        label: "Cancel slot",
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

  const embed = buildPublicEmbed(manager, claimable);
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
