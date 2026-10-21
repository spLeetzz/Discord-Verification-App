/**
 * The shared helpers of the tourneys interaction handlers.
 *
 * Two rules hold everywhere:
 *
 *  1. **A panel is a render of the row.** A handler loads the row, does
 *     one thing, and re-renders from the row that comes back. Nothing is
 *     held in memory between clicks, so a panel that is opened after a
 *     restart shows the truth.
 *
 *  2. **A handler writes one field.** The source's editor rebuilt the
 *     whole model from `dict(self.record)` on every interaction, which
 *     wrote columns another writer may have changed. Ours writes what
 *     the button touched.
 *
 * The refusals are built here rather than taken from `core/context.ts`,
 * because a modal submit is not a `RepliableInteraction` in discord.js
 * and the shared helper cannot answer one.
 */

import { EmbedBuilder, MessageFlags } from "discord.js";
import type {
  ButtonInteraction,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { ERROR_COLOR } from "../../../core/constants.js";
import { canUseTourneyMod } from "../guards.js";
import type { TourneysInteraction } from "../guards.js";
import * as repo from "../repo.js";
import type { TourneyRecord } from "../types.js";
import { parseTourneysId } from "./ids.js";
import type { TourneysId } from "./ids.js";

/** A rendered panel. */
export interface Panel {
  readonly embeds: EmbedBuilder[];
  readonly components: readonly {
    readonly components: readonly unknown[];
  }[];
}

/** The interactions a panel handler sees. */
export type PanelInteraction =
  | MessageComponentInteraction
  | ModalSubmitInteraction;

/** Refuses an interaction from somebody who may not manage tournaments. */
export async function refuseUnlessMod(
  interaction: PanelInteraction,
): Promise<boolean> {
  const refusal = await canUseTourneyMod(interaction as TourneysInteraction);

  if (!refusal) return false;

  await fail(interaction, refusal);

  return true;
}

/** Parses a tourneys custom id, or refuses it. */
export function readTourneysId(customId: string): TourneysId | null {
  return parseTourneysId(customId);
}

/** Loads the tournament a panel is about. */
export async function loadTourney(
  id: TourneysId,
  index = 0,
): Promise<TourneyRecord | null> {
  const tourneyId = id.parts[index];

  if (!tourneyId) return null;

  return repo.getTourney(tourneyId);
}

/**
 * Re-renders a panel onto the message it is attached to.
 *
 * The message is edited directly rather than through the interaction, so
 * it works the same whether the interaction was deferred, replied to, or
 * neither — which matters because a modal submit and a button press
 * arrive in different states.
 */
export async function renderPanel(
  interaction: PanelInteraction,
  panel: Panel,
): Promise<void> {
  const message = interaction.message;

  if (!message) {
    await interaction
      .editReply({ embeds: panel.embeds, components: panel.components })
      .catch(() => undefined);

    return;
  }

  await message.edit({ embeds: panel.embeds, components: panel.components });
}

/**
 * Acknowledges a modal submit and re-renders its panel.
 *
 * The acknowledgement has to happen inside Discord's three second
 * window; the re-render can take as long as it needs.
 */
export async function acknowledgeAndRender(
  interaction: ModalSubmitInteraction,
  panel: Panel,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => undefined);
  }

  await renderPanel(interaction, panel);
}

/**
 * Acknowledges a button press and re-renders its panel.
 *
 * `update` both answers the interaction and edits the message the
 * button is on, which is exactly what a panel wants.
 */
export async function updatePanel(
  interaction: ButtonInteraction,
  panel: Panel,
): Promise<void> {
  await interaction.update({
    embeds: panel.embeds,
    components: panel.components,
  });
}

/** Tells the caller something went wrong. */
export async function fail(
  interaction: PanelInteraction,
  message: string,
): Promise<void> {
  const embed = new EmbedBuilder().setDescription(message).setColor(ERROR_COLOR);

  if (interaction.deferred || interaction.replied) {
    await interaction
      .editReply({ embeds: [embed] })
      .catch(() => undefined);

    return;
  }

  await interaction
    .reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
    .catch(() => undefined);
}
