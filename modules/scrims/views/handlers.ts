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
 */

import type {
  ButtonInteraction,
  EmbedBuilder,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { MessageFlags } from "discord.js";
import { replyError } from "../../../core/context.js";
import { canUseScrimMod } from "../guards.js";
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

/** Refuses an interaction from somebody who may not manage scrims. */
export async function refuseUnlessMod(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
): Promise<boolean> {
  const refusal = await canUseScrimMod(interaction);

  if (!refusal) return false;

  await replyError(interaction, refusal, { ephemeral: true });

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
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
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
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  message: string,
): Promise<void> {
  await replyError(interaction, message, { ephemeral: true });
}

/** The flags of an ephemeral follow-up. */
export const EPHEMERAL = MessageFlags.Ephemeral;

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
