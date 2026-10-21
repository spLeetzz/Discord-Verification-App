/**
 * The shared helpers of the scrims interaction handlers.
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
import { canUseScrimMod } from "../guards.js";
import type { ScrimsInteraction } from "../guards.js";
import * as repo from "../repo.js";
import type { ScrimRecord } from "../types.js";
import { parseScrimsId } from "./ids.js";
import type { ScrimsId } from "./ids.js";
import type { PanelComponents } from "./manager.js";

/** A rendered panel. */
export interface Panel {
  readonly embeds: EmbedBuilder[];
  readonly components: PanelComponents;
}

/** The interactions a panel handler sees. */
export type PanelInteraction =
  | MessageComponentInteraction
  | ModalSubmitInteraction;

/** Refuses an interaction from somebody who may not manage scrims. */
export async function refuseUnlessMod(
  interaction: PanelInteraction,
): Promise<boolean> {
  const refusal = await canUseScrimMod(interaction as ScrimsInteraction);

  if (!refusal) return false;

  await fail(interaction, refusal);

  return true;
}

/** Parses a scrims custom id, or refuses it. */
export function readScrimsId(customId: string): ScrimsId | null {
  return parseScrimsId(customId);
}

/** Loads the scrim a panel is about. */
export async function loadScrim(
  id: ScrimsId,
  index = 0,
): Promise<ScrimRecord | null> {
  const scrimId = id.parts[index];

  if (!scrimId) return null;

  return repo.getScrim(scrimId);
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
  await interaction.update({ embeds: panel.embeds, components: panel.components });
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

/**
 * The position of a scrim among the guild's scrims.
 *
 * The editor's "page" footer. The scrims are ordered by `open_time`,
 * the way the source ordered them.
 */
export async function scrimPosition(
  scrim: ScrimRecord,
): Promise<{ index: number; total: number }> {
  const all = await repo.listScrims(scrim.guildId);

  const index = all.findIndex((entry) => entry.id === scrim.id);

  return { index: index < 0 ? 0 : index, total: all.length };
}
