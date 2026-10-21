/**
 * The select-menu handlers.
 *
 * The list panel's select menu carries the scrim ids as its values, so
 * choosing one is enough — there is no state to keep and the panel
 * survives a restart.
 */

import type { AnySelectMenuInteraction } from "discord.js";
import * as repo from "../repo.js";
import { buildScrimPanel } from "./manager.js";
import { fail, refuseUnlessMod } from "./handlers.js";

/** Handles one select-menu interaction. */
export async function handleScrimsSelect(
  interaction: AnySelectMenuInteraction,
  action: string,
): Promise<void> {
  if (await refuseUnlessMod(interaction)) return;

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
