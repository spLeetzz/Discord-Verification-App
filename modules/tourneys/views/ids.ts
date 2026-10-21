/**
 * The tournaments custom-id scheme.
 *
 * D18: a custom id carries the record it refers to, so a panel survives a
 * bot restart. The tournament's id is in the id, never guessed from its
 * shape.
 *
 * ```
 * tourneys:<action>[:<part>[:<part>…]]
 * ```
 *
 * Examples:
 *
 *  - `tourneys:manager` — the management panel, no record;
 *  - `tourneys:lifecycle:open:<tourneyId>` — open a tournament;
 *  - `tourneys:editor:set_role:<tourneyId>` — one field of the editor;
 *  - `tourneys:groups:<tourneyId>` — the group manager;
 *  - `tourneys:group_refresh:<tourneyId>:<groupNumber>` — the Refresh
 *    button of a published group list;
 *  - `tourneys:slotm:<tourneyId>` — the tournament slot manager.
 *
 * The wizard carries a **token** rather than a record id, because the
 * tournament does not exist yet: it is state with no database row, which
 * is exactly what D18 says a token is for.
 *
 * `tourneys:idp_copy` is the one id with no record at all: the room
 * credentials are read back out of the message the button is attached to,
 * so there is nothing else to point at.
 */

import { makeCustomId } from "../../../core/custom-id.js";

/** The prefix every tourneys custom id starts with. */
export const TOURNEYS_PREFIX = "tourneys";

/** Every action the tournaments area answers to. */
export const TOURNEYS_ACTIONS = [
  "manager",
  "wizard",
  "editor",
  "editor_nav",
  "lifecycle",
  "ban",
  "groups",
  "group_publish",
  "group_refresh",
  "slotm",
  "slotm_cancel",
  "slotm_rename",
  "slotm_pick",
  "slotm_swap",
  "partner",
  "partner_add",
  "partner_remove",
  "idp_copy",
  "modal",
  "select",
] as const;

export type TourneysAction = (typeof TOURNEYS_ACTIONS)[number];

/** A parsed tourneys custom id. */
export interface TourneysId {
  readonly action: TourneysAction;
  /** The parts after the action. */
  readonly parts: readonly string[];
}

/**
 * Builds a tourneys custom id.
 *
 * @param action what the interaction does;
 * @param parts  the payload — usually the record id.
 */
export function tourneysId(
  action: TourneysAction,
  ...parts: readonly (string | number)[]
): string {
  const payload = parts
    .map((part) => String(part))
    .filter((part) => part.length > 0)
    .join(":");

  return makeCustomId(TOURNEYS_PREFIX, action, payload);
}

/**
 * Parses a tourneys custom id.
 *
 * @returns `null` when the id is not a tourneys id, or names an action
 *          this area does not know.
 */
export function parseTourneysId(customId: string): TourneysId | null {
  const segments = customId.split(":");

  if (segments[0] !== TOURNEYS_PREFIX) return null;

  const action = segments[1];

  if (!action) return null;
  if (!(TOURNEYS_ACTIONS as readonly string[]).includes(action)) return null;

  return {
    action: action as TourneysAction,
    parts: segments.slice(2).filter((part) => part.length > 0),
  };
}

/** The tournament id in a parsed id, or `null`. */
export function tourneyIdOf(id: TourneysId): string | null {
  return id.parts[0] ?? null;
}

/** The group number in a parsed id, or `null`. */
export function groupNumberOf(id: TourneysId): number | null {
  const raw = id.parts[1];

  if (raw === undefined) return null;

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) return null;

  return value;
}
