/**
 * The select-menu handlers of the tournaments area.
 *
 * Two menus live here:
 *
 *  1. the **manager panel's** menu, which carries the tournament ids as
 *     its values, so choosing one is enough — there is no state to keep
 *     and the panel survives a restart (D18);
 *  2. the **slot manager's** menu, which asks a member which of their
 *     slots to rename. That one is *persistent* rather than awaited
 *     inline, and the reason is Discord's one-response-per-interaction
 *     rule — see {@link onSlotPick}.
 */

import type { AnySelectMenuInteraction } from "discord.js";
import { run } from "../../../core/fire-and-forget.js";
import * as repo from "../repo.js";
import { buildTourneyPanel } from "./manager.js";
import { buildFieldModal } from "./modals.js";
import { fail, refuseUnlessMod } from "./handlers.js";
import { tourneysId } from "./ids.js";

/**
 * Handles one select-menu interaction.
 *
 * @param action the action from the custom id;
 * @param parts  the parts after the action.
 */
export async function handleTourneysSelect(
  interaction: AnySelectMenuInteraction,
  action: string,
  parts: readonly string[],
): Promise<void> {
  if (action === "slotm_pick") {
    await onSlotPick(interaction, parts);

    return;
  }

  if (action !== "select" || parts[0] !== "pick") {
    await fail(interaction, "That menu is no longer active.");

    return;
  }

  if (await refuseUnlessMod(interaction)) return;

  const tourneyId = interaction.values[0];

  if (!tourneyId) {
    await fail(interaction, "No tournament was picked.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  const panel = buildTourneyPanel(tourney);

  await interaction.update({
    embeds: panel.embeds,
    components: panel.components,
  });
}

/**
 * Handles the answer to the "which slot do you want to rename?" menu.
 *
 * **The menu is persistent, and that is what makes the modal possible.**
 * Discord lets an interaction do exactly one thing: reply, defer, update
 * or show a modal. `core/select.ts`'s `awaitSelect` *answers* the select
 * interaction it opens, so a menu that is waited on inline cannot be
 * followed by a modal — `showModal` after a reply is a hard error.
 *
 * This menu is a real component in a message, so the member's pick
 * arrives as an interaction of its own, which is still unanswered. The
 * rename modal is shown from it.
 *
 * The custom id carries the tournament and the member who opened the
 * menu (D18), so a pick by anybody else is refused.
 */
async function onSlotPick(
  interaction: AnySelectMenuInteraction,
  parts: readonly string[],
): Promise<void> {
  const tourneyId = parts[0];
  const userId = parts[1];

  if (!tourneyId || !userId) {
    await fail(interaction, "That menu is no longer active.");

    return;
  }

  // The menu is the member's own.
  if (interaction.user.id !== userId) {
    await fail(interaction, "That menu is not yours.");

    return;
  }

  // The menu is answered by the modal, so it must not stay live: a
  // second press would find no slot to rename.
  run(
    () => interaction.message.edit({ components: [] }),
    "tourneys.clearSlotPickMenu",
  );

  const slotId = interaction.values[0];

  if (!slotId) {
    await fail(interaction, "No slot was picked.");

    return;
  }

  const tourney = await repo.getTourney(tourneyId);

  if (!tourney) {
    await fail(interaction, "This tournament no longer exists.");

    return;
  }

  // The slot has to be one of the member's own.
  const slots = await repo.listSlotsOfUser(tourney.id, interaction.user.id);

  const slot = slots.find((entry) => entry.id === slotId);

  if (!slot) {
    await fail(interaction, "You do not have that slot.");

    return;
  }

  await interaction.showModal(
    buildFieldModal({
      customId: tourneysId("modal", "rename", tourney.id, slot.id),
      title: "Change the team name",
      label: "The new team name",
      placeholder: "Team Awesome",
    }),
  );
}
