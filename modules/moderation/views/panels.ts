/**
 * The panels of the moderation area.
 *
 * Every message the area shows is built here. `core/ui.ts` owns the
 * shape — a title, a short description, the data as fields, and a footer
 * that says what to do next — and this file owns the area's two rules:
 *
 *  - **The colour rule.** A panel that reports something destructive is
 *    red, a panel that reports something created or restored is green,
 *    and everything else is the ordinary panel colour. It is the same
 *    rule the buttons follow: red means "this destroyed something".
 *  - **The footer rule.** Every panel says what to do next in its
 *    footer, so the description can stay short and the panel does not
 *    have to shout it.
 *
 * The empty states come from `core/ui.ts`'s `emptyPanel`. A new user
 * sees them first, so they say what to do rather than only reporting the
 * absence.
 */

import { MessageFlags } from "discord.js";
import type {
  EmbedBuilder,
  GuildTextBasedChannel,
  InteractionEditReplyOptions,
  MessageComponentInteraction,
  RepliableInteraction,
} from "discord.js";
import {
  DANGER_COLOR,
  PANEL_COLOR,
  SUCCESS_COLOR,
  emptyPanel,
  label,
  panelEmbed,
} from "../../../core/ui.js";
import type { Panel, PanelField } from "../../../core/ui.js";
import type { PurgeOutcome } from "../types.js";

/**
 * What a panel did.
 *
 * The three kinds map onto the three colours the area uses, and they are
 * the three the buttons use as well:
 *
 *  - `destructive` — red: the action destroyed something, and no button
 *    brings it back;
 *  - `constructive` — green: the action gave something back, or opened
 *    something that was closed;
 *  - `neutral` — the ordinary panel colour: everything else.
 */
export type PanelKind = "destructive" | "constructive" | "neutral";

/** The colour a kind gets. */
function colorFor(kind: PanelKind): number {
  switch (kind) {
    case "destructive":
      return DANGER_COLOR;
    case "constructive":
      return SUCCESS_COLOR;
    case "neutral":
      return PANEL_COLOR;
  }
}

/** How a result panel is shaped. */
export interface OutcomePanelSpec {
  /** What the action did. It decides the colour of the panel. */
  readonly kind: PanelKind;
  /** The title at the top. */
  readonly title: string;
  /** A short sentence about what happened. */
  readonly description?: string;
  /** The data, as fields. */
  readonly fields?: readonly PanelField[];
  /** The hint about what to do next. */
  readonly footer?: string;
}

/**
 * A panel that reports what a moderation action did.
 *
 * The kind is the whole of the colour rule: the panel says what happened
 * and the colour says how much of it matters.
 */
export function outcomePanel(spec: OutcomePanelSpec): Panel {
  return {
    embeds: [
      panelEmbed({
        title: spec.title,
        description: spec.description,
        fields: spec.fields,
        footer: spec.footer,
        color: colorFor(spec.kind),
      }),
    ],
    components: [],
  };
}

/**
 * A panel that says there is nothing to do.
 *
 * It is `core/ui.ts`'s `emptyPanel`, under the area's name, so the
 * empty states of the area are built in one place.
 */
export function emptyState(spec: {
  readonly title: string;
  readonly description: string;
  readonly footer?: string;
}): Panel {
  return emptyPanel(spec);
}

/**
 * A panel that says no.
 *
 * The title names the command that refused, so a moderator can see which
 * one it was without reading the message.
 */
export function refusalPanel(command: string, message: string): Panel {
  return {
    embeds: [
      panelEmbed({
        title: label(`${command} refused`),
        description: message,
        color: DANGER_COLOR,
      }),
    ],
    components: [],
  };
}

/**
 * The fields of a purge.
 *
 * The counts are the data, so they are fields. A count of zero is left
 * out: a field that says "0" is noise, and the panel is shorter without
 * it.
 */
function purgeOutcomeFields(outcome: PurgeOutcome): PanelField[] {
  const fields: PanelField[] = [
    { name: "Deleted", value: String(outcome.deleted), inline: true },
  ];

  if (outcome.tooOld > 0) {
    fields.push({
      name: "Too old",
      value: String(outcome.tooOld),
      inline: true,
    });
  }

  if (outcome.pinned > 0) {
    fields.push({
      name: "Pinned",
      value: String(outcome.pinned),
      inline: true,
    });
  }

  if (outcome.failed > 0) {
    fields.push({
      name: "Failed",
      value: String(outcome.failed),
      inline: true,
    });
  }

  return fields;
}

/**
 * The panel of a purge.
 *
 * A purge that matched nothing is an empty state: it says what to do
 * next rather than only reporting that there was nothing there.
 */
export function purgePanel(
  outcome: PurgeOutcome,
  spec: {
    /** The title of the panel. */
    readonly title: string;
    /** The sentence that says what was removed. */
    readonly description: string;
    /** The sentence that says nothing matched. */
    readonly emptyDescription: string;
  },
): Panel {
  if (outcome.matched === 0) {
    return emptyState({
      title: "Nothing to delete",
      description: spec.emptyDescription,
      footer: "Try a longer search, or a different filter.",
    });
  }

  return outcomePanel({
    kind: "destructive",
    title: spec.title,
    description: spec.description,
    fields: purgeOutcomeFields(outcome),
    footer: "Discord cannot delete messages that are more than 14 days old.",
  });
}

/**
 * The payload of a panel.
 *
 * The components are only there when the panel has some: an empty list
 * of rows is noise on the wire.
 */
function payloadOf(panel: Panel): InteractionEditReplyOptions {
  const payload: InteractionEditReplyOptions = { embeds: [...panel.embeds] };

  if (panel.components.length > 0) {
    payload.components = [...panel.components];
  }

  return payload;
}

/**
 * Sends a panel as the answer to a command.
 *
 * It is the interaction's own reply — the same message the command has
 * been editing all along — so a panel never turns into a second message
 * in the channel.
 */
export async function replyPanel(
  interaction: RepliableInteraction,
  panel: Panel,
): Promise<void> {
  await interaction.editReply(payloadOf(panel));
}

/**
 * Answers a button press with a panel, in private.
 *
 * The answer is for the member who pressed the button, not for the
 * channel, so it is ephemeral — the same as every other button refusal
 * in the bot.
 */
export async function replyPanelEphemeral(
  interaction: MessageComponentInteraction,
  panel: Panel,
): Promise<void> {
  await interaction.reply({
    embeds: [...panel.embeds],
    ...(panel.components.length > 0
      ? { components: [...panel.components] }
      : {}),
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Posts a panel to a channel, for everybody in it to see.
 *
 * The announcements of a lockdown, a purge and a role change are public
 * (D43): the people in the channel have to know that it is closed.
 */
export async function announcePanel(
  channel: GuildTextBasedChannel,
  panel: Panel,
): Promise<void> {
  const embeds: EmbedBuilder[] = [...panel.embeds];

  await channel.send({ embeds, components: [...panel.components] });
}
