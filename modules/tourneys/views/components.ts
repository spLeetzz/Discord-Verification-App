/**
 * The shared building blocks of the tournaments panels.
 *
 * **The design language lives in `core/ui.ts`.** The buttons, the rows,
 * the modals, the embeds and the component budget are all built there,
 * so the tournaments area looks like the rest of the bot and there is
 * one way to build a panel.
 *
 * What is left here is what `core/ui.ts` does not have:
 *
 *  - the editor's field table, which is a domain fact and not a design
 *    decision;
 *  - the id the modal handlers read a value from.
 */

/**
 * How a field is edited.
 *
 *  - `text` — a modal with a text input;
 *  - `number` — a modal with a text input that is validated;
 *  - `emojis` — a modal with a text input holding two emojis;
 *  - `channel` — a select menu of channels (D17);
 *  - `role` — a select menu of roles (D17);
 *  - `toggle` — a button that flips the value;
 *  - `days` — a multi-select menu of the seven weekdays;
 *  - `schedule` — a modal with the open time.
 */
export type FieldKind =
  | "text"
  | "number"
  | "emojis"
  | "channel"
  | "role"
  | "toggle"
  | "days"
  | "schedule";

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
}

/**
 * The editor fields, in the order the panel lays them out.
 *
 * The order matters: the buttons carry a letter from `a` onwards and the
 * embed lists the fields in the same order, so a moderator learns one
 * layout instead of two.
 *
 * The labels are **sentence case**, like every other label in the bot.
 */
export const EDITOR_FIELDS: readonly EditorField[] = [
  { key: "set_name", label: "Name", kind: "text" },
  { key: "set_reg_channel", label: "Registration channel", kind: "channel" },
  { key: "set_confirm_channel", label: "Confirm channel", kind: "channel" },
  { key: "set_role", label: "Success role", kind: "role" },
  { key: "set_mentions", label: "Required mentions", kind: "number" },
  { key: "set_slots", label: "Total slots", kind: "number" },
  { key: "set_group_size", label: "Teams per group", kind: "number" },
  { key: "set_emojis", label: "Reactions", kind: "emojis", premium: true },
  { key: "set_ping_role", label: "Ping role", kind: "role" },
  { key: "set_open_role", label: "Open role", kind: "role" },
  {
    key: "toggle_multireg",
    label: "Multi-register",
    kind: "toggle",
    column: "multiregister",
  },
  {
    key: "toggle_teamname",
    label: "Team compulsion",
    kind: "toggle",
    column: "teamnameCompulsion",
  },
  {
    key: "toggle_dup_name",
    label: "Duplicate team name",
    kind: "toggle",
    column: "noDuplicateName",
  },
  {
    key: "toggle_del_reject",
    label: "Autodelete rejected",
    kind: "toggle",
    column: "autodeleteRejects",
  },
  {
    key: "set_lines",
    label: "Required lines",
    kind: "number",
    premium: true,
  },
  {
    key: "toggle_dup_tags",
    label: "Duplicate / fake tags",
    kind: "toggle",
    column: "allowDuplicateTags",
    premium: true,
  },
  { key: "set_start_from", label: "Slotlist start from", kind: "number" },
  { key: "set_open_days", label: "Open days", kind: "days" },
  { key: "set_open_time", label: "Open time", kind: "schedule" },
  { key: "set_success_message", label: "Success message", kind: "text" },
];

/**
 * The letter a field's button carries.
 *
 * A table of twenty fields does not fit twenty long labels into five
 * rows — Discord truncates them. The letter does not truncate, and the
 * embed lists the fields in the same order with the same letters, so
 * one layout is learned instead of two.
 */
export function fieldLetter(index: number): string {
  return String.fromCharCode(97 + index);
}

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */

/** The custom id of the input inside a modal. */
export const MODAL_VALUE_ID = "value";

/** A text input's value, or an empty string. */
export function modalText(
  interaction: {
    fields: { getTextInputValue(id: string): string };
  },
  id = MODAL_VALUE_ID,
): string {
  try {
    return interaction.fields.getTextInputValue(id).trim();
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */