/**
 * The Confirm/Cancel prompt.
 *
 * Quotient's `ctx.prompt` opened a `discord.ui.View` with a Confirm and a
 * Cancel button and blocked on `await view.wait()` (D35). discord.js has
 * no views, so the wait becomes a promise resolved by a component
 * collector.
 *
 * The prompt is **owned by the caller**: only the member who invoked it may
 * answer. Somebody else's click is ignored, and the buttons stay live for
 * the caller.
 *
 * The prompt message has to be public for a second moderator to see it
 * (D43), so the prompt does not force an ephemeral reply. The ephemeral
 * flag of a slash command is fixed when the dispatcher defers it, though —
 * an option here only applies when the interaction has not been answered
 * yet.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import type { MessageComponentInteraction, RepliableInteraction } from "discord.js";
import { respond } from "./context.js";
import { randomId } from "./custom-id.js";
import { EMBED_COLOR, ERROR_COLOR } from "./constants.js";

/** The prefix every prompt button id starts with. */
export const PROMPT_CUSTOM_ID_PREFIX = "core:prompt";

/** How long a prompt stays open by default. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** How a prompt is shaped. */
export interface PromptOptions {
  /**
   * How long the prompt stays open, in milliseconds.
   *
   * Defaults to 60 seconds.
   */
  timeoutMs?: number;
  /**
   * Remove the buttons once the prompt is answered or times out.
   *
   * Defaults to `true` — a prompt whose buttons are still live after it
   * has been answered is a trap.
   */
  clearButtons?: boolean;
  /**
   * Make the prompt ephemeral.
   *
   * Only has an effect when the interaction has not been replied to yet.
   */
  ephemeral?: boolean;
}

/**
 * The custom id of one of the prompt's buttons.
 *
 * The token makes the id unique, so two prompts open in the same channel
 * at the same time cannot be answered by the same click.
 */
function promptCustomId(token: string, answer: "confirm" | "cancel"): string {
  return `${PROMPT_CUSTOM_ID_PREFIX}:${token}:${answer}`;
}

/**
 * Asks the caller a yes/no question.
 *
 * @returns `true` when the caller confirmed, `false` when they cancelled
 *          or the prompt timed out.
 */
export async function prompt(
  interaction: RepliableInteraction,
  question: string,
  options: PromptOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clearButtons = options.clearButtons ?? true;
  const token = randomId();

  const confirmId = promptCustomId(token, "confirm");
  const cancelId = promptCustomId(token, "cancel");

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmId)
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cancelId)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setDescription(question)
    .setColor(EMBED_COLOR);

  const handle = await respond(
    interaction,
    { embeds: [embed], components: [row] },
    options.ephemeral ?? false,
  );

  let answer: MessageComponentInteraction;

  try {
    answer = await handle.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: timeoutMs,
      filter: (candidate) =>
        candidate.customId === confirmId || candidate.customId === cancelId,
    });
  } catch {
    // The prompt timed out. Nobody answered, so the answer is "no".
    await finishWithTimeout(interaction, clearButtons);

    return false;
  }

  const confirmed = answer.customId === confirmId;

  await answer.update({
    embeds: [
      new EmbedBuilder()
        .setDescription(
          confirmed ? `${question}\n\n✅ Confirmed.` : `${question}\n\n❌ Cancelled.`,
        )
        .setColor(confirmed ? EMBED_COLOR : ERROR_COLOR),
    ],
    components: clearButtons ? [] : [row],
  });

  return confirmed;
}

/**
 * Closes the prompt down after it timed out.
 *
 * A failure here is not worth reporting: the prompt is already dead, and
 * the interaction may well have expired.
 */
async function finishWithTimeout(
  interaction: RepliableInteraction,
  clearButtons: boolean,
): Promise<void> {
  try {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setDescription("⏳ The prompt timed out. The action was cancelled.")
          .setColor(ERROR_COLOR),
      ],
      components: clearButtons ? [] : undefined,
    });
  } catch {
    // The interaction expired, or the reply is gone. Nothing to do.
  }
}
