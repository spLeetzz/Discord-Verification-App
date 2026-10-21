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
 * **The acknowledgement rule.** A button press has to be answered within
 * Discord's three second window, and a panel is a *message* that is
 * edited. So a handler acknowledges with `deferUpdate()` and then edits
 * the message the button is on. A handler that opens a modal does not
 * acknowledge at all — a modal *is* the answer.
 *
 * The refusals are built here rather than taken from `core/context.ts`,
 * because a modal submit is not a `RepliableInteraction` in discord.js
 * and the shared helper cannot answer one.
 */

import { EmbedBuilder, MessageFlags } from "discord.js";
import type {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
} from "discord.js";
import { EMBED_COLOR, ERROR_COLOR } from "../../../core/constants.js";
import { canUseTourneyMod } from "../guards.js";
import type { TourneysInteraction } from "../guards.js";
import * as repo from "../repo.js";
import type { TourneyRecord } from "../types.js";
import { parseTourneysId } from "./ids.js";
import type { TourneysId } from "./ids.js";

/**
 * The components of a panel.
 *
 * A panel is a list of rows; every row is either a row of buttons or a
 * row that holds one select menu.
 */
export type PanelComponents = (
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>
)[];

/** A rendered panel. */
export interface Panel {
  readonly embeds: EmbedBuilder[];
  readonly components: PanelComponents;
}

/** The interactions a panel handler sees. */
export type PanelInteraction =
  | MessageComponentInteraction
  | ModalSubmitInteraction;

/** How a refusal is delivered. */
export interface FailOptions {
  /** Only the caller sees it. Defaults to `true`. */
  readonly ephemeral?: boolean;
  /**
   * The message is good news rather than bad.
   *
   * It changes the colour of the embed, nothing else.
   */
  readonly ok?: boolean;
}

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
 * Acknowledges a button press.
 *
 * `deferUpdate` says "I am going to edit the message this button is
 * on". A handler that opens a modal must **not** call this — a deferred
 * interaction cannot show a modal.
 */
export async function acknowledge(
  interaction: ButtonInteraction,
): Promise<void> {
  if (interaction.deferred || interaction.replied) return;

  await interaction.deferUpdate().catch(() => undefined);
}

/**
 * Renders a panel onto the message it is attached to.
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

  if (message) {
    await message
      .edit({ embeds: panel.embeds, components: panel.components })
      .catch(() => undefined);

    return;
  }

  await interaction
    .editReply({ embeds: panel.embeds, components: panel.components })
    .catch(() => undefined);
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
 */
export async function updatePanel(
  interaction: ButtonInteraction,
  panel: Panel,
): Promise<void> {
  await acknowledge(interaction);
  await renderPanel(interaction, panel);
}

/**
 * Tells the caller something went wrong — or that something worked.
 *
 * The message is a **follow-up**, never an edit of the panel. A panel is
 * a persistent thing that other moderators are looking at; a refusal
 * that replaced it would take the panel away from them.
 */
export async function fail(
  interaction: PanelInteraction,
  message: string,
  options: FailOptions = {},
): Promise<void> {
  const embed = new EmbedBuilder()
    .setDescription(message)
    .setColor(options.ok ? EMBED_COLOR : ERROR_COLOR);

  const ephemeral = options.ephemeral ?? true;

  if (interaction.deferred || interaction.replied) {
    await interaction
      .followUp({
        embeds: [embed],
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
      })
      .catch(() => undefined);

    return;
  }

  await interaction
    .reply({
      embeds: [embed],
      flags: ephemeral ? MessageFlags.Ephemeral : undefined,
    })
    .catch(() => undefined);
}
