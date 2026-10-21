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
 * The token in the custom id is not a secret — it is in the message, and
 * the message is in a channel other people can read — so the owner check
 * is on the **user**, not on the id. A caller that wants a prompt anyone
 * may answer opts in with `allowOthers: true`.
 *
 * The prompt message has to be public for a second moderator to see it
 * (D43), so the prompt does not force an ephemeral reply. The ephemeral
 * flag of a slash command is fixed when the dispatcher defers it, though —
 * an option here only applies when the interaction has not been answered
 * yet.
 *
 * **One interaction yields one collection.** Discord allows an
 * interaction to be replied to once, so a flow that asks two questions
 * puts the second one on a follow-up (`asFollowUp: true`) or on a message
 * it sent itself. This is a Discord constraint, not a limitation of this
 * helper.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import type { MessageComponentInteraction, RepliableInteraction } from "discord.js";
import { sendCollectable } from "./context.js";
import type { ReplyHandle } from "./context.js";
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
  /**
   * Send the prompt as a follow-up message rather than as the
   * interaction's own reply.
   *
   * An interaction can only be replied to once, so a flow that needs two
   * inputs has to use a follow-up for the second one.
   */
  asFollowUp?: boolean;
  /**
   * Let anybody answer the prompt, not only the caller.
   *
   * Defaults to `false`: the prompt belongs to the member who opened it,
   * and a click from anybody else is ignored. The prompt message has to
   * be public for a second moderator to see it, so the buttons *are*
   * visible to the channel — which is exactly why the check is on the
   * user and not on the token in the custom id.
   *
   * Turn it on only for a prompt that is meant to be open to the channel:
   * a vote, a poll, a "who wants the next slot" question. It is a
   * deliberate, visible choice — a prompt that quietly became open to
   * everybody would be a way to confirm a deletion on someone else's
   * behalf.
   */
  allowOthers?: boolean;
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
 * Only the caller may answer, unless `allowOthers` says otherwise.
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
  const allowOthers = options.allowOthers ?? false;
  const ownerId = interaction.user.id;
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

  const handle = await sendCollectable(
    interaction,
    { embeds: [embed], components: [row] },
    {
      ephemeral: options.ephemeral ?? false,
      asFollowUp: options.asFollowUp ?? false,
    },
  );

  let answer: MessageComponentInteraction;

  try {
    answer = await handle.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: timeoutMs,
      // The owner check. A click from somebody else is not an answer:
      // the collector keeps waiting, and the buttons stay live for the
      // caller.
      filter: (candidate) =>
        (allowOthers || candidate.user.id === ownerId) &&
        (candidate.customId === confirmId || candidate.customId === cancelId),
    });
  } catch {
    // The prompt timed out. Nobody answered, so the answer is "no".
    await finishWithTimeout(handle, clearButtons);

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
 * The edit lands on the message the buttons are on — the interaction's
 * reply, or the follow-up the prompt was sent as. Editing the wrong one
 * would leave live buttons behind.
 *
 * A failure here is not worth reporting: the prompt is already dead, and
 * the interaction may well have expired.
 */
async function finishWithTimeout(
  handle: ReplyHandle,
  clearButtons: boolean,
): Promise<void> {
  try {
    await handle.edit({
      embeds: [
        new EmbedBuilder()
          .setDescription("⏳ The prompt timed out. The action was cancelled.")
          .setColor(ERROR_COLOR),
      ],
      components: clearButtons ? [] : undefined,
    });
  } catch {
    // The interaction expired, or the message is gone. Nothing to do.
  }
}
