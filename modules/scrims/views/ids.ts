/**
 * The scrims custom-id scheme.
 *
 * D18: a custom id carries the record it refers to, so a panel survives a
 * bot restart. The scrim's id is in the id, never guessed from its
 * shape.
 *
 * ```
 * scrims:<action>[:<part>[:<part>…]]
 * ```
 *
 * Examples:
 *
 *  - `scrims:list` — the list panel, no record;
 *  - `scrims:pick` — the select menu on the list panel;
 *  - `scrims:manager:<scrimId>` — the panel of one scrim;
 *  - `scrims:editor:set_role:<scrimId>` — one field of the editor;
 *  - `scrims:wizard:set_role:<token>` — one field of the wizard;
 *  - `scrims:modal:field:set_role:<scrimId>` — the modal behind a field;
 *  - `scrims:slotm_pick:<scrimId>:<kind>:<userId>` — the "which slot?"
 *    menu of the slotlist editor, and the member who opened it.
 *
 * The `slotm_pick` menu is **persistent** rather than awaited inline: a
 * modal cannot follow a menu that was waited on, because waiting on it
 * answers the interaction. See `views/slot-pick.ts`.
 *
 * The wizard carries a **token** rather than a record id, because the
 * scrim does not exist yet: it is state with no database row, which is
 * exactly what D18 says a token is for.
 */

import { makeCustomId } from "../../../core/custom-id.js";

/** The prefix every scrims custom id starts with. */
export const SCRIMS_PREFIX = "scrims";

/** Every action the scrims area answers to. */
export const SCRIMS_ACTIONS = [
  "list",
  "pick",
  "new",
  "wizard",
  "manager",
  "editor",
  "editor_open",
  "editor_nav",
  "ban",
  "reserve",
  "autoclean",
  "design",
  "slotlist",
  "modal",
  "select",
  "slotm_pick",
] as const;

export type ScrimsAction = (typeof SCRIMS_ACTIONS)[number];

/** A parsed scrims custom id. */
export interface ScrimsId {
  readonly action: ScrimsAction;
  /** The parts after the action. */
  readonly parts: readonly string[];
}

/**
 * Builds a scrims custom id.
 *
 * @param action what the interaction does.
 * @param parts  the payload — usually the record id.
 */
export function scrimsId(
  action: ScrimsAction,
  ...parts: readonly (string | number)[]
): string {
  const payload = parts
    .map((part) => String(part))
    .filter((part) => part.length > 0)
    .join(":");

  return makeCustomId(SCRIMS_PREFIX, action, payload);
}

/**
 * Parses a scrims custom id.
 *
 * @returns `null` when the id is not a scrims id, or names an action
 *          this area does not know.
 */
export function parseScrimsId(customId: string): ScrimsId | null {
  const segments = customId.split(":");

  if (segments[0] !== SCRIMS_PREFIX) return null;

  const action = segments[1];

  if (!action) return null;
  if (!(SCRIMS_ACTIONS as readonly string[]).includes(action)) return null;

  return {
    action: action as ScrimsAction,
    parts: segments.slice(2).filter((part) => part.length > 0),
  };
}

/** The scrim id in a parsed id, or `null`. */
export function scrimIdOf(id: ScrimsId): string | null {
  return id.parts[0] ?? null;
}
