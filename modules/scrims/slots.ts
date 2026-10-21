/**
 * Slots: the numbering, and the state machine a slot moves through.
 *
 * D14: a slot is a **row** in the `slots` table with a `state` column.
 * There is no `available_slots` array and no join table, so a claim is one
 * conditional `UPDATE`:
 *
 * ```sql
 * UPDATE slots
 *    SET state = 'claimed', team_name = $3, owner_user_id = $4, members = $5
 *  WHERE scrim_id = $1 AND num = $2 AND state = 'free'
 * RETURNING id;
 * ```
 *
 * Zero rows updated means somebody else got there first. The database
 * enforces the invariant; there is no lock and no read-modify-write.
 *
 * The numbering runs `startFrom … startFrom + totalSlots - 1`. The
 * source's "Add Team" button hard-coded `range(start_from, 30)` (B4),
 * offering slot numbers that did not exist; this uses `total_slots`.
 */

import type { SlotState } from "./types.js";

/**
 * The slot numbers a scrim has.
 *
 * `startFrom` is the first number and there are `totalSlots` of them, so
 * the last is `startFrom + totalSlots - 1`.
 */
export function slotNumbers(startFrom: number, totalSlots: number): number[] {
  if (totalSlots <= 0) return [];

  const numbers: number[] = [];

  for (let offset = 0; offset < totalSlots; offset += 1) {
    numbers.push(startFrom + offset);
  }

  return numbers;
}

/** The last slot number of a scrim. */
export function lastSlotNumber(startFrom: number, totalSlots: number): number {
  return startFrom + Math.max(totalSlots, 0) - 1;
}

/** Is this a slot number the scrim actually has? */
export function isValidSlotNumber(
  num: number,
  startFrom: number,
  totalSlots: number,
): boolean {
  if (!Number.isInteger(num)) return false;

  return num >= startFrom && num <= lastSlotNumber(startFrom, totalSlots);
}

/**
 * The state transitions a slot may make.
 *
 * The source had no such thing: a slot was either in the
 * `available_slots` array or it was a row. Here the state is explicit, and
 * the table is the whole rulebook.
 *
 *  - `free` → `claimed` — a team takes it.
 *  - `claimed` → `free` — a team cancels, or a moderator removes it.
 *  - `free` → `locked` — a moderator holds it out of circulation.
 *  - `locked` → `free` — a moderator releases it.
 *  - `free`/`locked` → `banned` — the slot number is banned.
 *  - `banned` → `free` — the ban is lifted.
 */
const TRANSITIONS: Readonly<Record<SlotState, readonly SlotState[]>> = {
  free: ["claimed", "locked", "banned"],
  claimed: ["free"],
  locked: ["free", "banned"],
  banned: ["free"],
};

/** May a slot move from one state to another? */
export function canTransition(from: SlotState, to: SlotState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The states a slot may move to from here. */
export function nextStates(from: SlotState): readonly SlotState[] {
  return TRANSITIONS[from];
}

/** Is a slot in a state the public may claim it from? */
export function isClaimable(state: SlotState): boolean {
  return state === "free";
}

/**
 * The slot a registration should take.
 *
 * The source took `available_slots[0]` — the lowest free number. Ours
 * takes the lowest free number too, and the caller then claims it with
 * the conditional `UPDATE`, which is what makes the choice safe: if two
 * registrations race for the same number, exactly one wins and the
 * loser retries with the next one.
 */
export function pickSlotToClaim(
  slots: readonly { readonly num: number; readonly state: SlotState }[],
): number | null {
  const free = slots
    .filter((slot) => isClaimable(slot.state))
    .map((slot) => slot.num)
    .sort((left, right) => left - right);

  return free[0] ?? null;
}

/**
 * The result of trying to claim a slot.
 *
 * `claimed` means the row was updated. `taken` means somebody else got
 * it first — the caller retries. `unavailable` means the slot is not
 * claimable at all (banned or locked).
 */
export type ClaimOutcome = "claimed" | "taken" | "unavailable";

/**
 * Decides what a claim attempt means.
 *
 * The conditional `UPDATE` distinguishes "no row matched" from "the row
 * was updated" by how many rows it returned. When it returned none, the
 * service re-reads the slot and this function turns that state into the
 * outcome:
 *
 *  - `claimed` — somebody else got it in the meantime. Retry with the
 *    next free number.
 *  - `locked` or `banned` — the slot is not claimable at all. Stop.
 *  - `free` or gone — a contradiction the database should not produce;
 *    treated as a lost race, because retrying is harmless.
 */
export function classifyClaim(
  stateAfterFailure: SlotState | null,
): ClaimOutcome {
  if (stateAfterFailure === null) return "taken";
  if (stateAfterFailure === "claimed") return "taken";

  return "unavailable";
}
