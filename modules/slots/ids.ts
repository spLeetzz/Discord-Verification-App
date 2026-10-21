/**
 * The slot-area custom-id scheme.
 *
 * D18: a custom id carries the record it refers to, so a panel survives a
 * bot restart. The record id is in the id, never guessed from its shape.
 *
 * ```
 * slots:<action>[:<payload>]
 * ```
 *
 * Examples:
 *
 *  - `slots:claim:<managerId>` — the claim button of the public panel;
 *  - `slots:slotlist_punish:<scrimId>` — the punish button of a scrim's
 *    published slot list;
 *  - `slots:pick:<token>` — a select menu whose options carry the choice;
 *  - `slots:modal_claim:<token>` — the claim form.
 *
 * The two kinds of payload are the two halves of D18:
 *
 *  - a **record id** for anything that refers to a database row — the
 *    slot manager, the scrim. It survives a restart, a message being
 *    moved and a message being edited.
 *  - a **token** for the state of a flow that is mid-flight and has no
 *    row yet — the slot a member picked, the ban mode, the reason that
 *    was typed. A token is only meaningful to the process that issued
 *    it, so it is never used where a record id would do.
 */

import { makeCustomId } from "../../core/custom-id.js";

/** The prefix every slot-area custom id starts with. */
export const SLOTS_PREFIX = "slots";

/** Every action the slot area answers to. */
export const SLOTS_ACTIONS = [
  /* The public panel. */
  "claim",
  "cancel",
  "remind",
  "idp",
  /* The published slot list. */
  "slotlist_edit",
  "slotlist_punish",
  "slotlist_info",
  "slotlist_add",
  "slotlist_remove",
  "slotlist_change",
  "slotlist_back",
  /* The slot-manager editor. */
  "manager_toggle",
  "manager_reminders",
  "manager_multi",
  "manager_scrims",
  "manager_scrims_add",
  "manager_scrims_remove",
  "manager_delete",
  "manager_channel",
  "manager_back",
  /* The flows. */
  "pick",
  "modal_claim",
  "modal_punish",
  "modal_team",
] as const;

export type SlotsAction = (typeof SLOTS_ACTIONS)[number];

/** A parsed slot-area custom id. */
export interface SlotsId {
  readonly action: SlotsAction;
  /** The parts after the action. */
  readonly parts: readonly string[];
}

/**
 * Builds a slot-area custom id.
 *
 * @param action what the interaction does.
 * @param parts  the payload — a record id, or a token.
 */
export function slotsId(
  action: SlotsAction,
  ...parts: readonly (string | number)[]
): string {
  const payload = parts
    .map((part) => String(part))
    .filter((part) => part.length > 0)
    .join(":");

  return makeCustomId(SLOTS_PREFIX, action, payload);
}

/**
 * Parses a slot-area custom id.
 *
 * @returns `null` when the id is not a slot-area id, or names an action
 *          this area does not know.
 */
export function parseSlotsId(customId: string): SlotsId | null {
  const segments = customId.split(":");

  if (segments[0] !== SLOTS_PREFIX) return null;

  const action = segments[1];

  if (!action) return null;
  if (!(SLOTS_ACTIONS as readonly string[]).includes(action)) return null;

  return {
    action: action as SlotsAction,
    parts: segments.slice(2).filter((part) => part.length > 0),
  };
}

/** The first part of a parsed id, or `null`. */
export function payloadOf(id: SlotsId): string | null {
  return id.parts[0] ?? null;
}
