/**
 * The shared building blocks of the scrims panels.
 *
 * Everything the panels have in common lives here: the editor's field
 * table, the row builders and the modals.
 *
 * **The component budget is real.** Discord allows 25 components per
 * message, five rows, and five buttons per row. Quotient's editor added
 * exactly 25 and had no headroom; ours is laid out in five rows of five
 * and counted.
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
import type { ModalSubmitInteraction } from "discord.js";
import { EMBED_COLOR } from "../../../core/constants.js";

/** Discord's own limits. */
export const MAX_ROWS = 5;
export const MAX_COMPONENTS_PER_ROW = 5;
export const MAX_COMPONENTS_PER_MESSAGE = 25;

/**
 * How a field is edited.
 *
 *  - `text` — a modal with a text input;
 *  - `number` — a modal with a text input that is validated;
 *  - `time` — a modal with a text input parsed by `parseNaturalTime`;
 *  - `emojis` — a modal with a text input holding two emojis;
 *  - `channel` — a modal with a **channel select** (D17);
 *  - `role` — a modal with a **role select** (D17);
 *  - `toggle` — a button that flips the value;
 *  - `days` — a multi-select menu of the seven weekdays;
 *  - `panel` — a sub-panel of its own.
 */
export type FieldKind =
  | "text"
  | "number"
  | "time"
  | "emojis"
  | "channel"
  | "role"
  | "toggle"
  | "days"
  | "panel";

/** One field of the editor. */
export interface EditorField {
  /** The fragment of the custom id. */
  readonly key: string;
  /** What the button and the embed call it. */
  readonly label: string;
  readonly kind: FieldKind;
  /**
   * The column a toggle writes.
   *
   * The custom-id fragment and the column are different names — the
   * button says `toggle_multireg`, the column says `multiregister` —
   * and this is where the two are joined.
   */
  readonly column?: string;
  /** Is the field behind a premium entitlement? */
  readonly premium?: boolean;
  /**
   * Does the source ask "apply to all scrims?" for this field?
   *
   * Only eight of the twenty did; the rest changed one scrim.
   */
  readonly applyToAll?: boolean;
}

/**
 * The twenty editor fields, in the order the source laid them out.
 *
 * The order matters: the buttons carry a letter from `a` to `t`, and
 * the embed lists the fields in the same order, so a moderator learns
 * one layout instead of two.
 */
export const EDITOR_FIELDS: readonly EditorField[] = [
  { key: "set_name", label: "Name", kind: "text" },
  { key: "set_reg_channel", label: "Registration Channel", kind: "channel" },
  { key: "set_slot_channel", label: "Slotlist Channel", kind: "channel" },
  { key: "set_role", label: "Success Role", kind: "role" },
  { key: "set_mentions", label: "Mentions", kind: "number" },
  { key: "set_slots", label: "Slots", kind: "number" },
  { key: "set_open_time", label: "Open Time", kind: "time" },
  {
    key: "set_emojis",
    label: "Reactions",
    kind: "emojis",
    premium: true,
    applyToAll: true,
  },
  { key: "set_ping_role", label: "Ping Role", kind: "role" },
  { key: "set_open_role", label: "Open Role", kind: "role" },
  {
    key: "toggle_multireg",
    label: "Multi-Register",
    kind: "toggle",
    column: "multiregister",
    applyToAll: true,
  },
  {
    key: "toggle_teamname",
    label: "Team Compulsion",
    kind: "toggle",
    column: "teamnameCompulsion",
    applyToAll: true,
  },
  {
    key: "toggle_dup_name",
    label: "Duplicate Team Name",
    kind: "toggle",
    column: "noDuplicateName",
    applyToAll: true,
  },
  {
    key: "toggle_del_reject",
    label: "Autodelete Rejected",
    kind: "toggle",
    column: "autodeleteRejects",
    applyToAll: true,
  },
  {
    key: "toggle_del_late",
    label: "Autodelete Late Messages",
    kind: "toggle",
    column: "autodeleteExtras",
    applyToAll: true,
  },
  {
    key: "set_start_from",
    label: "Slotlist Start From",
    kind: "number",
    applyToAll: true,
  },
  { key: "set_autoclean", label: "Autoclean", kind: "panel" },
  { key: "set_days", label: "Scrim Days", kind: "days" },
  { key: "set_lines", label: "Required Lines", kind: "number", premium: true },
  {
    key: "toggle_dup_tags",
    label: "Duplicate / Fake Tags",
    kind: "toggle",
    column: "allowDuplicateTags",
    premium: true,
    applyToAll: true,
  },
];

/** The letter a field's button carries. */
export function fieldLetter(index: number): string {
  return String.fromCharCode(97 + index);
}

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

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */

/** The custom id of the select inside a channel modal. */
export const MODAL_CHANNEL_ID = "value";

/** The custom id of the select inside a role modal. */
export const MODAL_ROLE_ID = "value";

/** One text input of a modal. */
export interface ModalText {
  readonly id?: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly value?: string;
  readonly required?: boolean;
  readonly maxLength?: number;
}

/** How a modal is shaped. */
export interface ModalSpec {
  readonly customId: string;
  readonly title: string;
  /** A text input. */
  readonly text?: ModalText;
  /**
   * Several text inputs.
   *
   * Discord allows five inputs per modal. The ban form needs three
   * (who, for how long, why) and the reserved-slot form needs four.
   */
  readonly texts?: readonly ModalText[];
}

/**
 * Builds a modal.
 *
 * Discord allows five inputs per modal. A channel or a role is **not**
 * a modal input — D17 wants a select menu for those, and a select menu
 * is a message component, so those flows open an ephemeral menu
 * instead (see `select-flow.ts`).
 */
export function buildModal(spec: ModalSpec): ModalBuilder {
  if (spec.title.length > 45) {
    throw new RangeError("a modal title may be at most 45 characters");
  }

  const modal = new ModalBuilder()
    .setCustomId(spec.customId)
    .setTitle(spec.title);

  const texts: ModalText[] = [
    ...(spec.text ? [spec.text] : []),
    ...(spec.texts ?? []),
  ];

  if (texts.length > 5) {
    throw new RangeError("a modal may hold at most five inputs");
  }

  for (const text of texts) {
    const input = new TextInputBuilder()
      .setCustomId(text.id ?? "value")
      .setLabel(text.label)
      .setStyle(TextInputStyle.Short);

    if (text.placeholder) input.setPlaceholder(text.placeholder);
    if (text.value) input.setValue(text.value);
    if (text.required !== undefined) input.setRequired(text.required);
    if (text.maxLength !== undefined) {
      input.setMaxLength(Math.min(text.maxLength, 4000));
    }

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
  }

  return modal;
}

/** A text input's value, or an empty string. */
export function modalText(
  interaction: ModalSubmitInteraction,
  id = "value",
): string {
  try {
    return interaction.fields.getTextInputValue(id).trim();
  } catch {
    return "";
  }
}

/** The embed a panel shows. */
export function panelEmbed(
  title: string,
  description: string,
): EmbedBuilder {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(EMBED_COLOR);
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
