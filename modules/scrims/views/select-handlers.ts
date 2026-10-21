/**
 * The select-menu handlers.
 *
 * Two menus live here:
 *
 *  1. the **list panel's** menu, which carries the scrim ids as its
 *     values, so choosing one is enough — there is no state to keep and
 *     the panel survives a restart;
 *  2. the **slotlist editor's** menu, which asks a moderator which slot
 *     to add a team to or to change. That one is *persistent* rather
 *     than awaited inline, and the reason is Discord's
 *     one-response-per-interaction rule — see {@link handleSlotPick}.
 */

import type { AnySelectMenuInteraction } from "discord.js";
import * as repo from "../repo.js";
import { buildScrimPanel } from "./manager.js";
import { fail, refuseUnlessMod } from "./handlers.js";
import { handleSlotPick } from "./slot-pick.js";

/**
 * Handles one select-menu interaction.
 *
 * @param action the action from the custom id.
 * @param parts  the parts after the action.
 */
export async function handleScrimsSelect(
  interaction: AnySelectMenuInteraction,
  action: string,
  parts: readonly string[],
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

  if (action === "slotm_pick") {
    await handleSlotPick(interaction, parts);

    return;
  }

  if (action !== "pick") {
    await fail(interaction, "That menu is no longer active.");

    return;
  }

  const scrimId = interaction.values[0];

  if (!scrimId) {
    await fail(interaction, "No scrim was picked.");

    return;
  }

  const scrim = await repo.getScrim(scrimId);

  if (!scrim) {
    await fail(interaction, "This scrim no longer exists.");

    return;
  }

  const panel = buildScrimPanel(scrim);

  await interaction.update({ embeds: panel.embeds, components: panel.components });
}
