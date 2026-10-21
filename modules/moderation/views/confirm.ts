/**
 * The confirmation panel of the moderation area.
 *
 * `core/prompt.ts` asks a yes/no question with a green **Confirm** and a
 * grey **Cancel** on one row. That is right for a question whose answer
 * creates something, and it is wrong for this area, where most of the
 * questions are asked *before* something is destroyed — a lockdown, a
 * category delete, a nuke. A green Confirm on "Delete this category?"
 * tells the moderator that the answer is good news.
 *
 * So this area asks its questions with a panel of its own:
 *
 *  - the **Confirm** button sits alone on the first row, and its colour
 *    says what the answer does: red when it destroys, green when it
 *    creates or restores;
 *  - the **Cancel** button is grey and has the last row to itself, so a
 *    destructive button never shares a row with something harmless;
 *  - the panel has a title that names the action and a footer that says
 *    what happens next.
 *
 * **The mechanics are the ones of `core/prompt.ts`.** Only the member who
 * ran the command may answer, the buttons go away once the question has
 * been answered, and a question nobody answers is a refusal. The custom
 * id keeps the same shape — `core:collect:prompt:<token>:<answer>` — so
 * the router leaves the interaction alone and the collector owns it,
 * exactly as it does for the shared prompt.
 */

import { ComponentType } from "discord.js";
import type {
  ButtonBuilder,
  EmbedBuilder,
  MessageComponentInteraction,
  RepliableInteraction,
} from "discord.js";
import { COLLECTOR_CUSTOM_ID_PREFIX, randomId } from "../../../core/custom-id.js";
import { sendCollectable } from "../../../core/context.js";
import type { ReplyHandle } from "../../../core/context.js";
import {
  DANGER_COLOR,
  PANEL_COLOR,
  SUCCESS_COLOR,
  actionRow,
  dangerButton,
  navigationRow,
  panelEmbed,
  primaryButton,
  secondaryButton,
  successButton,
} from "../../../core/ui.js";

/** How long a question stays open by default. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The prefix every button of the panel carries.
 *
 * It is the collector prefix, so the router leaves the interaction
 * alone: a pending collector owns the answer, and no module registered
 * the id.
 */
const CONFIRM_PREFIX = `${COLLECTOR_CUSTOM_ID_PREFIX}:prompt`;

/**
 * What the answer does.
 *
 * The same three kinds the outcome panels use, so a question and the
 * panel that follows it speak the same colour: red destroys, green gives
 * something back or opens something, and the ordinary colour is
 * everything else.
 */
export type ConfirmKind = "destructive" | "constructive" | "neutral";

/** The custom id of one of the panel's buttons. */
function confirmCustomId(token: string, answer: "confirm" | "cancel"): string {
  return `${CONFIRM_PREFIX}:${token}:${answer}`;
}

/**
 * The button that answers the question.
 *
 * Red when the answer destroys something, green when it creates or
 * restores something, and the ordinary primary when it is neither.
 */
function confirmButton(
  kind: ConfirmKind,
  customId: string,
  label: string,
): ButtonBuilder {
  switch (kind) {
    case "destructive":
      return dangerButton({ customId, label });
    case "constructive":
      return successButton({ customId, label });
    case "neutral":
      return primaryButton({ customId, label });
  }
}

/** How a question is shaped. */
export interface ConfirmSpec {
  /** The title, naming the action: "Lock channel". */
  readonly title: string;
  /** The question, in a sentence or two. */
  readonly question: string;
  /** What the answer does. It decides the colour of the confirm button. */
  readonly kind: ConfirmKind;
  /** The label on the confirm button: "Lock channel". */
  readonly confirmLabel: string;
  /** The hint about what happens next. */
  readonly footer?: string;
  /** How long the question stays open, in milliseconds. */
  readonly timeoutMs?: number;
  /**
   * Send the question as a follow-up rather than as the reply.
   *
   * An interaction can only be answered once, so a flow that asks two
   * questions puts the second one on a follow-up.
   */
  readonly asFollowUp?: boolean;
}

/**
 * The panel of a question.
 */
function questionPanel(spec: ConfirmSpec): EmbedBuilder {
  return panelEmbed({
    title: spec.title,
    description: spec.question,
    footer: spec.footer,
    color: spec.kind === "destructive" ? DANGER_COLOR : PANEL_COLOR,
  });
}

/**
 * The panel that is left behind once the question has been answered.
 *
 * A question that was answered keeps its hint — it is still true. A
 * question that was cancelled does not: nothing happened, so the hint
 * says that.
 */
function answeredPanel(spec: ConfirmSpec, confirmed: boolean): EmbedBuilder {
  return panelEmbed({
    title: spec.title,
    description: `${spec.question}\n\n${
      confirmed ? "Confirmed." : "Cancelled."
    }`,
    footer: confirmed ? spec.footer : "Nothing was changed.",
    color: confirmed ? SUCCESS_COLOR : DANGER_COLOR,
  });
}

/**
 * Asks the moderator a yes/no question.
 *
 * Only the member who ran the command may answer: the token in the
 * custom id is in the message, and the message is in a channel other
 * people can read, so the check is on the member and not on the id.
 *
 * @returns `true` when the moderator confirmed, `false` when they
 *          cancelled or the question timed out.
 */
export async function confirmAction(
  interaction: RepliableInteraction,
  spec: ConfirmSpec,
): Promise<boolean> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ownerId = interaction.user.id;
  const token = randomId();

  const confirmId = confirmCustomId(token, "confirm");
  const cancelId = confirmCustomId(token, "cancel");

  const handle = await sendCollectable(
    interaction,
    {
      embeds: [questionPanel(spec)],
      components: [
        actionRow(confirmButton(spec.kind, confirmId, spec.confirmLabel)),
        navigationRow(secondaryButton({ customId: cancelId, label: "Cancel" })),
      ],
    },
    { asFollowUp: spec.asFollowUp ?? false },
  );

  let answer: MessageComponentInteraction;

  try {
    answer = await handle.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: timeoutMs,
      filter: (candidate) =>
        candidate.user.id === ownerId &&
        (candidate.customId === confirmId || candidate.customId === cancelId),
    });
  } catch {
    // Nobody answered, so the answer is "no".
    await finishWithTimeout(handle);

    return false;
  }

  const confirmed = answer.customId === confirmId;

  await answer.update({
    embeds: [answeredPanel(spec, confirmed)],
    components: [],
  });

  return confirmed;
}

/**
 * Closes the question down after it timed out.
 *
 * The edit lands on the message the buttons are on — the interaction's
 * reply, or the follow-up the question was sent as. A failure here is
 * not worth reporting: the question is already dead, and the
 * interaction may well have expired.
 */
async function finishWithTimeout(handle: ReplyHandle): Promise<void> {
  try {
    await handle.edit({
      embeds: [
        panelEmbed({
          title: "Timed out",
          description: "The question timed out. Nothing was changed.",
          color: DANGER_COLOR,
        }),
      ],
      components: [],
    });
  } catch {
    // The interaction expired, or the message is gone. Nothing to do.
  }
}
