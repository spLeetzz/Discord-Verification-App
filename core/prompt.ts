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
 * **The look.** The prompt is the bot's most-used dialog, so it is the
 * same everywhere: the question under a short title, a green Confirm, a
 * grey Cancel, and a footer that says what to do next. It is built from
 * the shared helpers in `core/ui.ts`, so it looks like every other panel
 * in the bot.
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

import { ComponentType } from "discord.js";
import type { MessageComponentInteraction, RepliableInteraction } from "discord.js";
import { replaceComponentContent, sendCollectable } from "./context.js";
import { logger } from "../utils/logger.js";
import { errorMessage } from "../utils/errors.js";
import type { ReplyHandle } from "./context.js";
import { COLLECTOR_CUSTOM_ID_PREFIX, randomId } from "./custom-id.js";
import {
  DANGER_COLOR,
  PANEL_COLOR,
  SUCCESS_COLOR,
  actionRow,
  panelEmbed,
  secondaryButton,
  successButton,
} from "./ui.js";

/**
 * The prefix every prompt button id starts with.
 *
 * A prompt's buttons are answered by a collector, so the id carries the
 * collector prefix: the router must leave the interaction alone rather
 * than refuse it as an id nobody owns.
 */
export const PROMPT_CUSTOM_ID_PREFIX = `${COLLECTOR_CUSTOM_ID_PREFIX}:prompt`;

/** How long a prompt stays open by default. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The title of the prompt's panel.
 *
 * The prompt is one thing everywhere, so the title says what kind of
 * thing it is: the caller is being asked to confirm something.
 */
const PROMPT_TITLE = "Confirm";

/**
 * The hint the prompt's footer carries.
 *
 * The footer is where a panel says what to do next, so the question
 * itself does not have to.
 */
const PROMPT_FOOTER = "Confirm to go ahead, or cancel to stop.";

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

  const row = actionRow(
    successButton({ customId: confirmId, label: "Confirm" }),
    secondaryButton({ customId: cancelId, label: "Cancel" }),
  );

  const embed = panelEmbed({
    title: PROMPT_TITLE,
    description: question,
    footer: PROMPT_FOOTER,
  });

  const handle = await sendCollectable(
    interaction,
    { embeds: [embed], components: [row] },
    {
      ephemeral: options.ephemeral ?? false,
      asFollowUp: options.asFollowUp ?? false,
    },
  );

  let answer: MessageComponentInteraction;

  // **The collector is anchored on the client, not on the message.**
  //
  // A prompt is usually ephemeral, and discord.js models an ephemeral
  // reply with the *interaction's* id rather than the message's own
  // snowflake. A collector built on that message therefore waits for a
  // message id the click will never carry, so the click is never
  // collected: the prompt is sent, the user answers, and the answer
  // goes unanswered — which Discord shows as "the bot didn't respond in
  // time".
  //
  // A client-level collector has no message to be wrong about. The
  // filter narrows it to this prompt's own ids and this user.
  const channel = interaction.channel;

  if (!channel) {
    await finishWithTimeout(handle, clearButtons);

    return false;
  }

  const collector = channel.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: timeoutMs,
    // The owner check. A click from somebody else is not an answer:
    // the collector keeps waiting, and the buttons stay live for the
    // caller.
    filter: (candidate) =>
      (allowOthers || candidate.user.id === ownerId) &&
      (candidate.customId === confirmId || candidate.customId === cancelId),
  });

  try {
    answer = await collector.next;
  } catch (error) {
    // Nobody answered, or the answer could not be delivered. The reason
    // is logged, because a failure that is swallowed is a failure that
    // looks like a bug in the user's mouse.
    logger.warn(`[Prompt] The prompt was not answered: ${errorMessage(error)}`);

    // The prompt timed out. Nobody answered, so the answer is "no".
    await finishWithTimeout(handle, clearButtons);

    return false;
  } finally {
    collector.stop("done");
  }

  const confirmed = answer.customId === confirmId;

  await replaceComponentContent(answer, {
    embeds: [
      // The question stays on the panel, so the answer can be read in
      // context: the title says what happened, the colour says how it
      // went. Green is a confirmation; a refusal is not a problem, so
      // it is not red.
      panelEmbed({
        title: confirmed ? "Confirmed" : "Cancelled",
        description: question,
        color: confirmed ? SUCCESS_COLOR : PANEL_COLOR,
      }),
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
        panelEmbed({
          title: "Timed out",
          description: "The prompt timed out. The action was cancelled.",
          color: DANGER_COLOR,
        }),
      ],
      components: clearButtons ? [] : undefined,
    });
  } catch {
    // The interaction expired, or the message is gone. Nothing to do.
  }
}
