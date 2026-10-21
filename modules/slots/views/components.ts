/**
 * The shared building blocks of the slot panels.
 *
 * Everything the panels have in common lives here: the row builders, the
 * modals and the panel embed.
 *
 * **The component budget is real.** Discord allows 25 components per
 * message, five rows, and five buttons per row, so a panel that would
 * break those limits fails in development rather than in production.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";

/** Discord's own limits. */
export const MAX_ROWS = 5;
export const MAX_COMPONENTS_PER_ROW = 5;
export const MAX_COMPONENTS_PER_MESSAGE = 25;

/** A row of buttons. */
export function buttonRow(
  ...buttons: readonly ButtonBuilder[]
): ActionRowBuilder<ButtonBuilder> {
  if (buttons.length > MAX_COMPONENTS_PER_ROW) {
    throw new RangeError(
      `a row may hold at most ${MAX_COMPONENTS_PER_ROW} buttons, got ${buttons.length}`,
    );
  }

  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

/** One button. */
export function button(options: {
  readonly customId: string;
  readonly label?: string;
  readonly emoji?: string;
  readonly style?: ButtonStyle;
  readonly disabled?: boolean;
}): ButtonBuilder {
  const builder = new ButtonBuilder()
    .setCustomId(options.customId)
    .setStyle(options.style ?? ButtonStyle.Secondary);

  if (options.label) builder.setLabel(options.label);
  if (options.emoji) builder.setEmoji(options.emoji);

  if (options.disabled !== undefined) builder.setDisabled(options.disabled);

  return builder;
}

/** A row that holds one select menu. */
export function selectRow(
  menu: StringSelectMenuBuilder,
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/** One text input of a modal. */
export interface ModalText {
  readonly id?: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly value?: string;
  readonly required?: boolean;
  readonly maxLength?: number;
  readonly minLength?: number;
}

/** How a modal is shaped. */
export interface ModalSpec {
  readonly customId: string;
  readonly title: string;
  /** Several text inputs. Discord allows five per modal. */
  readonly texts: readonly ModalText[];
}

/**
 * Builds a modal.
 *
 * A channel or a role is **not** a modal input — D17 wants a select menu
 * for those, and a select menu is a message component, so those flows
 * open a menu instead.
 */
export function buildModal(spec: ModalSpec): ModalBuilder {
  if (spec.title.length > 45) {
    throw new RangeError("a modal title may be at most 45 characters");
  }

  if (spec.texts.length > 5) {
    throw new RangeError("a modal may hold at most five inputs");
  }

  const modal = new ModalBuilder()
    .setCustomId(spec.customId)
    .setTitle(spec.title);

  for (const text of spec.texts) {
    const input = new TextInputBuilder()
      .setCustomId(text.id ?? "value")
      .setLabel(text.label)
      .setStyle(TextInputStyle.Short);

    if (text.placeholder) input.setPlaceholder(text.placeholder);
    if (text.value) input.setValue(text.value);
    if (text.required !== undefined) input.setRequired(text.required);
    if (text.minLength !== undefined) input.setMinLength(text.minLength);
    if (text.maxLength !== undefined) {
      input.setMaxLength(Math.min(text.maxLength, 4000));
    }

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
  }

  return modal;
}

/** The embed a panel shows. */
export function panelEmbed(
  title: string,
  description: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(EMBED_COLOR);
}

/**
 * Counts the components of a set of rows.
 *
 * The layout is checked at build time, so a panel that would break
 * Discord's limits fails in development rather than in production.
 */
export function assertComponentBudget(
  rows: readonly { readonly components: readonly unknown[] }[],
): void {
  if (rows.length > MAX_ROWS) {
    throw new RangeError(
      `a message may hold at most ${MAX_ROWS} rows, got ${rows.length}`,
    );
  }

  const total = rows.reduce((sum, row) => sum + row.components.length, 0);

  if (total > MAX_COMPONENTS_PER_MESSAGE) {
    throw new RangeError(
      `a message may hold at most ${MAX_COMPONENTS_PER_MESSAGE} components, got ${total}`,
    );
  }
}
