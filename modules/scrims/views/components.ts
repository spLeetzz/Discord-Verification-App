/**
 * The shared building blocks of the scrims panels.
 *
 * Everything the panels have in common lives here: the editor's field
 * table, the row helpers and the two pieces the core does not have.
 *
 * **The buttons come from `core/ui.ts`.** The design language lives in
 * one file and this area uses it: `primaryButton`, `secondaryButton`,
 * `successButton`, `dangerButton`, `actionRow` and `navigationRow`.
 * There is no local `button()` any more — a button's colour says what
 * it does, so every button is built with the helper that means that,
 * and there is one way to do it.
 *
 * **The component budget is real.** Discord allows 25 components per
 * message, five rows, and five buttons per row. Quotient's editor added
 * exactly 25 and had no headroom; ours is laid out in five rows of five
 * and counted.
 */

import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";
import type { ButtonBuilder, EmbedBuilder, ModalSubmitInteraction } from "discord.js";
import {
  MAX_BUTTONS_PER_ROW,
  MAX_COMPONENT_ROWS,
  emptyPanel,
} from "../../../core/ui.js";

/** How many rows a message may carry. */
export const MAX_ROWS = MAX_COMPONENT_ROWS;

/** How many buttons fit in one row. */
export const MAX_COMPONENTS_PER_ROW = MAX_BUTTONS_PER_ROW;

/**
 * How many components a message may carry.
 *
 * Discord's limit is 25: five rows of five. It is derived from the two
 * limits above rather than written down twice, so the two cannot drift
 * apart.
 */
export const MAX_COMPONENTS_PER_MESSAGE = MAX_ROWS * MAX_COMPONENTS_PER_ROW;

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
 *
 * The labels are sentence case, like every other label in the bot.
 */
export const EDITOR_FIELDS: readonly EditorField[] = [
  { key: "set_name", label: "Name", kind: "text" },
  { key: "set_reg_channel", label: "Registration channel", kind: "channel" },
  { key: "set_slot_channel", label: "Slotlist channel", kind: "channel" },
  { key: "set_role", label: "Success role", kind: "role" },
  { key: "set_mentions", label: "Required mentions", kind: "number" },
  { key: "set_slots", label: "Total slots", kind: "number" },
  { key: "set_open_time", label: "Open time", kind: "time" },
  {
    key: "set_emojis",
    label: "Reactions",
    kind: "emojis",
    premium: true,
    applyToAll: true,
  },
  { key: "set_ping_role", label: "Ping role", kind: "role" },
  { key: "set_open_role", label: "Open role", kind: "role" },
  {
    key: "toggle_multireg",
    label: "Multi-register",
    kind: "toggle",
    column: "multiregister",
    applyToAll: true,
  },
  {
    key: "toggle_teamname",
    label: "Team compulsion",
    kind: "toggle",
    column: "teamnameCompulsion",
    applyToAll: true,
  },
  {
    key: "toggle_dup_name",
    label: "Duplicate team name",
    kind: "toggle",
    column: "noDuplicateName",
    applyToAll: true,
  },
  {
    key: "toggle_del_reject",
    label: "Autodelete rejected",
    kind: "toggle",
    column: "autodeleteRejects",
    applyToAll: true,
  },
  {
    key: "toggle_del_late",
    label: "Autodelete late messages",
    kind: "toggle",
    column: "autodeleteExtras",
    applyToAll: true,
  },
  {
    key: "set_start_from",
    label: "Slotlist start from",
    kind: "number",
    applyToAll: true,
  },
  { key: "set_autoclean", label: "Autoclean", kind: "panel" },
  { key: "set_days", label: "Scrim days", kind: "days" },
  { key: "set_lines", label: "Required lines", kind: "number", premium: true },
  {
    key: "toggle_dup_tags",
    label: "Duplicate / fake tags",
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

/** A row that holds one select menu. */
export function selectRow(
  menu: StringSelectMenuBuilder,
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/**
 * A panel that says there is nothing here yet.
 *
 * The empty state is the first thing a new user sees, so it says what
 * to do rather than only reporting the absence.
 *
 * `core/ui.ts` builds it; this copies the parts into the shape the
 * scrims area hands to discord.js, which takes mutable arrays.
 */
export function emptyScrimsPanel(options: {
  readonly title: string;
  readonly description: string;
  readonly footer?: string;
  readonly action?: ButtonBuilder;
}): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const panel = emptyPanel(options);

  return { embeds: [...panel.embeds], components: [...panel.components] };
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
