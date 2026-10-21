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
 *
 * **The modals are built with `core/ui.ts`.** The title names the
 * action, every field has a short noun label, a placeholder that shows
 * an example, and `required` is set explicitly. The way out of a modal
 * is the panel that opened it — every panel that opens a modal has a
 * grey **Back** (or **Cancel**) button — because Discord's modal API
 * cannot carry a button of its own.
 */

import { TextInputStyle } from "discord.js";
import type { ModalBuilder } from "discord.js";
import { buildModal as buildCoreModal } from "../../../core/ui.js";
import type { TextInputSpec } from "../../../core/ui.js";
import { MODAL_VALUE_ID } from "./components.js";

/** How a field modal is shaped. */
export interface FieldModalSpec {
  /** The custom id. It carries the record and the field. */
  readonly customId: string;
  /** The modal's title. It names the action. At most 45 characters. */
  readonly title: string;
  /** The label of the input. A short noun. At most 45 characters. */
  readonly label: string;
  /** The value the input starts with. */
  readonly value?: string;
  /** An example of what to type. */
  readonly placeholder?: string;
  /** Whether the input has to be filled in. */
  readonly required?: boolean;
  /** The shortest value the input accepts. */
  readonly minLength?: number;
  /** The longest value the input accepts. */
  readonly maxLength?: number;
  /** One line or many. */
  readonly style?: TextInputStyle;
}

/**
 * Builds a one-input modal.
 *
 * The custom id carries everything the handler needs: the record, the
 * field and any extra parts. Nothing is kept in memory.
 */
export function buildFieldModal(spec: FieldModalSpec): ModalBuilder {
  return buildCoreModal({
    customId: spec.customId,
    title: spec.title,
    inputs: [fieldInput(spec)],
  });
}

/** The one input of a field modal. */
function fieldInput(spec: FieldModalSpec): TextInputSpec {
  return {
    id: MODAL_VALUE_ID,
    label: spec.label,
    value: spec.value,
    placeholder: spec.placeholder,
    required: spec.required,
    minLength: spec.minLength,
    maxLength: spec.maxLength,
    style: spec.style,
  };
}

