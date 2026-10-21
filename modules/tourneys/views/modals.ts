/**
 * The modals of the tournaments area.
 *
 * Every "type a value" flow in this area is a **modal** (D17). The
 * source used `bot.wait_for("message")` for all of them, which is the
 * class of flow where bugs live: somebody else typing in the channel,
 * the bot's own messages, timeouts, races with the bot's own handler.
 *
 * A modal is addressed to the person who opened it, it cannot be
 * hijacked, and it cannot be swallowed by the bot's own message
 * handler.
 */

import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { MODAL_VALUE_ID } from "./components.js";

/** How a field modal is shaped. */
export interface FieldModalSpec {
  /** The custom id. It carries the record and the field. */
  readonly customId: string;
  /** The modal's title. At most 45 characters. */
  readonly title: string;
  /** The label of the input. At most 45 characters. */
  readonly label: string;
  /** The value the input starts with. */
  readonly value?: string;
  /** The placeholder of the input. */
  readonly placeholder?: string;
  /** Whether the input has to be filled in. */
  readonly required?: boolean;
  /** The longest value the input accepts. */
  readonly maxLength?: number;
}

/**
 * Builds a one-input modal.
 *
 * The custom id carries everything the handler needs: the record, the
 * field and any extra parts. Nothing is kept in memory.
 */
export function buildFieldModal(spec: FieldModalSpec): ModalBuilder {
  if (spec.title.length > 45) {
    throw new RangeError("a modal title may be at most 45 characters");
  }

  if (spec.label.length > 45) {
    throw new RangeError("a modal label may be at most 45 characters");
  }

  const input = new TextInputBuilder()
    .setCustomId(MODAL_VALUE_ID)
    .setLabel(spec.label)
    .setStyle(TextInputStyle.Short);

  if (spec.value) input.setValue(spec.value.slice(0, 4000));
  if (spec.placeholder) input.setPlaceholder(spec.placeholder.slice(0, 100));
  if (spec.required !== undefined) input.setRequired(spec.required);
  if (spec.maxLength !== undefined) {
    input.setMaxLength(Math.min(spec.maxLength, 4000));
  }

  const modal = new ModalBuilder()
    .setCustomId(spec.customId)
    .setTitle(spec.title)
    .addComponents(input);

  return modal;
}

/** How a two-input modal is shaped. */
export interface TwoInputModalSpec {
  readonly customId: string;
  /** The modal's title. At most 45 characters. */
  readonly title: string;
  readonly first: {
    readonly id: string;
    readonly label: string;
    readonly placeholder?: string;
  };
  readonly second: {
    readonly id: string;
    readonly label: string;
    readonly placeholder?: string;
  };
}

/**
 * Builds a modal with two text inputs.
 *
 * Discord allows five inputs per modal. Two is what the "create group
 * channels" form needs (the name format and the range) and what the
 * "add a slot" form needs (the leader and the team name).
 */
export function buildTwoInputModal(spec: TwoInputModalSpec): ModalBuilder {
  if (spec.title.length > 45) {
    throw new RangeError("a modal title may be at most 45 characters");
  }

  const first = new TextInputBuilder()
    .setCustomId(spec.first.id)
    .setLabel(spec.first.label.slice(0, 45))
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  if (spec.first.placeholder) {
    first.setPlaceholder(spec.first.placeholder.slice(0, 100));
  }

  const second = new TextInputBuilder()
    .setCustomId(spec.second.id)
    .setLabel(spec.second.label.slice(0, 45))
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  if (spec.second.placeholder) {
    second.setPlaceholder(spec.second.placeholder.slice(0, 100));
  }

  return new ModalBuilder()
    .setCustomId(spec.customId)
    .setTitle(spec.title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(first),
      new ActionRowBuilder<TextInputBuilder>().addComponents(second),
    );
}
