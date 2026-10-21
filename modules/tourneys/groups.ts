/**
 * The group algorithm.
 *
 * **Groups are a flat chunk of the ordered slot list by `group_size`.**
 *
 * That is the whole of it. Quotient's `Tourney._get_groups` is
 *
 * ```python
 * return split_list(await self.assigned_slots.all().order_by("num"), self.group_size)
 * ```
 *
 * and `split_list` (`src/utils/default.py:19-28`) is
 *
 * ```python
 * for i in range(0, len(data), per_list):
 *     new.append(data[i : i + per_list])
 * ```
 *
 * — a flat chunk. The last group is short when the count is not a
 * multiple of the group size, and there is no byes, no seeding and no
 * progression.
 *
 * **Quotient does not implement standings, points, seeding or
 * progression, and neither does this.** A group here is a bucket of teams,
 * nothing more. Anything else would be a new feature, not a port.
 */

/** The smallest group size that means anything. */
export const MIN_GROUP_SIZE = 1;

/** The largest group size the wizard offers. The source's limit was 25. */
export const MAX_GROUP_SIZE = 25;

/** A slot, as far as the grouping is concerned. */
export interface GroupableSlot {
  /** The position within the tournament. */
  readonly num: number;
  /** The team name the group list shows. */
  readonly teamName: string;
}

/** One group: the teams in it, in slot order. */
export interface Group<T extends GroupableSlot = GroupableSlot> {
  /** Which group this is, counting from 1. */
  readonly number: number;
  /** The teams, in slot order. */
  readonly slots: readonly T[];
}

/**
 * Chunks an ordered list into groups of `groupSize`.
 *
 * The list is chunked **as it is given**. The caller is responsible for
 * ordering it by slot number first — the source ordered by `num` before
 * chunking, and so does {@link groupSlots}.
 *
 * @param slots     the slots, already in slot order;
 * @param groupSize how many teams share a group. A size of `0` or less
 *                  produces no groups rather than throwing, because the
 *                  caller decides what an unset group size means.
 */
export function chunkIntoGroups<T extends GroupableSlot>(
  slots: readonly T[],
  groupSize: number,
): Group<T>[] {
  if (groupSize < MIN_GROUP_SIZE) return [];
  if (slots.length === 0) return [];

  const groups: Group<T>[] = [];

  for (let index = 0; index < slots.length; index += groupSize) {
    groups.push({
      number: groups.length + 1,
      slots: slots.slice(index, index + groupSize),
    });
  }

  return groups;
}

/**
 * The groups of a tournament.
 *
 * The slots are ordered by their number first, exactly as the source
 * ordered them (`order_by("num")`) before chunking.
 */
export function groupSlots<T extends GroupableSlot>(
  slots: readonly T[],
  groupSize: number,
): Group<T>[] {
  const ordered = [...slots].sort((left, right) => left.num - right.num);

  return chunkIntoGroups(ordered, groupSize);
}

/**
 * The one group with a given number.
 *
 * The source walked the list and returned the group whose index matched.
 * This is the same thing, spelled as a lookup.
 *
 * @returns the group, or `null` when there is no such group.
 */
export function getGroup<T extends GroupableSlot>(
  slots: readonly T[],
  groupSize: number,
  groupNumber: number,
): Group<T> | null {
  if (groupNumber < 1) return null;

  const groups = groupSlots(slots, groupSize);

  return groups[groupNumber - 1] ?? null;
}

/**
 * The line the published group list shows for one slot.
 *
 * The source printed `f"Slot {idx:02}  ->  {slot.team_name}"`, where
 * `idx` counted from `tourney.slotlist_start`. Ours counts from
 * `startFrom` too.
 */
export function groupListLine(
  slot: GroupableSlot,
  index: number,
  startFrom: number,
): string {
  return `Slot ${String(startFrom + index).padStart(2, "0")}  ->  ${slot.teamName}`;
}

/**
 * The whole published group list, as the code block the source printed.
 */
export function renderGroupList(
  group: Group,
  startFrom: number,
): string {
  const lines = group.slots.map((slot, index) =>
    groupListLine(slot, index, startFrom),
  );

  return ["```", ...lines, "```"].join("\n");
}