/** How a two-input modal is shaped. */
export interface TwoInputModalSpec {
  readonly customId: string;
  /** The modal's title. It names the action. At most 45 characters. */
  readonly title: string;
  readonly first: {
    readonly id: string;
    readonly label: string;
    readonly placeholder?: string;
    readonly value?: string;
  };
  readonly second: {
    readonly id: string;
    readonly label: string;
    readonly placeholder?: string;
    readonly value?: string;
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
  return buildCoreModal({
    customId: spec.customId,
    title: spec.title,
    inputs: [
      {
        id: spec.first.id,
        label: spec.first.label,
        value: spec.first.value,
        placeholder: spec.first.placeholder,
        required: true,
      },
      {
        id: spec.second.id,
        label: spec.second.label,
        value: spec.second.value,
        placeholder: spec.second.placeholder,
        required: true,
      },
    ],
  });
}

/* ------------------------------------------------------------------ *
 * The copy
 * ------------------------------------------------------------------ */

/**
 * The words of a modal.
 *
 * The title names the action, the label names the field, and the
 * placeholder shows an example of what to type.
 */
export interface ModalCopy {
  readonly title: string;
  readonly label: string;
  readonly placeholder: string;
  /** Whether the field has to be filled in. */
  readonly required?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly style?: TextInputStyle;
}

/** The words of a modal with two fields. */
export interface TwoInputCopy {
  readonly title: string;
  readonly first: {
    readonly label: string;
    readonly placeholder: string;
  };
  readonly second: {
    readonly label: string;
    readonly placeholder: string;
  };
}

/**
 * The modals the moderator tools open, keyed by the modal's kind.
 *
 * The kinds are the ones the custom id carries — `tourneys:modal:<kind>`.
 */
export const MODAL_COPY = {
  export: {
    title: "Export registrations",
    label: "Confirmation",
    placeholder: "export",
    // The export happens whatever the field says, so it may stay empty.
    required: false,
  },

  set_start_from: {
    title: "Set slotlist start",
    label: "First slot number",
    placeholder: "1",
    required: true,
    maxLength: 2,
  },

  ban: {
    title: "Ban or unban users",
    label: "Users",
    placeholder: "@someone @someone-else",
    required: true,
    maxLength: 100,
  },

  rename: {
    title: "Change team name",
    label: "Team name",
    placeholder: "Team Awesome",
    required: true,
    maxLength: 50,
  },

  partner_add: {
    title: "Add media partner",
    label: "Channel id",
    placeholder: "123456789012345678",
    required: true,
    maxLength: 20,
  },
} as const satisfies Record<string, ModalCopy>;

/** The modals with two fields the moderator tools open. */
export const TWO_INPUT_COPY = {
  add_slot: {
    title: "Add a slot",
    first: { label: "Team leader", placeholder: "@leader" },
    second: { label: "Team name", placeholder: "Team Awesome" },
  },

  remove_slot: {
    title: "Cancel a slot",
    first: { label: "Member", placeholder: "@someone" },
    second: { label: "Slot number", placeholder: "3" },
  },

  group_format: {
    title: "Create group channels",
    first: { label: "Name format", placeholder: "Group {0}" },
    second: { label: "Group range", placeholder: "1-5" },
  },

  swap: {
    title: "Swap two slots",
    first: { label: "First leader", placeholder: "@first" },
    second: { label: "Second leader", placeholder: "@second" },
  },
} as const satisfies Record<string, TwoInputCopy>;

/**
 * The copy of a field's modal.
 *
 * The key is a field's key, and the table is one of the copy tables
 * above. A field that has no modal — a channel, a role, a toggle —
 * gives `null`.
 */
export function copyFor(
  table: Readonly<Record<string, ModalCopy>>,
  key: string,
): ModalCopy | null {
  return table[key] ?? null;
}

/**
 * The field modals, keyed by the field's key.
 *
 * The wizard and the editor set the same fields, so they share one
 * table: the title names the action, the label is a short noun, and the
 * placeholder shows an example. A field that has no modal — a channel,
 * a role, a toggle — is not in the table.
 */
export const FIELD_MODAL_COPY = {
  set_name: {
    title: "Set tournament name",
    label: "Name",
    placeholder: "Spring Cup",
    required: true,
    maxLength: 30,
    style: TextInputStyle.Short,
  },

  set_mentions: {
    title: "Set required mentions",
    label: "Mentions",
    placeholder: "4",
    required: true,
    maxLength: 2,
  },

  set_slots: {
    title: "Set total slots",
    label: "Slots",
    placeholder: "64",
    required: true,
    maxLength: 5,
  },

  set_group_size: {
    title: "Set teams per group",
    label: "Teams per group",
    placeholder: "4",
    required: true,
    maxLength: 2,
  },

  set_emojis: {
    title: "Set reactions",
    label: "Reactions",
    placeholder: "✅,❌",
    required: true,
    maxLength: 20,
    style: TextInputStyle.Short,
  },

  set_lines: {
    title: "Set required lines",
    label: "Required lines",
    placeholder: "3",
    required: true,
    maxLength: 3,
  },

  set_start_from: {
    title: "Set slotlist start",
    label: "First slot number",
    placeholder: "1",
    required: true,
    maxLength: 2,
  },

  set_open_days: {
    title: "Set open days",
    label: "Open days",
    placeholder: "monday, wednesday",
    required: true,
    maxLength: 60,
    style: TextInputStyle.Short,
  },

  set_open_time: {
    title: "Set open time",
    label: "Open time",
    placeholder: "18:00",
    required: true,
    maxLength: 5,
  },

  set_success_message: {
    title: "Set success message",
    label: "Success message",
    placeholder: "Thanks for registering!",
    required: true,
    maxLength: 500,
    style: TextInputStyle.Paragraph,
  },
} as const satisfies Record<string, ModalCopy>;
